/**
 * Rule engine — rule family 4 of the consequence rule system.
 *
 * Loads the declarative rule set, evaluates each rule's state predicates against
 * the collectors, and emits structured consequences. A rule fires only when
 * every predicate is true; a predicate that cannot be decided leaves the rule
 * unfired and is reported in the coverage line instead of being guessed at
 * (fail-closed disclosure, paper §4.4's coverage requirement).
 *
 * @module dsh-project-guard/lib/rules
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseYaml } from './yaml.js';

/** Severity and recoverability vocabularies of the schema. */
export const SEVERITIES = ['high', 'medium', 'low'];
export const RECOVERABILITIES = ['low', 'medium', 'high'];

/** Predicate shape: `collector(args) op value`, or `always()`. */
const PREDICATE = /^([a-zA-Z_][\w.]*)\((.*)\)\s*(?:(==|!=|>=|<=|>|<)\s*(.+))?$/;

/** Where the shipped rule set lives. */
export function defaultRulePath() {
  return fileURLToPath(new URL('../rules/consequences.yml', import.meta.url));
}

/** Read and parse the rule set, reporting schema problems instead of throwing. */
export function loadRuleSet(text) {
  const problems = [];
  let document;
  try {
    document = parseYaml(text);
  } catch (error) {
    return { version: 0, rules: [], problems: [`rule set is not valid YAML: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const rules = Array.isArray(document?.rules) ? document.rules : [];
  if (rules.length === 0) problems.push('rule set contains no rules');

  const seen = new Set();
  for (const [index, rule] of rules.entries()) {
    const where = `rules[${index}]${rule?.id === undefined ? '' : ` (${rule.id})`}`;
    if (typeof rule?.id !== 'string' || rule.id.length === 0) problems.push(`${where}: missing id`);
    else if (seen.has(rule.id)) problems.push(`${where}: duplicate id`);
    else seen.add(rule.id);
    if (typeof rule?.action?.type !== 'string') problems.push(`${where}: missing action.type`);
    for (const field of ['type', 'severity', 'recoverability', 'confidence']) {
      if (rule?.consequence?.[field] === undefined) problems.push(`${where}: missing consequence.${field}`);
    }
    if (rule?.consequence?.severity !== undefined && !SEVERITIES.includes(rule.consequence.severity)) {
      problems.push(`${where}: invalid severity ${JSON.stringify(rule.consequence.severity)}`);
    }
    if (rule?.consequence?.recoverability !== undefined && !RECOVERABILITIES.includes(rule.consequence.recoverability)) {
      problems.push(`${where}: invalid recoverability ${JSON.stringify(rule.consequence.recoverability)}`);
    }
    const confidence = Number(rule?.consequence?.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) problems.push(`${where}: confidence must be 0..1`);
    if (typeof rule?.disclosure?.life !== 'string') problems.push(`${where}: missing disclosure.life`);
    if (rule?.state_predicates !== undefined && !Array.isArray(rule.state_predicates)) problems.push(`${where}: state_predicates must be a list`);
  }
  return { version: Number(document?.version ?? 0), updated: document?.updated, rules, problems };
}

/** Read the shipped rule set from disk. */
export function readRuleSet(path = defaultRulePath()) {
  return loadRuleSet(readFileSync(path, 'utf8'));
}

/** Split one predicate argument list, respecting quotes. */
function splitArguments(text) {
  const parts = [];
  let current = '';
  let quote;
  for (const character of text) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ',') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts.filter((entry) => entry.length > 0);
}

/** Parse predicate arguments into `{positional, named}`. */
function parseArguments(text) {
  const positional = [];
  const named = {};
  for (const part of splitArguments(text)) {
    const colon = part.indexOf(':');
    if (colon > 0) {
      const key = part.slice(0, colon).trim();
      const value = part.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
      named[key] = value;
    } else {
      positional.push(part.replace(/^["']|["']$/g, ''));
    }
  }
  return { positional, named };
}

/** Substitute the schema's `${target}` template in one string. */
function interpolate(text, action) {
  if (typeof text !== 'string') return text;
  return text.replace(/\$\{target\}/g, action.target ?? '(unknown target)');
}

/** Coerce a literal from a rule file. */
function literal(value) {
  const text = String(value).trim().replace(/^["']|["']$/g, '');
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

/** Evaluate one predicate against the action and the collectors. */
function evaluatePredicate(predicate, action, collectors) {
  const match = PREDICATE.exec(String(predicate).trim());
  if (match === null) return { status: 'unknown', detail: `unreadable predicate: ${predicate}` };
  const [, name, rawArguments, operator, rawValue] = match;

  // Built-ins that read the action rather than the environment.
  if (name === 'always') return { status: 'true', detail: 'no state required' };
  // Rules may match on the action text itself; still declarative, still no model.
  if (name === 'command.matches') {
    const { named: args } = parseArguments(rawArguments);
    const pattern = args.pattern ?? Object.values(args)[0];
    if (typeof pattern !== 'string' || typeof action.command !== 'string') {
      return { status: 'unknown', detail: 'no command text to match' };
    }
    let re;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      return { status: 'unknown', detail: `invalid pattern: ${pattern}` };
    }
    const hit = re.test(action.command);
    return { status: hit ? 'true' : 'false', detail: hit ? `command matches /${pattern}/` : `command does not match /${pattern}/` };
  }
  if (name === 'process.core_system') {
    return action.core === true
      ? { status: 'true', detail: 'target is a core system process' }
      : { status: 'false', detail: 'target is not a core system process' };
  }

  const collector = collectors[name];
  if (typeof collector !== 'function') return { status: 'unknown', detail: `no collector named ${name}` };

  const { positional, named } = parseArguments(rawArguments);
  const target = positional.find((entry) => entry === 'target') !== undefined || positional.length === 0
    ? action.target
    : positional[0];
  let observed;
  try {
    observed = collector(target, named);
  } catch (error) {
    return { status: 'unknown', detail: `${name} failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const observation = { collector: name, target, params: named, value: observed?.value ?? null, fingerprint: observed?.fingerprint };
  if (observed === undefined || observed.value === null || observed.value === undefined) {
    return { status: 'unknown', detail: observed?.detail ?? `${name} unavailable`, scope: name, observation };
  }
  if (operator === undefined) {
    return { status: observed.value === true ? 'true' : 'false', detail: observed.detail, scope: name, observation };
  }
  const expected = literal(rawValue);
  const actual = observed.value;
  let holds;
  switch (operator) {
    case '==': holds = actual === expected; break;
    case '!=': holds = actual !== expected; break;
    case '>': holds = Number(actual) > Number(expected); break;
    case '>=': holds = Number(actual) >= Number(expected); break;
    case '<': holds = Number(actual) < Number(expected); break;
    case '<=': holds = Number(actual) <= Number(expected); break;
    default: return { status: 'unknown', detail: `unsupported operator ${operator}`, observation };
  }
  return { status: holds ? 'true' : 'false', detail: observed.detail, scope: name, observed: actual, observation };
}

/**
 * Evaluate the whole rule set for one action.
 *
 * @param {{ruleSet: object, collectors: object, interest: object}} engine
 * @param {object} action normalized action from lib/action.js
 */
export function analyzeAction(engine, action) {
  const { ruleSet, collectors, interest } = engine;
  const consequences = [];
  const checkedScope = new Set();
  const undecided = [];
  const observations = [];

  for (const rule of ruleSet.rules) {
    if (rule?.action?.type !== action.type) continue;
    if (rule?.action?.target_kind !== undefined && rule.action.target_kind !== action.targetKind) continue;

    const predicates = Array.isArray(rule.state_predicates) ? rule.state_predicates : [];
    let fired = true;
    const evidence = [];
    const ruleObservations = [];
    for (const predicate of predicates) {
      const result = evaluatePredicate(predicate, action, collectors);
      if (result.scope !== undefined) checkedScope.add(result.scope);
      if (result.observation !== undefined) ruleObservations.push({ ...result.observation, usedBy: rule.id, ruleId: rule.id });
      if (result.status === 'unknown') {
        fired = false;
        undecided.push(`${rule.id}: ${result.detail}`);
        break;
      }
      if (result.status === 'false') {
        fired = false;
        break;
      }
      evidence.push(result.detail);
    }
    if (!fired) continue;
    observations.push(...ruleObservations);

    const text = (field) => typeof rule.disclosure?.[field] === 'string' ? interpolate(rule.disclosure[field], action) : undefined;
    const interestItem = interpolate(rule.interest?.item ?? rule.consequence.type, action);
    consequences.push({
      ruleId: rule.id,
      type: rule.consequence.type,
      severity: rule.consequence.severity,
      recoverability: rule.consequence.recoverability,
      confidence: Number(rule.consequence.confidence),
      nonObviousness: typeof rule.non_obviousness === 'number' ? rule.non_obviousness : 0.5,
      interest: interest.item(rule.interest?.dimension ?? 'data_work', interestItem),
      tier: interest.tierOf(rule.interest?.dimension ?? 'data_work'),
      target: action.target,
      evidence: [...evidence, ...(Array.isArray(rule.evidence) ? rule.evidence : [])],
      options: Array.isArray(rule.options)
        ? rule.options.map((option) => ({ ...option, loss: interpolate(option?.loss, action) }))
        : [],
      disclosure: {
        life: text('life'),
        technical: text('technical'),
        lifeZh: text('life_zh'),
        technicalZh: text('technical_zh')
      }
    });
  }

  return {
    action,
    consequences,
    observations,
    checkedScope: [...checkedScope],
    undecided,
    scopeDeclaration: { ...collectors.scopes }
  };
}
