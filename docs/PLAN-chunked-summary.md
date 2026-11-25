# 分批压缩（plan）

> 目标：**单次请求装不下的历史，也能压掉。**

## 0. 问题

压缩是所有其它失败的恢复手段，但它自己有一条死路：

```
会话 surface > 模型窗口
  → 触发压缩
  → 摘要请求要发整段被压缩内容（如 204 万 token）
  → 上游 400 context_length_exceeded
  → 压缩失败 → 会话永久不可恢复
```

实测（2026-11-26 Win11）：surface 2,100,381 tokens / 窗口 1,000,000，32 次压缩全失败，
最终只能靠 `dsh-session-rescue` 在 DSH 之外改文件救回来。

**根因唯一**：摘要请求一次要把整段被压缩内容发出去，而这段内容可能比窗口还大。

## 1. 契约

父类 `summarizeCompaction` 的调用与约束：

```js
summaryResult = await dependencies.summarize(prepared.input, agent, signal);
// summaryResult.summary 必须是 TextBlock[]，父类会 frameSummary() 包成 checkpoint
// 约束：framedSummaryTokenCount < prepared.shadowedRouteTokenCount（摘要必须比被压缩内容小）
```

`prepared.input` = `{ messages, tools? }`，其中 messages 是 surface 上被 shadow 的那一段。

**接入点**：`summarize()` 内部。它可以在返回前调用任意多次 LLM。

## 2. 设计

```
summarize(input, agent, signal)
  │
  ├─ 1. 量一下 input.messages 有多大
  │
  ├─ 装得下 → 走原路径（不变）
  │
  └─ 装不下 → 分批：
       batch 1: [最早的 messages ...装满 budget]              → S1（文本）
       batch 2: ["前情提要：S1"] + [后续 ...装满 budget]      → S2
       batch 3: ["前情提要：S2"] + [后续 ...]                 → S3
       ...
       最后：把 Sn 作为 summary 返回
```

**关键点**：每批都把上一批的摘要作为"前情提要"带进去，所以信息不丢、且每批请求都装得下。

### 预算

```
budget = contextWindow × 0.8
```

留 20% 给输出与指令。800k 窗口 → 每批最多 640k token 输入。

### 保护

| 保护 | 值 | 理由 |
|:--|:--|:--|
| 批次数上限 | 12 | 每批一次完整 LLM 调用，无上限会烧钱 |
| 每批前检查 `signal.aborted` | — | 用户取消要立刻停 |
| 单条消息本身超 budget | 离线裁剪该条 | 否则那批永远发不出去 |
| 摘要本身超 `shadowedRouteTokenCount` | 截断 | 否则父类直接拒绝 |

## 3. 降级链

```
① 一次发完（默认，Mac 现行路径）
② 分批（本方案）
③ 离线裁剪后再试 ②  ← 仅当单条消息就超 budget
```

③ 只在极端情况用：把超大的 tool 输出替换成头尾摘录。

## 4. 改动

| 文件 | 改动 |
|:--|:--|
| `lib/summarize-budget.js` | 从 `src/` 移入（预算、切分、裁剪，纯函数，19 测试已绿） |
| `lib/index.js` | `summarize()` 加分批分支；新增 stage 诊断 |
| `test/summarize-chunked.test.js` | 分批的接续逻辑、预算、上限、取消 |
| `e2e/run.sh` | 场景 `oversize`：假 provider 8k 窗口 + 30k 历史，断言压缩成功 |

## 5. 验收

- [ ] 装得下时行为**完全不变**（现有 222 测试全绿）
- [ ] 装不下时分批完成，且摘要覆盖全段（不是只留尾巴）
- [ ] 批次数超限时报错明确
- [ ] 每批都打诊断，能看出走了几批、每批多大
- [ ] e2e `oversize` 在旧版本红、新版本绿

## 6. 不做

- 不改父类事务语义
- 不引入新依赖
- 不碰 `dsh-session-rescue`（那是 DSH 之外的抢修，与本方案正交）
