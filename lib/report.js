/**
 * Consequence report — the post-execution half of the informed-execution
 * framework (paper §5.1, §5.3).
 *
 * When an action runs without a confirmation, the earlier preview never happened
 * and the loss would otherwise be silent. This module re-collects the state the
 * prediction was based on, compares predicted against observed, and writes one
 * line per action to a JSONL record. Those records are the evidence base the
 * paper's calibration step (§5.3, §7.4) consumes.
 *
 * Privacy (§6.4): a record stores action types, target paths and verdicts only.
 * Never file contents, never command output beyond the collector detail lines
 * that were already shown to the user.
 *
 * @module dsh-project-guard/lib/report
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Verdict for one predicted consequence after observation. */
export const VERDICTS = ['match', 'miss', 'falseAlarm'];

/**
 * Re-collect the collectors a prediction used.
 *
 * @param {{observations: object[], collectors: object}} input
 * @returns {{collector: string, target: string|undefined, before: unknown, after: unknown, changed: boolean, detail?: string}[]}
 */
export function observeAfterExecution({ observations, collectors }) {
  const results = [];
  const seen = new Set();
  for (const observation of observations) {
    const key = `${observation.collector}\u0000${observation.target ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const collector = collectors[observation.collector];
    if (typeof collector !== 'function') continue;
    let after;
    try {
      after = collector(observation.target, observation.params ?? {});
    } catch (error) {
      results.push({ collector: observation.collector, target: observation.target, before: observation.value, after: null, changed: false, detail: `re-check failed: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    // A richer fingerprint catches changes a boolean cannot: after deleting a
    // file, "dirty" is still true, but its version-control status moved.
    const before = observation.fingerprint ?? observation.value ?? null;
    const current = after?.fingerprint ?? after?.value ?? null;
    const changed = JSON.stringify(current) !== JSON.stringify(before);
    results.push({
      collector: observation.collector,
      target: observation.target,
      before,
      after: current,
      changed,
      detail: after?.detail
    });
  }
  return results;
}

/** A recovery hint, but only when the state we collected supports it. */
export function recoveryHint({ action, selected, observations }) {
  const types = new Set(selected.map((entry) => entry.type));
  const target = action.target;
  const tracked = observations.find((entry) => entry.collector === 'vcs.tracked');
  if (target !== undefined && (types.has('irreversible_data_loss') || types.has('partial_data_loss') || types.has('unbacked_deletion'))) {
    if (tracked?.value === true) return `git checkout -- ${target}（若该文件已被删除，用 git restore ${target}）`;
    return `未发现可恢复副本；可从备份介质或编辑器历史里找 ${target}`;
  }
  if (types.has('process_termination')) return '重新启动该程序即可恢复，未保存的内容无法找回';
  if (types.has('connectivity_loss')) return '把刚才改动的网络接口/服务改回原状态（例如重新开启 Wi-Fi）';
  if (types.has('resource_exhaustion')) return '删掉刚生成的大文件即可把磁盘/CPU 释放出来';
  return undefined;
}

/**
 * Build the report for one executed action.
 *
 * @param {{action: object, selected: object[], post: object[], observations: object[], coverage: object, recordPath?: string}} input
 */
export function buildReport({ action, selected, post, observations, coverage, recordPath }) {
  const observed = [];
  const changedCollectors = new Set(post.filter((entry) => entry.changed).map((entry) => entry.collector));

  for (const consequence of selected) {
    // A prediction is "matched" when at least one collector it relied on moved.
    const reliedOn = observations.filter((entry) => entry.ruleId === consequence.ruleId || entry.usedBy === consequence.ruleId);
    const touched = reliedOn.length > 0
      ? reliedOn.some((entry) => changedCollectors.has(entry.collector))
      : changedCollectors.size > 0;
    observed.push({ ...consequence, verdict: touched ? 'match' : 'falseAlarm' });
  }

  // A collector that moved while no selected consequence predicted it is a miss:
  // state changed in a way the selection did not cover.
  const predictedCollectors = new Set(observations.map((entry) => entry.collector));
  for (const change of post) {
    if (!change.changed) continue;
    if (!predictedCollectors.has(change.collector)) continue;
    if (observed.some((entry) => entry.verdict === 'match')) continue;
    observed.push({
      ruleId: 'observed-without-prediction',
      type: 'unpredicted_change',
      severity: 'medium',
      recoverability: 'medium',
      confidence: 0.4,
      interest: { dimension: 'data_work', item: change.collector, weight: 0.5 },
      evidence: [change.detail].filter(Boolean),
      options: [],
      disclosure: {
        life: `State changed in a way no rule predicted: ${change.collector}`,
        lifeZh: `有一处状态变化没有规则预测到：${change.collector}`
      },
      verdict: 'miss'
    });
  }

  return {
    action,
    target: action.target,
    selected,
    observed,
    coverage,
    recordPath,
    recover: recoveryHint({ action, selected, observations })
  };
}

/** Where reports live by default, relative to the session workspace. */
export function defaultRecordPath(workspace, directory = '.dsh-project-guard') {
  return join(workspace, directory, 'reports.jsonl');
}

/**
 * Append one record. Failure is reported, never thrown: an unwritable record
 * must not break the tool call it describes.
 *
 * @returns {string|undefined} the path written, or undefined on failure
 */
export function appendRecord(path, record) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
    return path;
  } catch {
    return undefined;
  }
}

/** Shape one JSONL record from a built report. */
export function toRecord(report, extra = {}) {
  return {
    ts: new Date().toISOString(),
    action: { type: report.action.type, target: report.action.target, targetKind: report.action.targetKind },
    predicted: report.selected.map((entry) => ({
      ruleId: entry.ruleId,
      type: entry.type,
      severity: entry.severity,
      recoverability: entry.recoverability,
      confidence: entry.confidence,
      score: entry.score
    })),
    observed: report.observed.map((entry) => ({ ruleId: entry.ruleId, verdict: entry.verdict })),
    coverage: { checked: report.coverage?.checked ?? [], unverified: report.coverage?.unverified ?? [], weights: report.coverage?.weights ?? [] },
    ...extra
  };
}
