/**
 * Disclosure rendering — rule family 6 of the consequence rule system.
 *
 * One renderer for the two modes of the informed-execution framework (paper §5):
 *
 *   Preview — before a decision, when the host's own policy asks for one.
 *   Report  — after execution, when the action ran by default, so that a silent
 *             loss can still be noticed, mitigated or recovered.
 *
 * The content follows paper §5.3 and has two layers: a life-level sentence, and
 * a technical layer (evidence, affected object, checked scope) that answers
 * "why should I believe this".
 *
 * @module dsh-project-guard/lib/disclosure
 */

/** Bilingual labels. */
const TEXT = {
  zh: {
    preview: '决策前披露 (Preview)',
    report: '执行后披露 (Report)',
    action: '动作',
    state: '当前状态',
    consequence: '后果',
    interest: '受影响利益',
    severity: '严重度 / 可恢复性',
    confidence: '置信度 / 已检查范围',
    technical: '技术层',
    options: '选项',
    hint: '推断（未核实）',
    flags: '价值判断（只提示，不替你裁决）',
    verdict: '预测 vs 观察',
    recover: '你现在可以',
    record: '记录',
    execute: '执行',
    reject: '拒绝',
    none: '无明显后果',
    checked: '已检查',
    unchecked: '未检查/无法判定',
    weight: '权重',
    match: '命中',
    miss: '未预测到',
    falseAlarm: '误报'
  },
  en: {
    preview: 'Preview (before the decision)',
    report: 'Report (after execution)',
    action: 'Action',
    state: 'Current state',
    consequence: 'Consequence',
    interest: 'Affected interest',
    severity: 'Severity / recoverability',
    confidence: 'Confidence / checked scope',
    technical: 'Technical layer',
    options: 'Options',
    hint: 'inference (unverified)',
    flags: 'value judgment (flagged, not adjudicated)',
    verdict: 'Predicted vs observed',
    recover: 'What you can do now',
    record: 'Record',
    execute: 'execute',
    reject: 'reject',
    none: 'no relevant consequence',
    checked: 'checked',
    unchecked: 'not checked / undecidable',
    weight: 'weight',
    match: 'match',
    miss: 'unpredicted',
    falseAlarm: 'false alarm'
  }
};

const SEVERITY_LABEL = {
  zh: { high: '高', medium: '中', low: '低' },
  en: { high: 'high', medium: 'medium', low: 'low' }
};
const RECOVERABILITY_LABEL = {
  zh: { low: '低（基本不可恢复）', medium: '中（有办法恢复，但要花力气）', high: '高（容易恢复）' },
  en: { low: 'low (effectively irreversible)', medium: 'medium (recoverable with effort)', high: 'high (easy to recover)' }
};

/** Pick the localized side of a consequence's disclosure text. */
function lifeOf(consequence, lang) {
  if (lang === 'zh') return consequence.disclosure.lifeZh ?? consequence.disclosure.life;
  return consequence.disclosure.life;
}

/** Pick the localized technical line. */
function technicalOf(consequence, lang) {
  if (lang === 'zh') return consequence.disclosure.technicalZh ?? consequence.disclosure.technical;
  return consequence.disclosure.technical;
}

/** One option line. */
function optionLine(option, lang) {
  const label = option.id === 'execute' ? TEXT[lang].execute
    : option.id === 'reject' ? TEXT[lang].reject
      : option.id;
  return `  · ${label} → ${option.loss}`;
}

/**
 * Render the pre-decision preview.
 *
 * @param {{action: object, selected: object[], coverage: object, interest: object, target?: string}} analysis
 * @param {{lang?: 'zh'|'en'}} [options]
 * @returns {string|undefined} the rendered block, or undefined when nothing is worth showing
 */
