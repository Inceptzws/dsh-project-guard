# dsh-project-guard
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23187648.svg)](https://doi.org/10.5281/zenodo.23187648)

**📄 Preprint: [Decision-Relevant Consequence Disclosure in Complex Computing Systems: Towards Informed Agent Execution](https://doi.org/10.5281/zenodo.23187648)**

[中文说明](README.zh.md) | **English**

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
**keeps the sandbox mode you chose** and judges only the *extra permission* a call
asks for. Work inside the workspace never involves the plugin at all — the sandbox
already confines it. When a call wants more than that mode allows, the test is
whether it can damage the computer or stop another program from working: reads,
network traffic, uploads, temp files and package caches pass; system state changes
and writes outside the project ask you once, with a consequence analysis; the
actions that would damage the machine or cut the session are refused outright. At
most one confirmation is outstanding at a time.

It is a Host plugin: zero dependencies, no imports of any Harness package, no UI
code, and no build step. `index.js` plus five small modules is the whole plugin.

---

## The highlight: not "may it act", but "what does it cost you"

Existing safety machinery answers three other questions: **may it act**
(authorization), **where may it act** (sandboxing), **how risky is it** (risk
scoring). None of them tells you what a command means *for you*. That is the
layer this plugin adds — **consequence analysis** — and it puts three
relationships into the same confirmation:

| Relationship | The question it answers | Example |
|---|---|---|
| **You ↔ the device** | Will this stop the machine or other programs from working? | Wi-Fi off → the model service carrying this conversation goes with it; `killall` → a program someone is using dies; a full disk → nothing can write |
| **Agent ↔ you** | What is it committing you to in your name? | Delegating to a sub-agent → later steps stop being shown to you and it spends your quota; `git push --force` → other people's commits on the remote disappear; a global install → shared dependencies move under other projects |
| **You ↔ your wider interests** | Does this reach past the device? | Keys or tokens leaving the machine, real money being spent, regulated data crossing a border, publishing or messaging under your name, bypassing certificate and terms safeguards |

**The analysis is measured, not guessed.** It collects state first (uncommitted
changes, recent backups, whether the target is a key store or a shared location)
and then applies rules: the same `rm` is "irrecoverable loss of work" when the
target is dirty and a different rule when it is clean and unbacked. A predicate
that cannot be decided is never rendered as "fine" — it lands in the
"not checked / undecidable" line.

**The interest space is open.** 21 built-in dimensions in seven groups — work
and data, machine availability, shared environment, authority and credentials,
accounts, balances and money, market positions, privacy and identity,
reputation, relationships, legal, compliance, intellectual property,
professional duties, ethics — and you can **declare your own**:

```yaml
interests:
  my_health_data:
    weight: 0.95
    tier: 1
    label: my health records
```

Because dimensions differ in how computable they are, each is treated by tier:
**Tier 1** is computed from collected state; **Tier 2** is emitted only as a
hint with explicit uncertainty (marked "inference (unverified)", with its
confidence capped); **Tier 3** is flagged only — never predicted, never
adjudicated. That is deliberate: dressing a value judgment up as a computed
result is worse than saying nothing.

**And it stays quiet.** By default the analysis runs only in **full access**, and
only for a call that is **asking you for more permission**. Ordinary work inside
the workspace is not analysed at all. Noise is itself a safety problem: it trains
you to click through.

## What it guarantees

| Requirement | How the plugin delivers it |
|---|---|
| Work inside the workspace is never interrupted | The sandbox already confines it, so the guard takes no part: no classification, no record, no prompt |
| The guard only speaks about *extra* permission | It engages when a call asks to escalate past the session's sandbox mode, or while the session runs at full permission |
| What cannot disturb the machine is granted silently | Reads anywhere, network and uploads, temp files, package caches, project writes — including the escalation those need |
| What could disturb the machine or another program needs your confirmation | System changes (services, preferences, network configuration, power, disks, processes, global installs) and writes outside the project |
| Other programs must keep working | Commands that starve the machine or take a shared resource ask first: `dd if=/dev/zero`, `yes >`, unbounded loops, `stress`, `python -m http.server` |
| Only one confirmation may be outstanding | A single-slot queue in front of the approval seam; system-related requests take the slot before ordinary ones |
| Every confirmation explains the downside | Each prompt carries a deterministic impact analysis: a level plus the concrete adverse outcome of saying yes |

### When the guard is involved — and when it is not

The three permission modes in the picker are the starting point:

| Session mode | What the guard does |
|---|---|
| **Workspace-write** (default) | Nothing at all, until a call asks for an escalation beyond it. Those requests are the "extra permission" the guard judges: in-project and machine-safe work is granted silently, a system change or an outside write asks, a destructive action is refused |
| **Full permission** | Every call is gated, because now anything can touch the system. In-project work still passes without a prompt; the rest is judged by effect |
| **Read-only** | Same as workspace-write: only an escalation request involves the guard |

It never changes the session's sandbox itself — the mode you pick stays the mode
you get. What it changes is *what has to be asked when a call wants more*.

The test is "can this damage the computer or stop another program working?", not
"is this inside the project":

- **granted silently** — reads anywhere, `curl`/`wget`/`ssh`/`git push`/uploads,
  temp files, package caches (`~/.npm`, `~/Library/Caches`, …), project writes,
  read-only system probes (`ps`, `sw_vers`, `lsof`);
- **confirmation** — system state changes (`sudo`, `launchctl`, `defaults`,
  `networksetup`, `pmset`, `diskutil`, `kill`, global installs), writes outside
  the project, resource exhaustion, port binding;
- **refused** — the actions that destroy the machine or cut the session.

### How a call is decided

Once the guard is involved, on the `tools/pre-execute` waterfall:

1. **Machine-safe → allow.** Project work, reads anywhere, network traffic and
   uploads, temp files and package caches. If the call asked for an escalation to
   do it, the guard grants that escalation silently.
2. **Could affect the machine or another program → ask.** System state changes
   and writes outside the project. The user decides, and the prompt carries the
   consequence analysis.
3. **Would destroy the machine or cut the session → deny.** Formatting a disk,
   deleting from `/`, deleting the home directory, powering the machine off,
   **turning Wi-Fi off**, bringing an interface down, killing
   `WindowServer`/`launchd`/`Finder`, `kill -9 1`, a fork bomb, or killing the
   running Harness. A confirmation for these can never be delivered, because the
   action destroys the session that would show it. Set
   `protectSessionAndSystem: false` to downgrade them to confirmations.

Anything it cannot read still **fails closed**: uninspectable commands
(`$(…)`, backticks, `eval`, `node -e`, `python -c`, unbalanced quotes), unknown
tools, and `$VAR` used as a path all ask first.

## Why "one at a time" is not cosmetic

Harness projects **one** pending approval per session. A newer request
*replaces* the older one in the composer instead of queueing behind it
(`dsh-client-ui-session` keeps every pending interaction but publishes a single
visible slot per session, and `dsh-client-ui-approval` registers the approval
precedence). Two concurrent approvals therefore make the first one impossible to
answer. This plugin queues `approval/request` in front of the interactive
answerer, so at most one prompt is ever live.

### Every prompt states what going ahead would cause

A prompt that only asks "allow?" makes you guess. Each confirmation carries a
deterministic, table-driven assessment — never model-generated — with an impact
level and the concrete consequence:

- **high** — `ifconfig en0 down`: the machine loses its network, including the
  model service carrying this conversation; the session is cut off and only you
  can bring it back.
- **medium** — `brew install jq`: installs packages globally, may upgrade shared
  dependencies and break other projects or command-line tools.
- **low** — `sw_vers`: only reads the system version; nothing is changed.
- **unknown** — `node -e "…"`: inline code the plugin cannot read, so the real
  effects are unknown and may reach beyond what the command appears to do.

The level comes from the verdict category and, for system commands, is refined
per program (`sudo`, `launchctl`, `defaults`, `kill`, `diskutil`, `pip`,
`osascript`, …). Refusals state the consequence too, so the model learns why.

### Decision table (defaults, when the guard is involved)

**Allow silently**

- Every read: `read` / `read_image` / `glob` / `grep` anywhere, `cat`, `ls`, and
  read-only system probes (`ps`, `sw_vers`, `lsof`, `uname`, `system_profiler`)
- Network and uploads: `curl`, `wget`, `ssh`, `scp`, `rsync`, `git push|pull|fetch|clone`,
  `gh`, `aws`, `gcloud`, `docker`, `kubectl`, `npx`, `npm publish`, `npm cache`
- Project writes: `write` / `edit` inside the project or a configured root,
  `mkdir`, `cp`, `mv`, `rm` inside the project, builds and tests
  (`pnpm`, `npm run`, `node`, `pytest`, `cargo build`, `go test`, `make`, `tsc`)
- Scratch and caches: `/tmp`, `~/.npm`, `~/Library/Caches`, `~/.cargo`, …
- Session tools: `todo_write`, `ask_user_question`, `present`, `skill`, `job_*`,
  `web_search`, `web_fetch`, `cordis_inspect_*`

**Ask**

- Writes outside the project: any `write` / `edit` path elsewhere, `echo x > /usr/…`,
  `rm -rf ../../other-project`, `cp a.txt ~/Desktop/`, `tee /etc/motd`,
  `chmod -R 777 /`, `find / -delete`
- System state: `sudo`, `launchctl`, `defaults`, `systemsetup`, `scutil`,
  `networksetup`, `ifconfig`, `ip`, `pfctl`, `pmset`, `diskutil`,
  `softwareupdate`, `sysctl`, `mdutil`, `kill`, `killall`, `pkill`, `brew`,
  `pip`, `conda`, `osascript`, `open`, `xargs`, `crontab`
- Shared environment: `npm install -g`, `git config --global`
- Resource abuse: `dd if=/dev/zero`, `yes >`, `cat /dev/zero`, `mkfile`,
  `fallocate`, `truncate`, `stress`, `while true`, `python -m http.server`
- Uninspectable: `node -e`, `python -c`, `$(…)`, `` `…` ``, `eval`, `$VAR` paths,
  unbalanced quotes, and any unknown tool

**Deny**

- `rm -rf /`, `rm -rf ~`, `rm -rf $HOME`
- `mkfs`, `newfs`, `fdisk`, `gpt`, `dd … of=/dev/…`, `diskutil eraseDisk`
- `shutdown`, `reboot`, `halt`
- `networksetup -setairportpower … off`, `ifconfig … down`, `ip link set … down`,
  `pfctl -d`, `wg-quick down`
- `killall WindowServer|loginwindow|launchd|Finder|Dock|mDNSResponder|configd`,
  `kill -9 1`, `pkill -f "DeepSeek Harness"`, fork bombs

## The consequence disclosure layer, mechanically

- **The rule set is declarative**, entirely in
  [`rules/consequences.yml`](rules/consequences.yml) — **34 rules** across files,
  processes, network, services, credentials and accounts, money, reputation and
  relationships, legal and compliance, intellectual property, and value
  judgments. Schema and "how to add a rule": [rules/README.md](rules/README.md).
- **The trigger is deliberately narrow**: by default (`discloseOn:
  full-access-asks`) the analysis runs only in **full access**, and only for a
  call that is **asking you for extra permission**. Ordinary work inside the
  workspace is never analysed. Widen it with `discloseOn: asks` (any call that
  needs your confirmation) or `all` (every action the rule set knows).
- **Preview (before the decision)**: the action, the collected state, the
  consequence in user-level words, the affected interest and its weight, severity
  and recoverability, confidence and the **checked scope**, and the losses of each
  option — including the cost of rejecting and backup-then-execute.
- **Report (after execution, off by default)**: with `reportExecuted` enabled, an
  action that ran unprompted appends a post-execution disclosure to its result
  with **predicted vs observed** (match / false alarm / unpredicted change) and a
  recovery hint. It is off by default because commenting on every action is
  itself noise.
- **Relevance selection**: every consequence is scored `r(e) = w · l · κ · ν`
  (loss net of recoverability); only the top-k above the threshold are shown, and
  anything below it is silent. Value judgments (tier 3) are flagged and never
  scored.
- **Calibration records**: each report appends one JSONL line to
  `.dsh-project-guard/reports.jsonl` with action types, paths, predictions,
  observations, coverage and the interest weights in force — never file contents.
  This is exactly the evidence a predicted-vs-observed calibration needs.

Configuration: `disclose` (master switch), `discloseOn`
(`full-access-asks` / `asks` / `all`), `attentionBudget` (budget k, default 2),
`relevanceThreshold` (τ, default 0.3), `reportMinSeverity` (default high),
`reportExecuted`, `reportDir`, `interests` (declare or add your own dimensions
and weights) and `rulesFile`.

## Install

## Install

The package is a standard Harness bundle: its `package.json` declares
`dsh.bundle.patch`, it has no dependencies and it needs no build step.

### From npm (anyone)

Published as [`dsh-project-guard`](https://www.npmjs.com/package/dsh-project-guard):

```sh
dsh plugin --profile <profile> add dsh-project-guard
# remove again:
dsh plugin --profile <profile> remove dsh-project-guard
```

### From GitHub

```sh
dsh plugin --profile <profile> add github:Inceptzws/dsh-project-guard
```

The command installs the package and selects its bundle. Confirm the result:

```sh
dsh --profile <profile> --dump-config | grep -A14 project-guard
```

`dsh` needs Node 24 or newer (`import.meta.main`); the runtime bundled with the
Desktop app works:

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" \
  /opt/homebrew/bin/dsh plugin --profile web add dsh-project-guard
```

### Desktop app (recommended there)

The `desktop` profile is owned exclusively by the Electron app, so its plugins
are installed from the app itself:

1. Open **Settings → Plugins** (设置 → 插件).
2. Choose **Install bundle** and give `dsh-project-guard`,
   `github:Inceptzws/dsh-project-guard`, or the absolute path of a local checkout.
3. The Plugins page reports the installation result and any warning; the new
   `project-guard` row appears there and is active immediately.

### Other profiles (web, tui, your own)

```sh
dsh plugin --profile web add /absolute/path/to/dsh-project-guard
# remove again:
dsh plugin --profile web remove dsh-project-guard
```

`dsh` needs Node 24 or newer (`import.meta.main`); the runtime bundled with the
app works:

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" \
  /opt/homebrew/bin/dsh plugin --profile web add /absolute/path/to/dsh-project-guard
```

### Manual install (advanced)

The Plugins page is the supported route. The two steps it performs are:

1. `pnpm add link:<absolute bundle directory>` inside `$DSH_HOME/profiles/<profile>`
2. append the bundle name to that profile's `dsh.profile.bundles` (the dependency
   alone is not enough — a bundle is only composed when it is listed)

Then confirm the composition with `dsh --profile <profile> --dump-config`. The
`desktop` profile rejects every CLI invocation from outside the Electron app, so
use the Plugins page there.

### Confirm the composition

```sh
dsh --profile web --dump-config | grep -A14 project-guard
```

You should see a `# == dsh-project-guard` layer and a `project-guard` row with
your config.

## Configure

Edit the `config` block in this package's `cordis.patch.yml` before installing,
or override the row from your profile's own patch layer (a matching `id`
replaces the complete config):

```yaml
- id: project-guard
  name: dsh-project-guard
  config:
    projectRoots:
      - ~/Documents/deepseek-harness            # `~` is expanded; siblings in this tree
    readOnlyRoots:
      - /Applications/DeepSeek Harness.app      # read app.asar without a prompt
    allowInlineCode: true                       # permit `node -e` / `python -c` inside the project
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `projectRoots` | `[]` | Extra project roots, merged with the session workspace |
| `includeSessionCwd` | `true` | Treat the session workspace (`session.header.cwd`) as a project root |
| `readOnlyRoots` | `[]` | Extra roots that may be read but never written |
| `includeTempDirs` | `true` | Treat `/tmp` and `os.tmpdir()` as scratch space |
| `resolveSymlinks` | `true` | Resolve symlinks before deciding containment |
| `enforceAskPolicy` | `true` | Switch the session back to the `ask` policy; under `never` every request is rejected before any answerer runs, so no prompt could appear |
| `cacheRoots` | `[]` (built-in) | Roots outside the project whose writes are allowed: package caches, alongside the platform temp area |
| `serializeApprovals` | `true` | At most one outstanding confirmation |
| `prioritizeSystemRequests` | `true` | System-related confirmations take the single slot first |
| `protectSessionAndSystem` | `true` | Deny machine- or session-destroying actions |
| `allowTools` / `askTools` / `denyTools` | `[]` | Add tools to the allow / ask / deny lists |
| `systemCommands` | `[]` | Extra system program names |
| `extraAskPatterns` / `extraAllowPatterns` | `[]` | Extra regular expressions (allow wins over ask) |
| `allowInlineCode` | `false` | Allow `node -e`, `python -c`, `$(…)`, `eval` |
| `verbose` | `false` | Log every decision at debug level |

## Verify

```sh
node --test test/*.test.mjs      # 46 unit and integration tests
node test/cordis-mount.mjs       # mounts the plugin on the real cordis runtime
```

The unit suite pins the three promises (allow / ask / deny), symlink and `..`
escapes, heredoc and redirection parsing, inline code and `eval`, resource
exhaustion, escalation reuse, the impact levels and texts, the one-time
sandbox raise, and the single-slot
queue (no overlap, system priority, abort, unload). The mount script proves
`ctx.effect(function* …)` teardown, `{ prepend: true }` ordering and the
`ctx.waterfall` contract against the installed runtime.

## Limitations

- Containment is judged from the tool name, its arguments and the command text.
  `allowInlineCode: true` and variables used as paths weaken that guarantee by
  design.
- The impact analysis is a rule table, not a simulation: it names the
  consequences the plugin has a rule for, and a consequence with no rule stays
  unmentioned even though it may still happen. The level is a hint for ranking
  your attention, not a guarantee of severity.
- It governs the Host tool calls it can see. Subagents run their own sessions;
  their approvals still pass through the same queue, so "one at a time" holds
  across them.
- Direct Node side effects inside a `run_code` program bypass inner-tool review,
  which is why `run_code` asks by default.
- Other policy plugins still apply. The guard runs first and only *delegates*
  on allow, so a `tools/pre-execute` listener from another plugin — the LLM Auto
  review mode, or a Codex/Claude hook — can still deny or ask about an in-project
  call. Keep the session on a preset without the Auto reviewer when you want
  in-project work to stay prompt-free.
- The guard judges intent from the tool name, its arguments and the command
  text. It never rewrites the session's sandbox, so the mode you pick stays the
  mode you get — and inside the workspace the sandbox, not this plugin, is what
  confines a command.
- Because reads and network traffic are never gated, an uninspected command can
  still move data outward. This guard protects the machine and other programs,
  not the confidentiality of what the agent reads.
- The approval policy must be `ask` for confirmations to be possible;
  `enforceAskPolicy` keeps it there while the guard is active.

## Files

| File | Role |
|---|---|
| `index.js` | Plugin entry: the gate, the approval answerer, the lifecycle |
| `lib/classify.js` | Policy engine and the rule tables |
| `lib/shell-parse.js` | Conservative shell reader (segments, redirects, heredocs, indirection) |
| `lib/path-utils.js` | `~` expansion and symlink-aware containment |
| `lib/approval-queue.js` | The single-slot FIFO with system priority |
| `cordis.patch.yml` | The profile row and its shipped defaults |
| `test/` | Unit, integration and real-runtime mount tests |

## License

MIT
