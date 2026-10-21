# OMP context insights: TUI summary + stats web

## Intent

让用户能回答三个问题，且 TUI 与 stats Web 的口径一致：

1. **当前上下文被谁占用**：system prompt / tools / system context / skills / messages 五类，tools 与 skills 可下钻到单个条目。
2. **上下文随每一步如何变化**：每个 provider request 的 prompt tokens、类别组成、相对上一步的 Δ、压缩/注入/模型切换等事件。
3. **文件活动对上下文的贡献**：哪些文件被读/写/改/搜索，读了多少行、写了多少行、改了多少行。

交付两个表面：

- **TUI 简版**：`/context` 保持默认总览，新增 Trend / Events / Files 标签页，键盘切换与滚动。
- **stats Web 完整版**：新增全局 Context 页（KPI、与 KPI 同窗口的 range 热力图、会话表）与会话级 Context 详情（Composition / Trend / Browser / Events / Files / Fleet 六个标签页）。

## Scope

### 范围内

- 扩展 `ContextSnapshot` 的**可选**持久化明细：五类 token、context window、逐 tool/per-skill token、请求时消息 token；不持久化消息正文、system prompt 正文或工具参数正文。
- 新增共享的 `ContextTimeline` 类型与纯 fold：同一份会话日志，coding-agent 与 stats 必须得到同构结果。
- coding-agent 暴露 `getContextTimeline()`，TUI `/context` 从它渲染。
- stats 新增：
  - `GET /api/context/overview`：全局 KPI、与 KPI 同窗口的 range 热力图、会话表与 omitted 聚合。
  - `GET /api/session/context?file=...`：单会话完整时间线（含 fleet 汇总）。
- stats Web 新增全局 Context 路由与会话级 Context 视图；复用现有 trace 的 transcript 链接与图表组件。
- 旧会话（无明细快照）显式标记“仅 provider 锚点 / 组成不可得”，不推断历史组成。
- 文档、changelog、测试与真实运行验证。

### 范围外

- 不替换或重写 `/context` 的默认总览卡片；它成为新面板的 Overview 标签页。
- 不做真正的 node-link fleet 图；Fleet 用表格/树 + 每 agent 上下文汇总。
- 不新增 stats DB 表；全局页只读既有 `messages` / `message_rollup`，单会话按需解析 JSONL 并做 ETag 缓存。若实测性能不达标，回到设计门再议。
- 不持久化任何 prompt/message/tool 参数正文；只存 token 数与名称。
- 不覆盖 `/opt/homebrew/bin/omp`。所有开发/测试从源码或 `dist` 运行；安装是最后一步，且必须在 S5-R 与 S5-E2E 通过后由用户确认。

## Verified baseline

以下均为本仓当前代码的事实，不是推断：

| # | 事实 | 证据 |
| --- | --- | --- |
| B1 | `ContextSnapshot` 目前只存 `promptTokens`、`nonMessageTokens`、`toolSchemaTokens`、`historyRewriteTokensRemoved`、`compactionEpoch`、`lastMessageTimestamp`；**没有类别组成** | `packages/ai/src/types.ts:1243-1268` |
| B2 | 快照在成功 assistant 消息持久化时写入，且仅当 `stopReason` 不是 `aborted`/`error` 且有 usage | `packages/coding-agent/src/session/agent-session.ts:3988-4000` |
| B3 | 请求发出前调用 `setPendingSnapshot({promptTokens, nonMessageTokens, cutoffCount})`，并计算 `getContextBreakdown({contextWindow, pendingMessages})` | `packages/coding-agent/src/session/agent-session.ts:8742-8757` |
| B4 | 当前类别拆分由 `computeNonMessageBreakdown` 用**当前** session/settings/tools/skills 计算；`getContextBreakdown` 的 `messagesTokens` 是 used 减 non-message，用于“此刻”而非历史 | `packages/tui/src/status-line/context-usage.ts:386-415`，`packages/coding-agent/src/session/session-stats.ts:279-370` |
| B5 | `ContextUsageBreakdown` 已有五类字段：`systemPromptTokens`/`systemToolsTokens`/`systemContextTokens`/`skillsTokens`/`messagesTokens` | `packages/coding-agent/src/session/agent-session-types.ts:532-541` |
| B6 | TUI `/context` 当前打开 `ContextUsageView`，正文是 waffle 网格 + 图例；`ContextUsageView` 无标签页/键盘导航 | `packages/coding-agent/src/slash-commands/builtin-session.ts:542-559`，`packages/coding-agent/src/modes/controllers/command-controller.ts:957-970`，`packages/tui/src/status-line/context-usage.ts:963-982` |
| B7 | `showCommandReport` 在 native 下是可聚焦 sheet，支持任意 `Component` body；TUI 已有 `TabBar` 与可复用的 usage dashboard 覆盖层/热力图模式 | `packages/coding-agent/src/modes/controllers/command-controller.ts:252-280`，`packages/tui/src/components/tab-bar.ts`，`packages/tui/src/overlays/usage-dashboard.ts:1075-1150` |
| B8 | stats 已有 `GET /api/sessions`、`GET /api/session/trace`、`GET /api/session/entry`；trace 直接解析 JSONL，且**不 import coding-agent** | `packages/stats/src/server.ts:280-360`，`packages/stats/src/trace.ts:1-20` |
| B9 | stats 入口是 `messages`/`message_rollup`，已有 input/cache/total token 列与按小时 rollup；没有 context 组成表 | `packages/stats/src/db.ts:146-183`，`packages/stats/src/rollup.ts:1-45` |
| B10 | 会话日志已有可派生事件：`compaction`(含 `tokensBefore/tokensAfter/method`)、`branch_summary`、`model_change`、`thinking_level_change`、`service_tier_change`、`mode_change`、`ttsr_injection`、`custom_message`、`reset_boundary`、`session_init` | `packages/coding-agent/src/session/session-entries.ts:118-344` |
| B11 | `prunedAt` 只存在于工具结果消息上（advisor 逐轮驱逐），**没有** `prune` 日志条目；Prune 事件只能从消息字段识别 | `packages/coding-agent/src/advisor/tool-result-eviction.ts:24-104` |
| B12 | 文件工具结果已有可用的行数/大小信息：read 的 `totalLines`/`fileSize`/`summary.lines`，write 的 `resolvedPath`，edit 的 `diff`/`perFileResults`/`oldText`/`newText` | `packages/tui/src/tools/read.ts:50-92`，`packages/tui/src/tools/write.ts:74-90`，`packages/tui/src/tools/edit.ts:73-115` |

