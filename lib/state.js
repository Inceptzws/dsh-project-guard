/**
 * State collectors — rule family 2 of the consequence rule system.
 *
 * The system only sees a partial state Ŝ(t) produced by collectors with a
 * declared scope K (paper §3.1). Every collector therefore reports what it did
 * and did not look at, and the disclosure always carries that scope line: a
 * consequence is only as trustworthy as the state it was computed from.
 *
 * Collectors run only for the rules that matched the action, which is the data
 * minimization principle of §6.4: no action, no collection.
 *
 * @module dsh-project-guard/lib/state
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** Suffixes a user or tool commonly leaves next to a file. */
const BACKUP_SUFFIXES = ['.bak', '.backup', '.orig', '.old', '.save', '~'];
/** Longest a single collector may take. */
const COLLECTOR_TIMEOUT_MS = 900;
/** Longest output we keep from a collector command. */
const MAX_OUTPUT = 8 * 1024;

/** Run one bounded read-only command. */
function run(command, args, options = {}) {
  try {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? COLLECTOR_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }
    });
    if (result.error !== undefined && result.error !== null) {
      return { ok: false, reason: result.error.code ?? 'spawn-failed', stdout: '' };
    }
    return { ok: true, code: result.status, stdout: (result.stdout ?? '').slice(0, MAX_OUTPUT) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), stdout: '' };
  }
}

/** Parse `7d`, `30m`, `12h`, `500ms` into milliseconds. */
export function parseDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/.exec(String(value ?? '').trim());
  if (match === null) return undefined;
  const amount = Number(match[1]);
  const unit = match[2] ?? 'ms';
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit];
  return amount * factor;
}

/** The directory a git command should run in for one target. */
function gitCwd(target, cwd, home) {
  const raw = typeof target === 'string' && target.length > 0 ? target : cwd;
  const expanded = typeof raw === 'string' && raw.startsWith('~') ? join(home, raw.slice(2)) : raw;
  const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded ?? '.');
  try {
    const stat = statSync(absolute);
    return stat.isDirectory() ? absolute : dirname(absolute);
  } catch {
    return dirname(absolute);
  }
}

