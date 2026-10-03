# dsh-project-guard · 项目守卫

**中文** | [English](README.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：
把权限**按项目范围**收紧——本项目内的工作自动获得完全权限、不再弹窗；本项目之外
以及所有系统级调用，都由你确认，而且**同一时刻只出现一条确认**。

它是一个 Host 插件：零依赖、不 import 任何 Harness 包、没有 UI 代码、不需要构建。
`index.js` 加四个小模块就是全部。

---

## 它保证什么

| 需求 | 插件怎么做到 |
|---|---|
| 自动完全权限**仅限本项目** | 能证明落在会话工作目录、配置的额外根目录、平台临时目录内的调用直接放行——包括工具为获得 `danger-full-access` 而发起的沙箱提权 |
| 任何与本项目无关的其他工作必须本人确认 | 项目外路径、会伸到项目外的命令、未知工具，统一转成一次人工确认 |
| 与系统相关的任何调用、变动必须本人确认 | `sudo`、`launchctl`、`defaults`、`networksetup`、`ifconfig`、`pmset`、`diskutil`、`softwareupdate`、`spctl`、`sysctl`、`ps`、`lsof`、`kill`/`killall`/`pkill`、`brew`、`pip`、`osascript`、`open`、`curl`/`ssh`/`gh`/`docker` 等 |
| 不能让其他程序无法正常使用 | 会占满机器或抢占共享资源的命令先确认：`dd if=/dev/zero`、`yes >`、死循环、`stress`、`python -m http.server` |
| 请求的许可一次只能出现一条 | 审批通道前加**单槽队列**；系统相关的请求优先占用这个槽位 |

## 为什么"一次一条"不是小事

Harness 每个会话只展示**一个**待处理审批：新的请求会在输入框位置**顶替**旧的，
而不是排在它后面（`dsh-client-ui-session` 保留全部待处理交互，但每会话只发布一个
可见槽位，`dsh-client-ui-approval` 注册审批优先级）。所以两条审批同时发出时，
先出现的那条就再也答不了了。本插件把 `approval/request` 排在最前面，保证
"提出来的永远只有一条"。

## 一次调用是怎么被判定的

每次工具调用都会经过 `tools/pre-execute`：

1. **项目内 → 放行。** 如果这次调用要提权沙箱（`sandbox_permissions`），插件会
   静默批准这次提权。已经被确认过的调用不会再弹第二次。
2. **项目外 / 系统级 / 无法判定 → 确认。** 由你决定。确认通过后，**同一次调用**
   后续的提权请求复用这次授权。
3. **会毁机器或断会话 → 直接拒绝。** 格式化磁盘、`rm -rf /`、删家目录、关机重启、
   **关闭 Wi-Fi**、把网卡 down 掉、杀掉 `WindowServer`/`launchd`/`Finder`、
   `kill -9 1`、fork 炸弹、杀掉正在运行的 Harness。这些操作一旦执行，
   承载"确认弹窗"的会话本身就没了（也就是"关 wifi 导致思维断裂"那种情况）。
   想改成"只确认不拒绝"，把 `protectSessionAndSystem` 设为 `false`。

其余一律**失败即确认**：读不懂的命令（`$(…)`、反引号、`eval`、`node -e`、
`python -c`、引号不配对）、未知工具、把 `$变量` 当路径用，全部先问你。

### 规则一览（默认）

**直接放行**

- 项目根下的 `read` / `read_image` / `glob` / `grep`；可写根下的 `write` / `edit`
- `pnpm` / `npm` / `yarn` / `bun` 的项目内子命令；`node`、`python`、`swift`、
  `make`、`cargo build`、`go test`、`pytest`、`tsc` 等
- `git add` / `commit` / `checkout` / `diff` / `stash` 等；项目内 `mkdir`、`cp`、
  `mv`、`rm`；`/tmp` 里的草稿文件
- 会话内与只读工具：`todo_write`、`ask_user_question`、`present`、`skill`、
  `job_*`、`web_search`、`web_fetch`、`cordis_inspect_*`

**需要确认**

- 任何项目外的路径
- 系统类：`sudo`、`launchctl`、`defaults`、`systemsetup`、`scutil`、
  `networksetup`、`ifconfig`、`ip`、`pfctl`、`pmset`、`diskutil`、
  `softwareupdate`、`spctl`、`csrutil`、`sysctl`、`system_profiler`、`lsof`、
  `netstat`、`ps`、`kill`、`killall`、`pkill`、`brew`、`pip`、`conda`、
  `osascript`、`open`、`xargs`、`updatedb`
- 对外访问：`curl`、`wget`、`ssh`、`scp`、`rsync`、`git push|pull|fetch|clone|remote`、
  `gh`、`aws`、`gcloud`、`docker`、`kubectl`、`npx`、`pipx`
- 共享状态：`npm publish`、`npm -g`、`npm cache clean`、`git config --global`
- 资源耗尽：`dd if=/dev/zero`、`yes >`、`cat /dev/zero`、`mkfile`、`fallocate`、
  `truncate`、`stress`、`while true`、`python -m http.server`
- 编排与插件：`plugin_manager`、`subagent`、`workflow`、`spawn_teammate`、
  `schedule_*`、`run_code`，以及任何未知工具

**直接拒绝**

- `rm -rf /`、`rm -rf ~`、`rm -rf $HOME`
- `mkfs`、`newfs`、`fdisk`、`gpt`、`dd … of=/dev/…`、`diskutil eraseDisk`
- `shutdown`、`reboot`、`halt`
- `networksetup -setairportpower … off`、`ifconfig … down`、`ip link set … down`、
  `pfctl -d`、`wg-quick down`
- `killall WindowServer|loginwindow|launchd|Finder|Dock|mDNSResponder|configd`、
  `kill -9 1`、`pkill -f "DeepSeek Harness"`、fork 炸弹

## 安装

本目录就是一个标准 Harness bundle：`package.json` 里声明了 `dsh.bundle.patch`，
没有任何依赖。

### 桌面 App（推荐）

`desktop` 配置由 Electron App 独占管理，所以它的插件要从 App 内安装：

1. 打开 **设置 → 插件**（Settings → Plugins）。
2. 选择 **安装 bundle / Install bundle**，选中本目录的绝对路径：
   `/Users/inception/Documents/deepseek-harness/default-workspace/dsh-project-guard`
   （任何 clone 路径都可以）。
3. 插件页会显示安装结果和警告，出现 `project-guard` 行，并且立即生效。

### 其他 profile（web、tui、自建）

```sh
dsh plugin --profile web add /absolute/path/to/dsh-project-guard
# 卸载：
dsh plugin --profile web remove dsh-project-guard
```

`dsh` 需要 Node 24 以上（要用 `import.meta.main`）；App 自带的运行时可以直接用：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" \
  /opt/homebrew/bin/dsh plugin --profile web add /absolute/path/to/dsh-project-guard
```

### 确认组合结果

```sh
dsh --profile web --dump-config | grep -A14 project-guard
```

应当能看到 `# == dsh-project-guard` 层，以及带你的配置的 `project-guard` 行。

## 配置

安装前改本包 `cordis.patch.yml` 里的 `config`，或在你自己 profile 的 patch 层里按
`id` 覆盖（同 `id` 会整体替换 config）：

```yaml
- id: project-guard
  name: dsh-project-guard
  config:
    projectRoots:
      - /Users/you/Documents/deepseek-harness   # 把这个目录下的兄弟项目也算本项目
    readOnlyRoots:
      - /Applications/DeepSeek Harness.app      # 读 app.asar 不再弹窗
    allowInlineCode: true                       # 项目内允许 node -e / python -c
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `projectRoots` | `[]` | 额外项目根，与会话工作目录合并 |
| `includeSessionCwd` | `true` | 把会话工作目录（`session.header.cwd`）当成项目根 |
| `readOnlyRoots` | `[]` | 只读可放行的额外根（写入仍会确认） |
| `includeTempDirs` | `true` | 把 `/tmp`、`os.tmpdir()` 当草稿区 |
| `resolveSymlinks` | `true` | 判定前解析软链接 |
| `enforceAskPolicy` | `true` | 会话策略不是 `ask` 时改回 `ask`；`never` 下任何请求都会被直接拒绝，根本弹不出确认 |
| `serializeApprovals` | `true` | 同一时刻只有一个确认 |
| `prioritizeSystemRequests` | `true` | 系统相关的确认优先占用槽位 |
| `protectSessionAndSystem` | `true` | 拒绝"毁机器/断会话"的动作 |
| `allowTools` / `askTools` / `denyTools` | `[]` | 按工具名增删放行 / 确认 / 拒绝 |
| `systemCommands` | `[]` | 追加系统程序名 |
| `extraAskPatterns` / `extraAllowPatterns` | `[]` | 追加正则（放行优先于确认） |
| `allowInlineCode` | `false` | 允许 `node -e`、`python -c`、`$(…)`、`eval` |
| `verbose` | `false` | 每次判定写 debug 日志 |

## 验证

```sh
node --test test/*.test.mjs      # 38 个单元与集成用例
node test/cordis-mount.mjs       # 在真实 cordis 运行时上挂载插件
```

单元测试钉住了三类判定（放行/确认/拒绝）、软链接与 `..` 逃逸、heredoc 与重定向
解析、内联代码与 `eval`、资源耗尽、提权授权复用，以及单槽队列（并发不重叠、
系统优先、可中止、卸载可释放）。挂载脚本在已安装的真实运行时上验证
`ctx.effect(function* …)` 的卸载、`{ prepend: true }` 的顺序和 `ctx.waterfall` 合约。

## 已知限制

- 判定依据是工具名、参数和命令文本。`allowInlineCode: true`、以及把变量当路径用，
  会按设计削弱这层保证。
- 它管得住它能看到的 Host 工具调用。子代理有自己的会话，但审批仍走同一条队列，
  所以"一次一条"对它们同样成立。
- `run_code` 程序内部直接调用 Node API 的副作用不经过内层工具审查，因此默认按
  "确认"处理。
- 它不替代宿主沙箱：沙箱仍是最后一道兜底，本插件只决定"要不要问你"。
- 要能弹出确认，审批策略必须是 `ask`；`enforceAskPolicy` 会在守卫生效期间保持它。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 插件入口：判定门、审批应答器、生命周期 |
| `lib/classify.js` | 策略引擎与规则表 |
| `lib/shell-parse.js` | 保守的 shell 解析（分段、重定向、heredoc、间接调用） |
| `lib/path-utils.js` | `~` 展开与解析软链接的包含判断 |
| `lib/approval-queue.js` | 带系统优先级的单槽 FIFO |
| `cordis.patch.yml` | profile 行与默认配置 |
| `test/` | 单元、集成与真实运行时挂载测试 |

## 许可

MIT
