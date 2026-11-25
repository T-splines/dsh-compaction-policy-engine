# dsh-compaction-policy-engine

[English](https://github.com/T-splines/dsh-compaction-policy-engine/blob/main/README.en.md) | **简体中文**

**DeepSeek Harness 的按模型上下文压缩策略——三层阈值、热加载与摘要模型选择，构建在官方压缩引擎之上。**

官方 `@deepseek-ai/dsh-compaction-basic` 已经支持阈值、摘要模型，以及通过 `modelPolicies`
给精确 `(provider, model)` 覆盖。本插件是它的子类，在它之上再加一层：

- **供应商层**——一条规则覆盖该 provider 后面的所有模型，不必逐个枚举模型 id；
- **逐字段继承**——模型层只覆盖 `threshold`，`retain`、`maxTokens`、摘要路由仍从供应商层或
  全局层继承；
- **比例与绝对 token 双单位**，按路由声明的窗口换算；
- **热加载 + 设置面板 + 会话徽标**；
- **摘要回退链**与上下文策略提示词。

选区、工具配对平衡、摘要框架、落盘事务全部沿用官方实现。如果你只需要少量精确
`(provider, model)` 覆盖，官方 `modelPolicies` 已经够用；本插件面向的是跨很多路由的分层策略。

- [为什么需要它](#为什么需要它)
- [差异点](#差异点)
- [安装与挂载](#安装与挂载)
- [配置](#配置)
- [策略如何解析](#策略如何解析)
- [设置面板](#设置面板)
- [行为保证](#行为保证)
- [测试](#测试)
- [兼容与迁移](#兼容与迁移)

## 为什么需要它

官方引擎的 `modelPolicies` 是精确 `(provider, model)` 对。当一个网关暴露很多模型 id，或者
多条路由共享同一套策略时，逐个枚举既啰嗦又脆弱：新加的模型会静默落回全局阈值，直到有人补上
一行。本插件允许一条供应商层规则覆盖该 provider 的所有模型，并按
`models[] → providers{} → default` 逐字段解析。

```
models[]  →  providers{}  →  default
```

模型层可以只覆盖 `threshold`，`retain`、`maxTokens`、`headroomTokens` 和摘要路由继续从供应商
层或全局层继承。

## 差异点

- **三层策略、逐字段。** `models[]` → `providers{}` → `default`；改一个字段不需要抄整层，
  一条供应商行覆盖该 provider 后面的所有模型。
- **比例或绝对 token 两种单位。** `threshold` / `retain` 按路由声明的窗口换算；
  `thresholdTokens` / `retainTokens` 是绝对预算。换算写回父类时使用
  `(tokens + 0.5) / window`，保证精确回到声明的数；路由没有声明窗口时**拒绝猜**，
  在真正需要策略的那一步报错并点名路由。
- **热加载。** 引擎每秒轮询 `settings.yaml` 与 `compaction-control-settings` 行；策略修改在
  下一次压缩生效，不需要重启。面板写的是同一份文档。引擎挂载行自己的 `config:` 在加载时读取
  （见[安装与挂载](#安装与挂载)）。
- **部分文档合并。** `settings.yaml` 的 `compaction-control:` 段与挂载行 `config:` **逐字段**
  合并（映射递归、数组整体替换），面板保存不会悄悄抹掉 profile 里的 `models[]` 层。
- **设置面板。** 编辑全局层或某个供应商层，切换单位时不留下两个键，空隙过小时给出红字提示；
  会话头徽标显示当前触发点和「上一次摘要实际由哪条路由写」。
- **摘要回退链。** `summarizationFallback` 在主摘要路由失败时按序尝试其它路由，避免一条坏
  路由让整个压缩停摆。
- **上下文策略提示词。** companion 注册一段系统提示：上下文管理是自动的，模型无法测量自己的
  用量，不得因为自认为「上下文快满了」而停止、缩短或移交工作。
- **手动 `/compact` 是持久工作。** 客户端断线/重连不会杀死一次 20–40 秒的压缩事务；无法开始
  时如实报告原因，不把空锁说成「已有压缩在跑」。
- **有测试。** 198 个 `node --test` 用例，分布在 13 个文件，覆盖真实 bundle 渲染、三层解析、
  单位换算、补丁文件解析和手动压缩保留量。

## 安装与挂载

要求：DSH `0.2.1-rc.x` / `0.2.2-rc.x`、Node.js 20+。

### 从 npm 安装

```bash
dsh plugin --profile web add @magic6/dsh-compaction-policy-engine
```

npm 包里包含 `examples/standard-with-policy` 供参考；下面的 preset 覆盖规则仍然适用。
web 小节里的 `$PWD` 命令假设使用源码检出。

### 从源码安装

```bash
git clone https://github.com/T-splines/dsh-compaction-policy-engine.git
cd dsh-compaction-policy-engine
dsh plugin --profile web add "$PWD"
```

包本身是 bundle，会挂两行：

- **引擎行**（`compaction-control`），**默认 disabled**；
- **companion 行**（`compaction-control-settings`），始终启用，负责设置卡片与上下文提示词；
  它**不**认领 `ctx.compaction`。

### 先确定挂载平面

`ctx.compaction` 是**按 realm 解析的单槽接缝**。必须挂在 agent 实际解析到的作用域；挂在别处
不是「覆盖」而是「并存」——两个引擎都订阅冒泡的 `agent/pre-step`，触发点变成两者中较低的那个，
表现为「装完插件后压缩异常地早」。

| profile | agent 的压缩引擎属于谁 | 怎么挂 |
|:--|:--|:--|
| `headless` | 宿主平面（没有 preset） | profile 的 `cordis.patch.yml`，覆盖 bundle 已插入的引擎行 |
| `web` | **agent preset**（`dsh-web-app` 停用了宿主平面的 `compaction-basic`） | 覆盖 preset 声明；本仓库带一个示例 bundle |

#### headless（宿主平面）

bundle 已经插入 `compaction-control`（disabled）。**覆盖这一行**，不要再 `insert` 一份：

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: compaction-basic
  disabled: true

- id: compaction-control
  disabled: false
  config:
    default:
      threshold: 0.8
      retain: 0.16
```

loader 认的键是 **`disabled`**，不是 `disable`；写错不会报错，会被静态配置静默丢掉
（看起来停用了，其实还启用）。

#### web（agent preset）

DSH 0.2.2 的 preset 是 bundle patch 里的 `@deepseek-ai/dsh-agent-preset` 声明。旧目录
`$DSH_HOME/.agent-presets/<id>/agent.cordis.yml` 已经不再被读取。web 的 agent realm 隔离了
`ctx.compaction`，宿主平面的引擎它看不到。

本仓库带一个示例 bundle：覆盖 `preset-standard`，把 `compaction` 组里的 `compaction-basic`
换成 `compaction-control`，并保留 `command-compact` 与 `tool-result-pruner`：

```bash
dsh plugin --profile web add "$PWD"
dsh plugin --profile web add "$PWD/examples/standard-with-policy"
```

重启 web app，新开会话验证。示例是 DSH 0.2.2 标准 preset 的快照；如果你改过标准 preset，请把
`compaction` 组的手动合并进你自己的 preset 声明，而不是盲目安装示例（Creator 模式可以代写
这个覆盖）。文件在
[`examples/standard-with-policy/cordis.patch.yml`](examples/standard-with-policy/cordis.patch.yml)，
头部也写了同样的提醒。

两种静默坏组合：

- 宿主平面挂了引擎，preset 里原版 `compaction-basic` 还在 → 两个引擎，阈值低的赢；
- 原版停用了却没有挂任何替代引擎 → 接缝无人认领，会话静默停止压缩，一路涨到被上游拒绝。

「停用旧的」和「启用新的」必须写在同一个组合里，一起 review。

### 热加载范围

设置面板写 `$DSH_HOME/settings.yaml`。引擎每秒轮询该文件**以及** `compaction-control-settings`
行，所以面板修改和这一行的修改会在下一次压缩生效，不需要重启。**引擎挂载行**
（`compaction-control`）的 `config:` 在插件加载时读取，改它需要重启。

### 阈值语义

官方引擎的触发点是

```
floor(min(W × threshold, W − O − headroomTokens))
```

其中 `W` 是路由声明的窗口，`O` 是输出预留，`headroomTokens` 默认 65,536。`measured`
**包含固定的系统提示词和工具清单**。在工具很多的部署里，`threshold: 0.5` 可能意味着
「系统提示词之外再攒约 23K 就压」，不是「对话到一半才压」。

本插件的 `threshold` / `retain` 映射到官方的 `thresholdRatio` / `retainRatio`；
`headroomTokens` 与 `maxTokens` 是逐层字段。默认 0.8 是官方引擎默认值，除非 headroom 上限
先到，否则不会比原版更早触发。会话头徽标显示的是 `窗口 × threshold` 的快速预览；因为
`W − O − headroomTokens` 可能更低，把它当作触发点的**上界**。

## 配置

策略可以写在挂载行的 `config:`，也可以写在 `$DSH_HOME/settings.yaml` 的
`compaction-control:` 段（面板编辑后者）。

```yaml
compaction-control:
  default:
    threshold: 0.8            # 到达窗口的这个比例就压
    retain: 0.16              # 原样保留的尾部比例，必须小于 threshold
    summarizationModel: auto  # auto = 用会话当前路由的模型，或 "provider/model"
    summarizationFallback: [] # 主摘要失败后按序尝试的 "provider/model" 路由
    headroomTokens: 65536     # 阈值下方预留的空间
    maxTokens: 8192           # 摘要长度上限
    compactionRetries: 1
    maxOverflowRetries: 1

  providers:
    some-provider:
      threshold: 0.5

  models:
    - provider: local
      model: model-262k
      threshold: 0.9

  auto: true
```

### 两种单位

每个预算字段都有比例与绝对 token 两种写法，**同一层只能写一种**：

| 比例 | 绝对 token | 语义 |
|:--|:--|:--|
| `threshold` | `thresholdTokens` | 到达这个量就压 |
| `retain` | `retainTokens` | 保留最近这么多内容 |

同一层两种都写时 token 形式生效，并打一行 `[compaction] WARNING` 点名被遮蔽的键。整段拒绝
会让面板刚保存的值看起来被静默忽略，所以选择「生效 + 告警」。

### 其它策略字段

以下字段在 `default`、`providers{}` 层或 `models[]` 层都有效：

| 字段 | 默认值 | 含义 |
|:--|:--|:--|
| `summarizationModel` | `auto` | `auto` 复用语会话当前路由；也可写明确的 `provider/model` |
| `summarizationFallback` | `[]` | 主摘要失败后按序尝试的 `provider/model` 路由 |
| `headroomTokens` | `65536`（官方默认） | 阈值下方预留的 token，给摘要留出比被压区间更小的空间 |
| `maxTokens` | 官方默认 | 生成摘要的长度上限 |
| `compactionRetries` | `1` | 压力仍高于阈值时的额外摘要尝试 |
| `maxOverflowRetries` | `1` | 确认上下文溢出后的重试次数；`0` 关闭恢复 |

`auto` 是根级开关，不是层字段：设为 `false` 只关闭自动压缩，手动 `/compact` 仍然可用。

**空隙要够大。** 摘要是结构化总结，实测下限约 3.2K token；`threshold − retain < 8192` 时摘要
不可能比被压缩的区间更小，父类会拒绝。面板把「可压缩空间」标红提示；小窗口下小空隙可能无法
避免，所以是告警而不是加载失败。

## 策略如何解析

- `models[]` → `providers{}` → `default`，**逐字段**解析，按 `(provider, model, window)` 缓存。
  会话中途换模型，下一次门限判断立刻使用新策略。
- 引擎在门限检查时读取**当时**的路由，而不是会话启动时的路由。
- 路由没声明窗口时，绝对 token 预算无法兑现：字段进入 `deferred`，真正需要策略的那一步报错
  并点名路由。
- 配置错误（比例越界、`retain >= threshold`、未知字段、`models[]` 重复目标、
  `summarizationModel` 残缺）在插件加载期失败，消息定位到字段。

## 设置面板

Models 页脚 → **Compaction policy** 卡片：

- 选择层：全局默认或某个供应商路由；
- 编辑每个预算字段；**数值形状即单位**（`0.2` 比例，`200000` token），非法值标红并禁用保存；
- 切换单位时在同一批操作里 `unset` 被替换的键，文档不会同时留下两种单位；
- 新增/移除供应商覆盖；移除会把用户层里的所有字段 unset，包括卡片不渲染的字段；
- 会话头徽标显示当前触发点（`比例 · token`）、来源层（`models[]` / `providers{}` / `default` /
  引擎默认）、可压缩空间，以及上一次摘要实际使用的路由。

`models[]` 仍然只能手写 `settings.yaml`：settings 写入器对数组是整体替换，列表编辑器会在每次
输入时重写整张表。徽标仍会报告会话命中了 `models[]`。

非环回浏览器拿到的是 DSH 的内存态视图（`status: 'unavailable'`、`writable: false`），卡片会
明说，而不是把插件默认值当成部署策略。

## 行为保证

- **配置错误在启动时炸，不在第一次压缩时炸。** 例外是需要路由窗口的绝对预算：在真正需要策略
  的那一步报错并点名路由。
- **覆盖导致 `retain >= threshold` 时报错**，不悄悄缩小 retain。
- **不劫持压缩语义。** 选区、工具配对、事务落盘一行没改。
- **手动压缩是持久工作。** `/compact` 不因客户端断线而取消；只有 agent 自己的维护信号能取消。
  Stop 仍然有效。
- **失败原因不谎报。** 闸门被占时先有界重试一次；始终不释放时明说「上一次活动还在收尾，
  锁是空的」。
- **上下文策略。** companion 声明：上下文由 harness 自动管理，模型无法测量自身用量，不得因为
  自认为快满而停止或缩短工作。profile 没有 `systemPrompt` 服务时不注册。

## 测试

```bash
npm test
```

198 个用例，分布在 13 个文件，包括：

- `manual-compaction.test.js` — 闸门重试、UI 信号中断、真实失败、诚实消息，以及对已安装官方包
  的契约断言；
- `context-policy.test.js` — 提示词段落注册与无服务时的降级；
- `policy.test.js` — 三层解析、逐字段合并、两种单位、换算、告警、overlay 文档规则；
- `engine.test.js` — 接缝注册、`inject` 继承、`Config` 必须自有、按目标切换、窗口换算、
  无窗口拒绝、`settings.yaml` 段存在时 profile 的 `models[]` 仍生效；
- `settings-file.test.js` — 补丁/settings 解析与即时编辑；
- `fallback.test.js`、`patch-file.test.js`、`settings.test.js`、`summary-prefix.test.js`、
  `unstated-threshold.test.js` — 摘要回退、补丁 entry 形状、settings 合并、摘要框架与
  未声明阈值告警；
- `client-policy.test.js` / `client.test.js` — 面板计算、单位切换、供应商层、会话徽标、
  非法值拦截、内联 bundle 一致性。

## 支持的平台

测试套件在下面这些环境里**实际跑过并通过**，不是「应该能跑」：

| 平台 | 版本 | 结果 | 验证方式 |
|:--|:--|:--|:--|
| macOS | 26.6.2 arm64 | ✅ 198/198 | 本机全量 `npm test` |
| Windows | 11 22631 x64 | ✅ 198/198 | 真机全量 `npm test` |
| Linux | ubuntu-latest x64 | ✅ 198/198 | GitHub Actions（Node 20 / 22） |

Windows 一行是 2026-11-25 才加上的：在那之前 CI 只跑 `ubuntu-latest`，
而用户主要在 Windows 上用。第一次在真机跑就抓出两个 Windows 独有的测试
失败（见 CHANGELOG）。现在 `.github/workflows/ci.yml` 里有一个
`windows-latest` 任务，这类问题不会再漏过去。

> 只列跑过测试的平台。没在这里出现 ≠ 不支持，只是还没人验证过 ——
> 如果你在别的平台跑通了，欢迎提 PR 把这一行补上。

## 端到端自测

单元测试里引擎和 meter 都是假的，只能证明策略解析对了。仓库里另有一层端到端验证：

```bash
npm run test:e2e      # 等价于 e2e/run.sh
```

它起一个**独立 `DSH_HOME`**、建临时 profile、从 npm（或工作树）装这个包，让一个假
provider 声明很大的 `contextWindow`、用**绝对 token 数**把门槛压到几轮对话就能跨过，
然后真的等 `gate=wait` 翻成 `gate=FIRE`。

断言不只看「压缩触发了没有」，还看 **`source=` 是哪一层**、`thresholdTokens` 是否等于
配置值、压缩后 `measured` 有没有真的落回门槛之下。细节见
[e2e/README.md](e2e/README.md)。

> 这一层在 0.5.9 抓到了三个单元测试测不出的 bug，其中两个是「诊断本身在撒谎」。
> 加场景的验收标准同样写在那份 README 里：**它必须在旧版本上会红**。

## 兼容与迁移

- DSH `0.2.1-rc.x` / `0.2.2-rc.x`（`engines.dsh`：`>=0.2.1-0 <0.3.0-0`）、Node.js 20+。
- **0.5.0 从 `dsh-compaction-control` 改名。** entry id 保持不变：
  `compaction-control`（引擎）、`compaction-control-settings`（companion），以及
  `compaction-control:` 设置命名空间。把 profile/preset 里的 `name:` 改成
  `@magic6/dsh-compaction-policy-engine`（引擎行加 `/engine`）即可。
- 仍然是官方 `BasicCompactionEngine` 的子类，不需要改 `node_modules`。

## 报告问题

发现 bug 请直接开 issue —— 不用先确认是不是自己的配置问题，贴上来我们一起看：

- 🐞 **[Bug report](https://github.com/T-splines/dsh-compaction-policy-engine/issues/new?template=bug_report.yml)**
  —— 行为不对、崩溃、该 fallback 没 fallback、熔断恢复不了。
- ❓ **[Config question](https://github.com/T-splines/dsh-compaction-policy-engine/issues/new?template=config_question.yml)**
  —— 能跑，但行为和配置不一致。

提 issue 时如果方便，附上这几样，通常当天就能定位：

1. 插件版本与 DSH 版本；
2. 操作系统（各平台的临时目录与路径拼接差异很大，别省）；
3. 原始的 `code` 和 `message`，不要转述；
4. 设置面板显示的生效值，以及它来自 `settings.yaml` 还是 profile patch。

安全相关问题请不要开公开 issue，按 [SECURITY.md](SECURITY.md) 私下报。

## 许可

MIT，见 [LICENSE](LICENSE)。
