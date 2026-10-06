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
 * Dimensions of user interest.
 *
 * Interests are much broader than on-device data: accounts, credentials and
 * their scopes, balances and quotas, third-party services, contracts,
 * reputation, relationships, regulated data. No closed list can enumerate them,
 * so this table is the shipped default and `createInterestProfile` accepts any
 * additional dimension the user or a rule author declares (see `custom` below).
 *
 * `tier` decides how a dimension may be treated, and the rule is enforced in
 * `lib/select.js` rather than left to the optimism of a rule author:
 *
 *   tier 1    — computed from collected state; the main object of the analysis.
 *   tier 1-2  — computable locally, but what it means needs context.
 *   tier 2    — needs external knowledge or policy; emitted as a hint with
 *               explicit uncertainty, never as a measurement.
 *   tier 2-3  — flagged, with an explicit value-judgment warning.
 *   tier 3    — a value judgment; flagged only, never predicted or adjudicated.
 *
 * `group` is for documentation and for the disclosure's wording; `weight` is the
 * default for r(e) = w·l·κ·ν and can be overridden per user.
 */
export const DIMENSIONS = {
  // ── Work and the local machine ───────────────────────────────────────────
  data_work: { group: 'work', tier: 1, weight: 1.0, en: 'your work and data', zh: '你的成果与数据' },
  availability: { group: 'work', tier: 1, weight: 0.9, en: 'the machine and other programs working', zh: '计算机与其他程序能否正常使用' },
  environment: { group: 'work', tier: 1, weight: 0.8, en: 'shared tools and other projects', zh: '共享工具与其他项目' },
  task_goal: { group: 'work', tier: 1, weight: 0.5, en: 'finishing the task at hand', zh: '把当前任务做完' },
  schedule: { group: 'work', tier: 1, weight: 0.5, en: 'scheduled jobs and deadlines', zh: '定时任务与截止时间' },

  // ── Authority, identity, credentials ────────────────────────────────────
  authority_delegation: { group: 'authority', tier: 1, weight: 0.7, en: 'your authority, credentials and delegation', zh: '你的权限、凭据与转授' },
  credentials: { group: 'authority', tier: 1, weight: 0.9, en: 'keys, tokens and password stores', zh: '密钥、令牌与密码库' },
  accounts: { group: 'authority', tier: 1, weight: 0.7, en: 'your accounts and their access', zh: '你的账号与访问权' },
  privacy: { group: 'identity', tier: '1-2', weight: 0.5, en: 'personal data and identity', zh: '个人数据与身份' },

  // ── Economy and finance ─────────────────────────────────────────────────
  economic: { group: 'economy', tier: 1, weight: 0.6, en: 'your balance or quota', zh: '你的余额或配额' },
  finance_money: { group: 'economy', tier: 2, weight: 0.9, en: 'money moved or committed', zh: '被支出或承诺的金钱' },
  finance_market: { group: 'economy', tier: 2, weight: 1.0, en: 'trades, positions and financial obligations', zh: '交易、持仓与金融义务' },
  business_ops: { group: 'economy', tier: 2, weight: 0.6, en: 'business records and operations', zh: '业务记录与运营' },

  // ── Other people and your standing ──────────────────────────────────────
  reputation: { group: 'social', tier: 2, weight: 0.4, en: 'how you appear to others', zh: '你对他人的呈现' },
  relationships: { group: 'social', tier: 2, weight: 0.6, en: 'the people you are accountable to', zh: '你需要负责的人' },

  // ── Rules, duties and values ────────────────────────────────────────────
  legal: { group: 'rules', tier: 2, weight: 0.5, en: 'contracts, terms of service and legal duties', zh: '合同、服务条款与法律义务' },
  compliance: { group: 'rules', tier: 2, weight: 0.6, en: 'regulated or protected data', zh: '受监管或受保护的数据' },
  intellectual_property: { group: 'rules', tier: 2, weight: 0.6, en: 'source, licences and patents', zh: '源码、许可与专利' },
  employment: { group: 'rules', tier: 2, weight: 0.5, en: 'professional duties and NDAs', zh: '职业义务与保密协议' },
  ethical: { group: 'values', tier: '2-3', weight: 0.4, en: 'harm to others or to society', zh: '对他人或社会的影响' },
  autonomy: { group: 'values', tier: 3, weight: 0.5, en: 'your own judgement being substituted', zh: '你的判断被替代' }
};

