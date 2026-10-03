/**
 * The project guard policy engine.
 *
 * The engine answers exactly one question for one pending tool call: may it run
 * without asking the user? It answers `allow` only for work that is provably
 * confined to the project (and the platform temp area), and `ask` for
 * everything else. A small set of machine- or session-destroying actions is
 * denied outright, because confirming them is pointless: turning off the
 * network or powering down the machine kills the very session that would carry
 * the confirmation.
 *
 * Every rule fails closed: an unreadable command, an unknown tool, an
 * unresolved variable used as a path, or a path that cannot be proven to be
 * inside the project all become `ask`.
 *
 * @module dsh-project-guard/lib/classify
 */
import { homedir, tmpdir } from 'node:os';
import { describeImpact } from './impact.js';
import { isContained, normalizeRoots, toAbsolute } from './path-utils.js';
import { argumentsOf, parseShellCommand, programOf } from './shell-parse.js';

/** Tools this plugin always lets through without a path check. */
export const DEFAULT_ALLOW_TOOLS = [
  'todo_write',
  'ask_user_question',
  'present',
  'skill',
  'load_workspace_dependencies',
  'get_goal',
  'create_goal',
  'update_goal',
  'job_list',
  'job_output',
  'job_kill',
  'list_agents',
  'team_task_list',
  'team_task_get',
  'web_search',
  'web_fetch',
  'cordis_inspect_list',
  'cordis_inspect_query'
];

/** Tools that reach outside the project or the session by construction. */
export const DEFAULT_ASK_TOOLS = [
  'plugin_manager',
  'run_code',
  'subagent',
  'subagent_fork',
  'workflow',
  'spawn_teammate',
  'send_message',
  'interrupt_agent',
  'team_task_create',
  'team_task_update',
  'schedule_create',
  'schedule_update',
  'schedule_delete',
  'schedule_list'
];

/** File tools this plugin resolves against the project roots. */
const PATH_TOOLS = {
  read: { args: ['file_path'], access: 'read' },
  read_image: { args: ['file_path'], access: 'read' },
  glob: { args: ['path'], access: 'read' },
  grep: { args: ['path'], access: 'read' },
  write: { args: ['file_path'], access: 'write' },
  edit: { args: ['file_path'], access: 'write' }
};

/** Shell executors whose command string is analysed. */
const SHELL_TOOLS = new Set(['bash', 'shell', 'sh', 'pwsh', 'powershell', 'cmd']);

/**
 * Programs that read or change machine state outside the project. Kept
 * deliberately broad: the point is that the user decides, not the plugin.
 */
const SYSTEM_PROGRAMS = new Set([
  // privilege, accounts and credentials
  'sudo', 'su', 'doas', 'login', 'passwd', 'chsh', 'chpass', 'dscl', 'dseditgroup',
  'sysadminctl', 'security', 'csrutil', 'spctl', 'softwareupdate',
  // services, launchers and schedulers
  'launchctl', 'launchd', 'systemctl', 'service', 'sc', 'crontab', 'at', 'atq', 'atrm', 'batch',
  // network configuration
  'defaults', 'systemsetup', 'scutil', 'networksetup', 'ifconfig', 'ip', 'nmcli', 'iwconfig', 'iw',
  'route', 'arp', 'pfctl', 'socketfilterfw', 'wg', 'wg-quick', 'airport', 'blueutil',
  // power and session
  'pmset', 'caffeinate', 'shutdown', 'reboot', 'halt', 'log',
  // process control
  'kill', 'killall', 'pkill', 'skill', 'renice',
  // disks and firmware
  'diskutil', 'hdiutil', 'asr', 'fsck', 'newfs', 'mkfs', 'fdisk', 'gpt', 'dd',
  'mount', 'umount', 'bless', 'nvram', 'firmwarepasswd', 'kextload', 'kextutil', 'kmutil',
  // system inspection
  'sysctl', 'ioreg', 'system_profiler', 'dscacheutil', 'mdutil', 'netstat', 'lsof', 'tcpdump',
  'ps', 'top', 'vm_stat', 'hostname', 'uptime', 'sw_vers', 'uname', 'arch',
  // system package managers
  'brew', 'port', 'mas', 'fink', 'dpkg', 'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'zypper',
  'rpm', 'snap', 'flatpak', 'pip', 'pip3', 'conda', 'mamba',
  // launching or scripting other applications
  'osascript', 'open', 'sdef',
  // unbounded or indirect process spawning
  'xargs', 'stress', 'stress-ng',
  // shared state that other programs read
  'updatedb'
]);