export function renderPreview(analysis, options = {}) {
  const lang = options.lang === 'en' ? 'en' : 'zh';
  const text = TEXT[lang];
  const { action, selected, coverage } = analysis;
  // A value judgment with no scored prediction is still worth flagging.
  const flags = analysis.flags ?? [];
  if (selected.length === 0 && flags.length === 0) return undefined;

  const lines = [text.preview];
  const target = analysis.target ?? action.target;
  lines.push(`· ${text.action}: ${action.type}${target === undefined ? '' : ` → ${target}`}`);

  const state = selected.flatMap((entry) => entry.evidence).filter((entry) => typeof entry === 'string' && entry.length > 0);
  if (state.length > 0) lines.push(`· ${text.state}: ${[...new Set(state)].join('；')}`);

  for (const entry of selected) {
    const marker = entry.kind === 'hint' ? `［${text.hint}］` : '';
    lines.push(`· ${text.consequence}${marker}: ${lifeOf(entry, lang)}`);
    lines.push(`  ${text.interest}: ${entry.interest.item}（${text.weight} ${Number(entry.weight ?? entry.interest?.weight ?? 0).toFixed(2)}）`);
    lines.push(`  ${text.severity}: ${SEVERITY_LABEL[lang][entry.severity] ?? entry.severity} / ${RECOVERABILITY_LABEL[lang][entry.recoverability] ?? entry.recoverability}`);
    const technical = technicalOf(entry, lang);
    lines.push(`  ${text.confidence}: ${entry.confidence.toFixed(2)}（${entry.ruleId}）${technical === undefined ? '' : `｜${text.technical}: ${technical}`}`);
  }

  const optionList = selected.find((entry) => entry.options.length > 0)?.options ?? [];
  if (optionList.length > 0) {
    lines.push(`· ${text.options}:`);
    for (const option of optionList) lines.push(optionLine(option, lang));
  }

  if (flags.length > 0) {
    lines.push(`· ${text.flags}:`);
    for (const flag of flags) lines.push(`  · ${lifeOf(flag, lang)}（tier ${flag.tier}）`);
  }
  lines.push(`· ${text.checked}: ${coverage.checked.length > 0 ? coverage.checked.join(', ') : '-'}｜${text.unchecked}: ${coverage.unverified.length > 0 ? coverage.unverified.join('; ') : '-'}`);
  return lines.join('\n');
}

/**
 * Render the post-execution report.
 *
 * @param {{action: object, selected: object[], observed: object[], coverage: object, recordPath?: string, recover?: string}} report
 * @param {{lang?: 'zh'|'en'}} [options]
 */
export function renderReport(report, options = {}) {
  const lang = options.lang === 'en' ? 'en' : 'zh';
  const text = TEXT[lang];
  const { action, selected, observed, coverage } = report;

  const verdicts = { match: 0, miss: 0, falseAlarm: 0 };
  for (const entry of observed) verdicts[entry.verdict] = (verdicts[entry.verdict] ?? 0) + 1;
  // A prediction that did not come true changed nothing the user can act on.
  // Reports exist for losses that happened, so silence is the right default.
  if (verdicts.match === 0 && verdicts.miss === 0) return undefined;

  const lines = [text.report];
  const target = report.target ?? action.target;
  lines.push(`· ${text.action}: ${action.type}${target === undefined ? '' : ` → ${target}`}`);

  if (selected.length > 0) {
    lines.push(`· ${text.verdict}: ${verdicts.match} ${text.match}｜${verdicts.miss} ${text.miss}｜${verdicts.falseAlarm} ${text.falseAlarm}`);
    for (const entry of observed) {
      lines.push(`  · [${entry.verdict === 'match' ? text.match : entry.verdict === 'miss' ? text.miss : text.falseAlarm}] ${lifeOf(entry, lang)}`);
    }
  }

  if (typeof report.recover === 'string' && report.recover.length > 0) lines.push(`· ${text.recover}: ${report.recover}`);
  if (typeof report.recordPath === 'string' && report.recordPath.length > 0) lines.push(`· ${text.record}: ${report.recordPath}`);
  lines.push(`· ${text.checked}: ${coverage.checked.length > 0 ? coverage.checked.join(', ') : '-'}`);
  return lines.join('\n');
}

export { RECOVERABILITY_LABEL, SEVERITY_LABEL };
