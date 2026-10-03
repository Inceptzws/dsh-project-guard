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

## Why "one at a time" is not cosmetic

Harness projects **one** pending approval per session. A newer request
*replaces* the older one in the composer instead of queueing behind it
(`dsh-client-ui-session` keeps every pending interaction but publishes a single
visible slot per session, and `dsh-client-ui-approval` registers the approval
precedence). Two concurrent approvals therefore make the first one impossible to
answer. This plugin queues `approval/request` in front of the interactive
answerer, so at most one prompt is ever live.

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
      - /Users/you/Documents/deepseek-harness   # sibling projects in this tree
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
node --test test/*.test.mjs      # 38 unit and integration tests
node test/cordis-mount.mjs       # mounts the plugin on the real cordis runtime
```

The unit suite pins the three promises (allow / ask / deny), symlink and `..`
escapes, heredoc and redirection parsing, inline code and `eval`, resource
exhaustion, escalation reuse, and the single-slot queue (no overlap, system
priority, abort, unload). The mount script proves `ctx.effect(function* …)`
teardown, `{ prepend: true }` ordering and the `ctx.waterfall` contract against
the installed runtime.

## Limitations

- Containment is judged from the tool name, its arguments and the command text.
  `allowInlineCode: true` and variables used as paths weaken that guarantee by
  design.
- It governs the Host tool calls it can see. Subagents run their own sessions;
  their approvals still pass through the same queue, so "one at a time" holds
  across them.
- Direct Node side effects inside a `run_code` program bypass inner-tool review,
  which is why `run_code` asks by default.
- It does not replace the host sandbox: the sandbox stays the last line of
  defence, and this plugin only decides whether *you* need to be asked.
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