/** Programs whose only purpose is to reach another machine or service. */
const NETWORK_PROGRAMS = new Set([
  'curl', 'wget', 'nc', 'netcat', 'ncat', 'telnet', 'ftp', 'lftp', 'ssh', 'scp', 'sftp',
  'npx', 'pnpx', 'bunx', 'uvx', 'pipx',
  'rsync', 'socat', 'openssl', 'gh', 'glab', 'hub', 'aws', 'gcloud', 'az', 'doctl',
  'heroku', 'fly', 'flyctl', 'vercel', 'netlify', 'wrangler', 'kubectl', 'helm',
  'docker', 'podman', 'colima', 'limactl', 'vagrant', 'terraform', 'tofu', 'ansible',
  'ansible-playbook', 'ping', 'ping6', 'traceroute', 'dig', 'nslookup', 'host', 'whois', 'nmap'
]);

/** Programs that operate on file paths, where `$VAR` must not be guessed. */
const FILE_PROGRAMS = new Set([
  'cd', 'cp', 'mv', 'rm', 'ln', 'mkdir', 'rmdir', 'touch', 'chmod', 'chown', 'chgrp',
  'install', 'tee', 'rsync', 'dd', 'truncate', 'tar', 'unzip', 'zip', 'find', 'sed',
  'open', 'pushd', 'popd', 'cat', 'head', 'tail', 'less', 'more', 'rmdir'
]);

/** Package-manager programs allowed to install into the project. */
const PROJECT_PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** Global-install flags that must never be auto-approved. */
const GLOBAL_FLAGS = new Set(['-g', '--global', '--location=global', '--global=true']);

/** Redirection targets that are devices rather than project paths. */
const SAFE_DEVICE_TARGETS = new Set([
  '/dev/null', '/dev/stdout', '/dev/stderr', '/dev/stdin', '/dev/tty', '/dev/zero', '/dev/random'
]);

/**
 * Actions denied outright: they destroy the machine or cut the session that
 * carries the confirmation. Disable with `protectSessionAndSystem: false`.
 */
