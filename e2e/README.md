# 端到端验证（`e2e/`）

单元测试里引擎和 meter 都是假的，只能证明「策略解析对了」。线上出事的另一类是：
**策略没到引擎**——补丁层被读错 profile、`settings.yaml` 不存在时静默用组合默认、
告警本身因为判断条件写错而永远不打印。这些只有让真宿主跑起来才看得见。

## 跑

```bash
e2e/run.sh          # 全部场景
e2e/run.sh fired    # 单个
e2e/run.sh --list
```

| 变量 | 作用 |
|:--|:--|
| `PLUGIN_SPEC` | 默认装**本仓库**（link:，测工作树源码）。设 `@magic6/dsh-compaction-policy-engine@0.5.8` 可做回归对照 |
| `E2E_WORK` | 工作目录，默认 `/tmp/dsh-compaction-e2e` |
| `THRESHOLD_TOKENS` / `RETAIN_TOKENS` | 门槛，默认 12000 / 1000 |

## 手法：怎么在不烧 12k token 的前提下跨过门槛

假 provider 声明一个**很大的** `contextWindow`（200k），门槛用**绝对 token 数**而不是
比例。比例会跟着窗口一起放大，绝对数不会 —— 于是几轮几百字的对话就能把 `measured`
推过 12000，十几秒看到 `gate=wait` 翻成 `gate=FIRE`。

摘要请求必须返回**比被替换内容更短**的东西，否则引擎会以
`summary is not smaller than the shadowed content` 正确拒绝。所以假服务器的脚本
交替给 `ok-long`（主对话）和 `ok`（摘要）。

## 场景

| 场景 | 断言 |
|:--|:--|
| `fired` | 六轮内必须出现 `gate=wait` 再到 `gate=FIRE`；FIRED 行里的 `thresholdTokens` 等于配置值、`source=cordis.patch.yml`；压缩后 `measured` 落到门槛之下 |
| `unstated` | 拿掉所有声明门槛的层后，必须打印 `NO THRESHOLD` 且带 `source=` |

## 回归对照

```bash
PLUGIN_SPEC='@magic6/dsh-compaction-policy-engine@0.5.8' E2E_WORK=/tmp/comp-old e2e/run.sh
```

| 版本 | 结果 |
|:--|:--|
| `0.5.8`（有 bug） | **0 通过 2 失败** |
| `0.5.9`（已修） | 2 通过 0 失败 |

这套 e2e 抓到的三个 bug，单元测试全都测不出来：

1. **`source=` 被错标** —— `settings.yaml` 不存在时，watcher 用组合层兜底并报告
   `origin: 'composition'`，但 `reloadPolicy` 只看 `_fileSection !== undefined` 就写
   `origin = 'settings.yaml'`。于是那行本用来暴露「配置没到引擎」的诊断，反而断言配置
   来自文件。**诊断撒谎比没有诊断更糟。**
2. **`patchFilePaths` 读错 profile** —— 它读 `process.env.DSH_PROFILE`，而那个值是宿主
   注入给 shell 工具的、属于**父进程**的 profile。从会话里起 `dsh --profile headless`
   时它会继承 `web`，于是插件一直去读 `profiles/web/cordis.patch.yml`，
   `/tmp/.../profiles/headless/` 下那份正确的补丁**永远读不到**。修法是改用
   `ctx.get('profileContext').name` —— 宿主自己的答案。
3. **`NO THRESHOLD` 永远不会打印** —— 判断条件用的是 `policy.thresholdRatio !== undefined`，
   但 `resolvePolicy` 永远用默认值填这个字段，所以函数无条件 return。原来的单元测试
   喂了一个解析器**根本不会产出**的形状（`{ retainRatio: 0.1 }`）而保持绿灯。修法是
   改判 `policy.source.threshold.layer !== 'engine'`。

## 一条教训

前两个 bug 都属于同一类：**代码在自己的假设里自洽，但那个假设与宿主的实际行为不符**
（`DSH_PROFILE` 是谁的、兜底值的 origin 是什么）。只有把真宿主拉起来才能证伪。
