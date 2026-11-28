# 经验记录

踩过的坑、非显而易见的结论。格式：问题 → 根因 → 解决 → 教训。

---

## [2026-11-28] Windows 桌面版：`HOME` 不存在 → 策略文档为空 → 阈值静默回落 0.8

**问题**：Win11 desktop profile，补丁里写着 `threshold: 0.42`，设置卡片也显示 42%，
但会话到 74% 都不自动压缩；唯一一次压力门触发发生在 68%。

**根因**：`settings-file.js` 用 `env.DSH_HOME ?? join(env.HOME ?? '', '.dsh')` 解析 home。
Windows 没有 `HOME`，桌面版 host 子进程也不导出 `DSH_HOME`（`desktopNodeEnvironment` 只透传
Electron 的 env），cwd 是 `profiles/desktop`，于是 `home = '.dsh'`（相对路径），每个候选都
解析到 `…/profiles/desktop/.dsh/profiles/desktop/cordis.patch.yml` —— 不存在。
`watchPatchFile` 把 ENOENT 当"正常情况"静默跳过；引擎行 `compaction-control` 自身没有
config，只能靠读文件拿到策略 → 空文档 → `resolvePolicy({})` → 0.8 / 0.16 / maxTokens 8192。
设置卡片走 loader 合并后的行 config，所以显示的 42% 是对的。0.5.11→0.5.14 只改了
index.js / policy.js，settings-file.js 一字未动，升级不解决问题。

**怎么确定的**（桌面版 host 的 stderr 不落盘——主进程只在内存留最后 64 KiB，host 退出报错时才展示，
所以 `engine up` / `FAILED` / `compact-debug` 历史上都查不到，只能用会话日志里的"引擎指纹"）：
1. `compaction/summary` 的 `maxTokens` 区分引擎：8192 = 本插件 `DEFAULT_MAX_TOKENS`；
   65536 = 官方引擎（`/compact` 经 preset isolate 里的 `command-compact` → 官方 `compaction-basic`）。
2. 压力门的 `measure()` 锚定在 provider usage 上（即 UI 显示的数）。官方公式
   `min(window×ratio, window − 请求maxTokens − 65536)`：当时请求 maxTokens=256000，0.8 → 678,464；
   turn 66 的 step 8/9/10 usage = 675,698 / 676,611 / 677,265 不触发，step 11 = 680,081 触发。
   若是 0.42（420k），前一天晚上就该触发。
3. 真机复现：Win11 上用桌面 runtime 自带的 node、清掉 `HOME`、cwd 设为 `profiles/desktop`，
   跑插件自己的 `patchFilePaths()` → `exists=false`；修复后 → `exists=true`。

**解决**：`resolveDshHome(env, hostHome)`：宿主报告的 `profileContext.home` → 非空 `DSH_HOME`
（展开 `~`）→ `os.homedir()/.dsh`，与核心 `dsh-home-paths` 同序；`index.js` 把
`profileContext.home` 透传给两个 reader；`watchPatchFile` 新增 `onMissing`，所有候选都不存在时
打一次 WARNING 并列出路径。

**教训**：
- **解析用户目录永远用 `os.homedir()`**（Windows 读 `USERPROFILE`）；`process.env.HOME` 在
  Windows 上不存在。兄弟插件里 `dsh-llm-resilience` 的写法（`DSH_HOME` → `homedir()/.dsh`）是对的，
  新插件照抄这个顺序，最好直接用宿主提供的 `profileContext.home` / `dshHomePath`。
- **e2e / 单测为什么没抓到**：两者都用 `DSH_HOME=<tmp>` 重定向 home 来隔离，恰好绕过了出错的
  回退分支；macOS / Linux 有 `$HOME`，回退分支即使走到也是对的。要测"环境里什么都没有"，
  必须显式删掉 `HOME` / `DSH_HOME` 再断言路径是绝对的（已加测试）。
- **"某个候选缺失是正常情况"和"全部缺失"要分开**：前者每秒发生，后者意味着引擎在用内置默认值
  跑，至少打一行带路径的 WARNING。
- **Windows 真机跑测试的价值再次兑现**：`resolve()` 让 POSIX 风格的 fixture 在 Windows 上变成
  `C:\home\x`，三条断言随即失败——产品行为是对的，断言是平台相关的。期望值也要过 `resolve()`。