const HARD_DENY_PATTERNS = [
  { code: 'FORK_BOMB', pattern: /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, label: 'fork bomb' },
  { code: 'ROOT_DELETE', pattern: /\brm\b[^\n]*\s\/(?=[\s*'"]|$)/, label: 'delete from the filesystem root' },
  { code: 'HOME_DELETE', pattern: /\brm\b[^\n]*\s(?:~|\$HOME|\$\{HOME\})\/?(?=\s|$|\*)/, label: 'delete the home directory' },
  { code: 'FORMAT', pattern: /\b(?:mkfs(?:\.[a-z0-9]+)?|newfs(?:_[a-z0-9]+)?|fdisk|gpt)\b/, label: 'format or repartition a disk' },
  { code: 'RAW_DISK_WRITE', pattern: /\bdd\b[^\n]*\bof=\/dev\//, label: 'write raw data to a device' },
  { code: 'DISK_ERASE', pattern: /\bdiskutil\s+(?:eraseDisk|eraseVolume|reformat|zeroDisk|partitionDisk|secureErase)\b/, label: 'erase a disk' },
  { code: 'POWER_OFF', pattern: /\b(?:shutdown|reboot|halt)\b/, label: 'power off or reboot the machine' },
  { code: 'NETWORK_OFF', pattern: /\bnetworksetup\s+-setairportpower\b[^\n]*\boff\b/, label: 'turn off Wi-Fi' },
  { code: 'INTERFACE_DOWN', pattern: /\b(?:ifconfig\s+\S+\s+(?:down|destroy)|ip\s+link\s+set\s+\S+\s+down|nmcli\s+\S+\s+down|pfctl\s+-d|wg-quick\s+down)\b/, label: 'bring a network interface down' },
  { code: 'SYSTEM_PROCESS_KILL', pattern: /\b(?:killall|pkill)\b[^\n]*\b(?:WindowServer|loginwindow|launchd|Finder|Dock|SystemUIServer|mDNSResponder|configd|coreaudiod|cfprefsd)\b/, label: 'kill a core system process' },
  { code: 'INIT_KILL', pattern: /\bkill\s+(?:-\d+\s+)?1\b/, label: 'kill the init process' },
  { code: 'SESSION_KILL', pattern: /\b(?:killall|pkill|kill)\b[^\n]*DeepSeek\s*Harness/i, label: 'kill the running Harness' }
];

/**
 * Actions that can starve the whole machine even when their target is inside
 * the project: a full disk, a saturated CPU or an exhausted process table stops
 * every other program. They are asked about, never silently allowed.
 */
const RESOURCE_ABUSE_PATTERNS = [
  { code: 'UNBOUNDED_WRITE', pattern: /\bdd\b[^\n]*\bif=\/dev\/(?:zero|random|urandom)/, label: 'an unbounded write that can fill the disk' },
  { code: 'UNBOUNDED_WRITE', pattern: /(?:^|[|;&(]\s*)yes\b/, label: 'an unbounded output stream' },
  { code: 'UNBOUNDED_WRITE', pattern: /\b(?:cat|base64)\b[^\n]*\/dev\/(?:zero|random|urandom)/, label: 'an unbounded output stream' },
  { code: 'DISK_FILL', pattern: /\b(?:mkfile|fallocate|truncate)\b[^\n]*-[a-z]*\s*\d+\s*[kmgt]?\b/i, label: 'a large file allocation' },
  { code: 'LOAD_TEST', pattern: /\b(?:stress|stress-ng)\b/, label: 'a load test' },
  { code: 'UNBOUNDED_LOOP', pattern: /while\s+(?:true|:)\s*;?\s*do|for\s*\(\s*\(\s*;\s*;\s*\)\s*\)/, label: 'an unbounded loop' }
];

/**
 * Actions that take a machine-wide resource other programs also need, such as a
 * listening port, and therefore need confirmation even inside the project.
 */
const SHARED_STATE_PATTERNS = [
  { code: 'PORT_BIND', pattern: /\b(?:python[0-9.]*\s+-m\s+https?\.server|http-server|live-server|serve\s+-s|npx\s+serve)\b/, label: 'a local server that binds a port' }
];

/**
 * Package-manager subcommands that only touch the project. Anything else
 * (publishing, tokens, the shared cache, global links) needs confirmation.
 */
const PROJECT_PACKAGE_SUBCOMMANDS = new Set([
  'install', 'i', 'add', 'ci', 'install-test', 'it', 'install-ci-test', 'cit',
  'run', 'run-script', 'test', 't', 'start', 'stop', 'restart', 'build',
  'why', 'ls', 'list', 'outdated', 'audit', 'view', 'info', 'show', 'pack',
  'dedupe', 'prune', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall', 'un',
  'init', 'node', 'bin', 'root', 'prefix', 'help', 'version', 'doctor'
]);

/** The shipped configuration, also the documentation of every knob. */
export const DEFAULT_CONFIG = {
  /** Master switch. */
  enabled: true,
  /** Extra project roots, in addition to the session workspace. */
  projectRoots: [],
  /** Treat the session workspace (its `cwd`) as a project root. */
  includeSessionCwd: true,
  /** Extra roots that may be read but never written. */
  readOnlyRoots: [],
  /** Treat the platform temp directory as scratch space, like the sandbox does. */
  includeTempDirs: true,
  /** Resolve symlinks before deciding containment. */
  resolveSymlinks: true,
  /** Keep the session on the `ask` approval policy, so confirmations can reach the user. */
  enforceAskPolicy: true,
  /** Deliver at most one confirmation at a time. */
  serializeApprovals: true,
  /** Give system-related confirmations the single slot before ordinary ones. */
  prioritizeSystemRequests: true,
  /** Deny machine- or session-destroying actions instead of asking. */
  protectSessionAndSystem: true,
  /** Extra tools to always allow. */
  allowTools: [],
  /** Extra tools to always ask about. */
  askTools: [],
  /** Tools to deny outright. */
  denyTools: [],
  /** Extra system program names. */
  systemCommands: [],
  /** Extra regular expressions that force a confirmation. */
  extraAskPatterns: [],
  /** Extra regular expressions that force an allowance (checked before ask patterns). */
  extraAllowPatterns: [],
  /** Allow `python -c`, `node -e`, `$(...)` and similar uninspectable text. */
  allowInlineCode: false,
  /** Log every decision at debug level. */
  verbose: false
};

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string' && entry.length > 0);
}

function compilePatterns(values, onError) {
  const compiled = [];
  for (const value of asStringArray(values)) {
    try {
      compiled.push(new RegExp(value, 's'));
    } catch {
      onError?.(value);
    }
  }
  return compiled;
}

/** Merge user configuration over the shipped defaults. */
export function normalizeConfig(raw, onError) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const config = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof DEFAULT_CONFIG[key] === 'boolean') {
      if (typeof value === 'boolean') config[key] = value;
      continue;
    }
    if (Array.isArray(DEFAULT_CONFIG[key])) {
      config[key] = asStringArray(value);
    }
  }
  config.compiledAsk = compilePatterns(config.extraAskPatterns, onError);
  config.compiledAllow = compilePatterns(config.extraAllowPatterns, onError);
  return config;
}

function verdict(kind, scope, code, reason, zh, detail) {
  return {
    kind,
    scope,
    code,
    reason,
    zh,
    displayReason: { en: reason.replace(/^project guard:\s*/, ''), zh },
    detail,
    system: scope === 'system' || scope === 'unknown'
  };
}

/** Flags that consume the following token, so it is not a subcommand. */
const PACKAGE_VALUE_FLAGS = new Set([
  '--filter', '-F', '--dir', '-C', '--prefix', '--registry', '--workspace', '-w',
  '--cwd', '--store-dir', '--config', '--reporter', '--loglevel', '--tag'
]);

/** The subcommand of a package-manager invocation, skipping flags and values. */
function firstPackageSubcommand(args) {
  for (let index = 0; index < args.length; index += 1) {
    const entry = args[index];
    if (entry.startsWith('-')) {
      if (PACKAGE_VALUE_FLAGS.has(entry)) index += 1;
      continue;
    }
    return entry;
  }
  return undefined;
}

/** Extract a path candidate from one shell word, or `undefined`. */
export function pathCandidateFrom(rawWord) {
  if (typeof rawWord !== 'string' || rawWord.length === 0) return undefined;
  if (rawWord.startsWith('&') || rawWord.startsWith('#')) return undefined;

  let word = rawWord;
  if (word.startsWith('-')) {
    const equals = word.indexOf('=');
    if (equals !== -1) {
      word = word.slice(equals + 1);
    } else {
      const slash = word.indexOf('/');
      if (slash === -1) return undefined;
      word = word.slice(slash);
    }
  }
  const pathLike = word.startsWith('/') || word.startsWith('~') || word.startsWith('.') || word.includes('/');
  if (!pathLike) return undefined;
  return word;
}

/**
 * Build a policy engine.
 *
 * @param {object} rawConfig the plugin row configuration.
 * @param {{ warn?: (message: string) => void }} [logger] diagnostics sink.
 */
export function createPolicy(rawConfig, logger) {
  const config = normalizeConfig(rawConfig, (value) => logger?.warn?.(`project-guard: ignoring invalid pattern ${JSON.stringify(value)}`));
  const home = homedir();
  const tempRoots = config.includeTempDirs ? normalizeRoots([tmpdir(), '/tmp', '/var/tmp', '/private/tmp'], home) : [];

  const rootsFor = (cwd) => {
    const parts = [];
    if (config.includeSessionCwd && typeof cwd === 'string' && cwd.length > 0) parts.push(cwd);
    parts.push(...config.projectRoots);
    return normalizeRoots(parts, home);
  };

  const extraRootsFor = (cwd) => {
    const writeRoots = [...rootsFor(cwd), ...tempRoots];
    const readRoots = [...writeRoots, ...normalizeRoots(config.readOnlyRoots, home)];
    const extraWrite = writeRoots.filter((root) => !rootsFor(cwd).includes(root));
    return { writeRoots, readRoots, extraWrite, projectRoots: rootsFor(cwd) };
  };

  const contained = (candidate, roots) => isContained(candidate, roots, config.resolveSymlinks);

  const systemPrograms = new Set([...SYSTEM_PROGRAMS, ...asStringArray(config.systemCommands)]);

  /** Analyse one shell segment list. */
  const classifyShell = (args, cwd) => {
    const command = typeof args?.command === 'string' ? args.command : undefined;
    if (command === undefined) {
      return verdict('ask', 'unknown', 'NO_COMMAND', 'project guard: the shell call has no readable command string', '无法读取该 shell 命令，请确认是否执行。');
    }
    const { writeRoots, readRoots, projectRoots } = extraRootsFor(cwd);

    const workdir = typeof args?.workdir === 'string' && args.workdir.length > 0 ? args.workdir : undefined;
    const base = workdir === undefined ? cwd : toAbsolute(workdir, cwd, home);
    if (workdir !== undefined && !contained(base, writeRoots)) {
      return verdict(
        'ask', 'outside', 'WORKDIR_OUTSIDE',
        `project guard: workdir "${workdir}" is outside the project`,
        `工作目录 "${workdir}" 不在项目范围内，请确认。`,
        base
      );
    }

    const requested = typeof args?.sandbox_permissions === 'string' ? args.sandbox_permissions : undefined;

    const parsed = parseShellCommand(command);
    // Safety rules describe what the shell will run. Heredoc bodies are file
    // content the shell merely writes, so they must not trigger them.
    const code = parsed.codeText;

    // Literal-text refusals come first: they must also catch a command whose
    // payload is hidden inside quotes or an inline interpreter.
    if (config.protectSessionAndSystem) {
      for (const rule of HARD_DENY_PATTERNS) {
        if (rule.pattern.test(code)) {
          return verdict(
            'deny', 'system', rule.code,
            `project guard: refused to ${rule.label}; this would damage the machine or cut this session`,
            `已拒绝：该命令会${rule.label}，可能损坏系统或中断当前会话。`
          );
        }
      }
    }

    if (parsed.substitutions || parsed.uncertain) {
      if (!config.allowInlineCode) {
        return verdict(
          'ask', 'unknown', 'UNINSPECTABLE',
          `project guard: cannot inspect this command (${parsed.notes.join('; ') || 'unreadable syntax'})`,
          '该命令包含无法检查的替换或内联代码，请确认是否执行。',
          parsed.notes.join('; ')
        );
      }
    }
    if (parsed.unbalanced) {
      return verdict('ask', 'unknown', 'UNBALANCED', 'project guard: the command has unbalanced quotes', '命令引号不配对，无法确认其影响范围，请确认。');
    }

    for (const pattern of config.compiledAllow) {
      if (pattern.test(code)) {
        return verdict('allow', 'project', 'USER_ALLOW', 'project guard: allowed by an extra allow pattern', '项目守卫：命中额外放行规则。');
      }
    }

    for (const rule of SHARED_STATE_PATTERNS) {
      if (rule.pattern.test(code)) {
        return verdict(
          'ask', 'system', rule.code,
          `project guard: this command starts ${rule.label}, which other programs may be using`,
          `该命令会${rule.label}（可能与其他程序冲突），需要你确认。`
        );
      }
    }

    for (const pattern of config.compiledAsk) {
      if (pattern.test(code)) {
        return verdict('ask', 'system', 'USER_ASK', 'project guard: this command matches a user ask pattern', '该命令命中需要确认的规则，请确认。');
      }
    }

    for (const rule of RESOURCE_ABUSE_PATTERNS) {
      if (rule.pattern.test(code)) {
        return verdict(
          'ask', 'system', rule.code,
          `project guard: this command starts ${rule.label} and can stop other programs from working`,
          `该命令会${rule.label}，可能占满磁盘/CPU 并影响其他程序运行，需要你确认。`
        );
      }
    }

    for (const segment of parsed.segments) {
      const program = programOf(segment);
      if (program === undefined) continue;

      if (program.includes('/')) {
        const programPath = toAbsolute(program, base, home);
        if (!contained(programPath, readRoots)) {
          return verdict(
            'ask', 'outside', 'PROGRAM_OUTSIDE',
            `project guard: runs "${program}" from outside the project`,
            `程序 "${program}" 位于项目之外，请确认。`,
            programPath
          );
        }
        continue;
      }

      if (systemPrograms.has(program)) {
        return verdict(
          'ask', 'system', 'SYSTEM_COMMAND',
          `project guard: "${program}" changes or inspects machine state, which needs your confirmation`,
          `"${program}" 属于系统级调用，需要你确认。`,
          program
        );
      }

      if (NETWORK_PROGRAMS.has(program)) {
        return verdict(
          'ask', 'system', 'NETWORK_COMMAND',
          `project guard: "${program}" reaches outside this machine, which needs your confirmation`,
          `"${program}" 会访问外部网络，需要你确认。`,
          program
        );
      }

      const segmentArgs = argumentsOf(segment);

      if (PROJECT_PACKAGE_MANAGERS.has(program)) {
        const global = segmentArgs.find((entry) => GLOBAL_FLAGS.has(entry) || entry.startsWith('--prefix=') || entry.startsWith('--location='));
        if (global !== undefined) {
          return verdict(
            'ask', 'system', 'GLOBAL_INSTALL',
            `project guard: "${program} ${global}" installs outside the project`,
            `"${program} ${global}" 会安装到项目之外，需要你确认。`,
            global
          );
        }
        const sub = firstPackageSubcommand(segmentArgs);
        if (sub !== undefined && !PROJECT_PACKAGE_SUBCOMMANDS.has(sub)) {
          return verdict(
            'ask', 'system', 'PACKAGE_SUBCOMMAND',
            `project guard: "${program} ${sub}" touches shared state outside the project`,
            `"${program} ${sub}" 会影响项目之外的共享状态，需要你确认。`,
            sub
          );
        }
      }

      if (program === 'git') {
        const sub = segmentArgs.find((entry) => !entry.startsWith('-'));
        const remote = new Set(['push', 'pull', 'fetch', 'clone', 'remote', 'submodule', 'lfs', 'request-pull']);
        if (sub !== undefined && remote.has(sub)) {
          return verdict(
            'ask', 'system', 'GIT_REMOTE',
            `project guard: "git ${sub}" talks to a remote, which needs your confirmation`,
            `"git ${sub}" 会与远端交互，需要你确认。`,
            sub
          );
        }
        if (sub === 'config' && segmentArgs.some((entry) => entry === '--global' || entry === '--system')) {
          return verdict(
            'ask', 'system', 'GIT_GLOBAL_CONFIG',
            'project guard: "git config --global" changes machine-wide configuration',
            '"git config --global" 会修改全局配置，需要你确认。'
          );
        }
        continue;
      }

      if (FILE_PROGRAMS.has(program)) {
        const indirect = segmentArgs.find((entry) => entry.includes('$') || entry.includes('`'));
        if (indirect !== undefined) {
          return verdict(
            'ask', 'unknown', 'VARIABLE_PATH',
            `project guard: "${program}" uses the unresolved variable "${indirect}" as a path`,
            `"${program}" 使用了无法解析的变量 "${indirect}" 作为路径，请确认。`,
            indirect
          );
        }
      }

      for (const candidate of segmentArgs) {
        if (candidate.includes('$') || candidate.includes('`')) {
          const pathLike = candidate.includes('/') || candidate.startsWith('~') || candidate.startsWith('.');
          if (pathLike) {
            return verdict(
              'ask', 'unknown', 'VARIABLE_PATH',
              `project guard: "${candidate}" expands a variable into a path`,
              `"${candidate}" 展开为路径变量，请确认。`,
              candidate
            );
          }
        }
      }
    }

    for (const rawPath of parsed.paths) {
      const candidate = pathCandidateFrom(rawPath);
      if (candidate === undefined) continue;
      if (SAFE_DEVICE_TARGETS.has(candidate)) continue;
      if (candidate.startsWith('/dev/fd/')) continue;
      const absolute = toAbsolute(candidate, base, home);
      if (!contained(absolute, readRoots)) {
        return verdict(
          'ask', 'outside', 'PATH_OUTSIDE',
          `project guard: "${candidate}" is outside the project`,
          `路径 "${candidate}" 不在项目范围内，需要你确认。`,
          absolute
        );
      }
    }

    if (requested !== undefined && requested !== 'workspace-write' && requested !== 'read-only') {
      // An escalation for an in-project command is expected and auto-approved by
      // the approval listener; nothing else needs to happen here.
      return verdict('allow', 'project', 'PROJECT_ESCALATION', 'project guard: in-project command may escalate', '项目内命令允许提权执行。');
    }

    if (projectRoots.length === 0) {
      return verdict('ask', 'outside', 'NO_PROJECT_ROOT', 'project guard: the session has no resolvable project root', '未解析到项目根目录，请确认。');
    }

    return verdict('allow', 'project', 'PROJECT_COMMAND', 'project guard: the command stays inside the project', '项目内命令，自动放行。');
  };

  /** Analyse one file tool call. */
  const classifyPathTool = (tool, args, cwd, rule) => {
    const { writeRoots, readRoots, projectRoots } = extraRootsFor(cwd);
    const roots = rule.access === 'write' ? writeRoots : readRoots;
    if (projectRoots.length === 0) {
      return verdict('ask', 'outside', 'NO_PROJECT_ROOT', 'project guard: the session has no resolvable project root', '未解析到项目根目录，请确认。');
    }
    const values = [];
    for (const key of rule.args) {
      const value = args?.[key];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'string') {
        return verdict('ask', 'unknown', 'BAD_PATH_ARGUMENT', `project guard: "${tool}.${key}" is not a single path string`, `无法解析 ${tool} 的路径参数，请确认。`);
      }
      values.push(value);
    }
    if (values.length === 0) {
      // No path argument means the session workspace default.
      return verdict('allow', 'project', 'PROJECT_DEFAULT', 'project guard: defaults to the session workspace', '默认作用于会话工作目录，自动放行。');
    }
    for (const value of values) {
      const absolute = toAbsolute(value, cwd, home);
      if (!contained(absolute, roots)) {
        return verdict(
          'ask', 'outside', 'PATH_OUTSIDE',
          `project guard: "${tool}" targets "${value}" outside the project`,
          `${rule.access === 'write' ? '写入' : '读取'}路径 "${value}" 不在项目范围内，需要你确认。`,
          absolute
        );
      }
    }
    return verdict('allow', 'project', 'PROJECT_PATH', `project guard: "${tool}" stays inside the project`, '项目内路径，自动放行。');
  };

  /**
   * Classify one pending call.
   *
   * @param {{tool: string, args: unknown, cwd: string}} input
   */
  const decide = ({ tool, args, cwd }) => {
    if (!config.enabled) return verdict('allow', 'project', 'DISABLED', 'project guard: disabled', '项目守卫已禁用。');

    const denyTools = new Set(asStringArray(config.denyTools));
    if (denyTools.has(tool)) {
      return verdict('deny', 'system', 'DENY_TOOL', `project guard: "${tool}" is denied by configuration`, `"${tool}" 已被配置为禁止调用。`);
    }

    const userAllow = new Set(asStringArray(config.allowTools));
    const userAsk = new Set(asStringArray(config.askTools));
    const allowTools = new Set([...DEFAULT_ALLOW_TOOLS, ...userAllow]);
    const askTools = new Set([...DEFAULT_ASK_TOOLS, ...userAsk]);

    if (SHELL_TOOLS.has(tool)) {
      return classifyShell(args, cwd);
    }
    if (PATH_TOOLS[tool] !== undefined) {
      return classifyPathTool(tool, args, cwd, PATH_TOOLS[tool]);
    }
    if (userAsk.has(tool)) {
      return verdict('ask', 'system', 'ASK_TOOL', `project guard: "${tool}" is configured to require confirmation`, `"${tool}" 已配置为需要你确认。`);
    }
    if (userAllow.has(tool)) {
      return verdict('allow', 'project', 'NEUTRAL_TOOL', `project guard: "${tool}" is configured as a safe tool`, `"${tool}" 已配置为安全工具，自动放行。`);
    }
    if (allowTools.has(tool)) {
      return verdict('allow', 'project', 'NEUTRAL_TOOL', `project guard: "${tool}" is a session or read-only tool`, `"${tool}" 为会话内/只读工具，自动放行。`);
    }
    if (askTools.has(tool)) {
      return verdict('ask', 'system', 'ASK_TOOL', `project guard: "${tool}" reaches outside the session or the project`, `"${tool}" 属于对外/系统级工具，需要你确认。`);
    }
    return verdict('ask', 'unknown', 'UNKNOWN_TOOL', `project guard: "${tool}" is not classified yet, so it needs your confirmation`, `未知工具 "${tool}"，需要你确认。`);
  };

  /**
   * Classify one call and attach the consequence analysis the prompt shows.
   *
   * @param {{tool: string, args: unknown, cwd: string}} input
   */
  const classify = (input) => {
    const decision = decide(input);
    return { ...decision, impact: describeImpact(decision) };
  };

  return {
    config,
    classify,
    rootsFor,
    /** Human-readable scope, used by the log line and the README. */
    describe: (cwd) => {
      const { writeRoots, readRoots } = extraRootsFor(cwd);
      return { writeRoots, readRoots, tempRoots, protectedActions: HARD_DENY_PATTERNS.map((rule) => rule.label) };
    }
  };
}

/** Re-exported for the test suite and for the README's rule table. */
export {
  HARD_DENY_PATTERNS,
  NETWORK_PROGRAMS,
  PATH_TOOLS,
  PROJECT_PACKAGE_MANAGERS,
  PROJECT_PACKAGE_SUBCOMMANDS,
  RESOURCE_ABUSE_PATTERNS,
  SHARED_STATE_PATTERNS,
  SHELL_TOOLS,
  SYSTEM_PROGRAMS
};
