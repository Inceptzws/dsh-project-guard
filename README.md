# dsh-project-guard

[中文说明](README.zh.md) | **English**

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
makes permissions **project-scoped**: work inside this project runs with full
access and no prompts, while everything outside it — and every system-level
call — is confirmed by you, **one prompt at a time**.

It is a Host plugin: zero dependencies, no imports of any Harness package, no UI
code, and no build step. `index.js` plus four small modules is the whole plugin.

---

## What it guarantees

| Requirement | How the plugin delivers it |
|---|---|
| Automatic full permissions **only inside this project** | Calls that are provably confined to the session workspace, the configured extra roots or the platform temp area pass straight through — including the sandbox escalation a tool needs to run with `danger-full-access` |
| Anything unrelated to the project needs your confirmation | Paths outside the project, commands that reach outside it, and unknown tools become one confirmation |
| Every system-related call or change needs your confirmation | `sudo`, `launchctl`, `defaults`, `networksetup`, `ifconfig`, `pmset`, `diskutil`, `softwareupdate`, `spctl`, `sysctl`, `ps`, `lsof`, `kill`/`killall`/`pkill`, `brew`, `pip`, `osascript`, `open`, `curl`/`ssh`/`gh`/`docker`, and more |
| Other programs must keep working | Commands that can starve the machine or occupy a shared resource ask first: `dd if=/dev/zero`, `yes >`, unbounded loops, `stress`, `python -m http.server` |
| Only one confirmation may be outstanding | A single-slot queue in front of the approval seam; system-related requests take the slot before ordinary ones |
| Every confirmation explains the downside | Each prompt carries a deterministic impact analysis: a level plus the concrete adverse outcome of saying yes |

### How the project gets full permission

"Automatic full permission" cannot be left to the sandbox's escalation path: the
Harness only escalates when a tool call *asks* for it (`sandbox_permissions`), so
a plain in-project write that falls outside the session's sandbox root fails
first and is retried — the guard looks uninvolved, and sibling project
directories stay walled off.

Instead the guard raises the sandbox once per session, through the same durable
write `dsh-sandbox-policy` itself uses (`session.append('sandbox/mode', …)`),
and that is the documented path the file sandbox and the bash sandbox both
resolve per call. From then on:

- **in-project work runs with full permission and no prompt** — including writes
  to the sibling project directories you configured;
- **the guard is what decides**, on every call, because it already sees all of
  them at `tools/pre-execute`;
- setting `elevateInProject: false` restores the old behaviour (sandbox stays the
  backstop, so out-of-root in-project calls fail once and rely on a retry with
  `sandbox_permissions`, which the guard auto-approves).

The raise happens once per session and only from the shipped default mode
(`elevateFromMode: workspace-write`), so a preset you deliberately chose — for
example `read-only` — is never overwritten. The trade-off is explicit: with the
session at full access, the guard is the only control, which is why its
classification fails closed and the destructive rules deny rather than ask.

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

## How a call is decided

For every tool call, on the `tools/pre-execute` waterfall:

1. **Inside the project → allow.** If the call asks to escalate its sandbox
   (`sandbox_permissions`), the plugin grants that escalation silently. A
   confirmed call never produces a second prompt.
2. **Outside the project, system-level, or undecidable → ask.** The user decides.
   After an approval, a later escalation of the *same* call reuses that grant.
3. **Machine- or session-destroying → deny.** Formatting a disk, deleting from
   `/`, deleting the home directory, powering the machine off, **turning Wi-Fi
   off**, bringing an interface down, killing `WindowServer`/`launchd`/`Finder`,
   `kill -9 1`, a fork bomb, or killing the running Harness. A confirmation for
   these can never be delivered, because the action destroys the session that
   would show it (the "Wi-Fi off breaks my train of thought" case). Set
   `protectSessionAndSystem: false` to downgrade them to confirmations.

