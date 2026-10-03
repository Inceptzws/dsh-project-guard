/**
 * Project guard — project-scoped automatic full permissions for DeepSeek Harness.
 *
 * The rule set the user asked for:
 *
 * 1. Work that is provably confined to this project runs without confirmation,
 *    including the sandbox escalation that reaches sibling project directories.
 * 2. Anything unrelated to the project, and every system-level call or change,
 *    is confirmed by the user first.
 * 3. At most one confirmation is outstanding at a time. The Web client keeps a
 *    single pending-approval slot per session and silently replaces an earlier
 *    prompt with a newer one, so two concurrent requests would make the first
 *    unanswerable; this plugin queues the requests in front of the approval
 *    seam and lets system-related requests take the slot first.
 * 4. Actions that would damage the machine or cut this session — formatting a
 *    disk, deleting from the filesystem root, powering the machine off, turning
 *    off Wi-Fi, or killing a core system process — are refused outright,
 *    because a confirmation for them can never be delivered.
 *
 * The plugin is dependency-free and imports no Harness package, so a profile
 * install resolves it without a lockfile entry for dsh internals.
 *
 * @module dsh-project-guard
 */
import { createApprovalQueue } from './lib/approval-queue.js';
import { createPolicy } from './lib/classify.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'project-guard';

/** Services that must be composed before the guard may activate. */
export const inject = ['tools', 'approval'];

/** Literal prefix `@deepseek-ai/dsh-sandbox` uses for every escalation ask. */
const ESCALATION_REASON = /^escalate sandbox to (?:read-only|workspace-write|danger-full-access)\b/;

/** Structured error name for a guard refusal. */
const GUARD_DENIED_ERROR_NAME = 'ProjectGuardDeniedError';

/** Build a short, user-facing pair of sentences from an audited reason. */
function displayOf(reason, zh) {
  return { en: reason.replace(/^project guard:\s*/, ''), zh };
}

/**
 * Install the project guard.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {unknown} config the plugin row configuration.
 */
