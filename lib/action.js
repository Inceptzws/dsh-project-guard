/**
 * Action normalizer — rule family 1 of the consequence rule system.
 *
 * Turns a raw Harness tool call into a typed action with a target, so that no
 * consequence rule ever depends on a particular agent or tool name. This is the
 * `analyze(action, context)` input described in section 4.6 of the paper.
 *
 * @module dsh-project-guard/lib/action
 */
import { argumentsOf, parseShellCommand, programOf } from './shell-parse.js';

/** File tools that replace the contents of one path. */
const OVERWRITE_TOOLS = new Set(['write', 'edit', 'notebook_edit']);
/** File tools that only read. */
const READ_TOOLS = new Set(['read', 'read_image', 'glob', 'grep']);
/** Tools that hand work to another agent. */
const DELEGATE_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow', 'spawn_teammate', 'send_message', 'team_task_create']);
/** Tools that change the Harness configuration or its future behaviour. */
const CONFIG_TOOLS = new Set(['plugin_manager', 'schedule_create', 'schedule_update', 'schedule_delete']);
/** Tools whose body is code the analyzer cannot read. */
const OPAQUE_TOOLS = new Set(['run_code']);

/** Programs grouped by the action they normalize to. */
const SHELL_ACTIONS = [
  { type: 'fs.delete', programs: ['rm', 'rmdir', 'unlink', 'shred'] },
  { type: 'fs.move', programs: ['mv'] },
  { type: 'fs.copy', programs: ['cp', 'ditto'] },
  { type: 'process.kill', programs: ['kill', 'killall', 'pkill', 'skill'] },
  { type: 'service.change', programs: ['launchctl', 'systemctl', 'service'] },
  { type: 'network.change', programs: ['networksetup', 'ifconfig', 'ip', 'ifconfig', 'route', 'pfctl', 'nmcli', 'wireless', 'airport', 'wg', 'wg-quick'] },
  { type: 'network.egress', programs: ['curl', 'wget', 'nc', 'netcat', 'ncat', 'telnet', 'ssh', 'scp', 'sftp', 'rsync', 'socat', 'gh', 'glab', 'aws', 'gcloud', 'az', 'doctl', 'heroku', 'fly', 'flyctl', 'vercel', 'netlify', 'wrangler', 'kubectl', 'docker', 'podman', 'terraform', 'ansible'] },
  { type: 'disk.change', programs: ['mkfs', 'newfs', 'fdisk', 'gpt', 'diskutil', 'asr', 'fsck', 'hdiutil', 'bless', 'kextload', 'kextutil', 'kmutil', 'firmwarepasswd', 'nvram'] },
  { type: 'power.change', programs: ['shutdown', 'reboot', 'halt', 'pmset'] },
  { type: 'package.install', programs: ['brew', 'port', 'mas', 'pip', 'pip3', 'conda', 'mamba', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'rpm', 'dpkg', 'snap', 'flatpak'] },
  { type: 'config.change', programs: ['defaults', 'systemsetup', 'scutil', 'csrutil', 'spctl', 'sysctl', 'mdutil', 'socketfilterfw', 'security'] },
  { type: 'resource.exhaust', programs: ['stress', 'stress-ng'] },
  { type: 'exec.uninspectable', programs: ['xargs'] }
];

/** Process names whose termination destabilises the machine. */
const CORE_PROCESSES = new Set([
  'windowserver', 'launchd', 'loginwindow', 'finder', 'dock', 'systemuiserver',
  'mdnsresponder', 'configd', 'coreaudiod', 'cfprefsd', 'kernel_task'
]);

/** Programs whose first path argument is written rather than read. */
const WRITE_PROGRAMS = new Set(['tee', 'truncate', 'dd', 'mkfile', 'fallocate', 'sed', 'mktemp']);

/** Shell programs that carry inline code. */
const INLINE_CODE_PROGRAMS = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'python', 'python2', 'python3',
  'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'osascript', 'swift', 'julia', 'eval', 'source', '.'
]);

/** First argument that is not a flag. */
function firstArgument(args) {
  return args.find((entry) => !entry.startsWith('-'));
}