/** The absolute form of one target, for path checks. */
function absoluteTarget(target, cwd, home) {
  if (typeof target !== 'string' || target.length === 0) return resolve(cwd);
  const expanded = target.startsWith('~') ? join(home, target.slice(2)) : target;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/**
 * Build the collector table.
 *
 * @param {{home: string, cwd: string, projectRoots: string[], isUnder: (path: string, root: string) => boolean, insideProject: (path: string) => boolean}} context
 */
export function createCollectors(context) {
  const { home, projectRoots, insideProject } = context;

  /** Declared scope of every collector, used for the coverage line. */
  const scopes = {
    'vcs.uncommitted': 'version control status of the containing repository',
    'vcs.tracked': 'version control index of the containing repository',
    'backup.exists': 'backup files next to the target, and version control',
    'path.exists': 'the target path only',
    'process.running': 'processes of the same user',
    'service.dependents': 'processes of the same user',
    'path.system_root': 'the target path only',
    'path.is_build_artifact': 'the target path only',
    'credential.sensitive': 'the target path only',
    'path.shared_resource': 'the target path only',
    'data.regulated': 'the target path only',
    'path.exists': 'the target path only'
  };

  return {
    scopes,

    /** Whether a path has uncommitted changes, or null when unknown. */
    'vcs.uncommitted'(target) {
      const dir = gitCwd(target, context.cwd, home);
      const tracked = run('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree']);
      if (!tracked.ok || tracked.code !== 0) return { value: null, confidence: 0, detail: 'not inside a version-controlled tree' };
      const status = run('git', ['-C', dir, 'status', '--porcelain', '--', target ?? '.']);
      if (!status.ok || status.code !== 0) return { value: null, confidence: 0, detail: 'git status failed' };
      const porcelain = status.stdout.trim();
      const dirty = porcelain.length > 0;
      return { value: dirty, fingerprint: porcelain, confidence: 0.9, detail: dirty ? 'uncommitted modifications found' : 'working tree clean for the target' };
    },

    /** Whether a path is tracked by version control, or null when unknown. */
    'vcs.tracked'(target) {
      const dir = gitCwd(target, context.cwd, home);
      const listed = run('git', ['-C', dir, 'ls-files', '--error-unmatch', '--', target ?? '.']);
      if (!listed.ok) return { value: null, confidence: 0, detail: 'git unavailable' };
      return { value: listed.code === 0, fingerprint: `tracked:${listed.code === 0}`, confidence: 0.9, detail: listed.code === 0 ? 'tracked' : 'not tracked' };
    },

    /** Whether a recent recoverable copy exists, or null when unknown. */
    'backup.exists'(target, params = {}) {
      const maxAge = parseDuration(params.max_age) ?? parseDuration('7d');
      const absolute = absoluteTarget(target, context.cwd, home);
      const directory = existsSync(absolute) && statSync(absolute).isDirectory() ? absolute : dirname(absolute);
      const name = basename(absolute);
      const cutoff = Date.now() - maxAge;
      let found = undefined;
      try {
        for (const entry of readdirSync(directory)) {
          const candidate = isBackupEntry(entry, name) ? join(directory, entry) : undefined;
          if (candidate === undefined) continue;
          try {
            if (statSync(candidate).mtimeMs >= cutoff) {
              found = entry;
              break;
            }
          } catch {
            // unreadable candidate: ignore, the scope line says what was checked
          }
        }
      } catch {
        return { value: null, confidence: 0, detail: 'target directory not readable' };
      }
      if (found !== undefined) return { value: true, fingerprint: `backup:${found}`, confidence: 0.8, detail: `recent backup next to target: ${found}` };

      // Version control is a recoverable copy even when it is not a "backup".
      const dir = gitCwd(target, context.cwd, home);
      const tracked = run('git', ['-C', dir, 'ls-files', '--error-unmatch', '--', target ?? '.']);
      if (tracked.ok && tracked.code === 0) {
        const status = run('git', ['-C', dir, 'status', '--porcelain', '--', target ?? '.']);
        const clean = status.ok && status.code === 0 && status.stdout.trim().length === 0;
        if (clean) return { value: true, fingerprint: 'vcs:clean', confidence: 0.7, detail: 'tracked and clean, so recoverable from version control' };
        return { value: false, fingerprint: 'vcs:dirty', confidence: 0.7, detail: 'tracked but dirty: the current contents are not in history' };
      }
      return { value: false, fingerprint: 'none', confidence: 0.6, detail: 'no backup file and no version control copy found' };
    },

    /** Whether the target is generated output or a cache, where loss is expected. */
    'path.is_build_artifact'(target) {
      if (typeof target !== 'string' || target.length === 0) return { value: null, confidence: 0, detail: 'no path target' };
      const absolute = absoluteTarget(target, context.cwd, home);
      const generated = ['node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache',
        'target', 'coverage', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', 'vendor', '.gradle', '.tox'];
      const parts = absolute.split('/').filter(Boolean);
      const hit = parts.find((part) => generated.includes(part));
      const suffix = /\.(log|tmp|temp|o|obj|pyc|class|cache)$/.test(absolute);
      return {
        value: hit !== undefined || suffix,
        fingerprint: `generated:${hit ?? (suffix ? 'suffix' : 'no')}`,
        confidence: 0.8,
        detail: hit !== undefined ? `inside ${hit}/` : suffix ? 'generated file type' : 'not generated output'
      };
    },

    /** Whether the target is a credential store or a secret. */
    'credential.sensitive'(target) {
      if (typeof target !== 'string' || target.length === 0) return { value: null, confidence: 0, detail: 'no path target' };
      const absolute = absoluteTarget(target, context.cwd, home);
      const patterns = [
        /(^|\/)\.ssh\//, /(^|\/)\.aws\//, /(^|\/)\.gnupg\//, /(^|\/)\.kube\/config$/,
        /(^|\/)\.config\/gcloud\//, /(^|\/)\.docker\/config\.json$/, /(^|\/)\.git-credentials$/,
        /(^|\/)\.netrc$/, /(^|\/)\.npmrc$/, /(^|\/)\.pypirc$/, /(^|\/)\.env(\.|$)/,
        /(^|\/)\.config\/gh\/hosts\.yml$/, /(^|\/)\.config\/git\/credentials$/, /login\.keychain/,
        /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, /(^|\/)[^/]+\.(pem|key|p12|pfx)$/,
        /(^|\/)secrets?\.(json|ya?ml|txt)$/, /(^|\/)credentials(\.json)?$/, /(^|\/)token(s)?\.(json|txt)$/
      ];
      const hit = patterns.find((pattern) => pattern.test(absolute));
      return {
        value: hit !== undefined,
        fingerprint: `secret:${hit !== undefined}`,
        confidence: 0.85,
        detail: hit === undefined ? 'not a credential store or key file' : 'target is a credential store or key file'
      };
    },

    /** Whether the target is shared with other people. */
    'path.shared_resource'(target) {
      if (typeof target !== 'string' || target.length === 0) return { value: null, confidence: 0, detail: 'no path target' };
      const absolute = absoluteTarget(target, context.cwd, home);
      const shared = /^\/Users\/Shared(\/|$)|^\/Volumes\/[^/]+\/Shared(\/|$)|^\/Users\/[^/]+\/Public(\/|$)|^\/(srv|var\/www)(\/|$)/.test(absolute);
      return {
        value: shared,
        fingerprint: `shared:${shared}`,
        confidence: 0.8,
        detail: shared ? 'target is shared with other people' : 'not a shared location'
      };
    },

    /** Whether the target looks like regulated or protected data. */
    'data.regulated'(target) {
      if (typeof target !== 'string' || target.length === 0) return { value: null, confidence: 0, detail: 'no path target' };
      const absolute = absoluteTarget(target, context.cwd, home);
      const hit = /patient|medical|health|hipaa|clinical|student|pupil|employee|payroll|salary|tax|ssn|passport|gdpr|personal[_-]?data|customers?|clients?|invoices?|ledger|medical|diagnos/i.test(absolute);
      return {
        value: hit,
        fingerprint: `regulated:${hit}`,
        confidence: 0.5,
        detail: hit ? 'path suggests regulated or protected data' : 'path does not suggest regulated data'
      };
    },

    /** Whether the target is a filesystem root or the user's home directory. */
    'path.system_root'(target) {
      if (typeof target !== 'string' || target.length === 0) return { value: null, confidence: 0, detail: 'no path target' };
      const absolute = absoluteTarget(target, context.cwd, home);
      const roots = ['/', '/System', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/Applications', '/Library', '/dev', '/Volumes', home];
      const hit = roots.find((root) => absolute === root || absolute === `${root}/`);
      return {
        value: hit !== undefined,
        fingerprint: `system_root:${hit ?? 'no'}`,
        confidence: 0.95,
        detail: hit === undefined ? 'not a filesystem root' : `target is ${hit === home ? 'the home directory' : hit}`
      };
    },

    /** Whether the path exists. */
    'path.exists'(target) {
      const present = existsSync(absoluteTarget(target, context.cwd, home));
      return { value: present, fingerprint: `exists:${present}`, confidence: 0.95, detail: 'checked with stat' };
    },

    /** Whether a process matching the target runs under this user. */
    'process.running'(target) {
      if (typeof target !== 'string' || target.length === 0) return { value: null, confidence: 0, detail: 'no process target' };
      const result = run('pgrep', ['-f', '--', target]);
      if (!result.ok) return { value: null, confidence: 0, detail: 'pgrep unavailable' };
      const running = result.stdout.trim().length > 0;
      return { value: running, fingerprint: `running:${running}`, confidence: 0.7, detail: running ? 'matching process is running' : 'no matching process' };
    },

    /** How many processes mention the service name. */
    'service.dependents'(target) {
      if (typeof target !== 'string' || target.length === 0) return { value: null, confidence: 0, detail: 'no service target' };
      const result = run('pgrep', ['-fl', '--', target]);
      if (!result.ok) return { value: null, confidence: 0, detail: 'pgrep unavailable' };
      const count = result.stdout.split('\n').filter((line) => line.trim().length > 0).length;
      return { value: count, confidence: 0.5, detail: `${count} process(es) mention ${target}` };
    },

    /** Whether the action's target resolves outside every configured project root. */
    'scope.outside_project'(target) {
      if (typeof target !== 'string' || target.length === 0) return { value: null, confidence: 0, detail: 'no path target' };
      const absolute = absoluteTarget(target, context.cwd, home);
      return { value: !insideProject(absolute), confidence: 0.9, detail: insideProject(absolute) ? 'inside a project root' : 'outside every project root' };
    },

    /** Trivially true, for rules that need no state. */
    'always'() {
      return { value: true, confidence: 1, detail: 'no state required' };
    },

    /** The plugin's own view of the project roots, for the coverage line. */
    projectRoots: [...projectRoots]
  };
}

/** Whether a directory entry looks like a backup copy of `name`. */
function isBackupEntry(entry, name) {
  if (entry === name) return false;
  if (entry === `${name}~`) return true;
  if (entry.startsWith(`${name}.`) && BACKUP_SUFFIXES.some((suffix) => entry.endsWith(suffix))) return true;
  if (entry.startsWith(`${name}.`) && /\.(bak|backup|orig|old|save)\d*$/.test(entry)) return true;
  return BACKUP_SUFFIXES.some((suffix) => entry === `${name}${suffix}`);
}
