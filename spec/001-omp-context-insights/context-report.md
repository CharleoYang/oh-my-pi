# Context insights — 现状调研与方案选择

目标：为 `spec-001-omp-context-insights` 提供 S2 设计的事实基础、备选方案与选择理由。本文只记录可核对的事实与取舍，不重复 FEATURE.md 的验收表。

## 1. 问题

当前 OMP 能回答“此刻上下文用了多少”，不能回答：

- 每个 request 的上下文**由哪些类别组成**（system prompt / tools / system context / skills / messages）。
- 上下文**随步骤如何变化**：哪一步涨了、哪一步被压缩、压缩前/后多少、哪一步切换了模型或模式。
- **哪些文件活动**导致了上下文增长：读了多少行、写了多少行、改了多少行。
- 同一会话在 **TUI 与 stats Web** 上的数字是否同一口径。

## 2. 现状

### 2.1 实时路径（coding-agent）

1. `#promptWithMessage` 在请求前计算 `getContextBreakdown({contextWindow, pendingMessages})`，得到五类估算与 `usedTokens`，然后 `setPendingSnapshot({promptTokens, nonMessageTokens, cutoffCount})`。证据：`packages/coding-agent/src/session/agent-session.ts:8742-8757`。
2. assistant 回复成功后，`#persistSessionMessageIfMissing` 把 `contextSnapshot = {promptTokens: calculatePromptTokens(usage), ...nonMessageSnapshot(), compactionEpoch}` 写到消息上；`aborted`/`error` 轮次不写。证据：`packages/coding-agent/src/session/agent-session.ts:3988-4000`。
3. `ContextSnapshot` 只有总量字段，没有类别组成。证据：`packages/ai/src/types.ts:1243-1268`。
4. `/context` 每次打开时用**当前** session/settings/tools/skills 重新计算类别；`messagesTokens` 是 `usedTokens - nonMessageTokens`。它不是历史快照。证据：`packages/tui/src/status-line/context-usage.ts:386-415`，`packages/coding-agent/src/session/session-stats.ts:279-370`。

结论：如果只扩展 UI，不补持久化，Trend/Browser 只能显示“用今天的配置重新解释昨天”，会违反用户已同意的“口径一致”。

### 2.2 日志路径（stats）

- stats 直接解析 session JSONL，`trace.ts` 明确“stats never imports coding-agent”，并镜像 journal 结构。证据：`packages/stats/src/trace.ts:1-20`。
- 现有 API 有 `/api/sessions`、`/api/session/trace`、`/api/session/entry`。证据：`packages/stats/src/server.ts:280-360`。
- `messages` 表与 `message_rollup` 存 input/output/cache token、cost、duration，可按小时聚合；没有上下文类别表。证据：`packages/stats/src/db.ts:146-183`，`packages/stats/src/rollup.ts:1-45`。
- `listSessionSummaries` 已能把子 agent/advisOR transcript 折进 root session，并返回 requests/toolCalls/subagents/totalTokens。证据：`packages/stats/src/trace.ts:1145-1240`。

结论：stats 有足够的**总量与事件原料**，但缺少按 request 的类别组成；需要与 coding-agent 共用同一份持久化明细与同一套 fold。

### 2.3 可派生数据

| 数据 | 来源 | 能否历史还原 |
| --- | --- | --- |
| prompt tokens / usage / cost | assistant `usage` + `contextSnapshot.promptTokens` | 是（provider 锚点） |
| 类别组成 | 请求时的 `ContextUsageBreakdown` | **只有持久化后能** |
| 压缩 | `compaction` 条目的 `tokensBefore`/`tokensAfter`/`method` | 是 |
| 注入 | `custom_message`、`ttsr_injection` | 是（无 token 估算） |
| 模型/思考/档位切换 | `model_change`、`thinking_level_change`、`service_tier_change` | 是 |
| 模式切换 | `mode_change` | 是 |
| reset | `reset_boundary` | 是 |
| prune | 工具结果消息的 `prunedAt` | 是（时间取消息时间，标记 inferred） |
| 文件活动 | assistant toolCall + toolResult 的 args/details | 是（统计读/写/改/搜索与行数） |
| fleet | 子 agent transcript 的 assistant 快照 | 是（子文件存在时） |

## 3. 方案比较

### 方案 A：每次打开时用当前配置重算历史类别

- 优点：零持久化、改动最小。
- 缺点：工具 roster、skills、system prompt、settings 会变；历史步骤会被当前配置污染。无法回答“这一步为什么涨”。直接违反“口径一致”。
- 结论：拒绝。

### 方案 B：在成功 request 的 assistant 快照里持久化最小明细（选用）

- 内容：五类 token、context window、逐 tool/per-skill token、system prompt/context 分块 token、消息数与 pending token。
- 成本：每轮一次额外的 token 估算。工具 schema 已有缓存；按 tool/skill 拆分只在请求时做一次，可复用同一缓存键。
- 体积：典型 30 tools + 20 skills，每轮约 1–3 KB JSON；设上限（200 tools、200 skills、20+20 prompt parts），最坏约 8 KB/轮。1000 轮约 8 MB 上限，典型远低于此。
- 隐私：只存名称与 token 数，不存正文、参数、消息内容。
- 兼容：`details` 是可选字段；旧快照无明细，读取方必须显式降级。

### 方案 C：持久化完整 prompt/tool/skill 正文

- 优点：可完全重放。
- 缺点：会话文件膨胀、隐私面扩大、与 session transcript 重复；provider 缓存/服务端策略仍会让“正文重算”与真实 prompt 不一致。
- 结论：拒绝；本 feature 只存计数与名称。

### 方案 D：新增 stats DB 表，按 request 存上下文

- 优点：全局查询快。
- 缺点：需要迁移、回填、双写同步；现有 sync worker 的 parser 状态机复杂。全局页只读 messages/rollup 已能满足 KPI/热力图；单会话详情按需解析 + ETag 已足够。
- 结论：本期不做；若实测单会话解析不可接受，再开设计门。设计文档明确这是可回退的决策。

### 方案 E：TUI 与 Web 各自实现一遍 fold

- 优点：各自贴合本端。
- 缺点：两套事件排序、压缩处理、文件聚合，必然漂移；AC-01/AC-06 无法保证。
- 结论：拒绝；共享 fold 放在双方都依赖的 `@oh-my-pi/pi-ai`。

## 4. 结论

1. 采用 **B + 共享 fold**：`ContextSnapshot.details` 持久化最小明细；`foldContextTimeline()` 在 pi-ai 中实现；coding-agent 与 stats 只做“适配 entry → 共享 fold”。
2. TUI 只做四页简版（Overview/Trend/Events/Files）；Web 做全局 Context 页 + 会话级六页完整版；两者读同一 `ContextTimeline`。
3. 旧会话显式标记“组成不可得”，不补算、不摊派。
4. 全局页只读既有 messages/rollup；不新增 DB 表。
5. 安装二进制是最后一步，且必须在 S5-R/S5-E2E 通过、用户确认后执行；开发期只从源码/`dist` 运行。

## 5. 需要 S2-R 重点挑战的点

- 每轮额外 token 估算是否会让请求路径变慢；缓存键是否覆盖 tool roster 变更与 settings revision。
- `promptTokens - Σcategories` 的符号与展示；是否会出现系统性高估/低估。
- `prunedAt` 不是日志事件，时间与归属是否会被误读。
- 统计旧会话时，active branch 解析是否与 live 一致（fork/branch/rewind）。
- stats 单会话解析 1000 步/500 文件上限是否足够；ETag 是否覆盖子 transcript。
