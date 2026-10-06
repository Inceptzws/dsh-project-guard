# Consequence rule set / 后果规则集

`consequences.yml` is the plugin's only source of rules. The rule text, the
severities and the disclosure wording all live here, not in the code.

`consequences.yml` 是本插件唯一的规则来源：规则文本、严重度、披露措辞都在这个
文件里，代码里没有隐藏的规则。

Six rule families appear in one rule, in evaluation order:

| Family | Where it lives |
| --- | --- |
| 1. Action | `action.type` / `action.target_kind`, produced by [`lib/action.js`](../lib/action.js) |
| 2. State | `state_predicates`, evaluated by the collectors in [`lib/state.js`](../lib/state.js) |
| 3. Interest | `interest.dimension` / `interest.item`, weighted by [`lib/interest.js`](../lib/interest.js) |
| 4. Consequence | `consequence.*`, built by [`lib/rules.js`](../lib/rules.js) |
| 5. Selection | not in the file: `r(e) = w_j · l_j(e) · κ_e · ν_e` in [`lib/select.js`](../lib/select.js) |
| 6. Disclosure | `disclosure.life` / `disclosure.technical`, rendered by [`lib/disclosure.js`](../lib/disclosure.js) |

## Rule schema

```yaml
- id: R-FILE-DEL-01                    # stable identifier, echoed in reports
  action: {type: fs.delete, target_kind: path}
  state_predicates:                    # all must hold, or the rule does not fire
    - "vcs.uncommitted(target) == true"
  interest: {dimension: data_work, item: "uncommitted work in ${target}"}
  consequence:
    type: irreversible_data_loss
    severity: high                     # high | medium | low
    recoverability: low                # low | medium | high
    confidence: 0.9                    # κ: 0-1
  non_obviousness: 0.9                 # ν: how non-obvious the consequence is
  options:                             # the losses of each alternative
    - {id: execute, loss: "the uncommitted work in ${target}"}
    - {id: reject, loss: "this step of the task does not happen"}
  disclosure:
    life: "This file holds changes you have not saved elsewhere."
    technical: "target has uncommitted modifications"
```

Optional fields: `non_obviousness` (defaults to 0.5), `options`, `evidence`, and
the rendering extensions `disclosure.life_zh` / `disclosure.technical_zh` for
Chinese output. `${target}` is substituted with the action's target.

## Predicates

`<collector>(<args>) <op> <value>`, or the built-ins `always()` and
`process.core_system`. A predicate that cannot be decided **does not** fire the
rule; it is reported in the disclosure's coverage line instead of being guessed.
That is deliberate: an unknown state must never be rendered as a known one.

Built-in predicates that read the action itself (no state collection):

| Predicate | Meaning |
| --- | --- |
| `always()` | nothing to check; use only when the consequence needs no state |
| `process.core_system` | the target is a core system process |
| `command.matches(pattern: '...')` | the command text matches a regular expression |

Available collectors and their declared scope `K`:

| Collector | Scope it declares |
| --- | --- |
| `vcs.uncommitted(target)` | version control status of the containing repository |
| `vcs.tracked(target)` | version control index of the containing repository |
| `backup.exists(target, max_age: 7d)` | backup files next to the target, plus version control |
| `path.exists(target)` | the target path only |
| `path.system_root(target)` | the target path only |
| `process.running(target)` | processes of the same user |
| `service.dependents(target)` | processes of the same user |
| `scope.outside_project(target)` | the configured project roots |
| `path.system_root(target)` | the target path only |
| `path.is_build_artifact(target)` | the target path only |
| `credential.sensitive(target)` | the target path only |
| `path.shared_resource(target)` | the target path only |
| `data.regulated(target)` | the target path only (path-based guess, low confidence) |

Operators: `==`, `!=`, `>`, `>=`, `<`, `<=`.

## Tiers

A rule's interest dimension carries a tier, and the tier decides how the
consequence may be presented — this is enforced in `lib/select.js`, not left to
the rule author:

| Tier | Treatment |
| --- | --- |
| 1 | computed from collected state; scored normally |
| 1-2 | computed, but what it means needs context; confidence capped at 0.6 |
| 2 | a hint: rendered as "inference (unverified)", confidence capped at 0.5 |
| 2-3 | flagged, with an explicit value-judgment warning; confidence capped at 0.4 |
| 3 | flagged only — never scored, ranked or adjudicated |

Tier 3 exists because dressing a value judgment up as a computed result is worse
than saying nothing. `lib/interest.js` holds the dimension table; a dimension the
user declares in `interests:` is registered with its own tier, and an unknown
dimension defaults to tier 2.

## Adding a rule

1. Pick the action type from the vocabulary in `action.type` above.
2. Express what you need to know as predicates; add a collector only if no
   existing one can answer it, and declare its scope in `lib/state.js`.
3. Set severity, recoverability, confidence and `non_obviousness` honestly —
   selection multiplies them, so an overconfident rule crowds out better ones.
4. Write the life-level sentence for a person under time pressure, and put the
   mechanism in `technical`.
5. Run `node --test test/disclosure.test.mjs`; the first test validates the whole
   file and fails on a missing or malformed field.

## Data minimization

Collectors run only for the rules whose action type matched, so an action no rule
speaks about costs one table lookup and nothing else. No rule performs a model
call: the whole analysis path is deterministic table lookup, which is what keeps
the added latency measurable (`node --test` covers the timing budget) and the
disclosures reproducible.