- **桌面版诊断盲区**：host stderr 不落盘，以后这类问题只能靠会话日志里的 `maxTokens`、`usage`、
  `request/header.config.maxTokens` 反推。

## [2026-11-26] 插件"装上就等于接管"才是对的，出厂 disabled 是灾难

**问题**：Win11 的 desktop profile 装了本插件，设置卡片正常、阈值读得回来，但压缩一次都不触发。
会话涨到 158,118 token 后被 opendesign 连拒四次（一次主请求 + 三次压缩），会话再也救不回来。

**根因**：`ctx.compaction` 是**单槽服务**，而 bundle 出厂把引擎行设成 `disabled: true`，
理由写的是「替换官方引擎属于部署决策」。那条推理默认官方引擎**正在运行**——在 preset 类
宿主上恰好相反：`dsh-web-app`（`web` / `desktop` 都由它托管）自己就把宿主平面的
`compaction-basic` 停了。于是两个引擎都是关的，接缝无人认领。

三个层次都静默：卡片照渲染、阈值照读、`engine up` 一行不打。唯一症状是会话一直涨。

**解决**：bundle 内一次做完两半 —— `disabled` 掉 `compaction-basic`，启用 `compaction-control`。
卸载时两行一起消失，官方引擎自动恢复。

**教训**：
- 「插件是否启用」不该由用户再手工勾一次。装 = 要它接管。出厂 disabled 等于让每个用户
  重做一遍部署决策，而他们不会知道要做。
- 一个 bundle 同时管「停用旧的」和「启用新的」时，**两件事必须写在同一个文件里**，
  否则卸载后必然剩一半。
- 判断一个能力"有没有生效"，不要看 UI 或配置回读，要看它**启动时的日志锚点**。
  本插件的锚点是 `[compaction] engine up: fiber=… threshold=… source=…`。

---

## [2026-11-26] `ctx.compaction` 是单槽，不是「谁低谁赢」

**问题**：想过「官方引擎留着当兜底，我们的阈值低所以会先触发」这个方案。

**根因**：`CompactionEngine` 的构造是 `super(ctx, "compaction")`。同一 context 里第二个实例
直接抛 `service "compaction" has been registered at <BasicCompactionEngine>`，宿主只打
`dsh: warning: 1 entry did not activate`。**不是竞争，是注册失败。**

**解决**：必须关掉官方引擎，没有"并存"选项。

**教训**：单槽服务的语义要去读 `Service` 基类的构造，不要按"两个监听器抢同一事件"来想当然。
`isolate: compaction: true` 的 preset realm 是**不同的 context**，那里可以各有一份——
但那是 realm 隔离，不是同一 seam 上的共存。

---

## [2026-11-26] e2e fixture 替被测代码打掩护，是最贵的假绿

**问题**：0.5.9 的引擎出厂 disabled，但 `e2e/run.sh` 全绿。bug 就这样发到了 npm。

**根因**：fixture 里写死了 `- id: compaction-control / disabled: false`。理由是"引擎得开着才能测"，
实际效果是**永远测不到 bundle 的出厂状态能不能用**。线上炸的正是出厂状态。

**解决**：fixture 只覆盖 `config:`，`disabled` 保持出厂值。`fired` 场景额外先断言
`[compaction] engine up:` 行存在——旧套件默默假设了这个前提。

**教训**：
- **测试夹具不能补齐被测对象该自己做到的事。** 夹具里每写一个 `disabled: false`、
  每个 `config:` 兜底值，都在缩小被测范围。
- 回归对照要做成表：新版本必须绿、旧版本必须红。只跑新版本绿的测试不叫验证。

---

## [2026-11-26] ⚠️ 不要在 Windows 上用 PowerShell 改含中文的 YAML

**问题**：用 `Get-Content` + `Set-Content -Encoding UTF8` 往 Win11 的 `cordis.patch.yml`
末尾追加几行配置，之后 DSH 直接打不开：

```
DesktopHostFatalError: dsh: failed to parse overlay …cordis.patch.yml:
YAMLException: bad indentation of a mapping entry (81:15)
 80 | # 閿紳閫夋嫨鍣ㄩ噷鐨勬。浣嶏紝…     ← 中文注释全变乱码
 81 |   'off': none
```

