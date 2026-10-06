/**
 * Interest profile — rule family 3 of the consequence rule system.
 *
 * Paper §3.2 defines interest as what the user would protect under reflective
 * conditions, and §4.3 builds the profile from three sources: declared (the
 * user said so), contextual (the action and the workspace say so), and
 * behavioral (observable history says so). Weights are what turn a generic
 * consequence into a decision-relevant one; this module keeps them explicit and
 * inspectable instead of hiding them in the rule text.
 *
 * @module dsh-project-guard/lib/interest
 */

/**
 * Dimensions, their tier (how computable they are, paper §3.2) and the default
 * weight when nothing else is known. `availability` and `environment` are the
 * two extensions this plugin needs: the paper's list does not name "the machine
 * and other programs keep working", which is the property this deployment is
 * asked to protect.
 */
export const DIMENSIONS = {
  data_work: { tier: 1, weight: 1.0, en: 'your work and data', zh: '你的成果与数据' },
  availability: { tier: 1, weight: 0.9, en: 'the machine and other programs working', zh: '计算机与其他程序能否正常使用' },
  environment: { tier: 1, weight: 0.8, en: 'shared tools and other projects', zh: '共享工具与其他项目' },
  authority_delegation: { tier: 1, weight: 0.7, en: 'your authority, delegated onward', zh: '你被继续转授的权限' },
  privacy: { tier: 2, weight: 0.5, en: 'data leaving this machine', zh: '离开本机的数据' },
  economic: { tier: 1, weight: 0.6, en: 'your balance or quota', zh: '你的余额或配额' },
  reputation: { tier: 2, weight: 0.4, en: 'how you appear to others', zh: '你对他人的呈现' },
  legal_ethical: { tier: 3, weight: 0.3, en: 'legal or ethical exposure', zh: '法律或伦理风险' }
};

/** Contextual boosts stay small: context tilts the order, it does not decide. */
const CONTEXTUAL_BOOST = 1.15;

/**
 * Build the interest profile for one workspace.
 *
 * @param {{config: object, cwd: string, signals?: {vcs?: boolean, dependencies?: boolean, backups?: boolean}}} input
 */
export function createInterestProfile({ config, cwd, signals = {} }) {
  const weights = {};
  const sources = {};
  for (const [dimension, meta] of Object.entries(DIMENSIONS)) {
    weights[dimension] = meta.weight;
    sources[dimension] = 'default';
  }

  // Declared: the user's own numbers win outright.
  const declared = config?.interests;
  if (declared !== null && typeof declared === 'object') {
    for (const [dimension, value] of Object.entries(declared)) {
      if (!(dimension in DIMENSIONS)) continue;
      const weight = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(weight)) continue;
      weights[dimension] = Math.min(1, Math.max(0, weight));
      sources[dimension] = 'declared';
    }
  }

  // Contextual: this workspace keeps version history, so work in it is at stake.
  if (signals.vcs === true && sources.data_work === 'default') {
    weights.data_work = Math.min(1, weights.data_work * CONTEXTUAL_BOOST);
    sources.data_work = 'contextual (version-controlled workspace)';
  }
  if (signals.dependencies === true && sources.environment === 'default') {
    weights.environment = Math.min(1, weights.environment * CONTEXTUAL_BOOST);
    sources.environment = 'contextual (shared dependency tree present)';
  }

  // Behavioral: if backups exist near this workspace, the user already treats
  // its contents as worth protecting.
  if (signals.backups === true && sources.data_work === 'default') {
    weights.data_work = Math.min(1, weights.data_work * CONTEXTUAL_BOOST);
    sources.data_work = 'behavioral (backup copies present)';
  }

  return {
    weights,
    sources,
    cwd,

    /** Weight for one dimension, falling back to the least protected value. */
    weightOf(dimension) {
      return weights[dimension] ?? 0.5;
    },

    /** Human-readable item, as the disclosure shows it. */
    item(dimension, item) {
      const meta = DIMENSIONS[dimension] ?? { en: dimension, zh: dimension };
      return { dimension, item, weight: this.weightOf(dimension), label: { en: meta.en, zh: meta.zh } };
    },

    /** One-line description for the coverage block and for documentation. */
    describe() {
      return Object.entries(weights)
        .sort((left, right) => right[1] - left[1])
        .map(([dimension, weight]) => `${dimension}=${weight.toFixed(2)} (${sources[dimension]})`);
    }
  };
}