/** Confidence cap per tier: a tier-2 hint must not look like a measurement. */
export const TIER_CONFIDENCE_CAP = { 1: 1, '1-2': 0.6, 2: 0.5, '2-3': 0.4, 3: 0.3 };

/** Tier a dimension gets when the user declares one we do not ship. */
export const UNKNOWN_DIMENSION_TIER = 2;

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
  const custom = {};
  for (const [dimension, meta] of Object.entries(DIMENSIONS)) {
    weights[dimension] = meta.weight;
    sources[dimension] = 'default';
  }

  const clamp = (value) => Math.min(1, Math.max(0, value));

  // Declared: the user's own dimensions and numbers win outright. A dimension we
  // do not ship is not an error — the interest space is open, and anything the
  // user names is carried through with its own tier.
  const declared = config?.interests;
  if (declared !== null && typeof declared === 'object') {
    for (const [dimension, value] of Object.entries(declared)) {
      const spec = value !== null && typeof value === 'object' ? value : { weight: value };
      const weight = Number(spec.weight);
      if (!(dimension in DIMENSIONS)) {
        custom[dimension] = {
          group: 'custom',
          tier: spec.tier ?? UNKNOWN_DIMENSION_TIER,
          weight: Number.isFinite(weight) ? clamp(weight) : 0.5,
          en: spec.label ?? dimension,
          zh: spec.label_zh ?? spec.label ?? dimension,
          custom: true
        };
      }
      if (Number.isFinite(weight)) {
        weights[dimension] = clamp(weight);
        sources[dimension] = 'declared';
      }
    }
  }

  // Contextual: this workspace keeps version history, so work in it is at stake.
  if (signals.vcs === true && sources.data_work === 'default') {
    weights.data_work = clamp(weights.data_work * CONTEXTUAL_BOOST);
    sources.data_work = 'contextual (version-controlled workspace)';
  }
  if (signals.dependencies === true && sources.environment === 'default') {
    weights.environment = clamp(weights.environment * CONTEXTUAL_BOOST);
    sources.environment = 'contextual (shared dependency tree present)';
  }
  // Behavioral: if backups exist near this workspace, the user already treats
  // its contents as worth protecting.
  if (signals.backups === true && sources.data_work === 'default') {
    weights.data_work = clamp(weights.data_work * CONTEXTUAL_BOOST);
    sources.data_work = 'behavioral (backup copies present)';
  }

  /** Metadata for one dimension: shipped, declared, or a conservative default. */
  const metaOf = (dimension) => DIMENSIONS[dimension] ?? custom[dimension] ?? {
    group: 'custom',
    tier: UNKNOWN_DIMENSION_TIER,
    weight: weights[dimension] ?? 0.5,
    en: dimension,
    zh: dimension,
    custom: true
  };

  return {
    weights,
    sources,
    custom,
    cwd,

    /** Weight for one dimension, falling back to the least protected value. */
    weightOf(dimension) {
      return weights[dimension] ?? metaOf(dimension).weight ?? 0.5;
    },

    /** Human-readable item, as the disclosure shows it. */
    item(dimension, item) {
      const meta = metaOf(dimension);
      return { dimension, item, weight: this.weightOf(dimension), tier: meta.tier, label: { en: meta.en, zh: meta.zh } };
    },

    /** The tier of one dimension, for tier-aware selection and rendering. */
    tierOf(dimension) {
      return metaOf(dimension).tier ?? 1;
    },

    /** Whether a dimension may be predicted at all, or only flagged. */
    isFlagOnly(dimension) {
      return String(this.tierOf(dimension)).includes('3');
    },

    /** Whether a dimension is a hint: predictable, but with explicit uncertainty. */
    isHint(dimension) {
      return String(this.tierOf(dimension)).includes('2');
    },

    /** Confidence cap that applies to one dimension. */
    confidenceCap(dimension) {
      return TIER_CONFIDENCE_CAP[this.tierOf(dimension)] ?? TIER_CONFIDENCE_CAP[UNKNOWN_DIMENSION_TIER];
    },

    /** The dimension table, for documentation and for the coverage line. */
    table() {
      return [...Object.entries(DIMENSIONS).map(([name, meta]) => ({ name, ...meta })),
        ...Object.entries(custom).map(([name, meta]) => ({ name, ...meta }))];
    },

    /** One-line description for the coverage block and for documentation. */
    describe() {
      return Object.entries(weights)
        .sort((left, right) => right[1] - left[1])
        .map(([dimension, weight]) => `${dimension}=${weight.toFixed(2)} (${sources[dimension] ?? 'custom'})`);
    }
  };
}