**根因**：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，且重写整个文件时按系统
代码页（GBK）解码 UTF-8 字节 → 中文注释变乱码 → 行宽/缩进判断错位 → YAML 解析失败。
**不是插件的问题**：插件只往 `package.json` 注册，从不写 `cordis.patch.yml`（审计过：
`lib/` 里零写文件调用、零网络、零子进程）。

**解决**：从备份恢复。永远不要在 Windows 上用文本管道改这类文件。

**教训**：
- 改远端含非 ASCII 的配置，用 **SCP 上传完整文件**覆盖，不要用 shell 管道重写。
- 动手前先 `copy` 一份带时间戳的备份；出事后先看**最近的 crash 日志**
  （`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log`），那里有精确的字节偏移和行号。
- 判断"是不是我们的插件搞坏的"，看它有没有写权限路径：本插件连 `fs.write` 都没有。

---

## [2026-11-26] 全量重放：一个"优化"如何让压缩永久失效

**问题**：Win11 会话（`session-91ac1b04`）涨到 158k token 后，四次压缩全部
`400 context_length_exceeded`，会话永久不可恢复。切模型、换 provider 都无效。

**根因**：`summarize()` 覆盖了父类的 region-only 输入，改为重放**整段对话**，目的是
让摘要请求成为 live state 的精确 token-前缀延伸，从而命中本地引擎的 `--prompt-cache`。
实测（同一会话）：

```
全量重放（带 reasoning）   2,182,311 tokens   ← 2.2x 窗口
全量重放（剥掉 reasoning） 1,247,719 tokens   ← 仍然 1.25x
网关实际请求峰值             217,373 tokens
声明窗口                   1,000,000 tokens
```

差别在于：**正常请求只发当前窗口内的内容，全量重放试图发累计历史。**
所以「需要压缩的会话」恰好就是「全量重放装不下的会话」——
用来救它的请求，正是发不出去的那个。这是结构性的，不是参数问题。

**曾走过的弯路**：先把 93 万 token 的 `reasoning` 认定为元凶（它确实占 43%），
打算只剥离 reasoning。但剥完仍有 1.25M —— **机制本身错了，局部修补无效**。

**解决**：删除 `fullConversationMessages` / `summarizationInput`，直接用父类的
region-only 输入（由 gate 限定，天然有界）。`780e74c`。

**教训**：
- **一个优化的成立条件必须写进代码。** 全量重放只在"会话装得下窗口"时成立，
  而这恰恰是它不需要存在的场合。注释里写了本地引擎的测量数据，唯独没写
  「会话本身不能太大」这个前提。
- **救火路径不能比它要救的东西更脆弱。** 压缩是所有其他失败的恢复手段，
  它必须是唯一保证有界的操作。为了缓存命中让它承载全部历史，是把保险丝换成铜线。
- 判断体积要用**网关报的 `totalTokens`**，不是会话文件大小、不是历史累计字符数。
  我第一次统计出"1.3M token"时误以为看错了，其实那就是累计历史 —— 它和单次请求
  体积本来就不是一回事。
- 用户凭直觉说"21.7 万不该超窗"是对的。**当数据与结论矛盾时，先怀疑自己的模型**
  （我当时假设"会话体积=请求体积"），不要急着给矛盾找解释。

---

## [2026-11-26] npm publish 成功 ≠ 包可用：`latest` 标签可能没跟着动

**问题**：`npm publish` 输出 `+ @magic6/dsh-compaction-policy-engine@0.5.11`，
但 Win11 上 `dsh plugin add @magic6/dsh-compaction-policy-engine@0.5.11` 报
`The latest release is "0.5.10"`，`npm view ... versions` 里也看不到 0.5.11。

**根因**：第一次 publish 因为网络/超时被中断，版本其实已经**暂存**到 registry
（`time` 元数据里有 `0.5.11: ...16:43:54.849Z`），但 `dist-tags.latest` 没更新。
重试 publish 时 registry 回 `E409 Cannot publish over previously staged version` ——
这个错误很误导，它说的是"已暂存"，不是"没发布"。

**判断依据**：不要看 publish 的 stdout，看两处：
```bash
curl -s -H "Accept: application/vnd.npm.install-v1+json" \
  https://registry.npmjs.org/@magic6%2fdsh-compaction-policy-engine | jq '.versions, .["dist-tags"]'
```
`versions` 里有 → 包已发布；`dist-tags.latest` 没指过去 → 安装时会回退到旧版。

