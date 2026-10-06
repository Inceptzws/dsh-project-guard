# dsh-project-guard
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23187648.svg)](https://doi.org/10.5281/zenodo.23187648)

**📄 Preprint: [Decision-Relevant Consequence Disclosure in Complex Computing Systems: Towards Informed Agent Execution](https://doi.org/10.5281/zenodo.23187648)**

[中文说明](README.zh.md) | **English**

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that **states what an action will cost you, before and after the agent touches your machine**.

It is the prototype adapter described in §6.2 of the preprint above: the same three interfaces `analyze` / `preview` / `report` (§4.6), the six-family consequence rule system (§4), and the Preview and Report modes of the informed-execution framework (§5.1). Every judgement is deterministic table lookup — no model call anywhere. Zero dependencies, no imports from Harness packages, no build step.

---

## 1. What decisions are missing is not permission, it is consequence

§1.4 of the paper observes that existing machinery answers three other questions:

| Mechanism | The question it answers |
|---|---|
| Authorization | *may* this action run |
| Sandboxing | *where* may it run |
| Risk assessment | *how risky* is it |

None of them answers **what it means for you**. And §3.4 makes that worse: task success is always visible while loss frequently is not (a *silent loss*), so among successful runs the true loss rate is systematically underestimated (Proposition 1):

$$\mathrm{SLR} = (1-\delta)\cdot P(l^*=1 \mid s=1)$$

This plugin is the prototype that adds that missing layer: **disclose the consequences, so the decision happens with information**.

---

## 2. How it helps your decision

**1. A Preview before the decision (§5.1, §5.3).** When a call is asking you for **extra permission**, the confirmation carries more than allow/deny: the action, the **collected state**, the consequence in user-level words, the affected interest, severity and **recoverability**, **confidence and the checked scope**, and **the losses of each option**. The goal is to bring a pressured decision — time limit, split attention, a queue of prompts — as close as possible to the *reflective* decision $D_R^*$.

**2. A Report afterwards (off by default, one switch).** An action that ran unprompted and matched a rule gets a post-execution disclosure appended to its result: **predicted vs observed** (match / false alarm / unpredicted change) plus a recovery hint. A silent loss becomes something you can notice, mitigate and recover from.

**3. Options, not just a warning (§3.5).** Rejecting is not free — it costs the task goal. So the Preview lists the losses of *execute*, *reject*, *backup-then-execute* and *rewrite*. Warning about execution alone degenerates into refusing everything.

**4. Only what is decision-relevant (§3.6, §4.4).** Every consequence is scored

$$r(e) = w_j \cdot l_j(e) \cdot \kappa_e \cdot \nu_e,\qquad l_j = (1-\rho_j)L_j + r_j$$

and only the top-k above the threshold $\tau$ are shown. Below it, the plugin **says nothing at all**. That comes straight from the motivation in §2: the more warnings there are, the more people click through them (Egelman et al.; Akhawe & Felt; Johnson & Goldstein; Turan on reviewer capacity and fatigue). **Silence is a design decision, not an omission.**

**5. The same action costs different amounts in different states (§3.3).** `delete(project.db)`: with a recent backup $l \approx 0$; without one, $l$ is large. Judgement is therefore $C, S, U \to \Delta U$, not $C \to$ risk. That is the core of this plugin.

**6. It would rather say "I do not know".** A predicate that cannot be decided is never treated as "fine" — it lands in the **not checked / undecidable** line. Confidence is capped per interest tier, and value judgments are flagged only: never predicted, never adjudicated.

---

## 3. Framework → code

| Paper | Implementation |
|---|---|
| §4.6 `analyze(action, context) → consequences` | `lib/engine.js` → `lib/rules.js` |
| §4.6 `preview(action, options, context) → disclosure` | `lib/engine.js` + `lib/disclosure.js` |
| §4.6 `report(action, pre_state, post_state) → report` | `lib/report.js` (predicted vs observed, JSONL calibration records) |
| §4.2 family 1: action rules | `lib/action.js` (tool call → typed action: `fs.delete`, `network.egress`, `process.kill`, `api.spend`, …) |
| family 2: state rules (declared scope $K$) | `lib/state.js` (uncommitted changes, recent backups, credential stores, shared locations, regulated data, build artifacts, …) |
| family 3: interest rules | `lib/interest.js` (21 built-in dimensions plus user-declared ones, each with a tier) |
| family 4: consequence rules | [`rules/consequences.yml`](rules/consequences.yml) (**34 declarative rules**) + `lib/rules.js` |
| family 5: selection rules | `lib/select.js` (budget $k$, threshold $\tau$, tier caps and flags) |
| family 6: disclosure rules | `lib/disclosure.js` (life level plus technical layer, bilingual) |
| §5.1 Preview / Report modes | `index.js`: the Preview rides the `tools/pre-execute` confirmation; the Report is appended by `tools/post-execute` |
| §5.3 predicted-vs-observed records | `lib/report.js` → `.dsh-project-guard/reports.jsonl` (calibration evidence, never file contents) |

The rule schema, the predicate table, the tier table and "how to add a rule" are in [`rules/README.md`](rules/README.md).

---

## 4. Interest dimensions and tiers (§3.2)

The paper is explicit that interests are **far wider than on-device data**: accounts, credentials and their scopes, balances and quotas, third-party services, delegation relations, reputation, legal duties. This plugin ships **21 dimensions in seven groups** and **accepts dimensions you declare yourself**:

| Group | Dimensions |
|---|---|
| Work and device | `data_work`, `availability` (the machine and other programs keep working), `environment`, `task_goal`, `schedule` |
| Authority and identity | `authority_delegation`, `credentials`, `accounts`, `privacy` |
| Economy and finance | `economic`, `finance_money`, `finance_market`, `business_ops` |
| People and standing | `reputation`, `relationships` |
| Rules and duties | `legal`, `compliance`, `intellectual_property`, `employment` |
| Values | `ethical`, `autonomy` |

Declaring your own — it does not have to be a dimension we know:

```yaml
interests:
  my_health_data:
    weight: 0.95
    tier: 1
    label: my health records
```

Because dimensions differ in how computable they are, each is treated by tier — **enforced in `lib/select.js`, not left to the optimism of a rule author**:

| Tier | Treatment |
|---|---|
| **1** | computed from collected state, scored normally |
| **1-2** | computable, but its meaning needs context; confidence capped at 0.6 |
| **2** | a **hint** only: marked "inference (unverified)", confidence capped at 0.5 |
| **2-3** | flagged with an explicit value-judgment warning; confidence capped at 0.4 |
| **3** | **flagged only**: never scored, ranked or adjudicated |

As `rules/README.md` puts it: **dressing a value judgment up as a computed result is worse than saying nothing.**

---

## 5. The trigger: staying quiet is part of the design

By default the analysis runs only in **full access**, and only for a call that is **asking you for extra permission**:

| Situation | Analysed? |
|---|---|
| Ordinary work inside the workspace (any mode) | ❌ not at all |
| An allowed call in full access | ❌ no |
| **Full access, call asks for extra permission** | ✅ yes (Preview) |
| Workspace mode, call **escalates to full access** | ✅ yes (Preview) |

Widen it with `discloseOn: asks` (any call that needs your confirmation) or `discloseOn: all` (every action the rule set knows, which also enables the Report). The post-execution Report has its own switch, `reportExecuted`, and is **off by default** — commenting on every action is itself noise.

---

## 6. The other layer: the permission gate

Beyond consequence disclosure the plugin keeps its original permission decision (the paper agrees authorization and containment remain necessary, §8.1):

- **Allow**: reads anywhere, read-only system queries, network and uploads, in-project writes and builds, temp directories and package caches, session tools.
- **Ask**: writes outside the project, system state changes (services, preferences, network, power, disks, processes, global installs), resource exhaustion and port grabs, uninspectable commands and unknown tools (**fail closed**).
- **Deny**: actions that destroy the machine or the session itself — formatting a disk, `rm -rf /`, power off, bringing an interface down, killing core system processes, killing the Harness. The reason is direct: the confirmation prompt depends on that session.

**At most one confirmation at a time.** The Harness Web client publishes a single pending approval per session and silently replaces an earlier one, so two concurrent prompts make the first unanswerable. The plugin puts a single-slot queue in front of `approval/request`, with system-related requests taking the slot first.

---

## 7. Install

```bash
dsh plugin add dsh-project-guard
# or from source
dsh plugin add github:Inceptzws/dsh-project-guard
```

On the desktop app use Settings → Plugins (that profile is managed exclusively by the app). Remove with `dsh plugin remove dsh-project-guard`.

---

## 8. Configure

Both layers share one config block (every default is documented in `cordis.patch.yml`):

| Key | Default | Effect |
|---|---|---|
| `enabled` | `true` | master switch |
| `projectRoots` / `includeSessionCwd` | `[]` / `true` | project roots; the session workspace counts as one |
| `enforceAskPolicy` | `true` | keeps confirmations deliverable (under `never` no prompt can appear) |
| `serializeApprovals` / `prioritizeSystemRequests` | `true` / `true` | single-slot queue, system requests first |
| `protectSessionAndSystem` | `true` | deny destructive actions (can be downgraded to asking) |
| `disclose` | `true` | master switch for the disclosure layer |
| `discloseOn` | `full-access-asks` | when it may speak: `full-access-asks` / `asks` / `all` |
| `attentionBudget` ($k$) | `2` | most consequences shown for one decision |
| `relevanceThreshold` ($\tau$) | `0.3` | below this score nothing is disclosed |
| `reportMinSeverity` | `high` | lowest severity that earns a Report |
| `reportExecuted` | `false` | append Reports to actions that ran unprompted |
| `reportDir` | `.dsh-project-guard` | where calibration records are written |
| `interests` | `{}` | declare or add interest dimensions and weights |
| `rulesFile` | `""` | use your own rule set |

---

## 9. Verify

```bash
node --test test/*.test.mjs   # 93 unit and integration tests
node test/cordis-mount.mjs    # mount check on the real cordis runtime
```

Releasing additionally verifies that the `npm pack` tarball **contains** `rules/consequences.yml` — the rule set is read from disk at runtime, so a tarball without it installs a plugin with no rules. The release workflow treats all three as gates.

---

## 10. Limitations

- Judgement is rule matching over **command text plus collected state**, not a sandbox; obfuscated shell can slip past the rules.
- Reads and network traffic are allowed by requirement, so it does **not** keep data from leaving the machine; it protects "the machine and other programs keep working" and what you are committed to in your name.
- Tier 2/3 dimensions need outside knowledge and can only be hinted or flagged — deliberate honesty, not an omission.
- Collectors only see locally observable state; balances, positions and quotas are reported as *not checked*.
- The plugin hooks core pipelines (`tools/pre-execute`, `tools/post-execute`, `approval/request`); Harness breaking changes need follow-up.
- Other policy plugins still apply: when this plugin allows a call it only **delegates** to the listeners behind it.

---

## 11. Files

```
index.js                 # permission gate + disclosure trigger + Report wiring
lib/action.js            # family 1: action normalization
lib/state.js             # family 2: state collectors (declared scope K)
lib/interest.js          # family 3: interest dimensions and tiers
lib/rules.js             # family 4: rule engine
lib/select.js            # family 5: relevance selection
lib/disclosure.js        # family 6: Preview / Report rendering
lib/report.js            # predicted vs observed + JSONL calibration records
lib/engine.js            # the analyze / preview / report interfaces
lib/classify.js          # the permission gate
lib/impact.js            # deterministic impact analysis for the gate
lib/shell-parse.js       # conservative shell parsing
lib/path-utils.js        # containment checks
lib/approval-queue.js    # single-slot FIFO
lib/yaml.js              # zero-dependency YAML subset parser
rules/consequences.yml   # 34 declarative rules
rules/README.md          # schema, predicates, tiers, how to add a rule
test/                    # 93 cases + the cordis mount check
```

---

## 12. Citation

```bibtex
@misc{zhu2026consequencedisclosure,
  title  = {Decision-Relevant Consequence Disclosure in Complex Computing Systems:
            Towards Informed Agent Execution},
  author = {Zhu, Wushuang},
  year   = {2026},
  month  = oct,
  note   = {Preprint v0.1},
  doi    = {10.5281/zenodo.23187648},
  url    = {https://doi.org/10.5281/zenodo.23187648}
}
```

This repository is the prototype adapter described in §6.2 of that paper; `rules/` is the "rule set" its availability statement refers to.

## License

MIT
