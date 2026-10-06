# dsh-project-guard · 项目守卫

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23187648.svg)](https://doi.org/10.5281/zenodo.23187648)

**📄 Preprint: [Decision-Relevant Consequence Disclosure in Complex Computing Systems: Towards Informed Agent Execution](https://doi.org/10.5281/zenodo.23187648)**

**中文** | [English](README.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：**在 agent 动你的机器之前与之后，把"这次动作会让你失去什么"讲清楚**。

它是上面这篇论文第 6.2 节所述**原型适配器**的实现：同样的 `analyze` / `preview` / `report` 三个接口（§4.6）、六族后果规则系统（§4）、Preview 与 Report 两种披露模式（§5.1）。全部判定是**确定性查表**，不调用任何模型；零依赖、不 import 任何 Harness 包、无构建步骤。

---

## 一、决策缺的不是许可，是后果

论文 §1.4 指出，现有机制回答的是另外三个问题：

| 机制 | 回答的问题 |
|---|---|
| 授权（authorization） | 这个动作**可以**做吗 |
| 沙箱（sandboxing） | 它**可以在哪里**做 |
| 风险评分（risk assessment） | 它**有多危险** |

它们都不回答：**它对你意味着什么**。而 §3.4 的"结果可见性不对称"让这件事更麻烦——任务是否成功总是看得见，损失却常常无声无息（silent loss）。于是在"运行成功"的样本里，真实损失被系统性低估（Proposition 1）：

$$\mathrm{SLR} = (1-\delta)\cdot P(l^*=1 \mid s=1)$$

本插件就是补这一层的原型：**把后果披露出来，让决策在有信息的状态下发生**。

---

## 二、它如何帮助你的决策

**1. 决策前给你 Preview（§5.1、§5.3）。** 当一个调用正在向你**额外申请权限**时，确认里给出的不只是"允许 / 拒绝"，而是：动作、**采集到的当前状态**、后果（生活层面一句话）、受影响的利益、严重度与**可恢复性**、**置信度与已检查范围**、以及**每个选项各自的损失**。目标是让你在时间压力、注意力不足的条件下（论文所说的"受压决策"），尽量接近**反思性决策** $D_R^*$。

**2. 决策后给你 Report（默认关闭，可开）。** 放行的动作若命中规则，会在工具结果后附一段执行后披露：**预测 vs 观察**（命中 / 误报 / 未预测到）＋恢复建议。静默损失因此能被注意到、被缓解、被恢复，而不是永远没人知道。

**3. 给你选项，而不是只给警告（§3.5）。** 拒绝不是零成本——它在任务目标上有机会成本。所以 Preview 会同时列出「执行 / 拒绝 / 先备份再执行 / 换一种写法」各自的损失。只警告执行，会退化成"什么都拒绝"的退化策略。

**4. 只讲决策相关的，不讲全部（§3.6、§4.4）。** 每条后果按

$$r(e) = w_j \cdot l_j(e) \cdot \kappa_e \cdot \nu_e,\qquad l_j = (1-\rho_j)L_j + r_j$$

打分，只展示 top-k 且 $r(e)\ge\tau$ 的；低于阈值**一句话都不说**。这条设计来自 §2 的直接动机：警告越多，人越会闭眼点过（Egelman 等；Akhawe & Felt；Johnson & Goldstein；Turan 关于"审查容量与疲劳"的分析）。**沉默是设计的一部分，不是遗漏。**

**5. 同一个动作，状态不同则后果不同（§3.3 的例子）。** `delete(project.db)`：有近期备份时 $l\approx 0$，没有备份时 $l$ 很大。所以判定是 $C, S, U \to \Delta U$，而不是 $C \to$ 风险——这正是本插件的核心。

**6. 宁可说"不知道"，也不假装知道。** 判定不了的谓词不会被当作"没问题"，而是写进**未检查 / 无法判定**；置信度按利益维度分级设上限；价值判断只标记、不预测、不裁决。

---

## 三、框架 → 代码

| 论文 | 实现 |
|---|---|
| §4.6 `analyze(action, context) → consequences` | `lib/engine.js` → `lib/rules.js` |
| §4.6 `preview(action, options, context) → disclosure` | `lib/engine.js` + `lib/disclosure.js` |
| §4.6 `report(action, pre_state, post_state) → report` | `lib/report.js`（预测 vs 观察、JSONL 标定记录） |
| §4.2 规则族 1：action rules | `lib/action.js`（工具调用 → 类型化动作：`fs.delete`、`network.egress`、`process.kill`、`api.spend`……） |
| 规则族 2：state rules（声明作用域 $K$） | `lib/state.js`（未提交改动、近期备份、凭据库、共享位置、受监管数据、构建产物……） |
| 规则族 3：interest rules | `lib/interest.js`（21 个内置维度 + 用户自定义维度，带 Tier） |
| 规则族 4：consequence rules | [`rules/consequences.yml`](rules/consequences.yml)（**34 条声明式规则**）+ `lib/rules.js` |
| 规则族 5：selection rules | `lib/select.js`（预算 $k$、阈值 $\tau$、Tier 上限与标记） |
| 规则族 6：disclosure rules | `lib/disclosure.js`（生活层 + 技术层，中英双语） |
| §5.1 Preview / Report 两种模式 | `index.js`：Preview 进 `tools/pre-execute` 的确认弹窗；Report 由 `tools/post-execute` 追加到工具结果 |
| §5.3 预测 vs 观察的记录 | `lib/report.js` → `.dsh-project-guard/reports.jsonl`（标定证据，**不含文件内容**） |

规则集的 schema、谓词表、Tier 表、以及"怎么加一条规则"见 [`rules/README.md`](rules/README.md)。

---

## 四、利益维度与 Tier（§3.2）

论文强调：**利益比设备上的数据宽得多**——账号、凭据及其范围、额度与余额、第三方服务、委派关系、声誉、法律义务。本插件内置 **21 个维度、七组**，并且**接受你自定义的维度**：

| 组 | 维度 |
|---|---|
| 成果与设备 | `data_work`、`availability`（机器与别的程序还能否正常用）、`environment`、`task_goal`、`schedule` |
| 权限与身份 | `authority_delegation`、`credentials`、`accounts`、`privacy` |
| 经济与金融 | `economic`、`finance_money`、`finance_market`、`business_ops` |
| 他人与声誉 | `reputation`、`relationships` |
| 规则与义务 | `legal`、`compliance`、`intellectual_property`、`employment` |
| 价值判断 | `ethical`、`autonomy` |

自定义（不必是我们认识的维度）：

```yaml
interests:
  我的健康数据:
    weight: 0.95
    tier: 1
    label: my health records
```

可计算程度不同，处置方式就不同——**这一条在 `lib/select.js` 里强制，不靠规则作者自觉**：

| Tier | 处置 |
|---|---|
| **1** | 由采集到的状态算出，正常计分 |
| **1-2** | 可算，但含义需要上下文；置信度上限 0.6 |
| **2** | 只给**推断**：标注「推断（未核实）」，置信度上限 0.5 |
| **2-3** | 标记 + 明确的价值判断提示；置信度上限 0.4 |
| **3** | **只标记**：不计分、不排序、不裁决 |

理由写在 `rules/README.md` 里：**把价值判断包装成计算结果，比不说更糟。**

---

## 五、触发条件：安静是设计的一部分

默认只在**完全权限**下、且某个调用**正在向你额外申请授权**时做后果分析：

| 情形 | 是否分析 |
|---|---|
| 工作区内的正常操作（任何模式） | ❌ 完全不分析 |
| 完全权限下的普通放行 | ❌ 不分析 |
| **完全权限下、调用额外申请授权** | ✅ 分析（Preview） |
| 工作区模式、但**提权到完全权限** | ✅ 分析（Preview） |

想更宽可以设 `discloseOn: asks`（任何需要确认的调用）或 `discloseOn: all`（所有规则涉及的动作，同时启用 Report）。事后 Report 由 `reportExecuted` 单独开关，**默认关闭**——"每条动作都说一句"本身就是噪音。

---

## 六、另一层：权限门

后果披露之外，插件仍保留最初的权限判定（论文也认为授权与隔离依然必要，§8.1）：

- **放行**：读取任意位置、只读系统查询、网络与上传、项目内写入与构建、临时目录与包缓存、会话内工具。
- **确认**：写入项目外、系统状态改动（服务、偏好、网络、电源、磁盘、进程、全局安装）、资源耗尽与抢端口、无法检查的命令与未知工具（**失败即确认**）。
- **拒绝**：会毁掉机器或终止会话本身的动作——格式化磁盘、`rm -rf /`、关机重启、关闭网络接口、杀掉核心系统进程、杀掉 Harness 自身。理由很直接：确认弹窗本身依赖这个会话。

**同一时刻最多一条确认。** Harness 的 Web 端每个会话只投影一个待处理审批（新的会顶替旧的），并发两条会让先出现那条永远答不了。插件在 `approval/request` 最前面放了单槽队列，系统相关请求优先占槽。

---

## 七、安装

```bash
dsh plugin add dsh-project-guard
# 或从源码
dsh plugin add github:Inceptzws/dsh-project-guard
```

桌面 App 请用 设置 → 插件 页面安装（该 profile 由 App 独占管理）。卸载用 `dsh plugin remove dsh-project-guard`。

---

## 八、配置

两层共用一个配置块（`cordis.patch.yml` 里有全部默认值）：

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `projectRoots` / `includeSessionCwd` | `[]` / `true` | 项目根；会话工作区默认算一个 |
| `enforceAskPolicy` | `true` | 保证确认能到达你（策略为 `never` 时弹窗无法出现） |
| `serializeApprovals` / `prioritizeSystemRequests` | `true` / `true` | 单槽队列与系统优先 |
| `protectSessionAndSystem` | `true` | 破坏性动作直接拒绝（可降级为确认） |
| `disclose` | `true` | 后果披露层总开关 |
| `discloseOn` | `full-access-asks` | 何时披露：`full-access-asks` / `asks` / `all` |
| `attentionBudget`（$k$） | `2` | 一次最多展示几条后果 |
| `relevanceThreshold`（$\tau$） | `0.3` | 低于此分完全不打扰 |
| `reportMinSeverity` | `high` | 事后 Report 的最低严重度 |
| `reportExecuted` | `false` | 是否对放行动作追加 Report |
| `reportDir` | `.dsh-project-guard` | 标定记录的落盘目录 |
| `interests` | `{}` | 声明或新增利益维度与权重 |
| `rulesFile` | `""` | 换成你自己的规则集 |

---

## 九、验证

```bash
node --test test/*.test.mjs   # 93 个单元与集成用例
node test/cordis-mount.mjs    # 在真实 cordis 运行时上挂载检查
```

发布前还会验证：`npm pack` 的 tarball 里**必须**含 `rules/consequences.yml`（规则集是运行时从磁盘读的，漏了它插件会没有规则）。CI 的发布工作流把这三件事都当作闸门。

---

## 十、已知限制

- 判定是**命令文本 + 采集状态**的规则匹配，不是沙箱；混淆过的 shell 可以绕过规则。
- 按需求放行了读取与网络通信，因此它**不保护数据不外流**，保护的是"机器与其他程序能否正常用"以及你被承诺出去的东西。
- Tier 2/3 的维度依赖外部知识，只能给带不确定性的推断或标记——这是有意的诚实，不是遗漏。
- 收集器只覆盖本机可观察的状态；余额、持仓、配额等远程状态标注为"未检查"。
- 插件挂在核心管线上（`tools/pre-execute`、`tools/post-execute`、`approval/request`），Harness 的破坏性变更需要跟进。
- 其他策略插件仍然生效：本插件放行时只是**委托**给后续监听器。

---

## 十一、文件

```
index.js                 # 入口：权限门 + 披露触发 + Report 挂载
lib/action.js            # 规则族 1：动作归一化
lib/state.js             # 规则族 2：状态收集器（声明作用域 K）
lib/interest.js          # 规则族 3：利益维度与 Tier
lib/rules.js             # 规则族 4：规则引擎
lib/select.js            # 规则族 5：相关性选择
lib/disclosure.js        # 规则族 6：Preview / Report 渲染
lib/report.js            # 预测 vs 观察 + JSONL 标定记录
lib/engine.js            # analyze / preview / report 三接口
lib/classify.js          # 权限门
lib/impact.js            # 权限门的确定性影响分析
lib/shell-parse.js       # 保守 shell 解析
lib/path-utils.js        # 路径包含判断
lib/approval-queue.js    # 单槽 FIFO
lib/yaml.js              # 零依赖 YAML 子集解析器
rules/consequences.yml   # 34 条声明式规则
rules/README.md          # schema、谓词、Tier、如何加规则
test/                    # 93 个用例 + cordis 挂载检查
```

---

## 十二、引用

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

本仓库是论文第 6.2 节所述的原型适配器；`rules/` 即论文可用性声明中所指的 "code and rule sets"。

## 许可

MIT