**解决**：`npm dist-tag add <pkg>@<version> latest`。

**教训**：
- **`npm publish` 的 `+` 行不代表完成**，它只是本地 staging 成功的回显。装不上就先查
  registry 的 `versions` 和 `dist-tags`，别急着重发（重发会撞 E409）。
- E409 "Cannot publish over previously staged version" 的正确解读是
  **该版本已存在，去修 dist-tag，不要换版本号**。我一开始换到 0.5.12，
  等于白白多了一个空版本号。
- 端到端验证要用**分发产物**（`dsh plugin add` 从 registry 装），不能用本地目录装 ——
  本地装测不到这类发布问题。

### 追加（2026-11-26 晚，又踩了一次）

记过了还是又踩一遍，说明上一条缺的是**可执行的判定与动作**，不是道理。补上：

**发布后必跑的三行（缺一不可）**：
```bash
PKG=@magic6/dsh-compaction-policy-engine
node -p "require('./package.json').version"                    # ① 本地准备发的是几
curl -s https://registry.npmjs.org/$PKG | jq -r '.["dist-tags"].latest'   # ② registry 的 latest
npm install $PKG@latest --prefix /tmp/verify-$RANDOM && \
  node -p "require('/tmp/verify-*/node_modules/'+'$PKG'+'/package.json').version"   # ③ 装下来是几
```
②③ 都等于 ① 才算发布完成。**只看 `npm publish` 的 `+` 行等于没验证。**

**这次的实际现象**：0.5.12 进了 `versions` 但 `latest` 停在 0.5.11；
紧接着发 0.5.13 又撞 E409。两次都以为"发布失败了"，其实都是**已暂存，
缺 dist-tag 收尾**。

**E409 的正确动作（只此一条，不要升版本号）**：
```bash
npm dist-tag add $PKG@<那个撞 E409 的版本> latest
```
升版本号 = 制造一个永远没人装的空版本，registry 上永久多一行垃圾。

**`npm install` 会骗你**：包名带 `@latest` 时若本地有旧缓存，装下来的可能是旧版。
判断安装结果之前先 `rm -rf node_modules` 或用全新临时目录，别在旧目录里看版本号。

## [2026-11-26] 发了 npm 没发 Release → dshmarket 永远显示旧版本

**现象**：dshmarket 里我们的插件一直停在旧版，但 `npm view` 明明是新版。
页面显示 `0.5.8`，npm 上实际是 `0.5.14`。

**根因**：dshmarket 的索引是 `awesome-dsh-plugin.com/updates.json`，它**优先读
GitHub Release tag**；没有 Release 时退化成从最近 commits 猜一个版本号。我们的
`publish.yml` 只做 npm publish，**从来没有创建 Release 这一步**，所以：

```
GitHub Release 最新  v0.5.5   （2026-11-22）
market 显示          0.5.8     ← 从 commits 猜的
npm 实际             0.5.14
```

`publish.yml` 由 tag 触发、权限是 `contents: read`——连创建 Release 的权限都没有。

**修法**（两处，缺一不可）：
1. `permissions.contents: write`；
2. 在 npm publish 之后加一步 `gh release create "${GITHUB_REF_NAME}"`，
   正文取 CHANGELOG 对应小节，取不到就写最小信息（不让「没 changelog」阻塞发版），
   并先 `gh release view` 判重（手动补发过时不失败）。

**判定依据**（不要看网页找，直接查数据源）：
```bash
# market 索引里我们那条
curl -s https://awesome-dsh-plugin.com/updates.json \
 | jq '.updates["https://github.com/<owner>/<repo>"]'
# GitHub 实际有多少 Release
curl -s https://api.github.com/repos/<owner>/<repo>/releases | jq '.[].tag_name'
```

**教训**：
- **「发布」对这类插件是两件事**：npm 包（给 `dsh plugin add` 用）和 GitHub
  Release（给 market 索引和人类的更新日志用）。只做前者，用户在市场里永远看到旧的。
- `on: push: tags` 触发的工作流默认 `contents: read`，想建 Release 必须显式提权。
- 补 Release 时注意 tag 是否真的 push 了：本地 tag 不等于远端 tag
  （这次 `v0.5.6`~`v0.5.9` 本地有、远端没有，`v0.5.10` 之后两边都没有）。