export function apply(ctx, config) {
  const policy = createPolicy(config, { warn: (message) => ctx.logger?.warn?.(message) });
  const log = (message) => ctx.logger?.debug?.(message);
  const warn = (message) => ctx.logger?.warn?.(message);

  if (!policy.config.enabled) {
    ctx.logger?.info?.('project-guard: disabled by configuration');
    return;
  }

  /** Pending classification per call id, and the human outcome once decided. */
  const records = new Map();
  const MAX_RECORDS = 512;
  const queue = createApprovalQueue(policy.config.prioritizeSystemRequests);

  const keyOf = (callId) => (typeof callId === 'string' && callId.length > 0 ? callId : undefined);

  const remember = (exec, session, decision) => {
    const key = keyOf(exec.callId);
    if (key === undefined) return undefined;
    const record = { session, decision, humanOutcome: undefined };
    records.set(key, record);
    if (records.size > MAX_RECORDS) {
      const oldest = records.keys().next();
      if (!oldest.done) records.delete(oldest.value);
    }
    return record;
  };

  const recordFor = (req) => {
    const key = keyOf(req.callId);
    if (key === undefined) return undefined;
    const record = records.get(key);
    if (record === undefined || record.session !== req.agent?.session) return undefined;
    return record;
  };

  /**
   * Keep the session on the `ask` policy: under `never` the approval service
   * rejects every request before any answerer runs, so the user could never see
   * the confirmation this plugin promises.
   */
  const ensureAskPolicy = (agent) => {
    if (!policy.config.enforceAskPolicy) return;
    const approval = ctx.get('approval');
    if (approval === undefined) return;
    try {
      const session = agent.session;
      const current = typeof approval.effectivePolicy === 'function'
        ? approval.effectivePolicy(session)
        : (typeof approval.overrideOf === 'function' ? approval.overrideOf(session) : undefined);
      if (current === 'ask' || current === undefined) return;
      if (typeof approval.setPolicy !== 'function') return;
      approval.setPolicy(agent, 'ask');
      warn(`project-guard: approval policy was "${current}"; switched to "ask" so out-of-project work can reach you`);
    } catch (error) {
      warn(`project-guard: could not enforce the ask policy: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** The `tools/pre-execute` gate: decide, record, and never block in silence. */
  const gate = async (exec, next) => {
    const agent = exec.agent;
    const session = agent?.session;
    const cwd = session?.header?.cwd;
    if (session === undefined || typeof cwd !== 'string' || cwd.length === 0) return next();

    let decision;
    try {
      decision = policy.classify({ tool: exec.name, args: exec.arguments, cwd });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      decision = {
        kind: 'ask',
        scope: 'unknown',
        code: 'CLASSIFIER_FAILURE',
        system: true,
        reason: `project guard: the classifier failed for "${exec.name}", so it needs your confirmation`,
        zh: `项目守卫无法判定 "${exec.name}"，需要你确认。`,
        detail: message
      };
      warn(`project-guard: classifier failure for ${exec.name}: ${message}`);
    }

    remember(exec, session, decision);

    if (policy.config.enforceAskPolicy) ensureAskPolicy(agent);
    log(`project-guard: ${decision.kind} ${exec.name} (${decision.code})${decision.detail === undefined ? '' : ` — ${decision.detail}`}`);

    if (decision.kind === 'allow') return next();
    if (decision.kind === 'deny') {
      return {
        kind: 'deny',
        reason: decision.reason,
        info: {
          name: GUARD_DENIED_ERROR_NAME,
          code: decision.code ?? 'PROJECT_GUARD_DENIED',
          ...(typeof decision.detail === 'string' ? { reason: decision.detail } : {})
        }
      };
    }
    return {
      kind: 'ask',
      reason: decision.reason,
      displayReason: displayOf(decision.reason, decision.zh)
    };
  };

  /**
   * The `approval/request` answerer. It runs before the interactive answerer, so
   * it can grant the escalation of a confirmed in-project call without a second
   * prompt, and can serialize everything that still has to reach the user.
   */
  const answerer = async (req, next) => {
    const record = recordFor(req);
    const reason = typeof req.reason === 'string' ? req.reason : '';
    const escalation = ESCALATION_REASON.test(reason);

    if (record !== undefined) {
      if (record.humanOutcome === 'allowed-once') return 'allowed-once';
      if (record.humanOutcome === 'rejected' || record.humanOutcome === 'cancelled') return record.humanOutcome;
      if (record.decision.kind === 'allow' && escalation) {
        log(`project-guard: auto-approved the sandbox escalation of ${req.toolName ?? 'a tool'}`);
        return 'allowed-once';
      }
    }

    const run = async () => {
      const outcome = await next();
      return typeof outcome === 'string' ? outcome : 'unavailable';
    };

    if (!policy.config.serializeApprovals) {
      const outcome = await run();
      if (record !== undefined) record.humanOutcome = outcome;
      return outcome;
    }

    const priority = record?.decision?.system === true;
    const acquired = await queue.acquire(req.signal, priority);
    if (!acquired) return 'cancelled';
    let outcome;
    try {
      outcome = await run();
    } finally {
      queue.release();
    }
    if (record !== undefined) record.humanOutcome = outcome;
    return outcome;
  };

  ctx.effect(function* () {
    yield ctx.on('tools/pre-execute', gate, { prepend: true });
    yield ctx.on('approval/request', answerer, { prepend: true });
    yield ctx.on('tools/result', (exec) => {
      const key = keyOf(exec?.callId);
      if (key !== undefined) records.delete(key);
    });
    yield () => {
      queue.drain();
      records.clear();
    };
  }, 'project-guard lifecycle');

  ctx.logger?.info?.('project-guard: active; in-project work is auto-approved, everything else asks once at a time');
}