### 已知约束

- 旧快照无法还原历史类别组成。任何“补算历史”都会把当前配置写进过去，违反口径一致；本 feature 一律显式降级。
- `promptTokens` 是 provider 权威锚点；类别之和可能因估算与缓存/服务端策略有偏差。设计必须定义差额归属（见 S2）。
- stats 不 import coding-agent；共享层只能放在双方都依赖的包（`@oh-my-pi/pi-ai`）。
- TUI 是单列窄屏；六类信息不能平铺。TUI 只做四页，Browser/Fleet 留给 Web。
- 安装二进制会覆盖当前运行环境；测试通过前只允许 `bun` 源码运行。

## Proposed acceptance criteria

| ID | 可观察的验收条件 |
| --- | --- |
| AC-01 | 对同一 fixture 会话，coding-agent 的 `getContextTimeline()` 与 stats 的 journal fold 产出相同 `ContextTimeline`（步骤、类别、事件顺序、文件聚合逐字段相等）；快照含明细时 `Σcategories + unattributed === promptTokens`；`unattributed` 允许为负并原样展示，不静默摊回五类。 |
| AC-02 | 每个成功 assistant 轮次持久化明细；`aborted`/`error` 轮次沿用现有快照规则且不产生伪明细；旧快照读取为 `details: undefined`，TUI/Web 显示“组成不可得”，测试断言不构造类别。 |
| AC-03 | `/context` 打开后默认 Overview，Tab/Shift-Tab 或 1-4 可切换 Overview/Trend/Events/Files；`d` 切换 Δ；窄屏（<80 列）与无模型/空会话均有明确降级文本；组件测试覆盖按键与渲染。 |
| AC-04 | `/api/context/overview` 返回 KPI、与 KPI 同窗口的 range 热力图、最多 200 行会话行及 omitted 聚合；数据来自 `messages`/rollup，且在未截断/截断两种情形下均满足 `Σheatmap.requests === Σsession.requests + omittedRequests`、`Σheatmap.promptTokens === Σsession.promptTokens + omittedPromptTokens`；UI 路由可加载并点击进入会话详情。 |
| AC-05 | `/api/session/context?file=` 返回 steps/composition/events/files/fleet；Web 六个标签页可切换并展示；Browser 可下钻到 tool/skill/system-part 条目与 message 计数；新会话显示 `estimated` 标记，旧会话显示 `composition unavailable`。 |
| AC-06 | TUI 与 Web 的测试共享同一 fixture 与断言函数：类别求和、事件排序、文件聚合、步骤上限一致；不允许两套独立“口径”实现。 |
| AC-07 | 不持久化正文；单次 API payload 有明确上限（steps ≤ 1000、events ≤ 200、files ≤ 500、browser 条目 ≤ 500）；超限返回 `truncated: true` 且测试覆盖。 |
| AC-08 | 从源码启动 TUI 与 `omp stats`，对同一正在写入的会话验证：新 turn 后 TUI Trend 与 Web Trend 的新增步骤数/Δ 一致；浏览器与 PTY 均为真实运行证据，不以单测代替。 |
| AC-09 | 受影响测试、类型检查、lint 通过；`bun run build` 产物可运行；**在用户明确确认前不覆盖已安装 omp**。 |

## Decisions requested at S2-H

1. `/context` 原地升级为四页（Overview 保持原卡片）而不是新增第二个命令。
2. 共享 fold 放在 `packages/ai/src/context-insights.ts`，coding-agent 与 stats 都 import；stats 继续不 import coding-agent。
3. 全局 Context 页不新增 DB 表；只读既有 messages/rollup。单会话详情按需解析 JSONL，用文件 mtime+size 做 ETag。
4. 类别差额归属：`promptTokens` 是权威值，`Σcategories` 是估算；差额记入有符号 `unattributed = promptTokens - Σcategories`，正负都原样展示，不摊回五类。composition 存在时 `compositionEstimated=true`；旧快照不补算。
5. 事件“Prune”只从工具结果 `prunedAt` 识别，时间取消息时间并标记 `inferred: true`。
