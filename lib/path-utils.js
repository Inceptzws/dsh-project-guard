/**
 * Path containment helpers for the project guard.
 *
 * Every helper here is deliberately conservative: a path counts as "inside the
 * project" only when both its lexical form and its symlink-resolved form stay
 * under one of the configured roots. Anything undecidable resolves to
 * "outside", which the caller turns into a human confirmation.
 *
 * Node built-ins only: this package declares no dependencies and must keep
 * loading even when the profile installs it without a lockfile.
 *
 * @module dsh-project-guard/lib/path-utils
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';

/** Fold path case on platforms whose default filesystem is case-insensitive. */
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

/** Expand a leading `~` to the home directory. */
export function expandHome(value, home = homedir()) {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (value === '~') return home;
  if (value.startsWith('~/')) return join(home, value.slice(2));
  return value;
}

/** Resolve one user-supplied path against a base directory. */
export function toAbsolute(value, base, home = homedir()) {
  const expanded = expandHome(value, home);
  return isAbsolute(expanded) ? normalize(expanded) : resolve(base, expanded);
}

function key(value) {
  const normalized = normalize(value);
  return CASE_INSENSITIVE ? normalized.toLowerCase() : normalized;
}

/** Whether `child` is `root` itself or lives below it, after lexical folding. */
export function isUnder(child, root) {
  const c = key(child);
  const r = key(root);
  if (c === r) return true;
  const rel = relative(r, c);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Resolve the real path of `value`, falling back to the real path of its
 * deepest existing ancestor when the tail does not exist yet. A path that
 * cannot be resolved at all is returned normalized and unchanged.
 */
export function realPrefix(value) {
  const tail = [];
  let current = resolve(value);
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(value);
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Whether `value` stays inside at least one root, checking both the lexical
 * path and its symlink-resolved form. `resolveSymlinks: false` keeps the
 * lexical check only.
 */
export function isContained(value, roots, resolveSymlinks = true) {
  if (!Array.isArray(roots) || roots.length === 0) return false;
  const candidates = resolveSymlinks ? [normalize(value), realPrefix(value)] : [normalize(value)];
  for (const root of roots) {
    if (typeof root !== 'string' || root.length === 0) continue;
    const targets = resolveSymlinks ? [normalize(root), realPrefix(root)] : [normalize(root)];
    for (const candidate of candidates) {
      for (const target of targets) {
        if (isUnder(candidate, target)) return true;
      }
    }
  }
  return false;
}

/** Deduplicate and normalize a list of root directories. */
export function normalizeRoots(values, home = homedir()) {
  const seen = new Set();
  const roots = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    const absolute = toAbsolute(value.trim(), process.cwd(), home);
    const folded = key(absolute);
    if (seen.has(folded)) continue;
    seen.add(folded);
    roots.push(absolute);
  }
  return roots;
}