/** Program name without any directory prefix. */
function baseName(value) {
  return value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value;
}

/** Whether one shell program asks for global scope. */
function isGlobalInstall(program, args) {
  if (['pip', 'pip3', 'conda', 'mamba', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'rpm', 'dpkg', 'snap', 'flatpak', 'brew', 'port', 'mas'].includes(program)) return true;
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(program)) {
    return args.some((entry) => entry === '-g' || entry.startsWith('--global') || entry.startsWith('--location=global'));
  }
  return false;
}

/** Build a typed action from one shell command. */
function fromShell(command, cwd) {
  const parsed = parseShellCommand(command);
  const segments = parsed.segments ?? [];
  const targets = [];
  const programs = [];
  const notes = [];

  for (const segment of segments) {
    const program = programOf(segment);
    if (program === undefined) continue;
    const name = baseName(program);
    const args = argumentsOf(segment);
    programs.push(name);

    // Inline code cannot be read, which is itself the consequence.
    if (parsed.substitutions || parsed.uncertain || parsed.unbalanced) {
      const flagged = INLINE_CODE_PROGRAMS.has(name) || parsed.substitutions;
      if (flagged) return finish('exec.uninspectable', 'command', program, [], { command, cwd, notes: parsed.notes });
    }

    // Bounded resource burning: unbounded writes, load tools, endless loops.
    if (/\bdd\b[^\n]*if=\/dev\/(zero|random|urandom)|\byes\b|\bcat\b[^\n]*\/dev\/(zero|random)|\bmkfile\b|\bfallocate\b|\bwhile\s+(true|:)\b/.test(command)) {
      return finish('resource.exhaust', 'resource', name, [], { command, cwd });
    }

    if (/\bpython[0-9.]*\s+-m\s+https?\.server|http-server|live-server|npx\s+serve|vite\s+preview\s+--host/.test(command)) {
      return finish('resource.exhaust', 'resource', 'port', [], { command, cwd });
    }

    if (name === 'dd' && /\bof=\/dev\//.test(command)) {
      return finish('disk.change', 'path', '/dev', [], { command, cwd });
    }
    if (name === 'diskutil' && /\b(eraseDisk|eraseVolume|reformat|zeroDisk|partitionDisk|secureErase)\b/.test(command)) {
      return finish('disk.change', 'path', 'disk', [], { command, cwd });
    }
    if (segment.redirects?.length > 0) {
      for (const target of segment.redirects) {
        if (target.startsWith('&') || target.startsWith('/dev/')) continue;
        return finish('fs.overwrite', 'path', target, [target], { command, cwd });
      }
    }

    if (WRITE_PROGRAMS.has(name)) {
      if (name === 'sed' && !args.some((entry) => entry === '-i' || entry.startsWith('-i'))) continue;
      const target = firstArgument(args.filter((entry) => !entry.startsWith('-')));
      if (target !== undefined) return finish('fs.overwrite', 'path', target, [target], { command, cwd });
    }

    if (name === 'find' && args.includes('-delete')) {
      const target = firstArgument(args);
      return finish('fs.delete', 'path', target ?? cwd, [target ?? cwd], { command, cwd });
    }

    if (name === 'git') {
      const sub = firstArgument(args);
      if (sub === 'push' || sub === 'fetch' || sub === 'pull' || sub === 'clone') {
        return finish('network.egress', 'network', 'git', [], { command, cwd });
      }
      continue;
    }

    if (['npm', 'pnpm', 'yarn', 'bun'].includes(name) && args.includes('publish')) {
      return finish('network.egress', 'network', name, [], { command, cwd });
    }

    if (isGlobalInstall(name, args)) {
      const sub = firstArgument(args);
      if (['install', 'i', 'add', 'upgrade', 'update', 'global'].includes(sub) || name !== 'brew') {
        return finish('package.install', 'package', name, [], { command, cwd, notes: [sub].filter(Boolean) });
      }
    }

    if (['killall', 'pkill'].includes(name)) {
      const target = firstArgument(args) ?? '';
      if (/DeepSeek\s*Harness/i.test(command)) return finish('session.kill', 'session', 'harness', [], { command, cwd });
      if (CORE_PROCESSES.has(String(target).toLowerCase())) return finish('process.kill', 'process', target, [], { command, cwd, core: true });
      return finish('process.kill', 'process', target, [], { command, cwd });
    }
    if (name === 'kill') {
      const target = firstArgument(args) ?? '';
      return finish('process.kill', 'process', target, [], { command, cwd, init: target === '1' });
    }

    for (const group of SHELL_ACTIONS) {
      // `mkfs.ext4`, `newfs_apfs` and friends carry a suffix; match the family.
      if (!group.programs.some((program) => program === name || name.startsWith(`${program}.`) || name.startsWith(`${program}_`))) continue;
      const target = firstArgument(args) ?? name;
      for (const entry of args) {
        if (entry.startsWith('-')) continue;
        if (entry.includes('/') || entry.startsWith('~') || entry.startsWith('.')) targets.push(entry);
      }
      return finish(group.type, kindFor(group.type), target, targets, { command, cwd });
    }
  }

  const program = programs.at(-1) ?? '';
  return finish('exec.generic', 'command', program, targets, { command, cwd, notes });
}

