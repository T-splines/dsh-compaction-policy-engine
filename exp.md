# 经验记录

踩过的坑、非显而易见的结论。格式：问题 → 根因 → 解决 → 教训。

---

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
