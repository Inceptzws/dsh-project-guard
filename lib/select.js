/**
 * Relevance selection — rule family 5 of the consequence rule system.
 *
 * Implements paper §3.3 and §4.4:
 *
 *   l_j(e) = (1 - ρ) L_j + r_j          effective loss: magnitude net of
 *                                       recoverability, plus recovery effort
 *   r(e)   = w_j · l_j(e) · κ_e · ν_e   decision relevance
 *
 * Selection keeps the top-k items with r(e) ≥ τ, and the disclosure always ends
 * with a coverage line: what was checked, what was not, and which interest
 * weights were used. Disclosing more is not better — approval fatigue makes a
 * system less safe (paper §2), so a low-relevance action produces no disclosure
 * at all.
 *
 * @module dsh-project-guard/lib/select
 */

/** Loss magnitude per severity level. */
const LOSS_BY_SEVERITY = { high: 1.0, medium: 0.6, low: 0.3 };
/** Fraction of the loss that survives recovery, per recoverability level. */
const UNRECOVERED = { low: 0.9, medium: 0.5, high: 0.1 };
/** Recovery effort cost, per recoverability level. */
const RECOVERY_EFFORT = { low: 0.2, medium: 0.1, high: 0.05 };

/** Effective loss of one consequence. */
export function effectiveLoss(consequence) {
  const magnitude = LOSS_BY_SEVERITY[consequence.severity] ?? 0.5;
  const unrecovered = UNRECOVERED[consequence.recoverability] ?? 0.5;
  const effort = RECOVERY_EFFORT[consequence.recoverability] ?? 0.1;
  return unrecovered * magnitude + effort;
}

/**
 * Score and select the consequences worth showing.
 *
 * @param {{consequences: object[], interest: object, budget?: number, threshold?: number, undecided?: string[], checkedScope?: string[]}} input
 */
export function selectConsequences({ consequences, interest, budget = 3, threshold = 0.15, undecided = [], checkedScope = [], flagBudget = 2 }) {
  const scored = consequences.map((consequence) => {
    const dimension = consequence.interest.dimension;
    const weight = interest.weightOf(dimension);
    const loss = effectiveLoss(consequence);
    // The tier decides how much the confidence may claim: a tier-2 hint must not
    // read like a measurement, and a tier-3 item is never scored at all.
    const confidence = Math.min(consequence.confidence, interest.confidenceCap(dimension));
    const score = weight * loss * confidence * consequence.nonObviousness;
    const kind = interest.isFlagOnly(dimension) ? 'flag' : interest.isHint(dimension) ? 'hint' : 'prediction';
    return { ...consequence, score, loss, weight, confidence, tier: interest.tierOf(dimension), kind };
  });

  // Value judgments are flagged, never ranked: ranking them would be adjudicating.
  const flags = scored.filter((entry) => entry.kind === 'flag').slice(0, flagBudget);
  const rateable = scored.filter((entry) => entry.kind !== 'flag');
  rateable.sort((left, right) => right.score - left.score);
  const selected = rateable.slice(0, Math.max(1, budget)).filter((entry) => entry.score >= threshold);
  const dropped = rateable.length - selected.length;

  const coverage = {
    checked: [...checkedScope],
    unverified: [...undecided],
    weights: interest.describe(),
    dropped,
    hinted: selected.filter((entry) => entry.kind === 'hint').length,
    flagged: flags.length,
    threshold,
    budget
  };

  return { selected, flags, coverage, highestSeverity: rankSeverity(selected) };
}

/** The highest severity among the selected consequences. */
export function rankSeverity(selected) {
  const order = ['low', 'medium', 'high'];
  let best = undefined;
  for (const entry of selected) {
    if (best === undefined || order.indexOf(entry.severity) > order.indexOf(best)) best = entry.severity;
  }
  return best;
}

export { LOSS_BY_SEVERITY, RECOVERY_EFFORT, UNRECOVERED };