/** Target kind for one shell action type. */
function kindFor(type) {
  switch (type) {
    case 'fs.delete':
    case 'fs.move':
    case 'fs.copy':
    case 'fs.overwrite':
    case 'fs.read':
    case 'disk.change':
      return 'path';
    case 'process.kill':
      return 'process';
    case 'service.change':
      return 'service';
    case 'network.change':
    case 'network.egress':
      return 'network';
    case 'package.install':
      return 'package';
    case 'resource.exhaust':
      return 'resource';
    case 'session.kill':
      return 'session';
    case 'agent.spawn':
      return 'agent';
    case 'api.spend':
      return 'quota';
    default:
      return 'command';
  }
}

/** Compose the normalized action value. */
function finish(type, targetKind, target, targets, extra = {}) {
  return {
    type,
    targetKind,
    target: target === undefined || target === '' ? undefined : String(target),
    targets: [...new Set(targets.filter((entry) => typeof entry === 'string' && entry.length > 0))],
    ...extra
  };
}

/**
 * Normalize one pending tool call.
 *
 * @param {{tool: string, args: unknown, cwd: string}} input
 * @returns {{type: string, targetKind: string, target?: string, targets: string[], command?: string, cwd: string, core?: boolean, init?: boolean}}
 */
export function normalizeAction({ tool, args, cwd }) {
  if (typeof tool !== 'string' || tool.length === 0) return finish('exec.generic', 'command', undefined, [], { cwd });

  if (DELEGATE_TOOLS.has(tool)) return finish('agent.spawn', 'agent', tool, [], { cwd });
  if (OPAQUE_TOOLS.has(tool)) return finish('exec.uninspectable', 'command', tool, [], { cwd });
  if (CONFIG_TOOLS.has(tool)) return finish('config.change', 'command', tool, [], { cwd });
  if (READ_TOOLS.has(tool)) return finish('fs.read', 'path', args?.file_path ?? args?.path, [], { cwd });
  if (OVERWRITE_TOOLS.has(tool)) {
    const target = typeof args?.file_path === 'string' ? args.file_path : undefined;
    return finish('fs.overwrite', 'path', target, target === undefined ? [] : [target], { cwd });
  }

  if (tool === 'bash' || tool === 'shell' || tool === 'sh' || tool === 'pwsh' || tool === 'powershell' || tool === 'cmd') {
    const command = typeof args?.command === 'string' ? args.command : undefined;
    if (command === undefined) return finish('exec.generic', 'command', tool, [], { cwd });
    const action = fromShell(command, cwd);
    if (typeof args.workdir === 'string' && args.workdir.length > 0) action.workdir = args.workdir;
    return action;
  }

  return finish('exec.generic', 'command', tool, [], { cwd });
}

/** Exported for the rule set's action vocabulary documentation and tests. */
export { CORE_PROCESSES, INLINE_CODE_PROGRAMS, isGlobalInstall };