Everything else **fails closed**: unreadable commands (`$(…)`, backticks,
`eval`, `node -e`, `python -c`, unbalanced quotes), unknown tools, and `$VAR`
used as a path all ask first.

### Decision table (defaults)

**Allow silently**

- `read` / `read_image` / `glob` / `grep` under a project root; `write` / `edit`
  under a writable root
- `pnpm` / `npm` / `yarn` / `bun` project subcommands; `node`, `python`, `swift`,
  `make`, `cargo build`, `go test`, `pytest`, `tsc`, …
- `git add` / `commit` / `checkout` / `diff` / `stash` / …; `mkdir`, `cp`, `mv`,
  `rm` inside the project; scratch files in `/tmp`
- Session and read-only tools: `todo_write`, `ask_user_question`, `present`,
  `skill`, `job_*`, `web_search`, `web_fetch`, `cordis_inspect_*`

**Ask**

- Any path outside the project
- System: `sudo`, `launchctl`, `defaults`, `systemsetup`, `scutil`,
  `networksetup`, `ifconfig`, `ip`, `pfctl`, `pmset`, `diskutil`,
  `softwareupdate`, `spctl`, `csrutil`, `sysctl`, `system_profiler`, `lsof`,
  `netstat`, `ps`, `kill`, `killall`, `pkill`, `brew`, `pip`, `conda`,
  `osascript`, `open`, `xargs`, `updatedb`
- External: `curl`, `wget`, `ssh`, `scp`, `rsync`, `git push|pull|fetch|clone|remote`,
  `gh`, `aws`, `gcloud`, `docker`, `kubectl`, `npx`, `pipx`
- Shared state: `npm publish`, `npm -g`, `npm cache clean`, `git config --global`
- Resource abuse: `dd if=/dev/zero`, `yes >`, `cat /dev/zero`, `mkfile`,
  `fallocate`, `truncate`, `stress`, `while true`, `python -m http.server`
- Orchestration and plugins: `plugin_manager`, `subagent`, `workflow`,
  `spawn_teammate`, `schedule_*`, `run_code`, and any unknown tool

**Deny**

- `rm -rf /`, `rm -rf ~`, `rm -rf $HOME`
- `mkfs`, `newfs`, `fdisk`, `gpt`, `dd … of=/dev/…`, `diskutil eraseDisk`
- `shutdown`, `reboot`, `halt`
- `networksetup -setairportpower … off`, `ifconfig … down`, `ip link set … down`,
  `pfctl -d`, `wg-quick down`
- `killall WindowServer|loginwindow|launchd|Finder|Dock|mDNSResponder|configd`,
  `kill -9 1`, `pkill -f "DeepSeek Harness"`, fork bombs

## Install

The bundle lives in this directory and is a standard Harness bundle: its
`package.json` declares `dsh.bundle.patch` and it has no dependencies.

### Desktop app (recommended)

The `desktop` profile is owned exclusively by the Electron app, so its plugins
are installed from the app itself:

1. Open **Settings → Plugins** (设置 → 插件).
2. Choose **Install bundle** and pick the absolute package directory:
   `/Users/inception/Documents/deepseek-harness/default-workspace/dsh-project-guard`
   (any checkout path works).
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
| `elevateInProject` | `true` | Raise the session sandbox once, so in-project work runs with full permission without waiting for a tool to request an escalation |
| `elevateFromMode` | `workspace-write` | Only raise a session whose sandbox is still at this mode, so a deliberately chosen narrower preset is respected |
| `elevatedMode` | `danger-full-access` | The mode an in-project session is raised to |
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
node --test test/*.test.mjs      # 47 unit and integration tests
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
- With `elevateInProject` on (the default) the session runs at full access, so
  inside the project the sandbox is no longer a second opinion: the guard's
  classification is the control. Set it to `false` to keep the sandbox as the
  backstop and accept the failed-then-escalated retry for out-of-root paths.
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
