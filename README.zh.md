# dsh-project-guard · 项目守卫

**中文** | [English](README.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：
**保留你自己选的沙箱模式**，只判定调用**额外申请的权限**。工作区内的操作完全不经过
插件——沙箱本身已经把它管住了。当某个调用想要超出该模式的权限时，判断标准是"会不会
损坏计算机、或让别的程序没法正常用"：读取、网络通信、上传、临时文件与包缓存放行；
改动系统状态或写入项目之外，由你确认一次，并附上后果分析；会毁机器或断会话的动作
直接拒绝。同一时刻最多只有一条确认。

它是一个 Host 插件：零依赖、不 import 任何 Harness 包、没有 UI 代码、不需要构建。
`index.js` 加五个小模块就是全部。

---

## 亮点：不问"能不能做"，而问"做了会让你失去什么"

已有的安全机制回答的是另外三个问题：**能不能做**（授权）、**能在哪做**（沙箱）、
**有多危险**（风险评分）。它们都不告诉你，这条命令落到**你**身上到底意味着什么。
本插件补的就是这一层——**后果分析**，并把三层关系摆进同一次确认里：

| 关系 | 它要回答的问题 | 例子 |
|---|---|---|
| **你 ↔ 设备** | 这条命令会不会让机器或别的程序没法正常用？ | 关 Wi-Fi → 连承载这次对话的模型服务一起断；`killall` → 别人正在用的程序直接死；写满磁盘 → 所有程序都写不进去 |
| **agent ↔ 你** | 它正以你的名义把什么承诺出去？ | 委派给子智能体 → 后续步骤不再逐条给你看、额度由它花；`git push --force` → 远端别人的提交一起没；全局安装 → 共享依赖被带着升级 |
| **你 ↔ 广泛的利益** | 这一步会不会碰到设备之外的东西？ | 密钥/令牌外发、真金白银的下单、受监管数据出境、以你名义发布或发消息、绕开证书与条款防护 |

**判定不是猜的。** 它先采集状态（有无未提交改动、有无近期备份、目标是不是密钥库、
是不是与他人共享的位置……），再按规则推后果：同一句 `rm`，目标有未提交改动时判
"不可恢复的成果丢失"，干净且无备份时走另一条规则；谓词判定不了时**不会**当成"没问题"，
而是写进"未检查/无法判定"——不把未知渲染成已知。

**利益范围是开放的。** 内置 21 个维度，分七组：成果与数据、机器可用性、共享环境、
权限与凭据、账号、额度与金钱、金融持仓、隐私与身份、声誉、关系、法律、合规、
知识产权、职业义务、伦理……并且允许你**自定义维度**：

```yaml
interests:
  我的健康数据:
    weight: 0.95
    tier: 1
    label: my health records
```

因为可计算程度不同，每个维度按三级处置：**Tier 1** 从采集到的状态算出；
**Tier 2** 只给带明确不确定性的**推断**（在确认里标注"推断（未核实）"，置信度压上限）；
**Tier 3** 只**标记**、不预测也不替你裁决。这是有意为之：把价值判断伪装成计算结果，
比不说更糟。

**而且它很安静。** 默认只在**完全权限**下、且某个调用正在**向你额外申请授权**时才做后果分析；
工作区内的正常操作完全不分析。噪音本身就是安全问题——它会训练你闭眼点"允许"。

## 它保证什么

| 需求 | 插件怎么做到 |
|---|---|
| 自动完全权限**仅限本项目** | 能证明落在会话工作目录、配置的额外根目录、平台临时目录内的调用直接放行——包括工具为获得 `danger-full-access` 而发起的沙箱提权 |
| 任何与本项目无关的其他工作必须本人确认 | 项目外路径、会伸到项目外的命令、未知工具，统一转成一次人工确认 |
| 与系统相关的任何调用、变动必须本人确认 | `sudo`、`launchctl`、`defaults`、`networksetup`、`ifconfig`、`pmset`、`diskutil`、`softwareupdate`、`spctl`、`sysctl`、`ps`、`lsof`、`kill`/`killall`/`pkill`、`brew`、`pip`、`osascript`、`open`、`curl`/`ssh`/`gh`/`docker` 等 |
| 不能让其他程序无法正常使用 | 会占满机器或抢占共享资源的命令先确认：`dd if=/dev/zero`、`yes >`、死循环、`stress`、`python -m http.server` |
| 请求的许可一次只能出现一条 | 审批通道前加**单槽队列**；系统相关的请求优先占用这个槽位 |
| 每条确认都说明"答应之后会怎样" | 每条提示都附一份确定性的影响分析：等级 + 具体的不良结果 |

### 什么时候会走插件，什么时候不会

选择器里的三种模式就是起点：

| 会话模式 | 插件做什么 |
|---|---|
| **工作区内修改**（默认） | 完全不参与；只有某个调用申请超出工作区的提权时才介入。这个"额外授权"由插件判定：项目内、不影响机器的直接放行，改系统或写项目外要确认，破坏性的直接拒绝 |
| **完全权限** | 每个调用都过一遍，因为此时什么都可能碰到系统。项目内的工作依旧不弹窗，其余按影响判定 |
| **仅可查看** | 与工作区内修改相同：只有提权请求才会让插件介入 |

插件**从不改动会话的沙箱模式**——你选什么就是什么；它改的是"某个调用想要更多权限时，
哪些必须问你"。

判断标准是"会不会损坏计算机、或让别的程序没法正常用"，而不是"在不在项目里"：

- **直接放行** — 任何位置的读取、`curl`/`wget`/`ssh`/`git push`/上传、临时文件、
  包缓存（`~/.npm`、`~/Library/Caches` 等）、项目内写入、只读系统查询
  （`ps`、`sw_vers`、`lsof`）；
- **需要确认** — 改动系统状态（`sudo`、`launchctl`、`defaults`、`networksetup`、
  `pmset`、`diskutil`、`kill`、全局安装）、写入项目之外、资源耗尽、抢占端口；
- **直接拒绝** — 会毁机器或断会话的动作。

### 一次调用是怎么被判定的

插件介入后，在 `tools/pre-execute` 瀑布上：

1. **不影响机器 → 放行。** 项目内工作、任何位置的读取、网络与上传、临时文件与包缓存；
   如果这次调用为此申请了提权，插件静默批准这次提权。
2. **可能影响机器或其他程序 → 确认。** 改动系统状态、写入项目之外；由你决定，
   弹窗里带影响分析。
3. **会毁机器或断会话 → 拒绝。** 格式化磁盘、删文件系统根目录、删家目录、关机重启、
   **关闭 Wi-Fi**、把网卡拉下来、杀掉 `WindowServer`/`launchd`/`Finder`、
   杀掉 init、fork 炸弹、杀掉正在运行的 Harness。这些操作一旦执行，
   承载"确认弹窗"的会话本身就没了。想改成"只确认不拒绝"，把
   `protectSessionAndSystem` 设为 `false`。

读不懂的仍然**失败即确认**：命令替换、反引号、`eval`、`node -e`、`python -c`、
引号不配对、未知工具、把 `$VAR` 当路径用。

### 规则一览（默认，仅在插件介入时）

**直接放行**：任何读取（`read`/`read_image`/`glob`/`grep`、`cat`、`ls`、`ps`、`sw_vers`、`lsof`）；
网络与上传（`curl`、`wget`、`ssh`、`scp`、`rsync`、`git push|pull|fetch|clone`、`gh`、`aws`、
`gcloud`、`docker`、`kubectl`、`npx`、`npm publish`、`npm cache`）；项目内写入与构建测试；
临时目录与包缓存；会话内工具（`todo_write`、`ask_user_question`、`present`、`skill`、`job_*`、
`web_search`、`web_fetch`、`cordis_inspect_*`）。

**需要确认**：项目外写入（任何 `write`/`edit` 到项目外、重定向到系统路径、`rm` 其他项目、
拷到桌面、`tee /etc/...`、`chmod -R 777 /`、`find / -delete`）；系统状态（`sudo`、`launchctl`、
`defaults`、`systemsetup`、`scutil`、`networksetup`、`ifconfig`、`ip`、`pfctl`、`pmset`、
`diskutil`、`softwareupdate`、`sysctl`、`mdutil`、`kill`/`killall`/`pkill`、`brew`、`pip`、
`conda`、`osascript`、`open`、`xargs`、`crontab`）；共享环境（`npm install -g`、
`git config --global`）；资源耗尽与抢占端口；无法检查的命令与未知工具。

**直接拒绝**：删文件系统根目录、删家目录、格式化/分区磁盘、向块设备写原始数据、
`diskutil eraseDisk`、关机重启、关闭 Wi-Fi、把网络接口拉下来、`pfctl -d`、
杀掉核心系统进程、杀 init、杀掉正在运行的 Harness、fork 炸弹。

## 为什么"一次一条"不是小事

Harness 每个会话只展示**一个**待处理审批：新的请求会在输入框位置**顶替**旧的，
而不是排在它后面（`dsh-client-ui-session` 保留全部待处理交互，但每会话只发布一个
可见槽位，`dsh-client-ui-approval` 注册审批优先级）。所以两条审批同时发出时，
先出现的那条就再也答不了了。本插件把 `approval/request` 排在最前面，保证
"提出来的永远只有一条"。

### 每条确认都会说明"答应之后会怎样"

只问"是否允许"等于让你猜。每条确认都带一份**确定性**（查表得出，不是模型生成）
的影响分析：等级 + 具体的不良结果。

- **高** — `ifconfig en0 down`：本机断网，连承载这次对话的模型服务也一起断；
  会话会直接失联，且只有你能把网络恢复回来。
- **中** — `brew install jq`：全局安装软件包，可能连带升级共享依赖，
  让其他项目或命令行工具失效。
- **低** — `sw_vers`：只读取系统版本，不改动任何东西。
- **未知** — `node -e "…"`：内联代码无法检查，真实影响不可知，
  副作用可能超出这条命令看起来的范围。

等级由判定类别决定；对系统命令还会按具体程序细化（`sudo`、`launchctl`、
`defaults`、`kill`、`diskutil`、`pip`、`osascript`…）。直接拒绝时同样写明后果，
让模型知道被拒的原因。

## 后果披露层：机制

- **规则集是声明式的**，全部在 [`rules/consequences.yml`](rules/consequences.yml)
  （**34 条规则**，覆盖文件、进程、网络、服务、凭据/账号、金融、声誉/关系、法律/合规、
  知识产权与价值判断），schema 与"怎么加一条规则"见 [rules/README.md](rules/README.md)。
- **触发是克制的**：默认（`discloseOn: full-access-asks`）只在**完全权限**下、且这次调用
  正在**向你额外申请授权**（`sandbox_permissions`）时才做分析；工作区内的正常操作一律不分析。
  想更宽可以设 `discloseOn: asks`（任何需要你确认的调用）或 `all`（所有规则涉及的动作）。
- **Preview（决定前）**：确认里给出动作 / 当前状态 / 后果（生活层面一句话）/
  受影响利益与权重 / 严重度与可恢复性 / 置信度与**已检查范围** / **各选项的损失**
  （含拒绝的机会成本、先备份再执行）。
- **Report（执行后，默认关闭）**：打开 `reportExecuted` 后，被放行的动作会在工具结果后
  附一段执行后披露，写明**预测 vs 观察**（命中 / 误报 / 未预测到）与恢复建议；
  默认关闭是因为"每条动作都说一句"本身就是噪音。
- **相关性排序**：每条后果按 `r(e) = w·l·κ·ν` 打分（损失按可恢复性折算），
  只展示 top-k 且超过阈值的；低于阈值完全安静。值判断类（Tier 3）只作标记、不参与打分。
- **标定记录**：产生 Report 时追加一行 JSONL 到 `.dsh-project-guard/reports.jsonl`，
  含动作类型、路径、预测、观察、覆盖率与当时的兴趣权重，**不含文件内容**——
  这正是论文评测里"预测 vs 观察"标定所需要的证据。

配置项：`disclose`（总开关）、`discloseOn`（`full-access-asks` / `asks` / `all`）、
`attentionBudget`（预算 k，默认 2）、`relevanceThreshold`（阈值 τ，默认 0.3）、
`reportMinSeverity`（Report 的最低严重度，默认 high）、`reportExecuted`、
`reportDir`、`interests`（声明或新增你的利益维度与权重）、`rulesFile`（换成你自己的规则集）。

## 安装

## 安装

这是一个标准 Harness bundle：`package.json` 里声明了 `dsh.bundle.patch`，
没有任何依赖，也不需要构建。

### 从 npm 安装（任何人，推荐）

已发布到 npm：[`dsh-project-guard`](https://www.npmjs.com/package/dsh-project-guard)

```sh
dsh plugin --profile <profile> add dsh-project-guard
# 卸载：
dsh plugin --profile <profile> remove dsh-project-guard
```

### 从 GitHub 安装

```sh
dsh plugin --profile <profile> add github:Inceptzws/dsh-project-guard
```

这条命令会安装包并选中它的 bundle。确认组合结果：

```sh
dsh --profile <profile> --dump-config | grep -A14 project-guard
```

`dsh` 需要 Node 24 以上（要用 `import.meta.main`）；App 自带的运行时可以直接用：

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" \
  /opt/homebrew/bin/dsh plugin --profile web add dsh-project-guard
```

### 桌面 App（推荐）

`desktop` 配置由 Electron App 独占管理，所以它的插件要从 App 内安装：

1. 打开 **设置 → 插件**（Settings → Plugins）。
2. 选择 **安装 bundle / Install bundle**，填入 `dsh-project-guard`
   （或 `github:Inceptzws/dsh-project-guard`，或本地 clone 的绝对路径）。
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

### 手动安装（进阶）

插件页是受支持的路径；它实际执行的是两步：

1. 在 `$DSH_HOME/profiles/<profile>` 里执行 `pnpm add link:<bundle 绝对路径>`
2. 把 bundle 名字追加到该 profile 的 `dsh.profile.bundles`（只加依赖不够，
   必须列进 bundles 才会被组合）

然后用 `dsh --profile <profile> --dump-config` 确认组合结果。`desktop` profile
会拒绝来自 Electron App 之外的一切 CLI 调用，所以那种情况只能走插件页。

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
      - ~/Documents/deepseek-harness            # 支持 `~`；这个目录下的兄弟项目也算本项目
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
| `cacheRoots` | `[]`（内置） | 项目之外允许写入的目录：包缓存（与平台临时区一起），空表示用内置列表 |
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
node --test test/*.test.mjs      # 46 个单元与集成用例
node test/cordis-mount.mjs       # 在真实 cordis 运行时上挂载插件
```

单元测试钉住了三类判定（放行/确认/拒绝）、软链接与 `..` 逃逸、heredoc 与重定向
解析、内联代码与 `eval`、资源耗尽、提权授权复用、影响等级与文案、沙箱一次性提升，
以及单槽队列
（并发不重叠、系统优先、可中止、卸载可释放）。挂载脚本在已安装的真实运行时上验证
`ctx.effect(function* …)` 的卸载、`{ prepend: true }` 的顺序和 `ctx.waterfall` 合约。

## 已知限制

- 判定依据是工具名、参数和命令文本。`allowInlineCode: true`、以及把变量当路径用，
  会按设计削弱这层保证。
- 影响分析是一张规则表，不是仿真：它只会写出插件有规则覆盖的后果，没有规则的
  后果仍可能发生却不被提及。等级只是帮你排优先级的提示，不是严重程度的保证。
- 它管得住它能看到的 Host 工具调用。子代理有自己的会话，但审批仍走同一条队列，
  所以"一次一条"对它们同样成立。
- `run_code` 程序内部直接调用 Node API 的副作用不经过内层工具审查，因此默认按
  "确认"处理。
- 其他策略插件依然生效。守卫先跑，放行时只是**委托**给后续监听器，所以别的插件
  （例如 LLM 的 Auto 审查模式、Codex/Claude hook）仍可能对项目内调用拒绝或提问。
  想让项目内工作彻底不弹窗，就别把会话切到带 Auto 审查的 preset。
- 守卫是根据工具名、参数和命令文本判断影响的。它从不改写会话的沙箱模式，所以
  你选什么模式就是什么模式；工作区内的约束来自沙箱，而不是这个插件。
- 因为读取和网络通信永不拦截，一条未被检查的命令仍可能把数据送出去。这个守卫保护的是
  计算机和其他程序的正常使用，而不是代理读到内容的机密性。
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
