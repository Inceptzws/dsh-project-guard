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
 * On top of that permission layer sits the consequence-disclosure layer of
 * *Decision-Relevant Consequence Disclosure in Complex Computing Systems*: a
 * deterministic rule set that predicts what an action would cost the user
 * (state -> interest -> consequence -> relevance selection), a **Preview** shown
 * before a confirmation, and a **Report** appended to the tool result when an
 * action ran by default, so a loss is never silent.
 *
 * The plugin is dependency-free and imports no Harness package, so a profile
 * install resolves it without a lockfile entry for dsh internals.
 *
 * @module dsh-project-guard
 */
import { createApprovalQueue } from './lib/approval-queue.js';
import { createPolicy } from './lib/classify.js';
import { createDisclosureEngine } from './lib/engine.js';
import { impactLine } from './lib/impact.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'project-guard';

/** Services that must be composed before the guard may activate. */
export const inject = ['tools', 'approval'];

/** Literal prefix `@deepseek-ai/dsh-sandbox` uses for every escalation ask. */
const ESCALATION_REASON = /^escalate sandbox to (?:read-only|workspace-write|danger-full-access)\b/;

/** Structured error name for a guard refusal. */
const GUARD_DENIED_ERROR_NAME = 'ProjectGuardDeniedError';

/**
 * Build the text the confirmation prompt shows: what the call does, and what
 * goes wrong if the user allows it.
 */
function displayOf(reason, zh, impact) {
  const en = reason.replace(/^project guard:\s*/, '');
  const warning = impactLine(impact);
  if (warning === undefined) return { en, zh };
  return { en: `${en}\n\n${warning.en}`, zh: `${zh}\n\n${warning.zh}` };
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
  /** Calls whose predicted consequences still need an after-the-fact report. */
  const pendingReports = new Map();
  const MAX_PENDING_REPORTS = 128;

  /** The consequence-disclosure layer, when it is switched on. */
  const engine = policy.config.disclose ? createDisclosureEngine({ policy, warn, log }) : undefined;

  /** Keep a prediction for the Report phase, for actions that will execute. */
  const keepForReport = (exec, session, cwd, analysis) => {
    if (analysis === undefined || analysis.selected.length === 0) return;
    const key = keyOf(exec.callId);
    if (key === undefined) return;
    pendingReports.set(key, { analysis, cwd, session });
    if (pendingReports.size > MAX_PENDING_REPORTS) {
      const oldest = pendingReports.keys().next();
      if (!oldest.done) pendingReports.delete(oldest.value);
    }
  };

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
   * The session's effective sandbox mode, when the deployment exposes it. The
   * guard only engages for full-permission sessions and for calls that ask for
   * more than the session already has.
   */
  const sandboxModeOf = (session) => {
    const sandbox = ctx.get('sandboxPolicy');
    if (sandbox === undefined || typeof sandbox.resolve !== 'function') return undefined;
    try {
      return sandbox.resolve({ session })?.mode;
    } catch {
      return undefined;
    }
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

    const mode = sandboxModeOf(session);

    // Consequence analysis first: it is skipped in microseconds unless the rule
    // set speaks about this kind of action.
    const analysis = engine === undefined ? undefined : engine.analyze({ tool: exec.name, args: exec.arguments, cwd, session });

    let decision;
    try {
      decision = policy.classify({ tool: exec.name, args: exec.arguments, cwd, mode });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      decision = {
        engage: true,
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

    // Work that stays inside the workspace is already confined by the sandbox:
    // the permission layer does not take part in it at all. The disclosure layer
    // does, because an action that runs by default is exactly the case where a
    // loss would otherwise be silent.
    if (decision.engage === false) {
      keepForReport(exec, session, cwd, analysis);
      return next();
    }

    remember(exec, session, decision);

    if (policy.config.enforceAskPolicy) ensureAskPolicy(agent);
    log(`project-guard: ${decision.kind} ${exec.name} (${decision.code})${decision.detail === undefined ? '' : ` — ${decision.detail}`}`);

    if (decision.kind === 'allow') {
      keepForReport(exec, session, cwd, analysis);
      return next();
    }
    if (decision.kind === 'deny') {
      return {
        kind: 'deny',
        reason: decision.impact === undefined ? decision.reason : `${decision.reason} — ${decision.impact.en}`,
        info: {
          name: GUARD_DENIED_ERROR_NAME,
          code: decision.code ?? 'PROJECT_GUARD_DENIED',
          ...(typeof decision.detail === 'string' ? { reason: decision.detail } : {})
        }
      };
    }
    const level = decision.impact?.level;
    const base = displayOf(decision.reason, decision.zh, decision.impact);
    const preview = engine?.preview(analysis, 'zh');
    const previewEn = engine?.preview(analysis, 'en');
    return {
      kind: 'ask',
      // The audited reason carries the impact level; the prompt carries the text.
      reason: level === undefined ? decision.reason : `${decision.reason} [impact: ${level}]`,
      displayReason: preview === undefined ? base : {
        zh: `${base.zh}\n\n${preview}`,
        en: `${base.en}\n\n${previewEn}`
      }
    };
  };

  /**
   * The `tools/post-execute` waterfall: append the post-execution Report to the
   * result of an action that ran without a confirmation. A report exists only
   * when the rule set predicted something for that action, so ordinary work
   * stays untouched.
   */
  const postExecute = async (exec, result, next) => {
    const decision = await next();
    if (engine === undefined || pendingReports.size === 0) return decision;
    const key = keyOf(exec?.callId);
    const pending = key === undefined ? undefined : pendingReports.get(key);
    if (pending === undefined) return decision;
    pendingReports.delete(key);

    const built = engine.report({
      analysis: pending.analysis,
      cwd: pending.cwd,
      session: pending.session,
      sessionId: pending.session?.header?.id
    });
    if (built === undefined) return decision;

    // A downstream block wins; a value-shaped acceptance cannot carry content.
    if (decision.kind !== 'accept' || decision.value !== undefined) return decision;
    const content = Array.isArray(decision.content)
      ? decision.content
      : (Array.isArray(result?.content) ? [...result.content] : []);
    log(`project-guard: report appended for ${exec.name} (${pending.analysis.action.type})`);
    return { kind: 'accept', content: [...content, { type: 'text', text: built.rendered }] };
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
    yield ctx.on('tools/post-execute', postExecute);
    yield ctx.on('tools/result', (exec) => {
      const key = keyOf(exec?.callId);
      if (key === undefined) return;
      records.delete(key);
      pendingReports.delete(key);
    });
    yield () => {
      queue.drain();
      records.clear();
      pendingReports.clear();
    };
  }, 'project-guard lifecycle');

  ctx.logger?.info?.(
    engine === undefined
      ? 'project-guard: active; in-project work is untouched, every extra permission is decided here, one confirmation at a time'
      : `project-guard: active; permission gate + consequence disclosure (${engine.ruleSet.rules.length} rules), one confirmation at a time`
  );
}
