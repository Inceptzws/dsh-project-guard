/**
 * Disclosure engine — wires the six rule families into the two modes of the
 * informed-execution framework (paper §6.1 architecture):
 *
 *   action normalizer -> state collectors -> rule engine -> relevance selection
 *     -> preview            (before a decision)
 *     -> post-state collectors -> report   (after execution)
 *
 * It is deliberately small and shares the plugin's zero-dependency rule: the
 * analysis path is deterministic table lookup, with no model call anywhere.
 *
 * @module dsh-project-guard/lib/engine
 */
import { homedir } from 'node:os';

import { normalizeAction } from './action.js';
import { renderPreview, renderReport } from './disclosure.js';
import { createInterestProfile } from './interest.js';
import { appendRecord, buildReport, defaultRecordPath, observeAfterExecution, toRecord } from './report.js';
import { analyzeAction, defaultRulePath, readRuleSet } from './rules.js';
import { selectConsequences } from './select.js';
import { createCollectors } from './state.js';
import { isContained } from './path-utils.js';

/** How long one collector result may be reused inside the pre-decision path. */
const COLLECTOR_CACHE_MS = 1500;

/** Wrap a collector table so repeated pre-decision checks stay cheap. */
function withCache(collectors, ttlMs) {
  const cache = new Map();
  const wrapped = { scopes: collectors.scopes, projectRoots: collectors.projectRoots };
  for (const [key, value] of Object.entries(collectors)) {
    if (typeof value !== 'function') continue;
    wrapped[key] = (target, params = {}) => {
      const cacheKey = `${key}\u0000${target ?? ''}\u0000${JSON.stringify(params)}`;
      const hit = cache.get(cacheKey);
      const now = Date.now();
      if (hit !== undefined && now - hit.at <= ttlMs) return hit.value;
      const value2 = value(target, params);
      cache.set(cacheKey, { at: now, value: value2 });
      if (cache.size > 256) cache.clear();
      return value2;
    };
  }
  return wrapped;
}

/**
 * Build the engine.
 *
 * @param {{policy: object, warn?: (message: string) => void, log?: (message: string) => void}} input
 */
export function createDisclosureEngine({ policy, warn, log }) {
  const config = policy.config;
  let loaded;
  try {
    loaded = readRuleSet(config.rulesFile.length > 0 ? config.rulesFile : defaultRulePath());
  } catch (error) {
    loaded = { version: 0, rules: [], problems: [error instanceof Error ? error.message : String(error)] };
  }
  for (const problem of loaded.problems) warn?.(`project-guard: rule set: ${problem}`);
  const actionTypes = new Set(loaded.rules.map((rule) => rule?.action?.type).filter((type) => typeof type === 'string'));
  log?.(`project-guard: ${loaded.rules.length} consequence rules loaded (${actionTypes.size} action types)`);

  /** Per-session state: collectors and interest profile depend on the workspace. */
  const sessions = new WeakMap();

  const contextFor = (session, cwd) => {
    let cached = sessions.get(session);
    if (cached !== undefined && cached.cwd === cwd) return cached;

    const home = homedir();
    const roots = policy.rootsFor(cwd);
    const insideProject = (path) => roots.some((root) => isContained(path, [root], config.resolveSymlinks));
    const collectors = createCollectors({ home, cwd, projectRoots: roots, insideProject });
    const cache = withCache(collectors, COLLECTOR_CACHE_MS);

    // Contextual and behavioral signals for the interest profile (paper §4.3).
    const vcsCheck = collectors['vcs.uncommitted'](cwd);
    const interest = createInterestProfile({
      config,
      cwd,
      signals: {
        vcs: vcsCheck.value !== null,
        dependencies: false,
        backups: false
      }
    });
    cached = { cwd, collectors, cache, interest, home };
    sessions.set(session, cached);
    return cached;
  };

  return {
    ruleSet: loaded,
    actionTypes,

    /**
     * Analyze one pending call. Returns undefined when no rule speaks about this
     * kind of action, which is the cheap and common case.
     */
    analyze({ tool, args, cwd, session }) {
      const action = normalizeAction({ tool, args, cwd });
      if (!actionTypes.has(action.type)) return undefined;
      const context = contextFor(session, cwd);
      const result = analyzeAction({ ruleSet: loaded, collectors: context.cache, interest: context.interest }, action);
      if (result.consequences.length === 0) {
        return { action, selected: [], coverage: { checked: result.checkedScope, unverified: result.undecided, weights: context.interest.describe(), dropped: 0 }, observations: result.observations, interest: context.interest };
      }
      const selection = selectConsequences({
        consequences: result.consequences,
        interest: context.interest,
        budget: config.attentionBudget,
        threshold: config.relevanceThreshold,
        undecided: result.undecided,
        checkedScope: result.checkedScope
      });
      return {
        action,
        selected: selection.selected,
        coverage: selection.coverage,
        observations: result.observations,
        interest: context.interest,
        highestSeverity: selection.highestSeverity
      };
    },

    /** Render the pre-decision block, in both languages when asked. */
    preview(analysis, language = 'zh') {
      if (analysis === undefined || analysis.selected.length === 0) return undefined;
      return renderPreview(analysis, { lang: language });
    },

    /**
     * Observe an executed action and produce the report. Never throws: a failing
     * report must not break the tool call it describes.
     */
    report({ analysis, cwd, session, sessionId }) {
      if (analysis === undefined) return undefined;
      // Unsolicited notices are expensive: only a material consequence earns one.
      const order = ['low', 'medium', 'high'];
      const floor = order.indexOf(config.reportMinSeverity ?? 'high');
      const selected = analysis.selected.filter((entry) => order.indexOf(entry.severity) >= floor);
      if (selected.length === 0) return undefined;
      try {
        const context = contextFor(session, cwd);
        const post = observeAfterExecution({ observations: analysis.observations ?? [], collectors: context.collectors });
        const recordPath = defaultRecordPath(cwd, config.reportDir);
        const built = buildReport({
          action: analysis.action,
          selected,
          post,
          observations: analysis.observations ?? [],
          coverage: analysis.coverage
        });
        const record = toRecord(built, { session: sessionId });
        const written = appendRecord(recordPath, record);
        const rendered = renderReport({ ...built, recordPath: written }, { lang: 'zh' });
        return rendered === undefined ? undefined : { rendered, record, recordPath: written };
      } catch (error) {
        warn?.(`project-guard: report failed: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    }
  };
}
