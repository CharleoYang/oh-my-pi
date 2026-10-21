# Context insights — 设计文档

Goal：`spec-001-omp-context-insights`。本文是实现契约；接口类型以 `接口文档.md` 为准，类图见 `类图.md`。

## 1. 目标与约束

- **一个口径**：TUI 与 stats Web 都从 `ContextTimeline` 读取步骤、组成、事件、文件活动；不允许两端各写一套 fold。
- **历史不可伪造**：只有请求时持久化的明细才能还原历史组成；旧快照显示“组成不可得”。
- **provider 锚点优先**：`promptTokens` 是权威值；类别是估算；差额记入 `unattributed`，原样展示。
- **不存正文**：只存 token 数与名称（tool/skill/part 序号）。
- **开发期不覆盖安装**：所有验证从源码或 `dist` 运行；安装是 S5 之后的独立动作，且需用户确认。
- **TUI 单列窄屏**：四页简版；Browser/Fleet 只在 Web。

## 2. 架构

### 2.1 分层

```text
packages/ai/src/context-insights.ts        共享类型 + foldContextTimeline + 上限/降级
        ▲                         ▲
        │                         │
coding-agent 适配器            stats 适配器
- 请求时捕获 details           - 解析 JSONL / active branch
- AgentSession.getContextTimeline  - 子 transcript → fleet
- 持久化到 assistant 快照       - /api/session/context
        │                         │
TUI ContextInsightsView        stats client ContextRoute/ContextDetail
```

- **共享层**：`@oh-my-pi/pi-ai` 新增 `context-insights.ts`，并从 package index 导出。纯函数、无 Node API、无 TUI/agent 依赖。
- **coding-agent**：新增 `session/context-insights.ts`，负责 live 适配、`AgentSession.getContextTimeline()`；`session-stats.ts` 负责把 details 挂到 pending snapshot；`agent-session.ts` 负责持久化。
- **TUI**：`packages/tui/src/status-line/context-insights.ts` 提供组件与文本渲染；`command-controller.ts` 的 `/context` 改为打开该组件（Overview 仍是原卡片）。
- **stats**：新增 `src/context.ts`（journal 适配、全局 overview 查询、ETag），`server.ts` 增加两个路由；client 新增 `routes/ContextRoute.tsx` 与 `routes/context/**`。
- **不新增 stats DB 表**；全局页只读 `messages`/`message_rollup`，单会话按需解析。

### 2.2 数据流：实时

```text
before request
  getContextBreakdown(...) -> categories
  captureContextSnapshotDetails(...) -> details
  stats.setPendingSnapshot({promptTokens, nonMessageTokens, cutoffCount, details})
response
  assistant.contextSnapshot = {promptTokens(usage), nonMessageTokens, toolSchemaTokens, compactionEpoch, details}
  persist session entry
/context
  session.getContextTimeline() = fold(active branch entries, source="live")
  ContextInsightsView(timeline, current breakdown)
```

### 2.3 数据流：stats

```text
GET /api/session/context?file=...
  resolve path under sessions dir (reuse trace path guard)
  root + child transcripts (for fleet)
  parse entries leniently -> active parentId chain
  foldContextTimeline(entries, source="journal")
  build ContextAgentUsage[] from child folds
  ETag = root mtime/size + child fingerprint
  200 JSON | 304 unchanged | 400 path | 404 missing
```

```text
GET /api/context/overview?range=...
  messages/rollup -> KPI + hourly series + session rows
  listSessionSummaries -> titles/folders/models
  attach prompt peak/avg per session
  200 JSON
```

## 3. 数据模型

### 3.1 快照明细（持久化）

`ContextSnapshot` 增加可选 `details`：

```ts
type ContextCategoryId = "systemPrompt" | "systemTools" | "systemContext" | "skills" | "messages";

interface ContextCategoryTokens {
  systemPrompt: number;
  systemTools: number;
  systemContext: number;
  skills: number;
  messages: number;
}

interface ContextNamedTokens { name: string; tokens: number; }

interface ContextSnapshotDetails {
  contextWindow: number;
  categories: ContextCategoryTokens;
  toolSchemas?: ContextNamedTokens[];
  omittedToolSchemas?: number;
  skills?: ContextNamedTokens[];
  omittedSkills?: number;
  /** Token counts for systemPrompt parts; parts[0] already has skills subtracted. */
  systemPromptParts?: number[];
  /** Original parts merged into the last returned part (0 when none). */
  systemPromptPartsOmitted?: number;
  messageCount: number;
  pendingMessageTokens: number;
}

/** Bounded projection attached to a returned step (response cap, see maxBrowserEntries). */
interface ContextStepDetails {
  contextWindow: number;
  categories: ContextCategoryTokens;
  toolSchemas?: ContextNamedTokens[];
  omittedToolSchemas?: number;
  skills?: ContextNamedTokens[];
  omittedSkills?: number;
  systemPromptParts?: number[];
  systemPromptPartsOmitted?: number;
  messageCount: number;
  pendingMessageTokens: number;
}
```

不变式：

- `categories` 是**请求时估算**；`promptTokens` 在响应后由 provider usage 覆盖为权威值。
- `toolSchemas` / `skills` 是**独立估算**；tokenizer 的边界合并会让逐项计数之和与类别总量不一致。捕获时用最大余数法把逐项值归一到类别总量：原始权重和 > 0 且没有条目被上限省略时，和**恰好等于**对应类别；全零权重时 items 为空、等式不适用；有条目省略时，保留项之和 ≤ 类别总量，差额由 `omitted*` 解释。
- `systemPromptParts` 覆盖 `systemPrompt` 全部 part：`parts[0]` 归一后等于 `categories.systemPrompt`，`parts[1..]` 之和归一后等于 `categories.systemContext`。`maxSystemParts` 最小为 2；超过上限时保留前 `max-1` 个，最后一项吸收剩余部分总量，`systemPromptPartsOmitted` = **被并入最后一格的额外原始 part 数**（`originalCount - returnedCount`，0 表示没有合并；21 个 part、cap 20 → omitted=1，最后一项代表原始 `parts[19..20]`）。
- 原始权重全为 0 且类别总量 > 0 时：items 返回空数组（不发明条目），类别总量保留；system parts 则把 prompt/context 类别总量分别放进 `parts[0]`/剩余部分。
- 最大余数法：按权重比例取整，余数给小数部分最大者；并列按 name（items）或原始序号（parts）升序。所有输入先 clamp 为非负有限整数。
- `omittedToolSchemas`/`omittedSkills` 表示被上限省略的条目数；被省略的 token 仍计入对应类别总量。
- 不存消息正文、system prompt 正文、工具参数正文。

### 3.2 Timeline（共享视图）

```ts
interface ContextStep {
  id: string;                    // assistant entry id
  index: number;                 // absolute step index in the session
  timestamp: number;
  model?: string;
  provider?: string;
  promptTokens: number;          // provider anchor when available
  anchored: boolean;             // snapshot present
  composition?: ContextCategoryTokens; // undefined for legacy
  compositionEstimated?: boolean; // true when composition exists (always an estimate)
  /** Bounded snapshot-detail projection; undefined when legacy or over the response budget. */
  details?: ContextStepDetails;
  unattributed?: number;         // promptTokens - sum(composition), signed
  contextWindow?: number;
  deltaTokens?: number;
  deltaKind: "first" | "grow" | "shrink" | "compaction" | "reset" | "model-switch";
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; costTotal?: number };
  eventIds: string[];
  filePaths: string[];
}

interface ContextEvent {
  id: string;
  timestamp: number;
  kind: "inject" | "compact" | "prune" | "switch" | "mode" | "reset" | "branch";
  label: string;
  detail?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  source?: string;
  inferred?: boolean;            // prune from prunedAt, not a journal event
  /** Absolute index of the next step in file order (the step it affects); undefined when trailing. */
  stepIndex?: number;
}

interface ContextFileActivity {
  path: string;
  reads: number; writes: number; edits: number; searches: number;
  linesRead: number; linesAdded: number; linesRemoved: number;
  bytesRead: number; bytesWritten: number;
  lastTimestamp: number;
}

interface ContextAgentUsage {
  trackId: string; label: string; agent?: string; model?: string;
  requests: number; peakTokens: number; lastTokens?: number; costTotal?: number;
  status: "main" | "subagent" | "advisor";
}

interface ContextTimeline {
  schemaVersion: 1;
  sessionId: string;
  file?: string;
  cwd?: string;
  source: "live" | "journal";
  steps: ContextStep[];
  omittedSteps: number;
  /** Steps that have details in the journal but exceeded maxBrowserEntries. */
  detailsOmittedSteps: number;
  composition?: ContextCategoryTokens; // last returned step
  contextWindow?: number;              // last returned step
  peakTokens: number;
  events: ContextEvent[];
  omittedEvents: number;
  files: ContextFileActivity[];
  omittedFiles: number;
  /** Tool calls that produced no toolResult before the session ended. */
  incompleteFileCalls: number;
  agents: ContextAgentUsage[];
  legacySteps: number;
  truncated: boolean;
}
```

### 3.3 语义

- `promptTokens`：优先 `contextSnapshot.promptTokens - historyRewriteTokensRemoved`；否则 `usage.contextTokens ?? usage.input + usage.cacheRead + usage.cacheWrite`。负数 clamp 到 0（与现有 `correctedPromptTokens` 一致）。
- `anchored`：存在 `contextSnapshot`。仅有 usage 的步骤 `anchored=false`，但仍是真实请求，保留在 timeline。
- `composition`：仅当 `contextSnapshot.details` 存在；否则 `undefined`，`legacySteps++`。`compositionEstimated=true` 表示它是请求时估算，不是 provider 实测。
- `details`：从 `contextSnapshot.details` 投影，**只对返回窗口内、且在 `maxBrowserEntries` 预算内的最新步骤**填充；被预算跳过的步骤 `details=undefined`，`detailsOmittedSteps++`，但**不**增加 `legacySteps`（`legacySteps` 只看源快照是否缺 details/composition）。旧快照永远没有 `details`。
- `unattributed`：`promptTokens - Σcomposition`，**有符号**。正数=provider 额外部分（缓存/服务端策略/估算误差）；负数=估算高估。UI 原样显示；不得把差额摊回五类。
- `deltaTokens`：与上一条 timeline step 的 `promptTokens` 之差。若两者之间发生 reset/compaction/model switch，`deltaKind` 按 reset > compaction > model-switch 的优先级标记（多个事件时取最高优先级）；`deltaTokens` 仍按数值差给出，但 UI 必须显示 baseline 已重置。首步 `deltaKind="first"`、无 delta。
- `peakTokens`：返回窗口内 `promptTokens` 最大值；不跨 compaction 累加。
- `index`：会话内绝对序号（从 0 开始）；窗口只保留最新 N 步时 `omittedSteps` 给出被省略数，首步 `index` 不一定为 0。
- `eventIds`/`stepIndex`：事件只按**文件顺序**关联到“它之后的第一条 step”（即它影响的下一步）；没有后续 step 的尾部事件 `stepIndex=undefined`。`step.eventIds` 只包含关联到该返回 step 的事件；若目标 step 已被 steps 窗口省略，事件仍保留绝对 `stepIndex`，但 UI 不提供跳转。时间戳只用于显示，不参与关联，避免时钟回拨造成双重归属。
- `incompleteFileCalls`：有 toolCall 但活动分支内没有对应 toolResult 的文件工具调用数；调用侧可确定的写/编辑计数仍计入。
- `agents`：journal 适配器填 fleet；live 适配器为 `[]`（TUI 不展示 Fleet）。
- `truncated`：任一列表或 details 预算被截断即为 true。

## 4. 算法

### 4.1 捕获快照明细

入口：`#promptWithMessage` 已算出 `breakdown`（`ContextUsageBreakdown`）与 `contextWindow`。

1. 新建 `captureContextSnapshotDetails(session, breakdown, tokenizer, options)`：
   - `categories` 直接取 breakdown 的五类；`messages` 是 breakdown 的 `messagesTokens`。
   - `toolSchemas`：对每个 tool 用与 `estimateToolSchemaTokens` 相同的 fragments（name/description/wire schema/examples）**单独**计数，再用最大余数法归一到 `categories.systemTools`。排序按 tokens 降序、name 升序；超过 200 个时保留前 200，`omittedToolSchemas` 记剩余数；此时不再归一（保留项之和 ≤ 总量）。
   - `skills`：对 `renderedSkills(...)` 逐个 `countTokens([name, description])`，同样归一到 `categories.skills`；上限 200；`omittedSkills`。
   - `systemPromptParts`：对 `session.systemPrompt ?? []` 每个 part countTokens；part 0 减去 skills 总量（不小于 0）；把 part 0 归一到 `categories.systemPrompt`，把 parts[1..] 归一到 `categories.systemContext`。`maxSystemParts` clamp 到 `[2, 20]`；超过上限时保留前 `max-1` 个，最后一项 = prompt+context 类别总量 - 前 `max-1` 个之和，`systemPromptPartsOmitted` = 被并入最后一格的**额外**原始 part 数（`originalCount - returnedCount`，0 表示没有合并）。例如 21 个 part、cap 20：返回 20 项，`parts[19]` 吸收原始 `parts[19..20]`（2 个原始 part），`systemPromptPartsOmitted=1`。
   - 原始权重全为 0 且类别总量 > 0：`toolSchemas`/`skills` 返回空数组（不发明条目），类别总量保留；system parts 把 prompt/context 类别总量分别放入 `parts[0]`/剩余部分。
   - `messageCount = session.messages.length + pendingMessages.length`；`pendingMessageTokens = tokenizer.countMessages(pendingMessages)`。
2. `stats.setPendingSnapshot({..., details})`。
3. `#persistSessionMessageIfMissing` 在成功 assistant 上写入 `details`。
4. `recordAnchoredHistoryRewrite` 若补建 snapshot（历史 anchor 没有 snapshot），**不写 details**；这是旧会话路径。
5. `aborted`/`error` 不写 snapshot（保持现状）；它们的 usage 仍可在 fold 中形成 `anchored=false` 的步骤。

性能：`estimateToolSchemaTokens` 已有 roster 级缓存；新增按 tool 拆分只在该缓存未命中时计算，并缓存 `byTool` 结果（同一 tool array、tokenizer、sourceRevision、model schema policy 键）。每轮通常命中缓存，成本 O(1)；配置/roster 变化时 O(tools)。

### 4.2 共享 fold

`foldContextTimeline(input: ContextTimelineInput): ContextTimeline`：

1. 输入是**已按 active branch 过滤**的 entries（适配器负责，规则见 4.6）。若 entry 缺 `id`，用 `type + timestamp + 序号` 生成稳定 id。
2. 按文件顺序遍历；同一 `id` 只处理第一次（重复/复制条目去重）。
3. assistant 消息：
   - 从 `message.content` 提取 `type === "toolCall"` 的 block，建立 `toolCallId -> {name, arguments}`；文件工具立即按 4.4 的调用侧规则登记（write/edit 不依赖 result）。
   - `promptTokens` 按 3.3 计算；为 0 且无 snapshot 时跳过（非模型调用）。
   - 生成 `ContextStep`；`composition` 从 `message.contextSnapshot.details.categories` 取，`compositionEstimated=true`；`details` 暂存原始 `ContextSnapshotDetails`（供第 7 步预算投影）。
   - `usage` 从 message.usage 取；`total` 取 usage.total ?? input+output+cacheRead+cacheWrite。
   - 记录该 step 的绝对 index。
4. toolResult 消息：
   - 若 `prunedAt` 存在 → `ContextEvent{kind:"prune", inferred:true, timestamp: message.timestamp}`。
   - 与 toolCall 按 id 关联，按 4.4 补齐 diff/行数；清除 pending 标记。
5. 事件条目：按 4.3 映射；所有事件保持**文件顺序**（时间戳只用于显示）。
6. 事件归属：事件关联到**文件顺序上它之后的第一条 step**（即它影响的下一步），设 `stepIndex` 为该 step 的绝对 index；没有后续 step 的尾部事件 `stepIndex=undefined`。`step.eventIds` 只填关联到该返回 step 的事件；目标 step 被 steps 窗口省略时，事件保留绝对 `stepIndex`，但不填任何返回 step 的 `eventIds`。不得用 timestamp 做关联。
7. details 预算：steps 保留最新 `maxSteps` 后，从**最新 step 向前**为带 `ContextSnapshotDetails` 的 step 投影 `ContextStepDetails`；每个 step 的条目数 = `toolSchemas.length + skills.length + systemPromptParts.length`。若加入该 step 会超过 `maxBrowserEntries`，则该 step `details=undefined`、`detailsOmittedSteps++`；不返回半份 details。`maxBrowserEntries=0` 表示不返回任何 details。旧快照不参与。
8. 截断：events 保留最新 `maxEvents`（尾部优先），files 按 `reads+writes+edits+searches` 降序、再按 `lastTimestamp` 降序保留 `maxFiles`；记录 omitted 计数。尾部事件的 `stepIndex` 仍按完整 timeline 计算。
9. 文件收尾：遍历结束后，仍未匹配 result 的文件 toolCall 计入 `incompleteFileCalls`；调用侧已登记的 write lines/bytes、edit 计数保留。
10. 返回：`composition`/`contextWindow` 取最后返回 step；`peakTokens` 取返回窗口最大值；`legacySteps` 只统计**源快照**没有 `ContextSnapshotDetails`/composition 的返回 step（budget 省略导致的 `details=undefined` **不算** legacy，只计入 `detailsOmittedSteps`）；`truncated` 任一列表/预算截断即为 true。

### 4.3 事件映射

| entry / 字段 | kind | label | 其他 |
| --- | --- | --- | --- |
| `compaction` | `compact` | `compact ${method ?? "?"} ${tokensBefore}→${tokensAfter ?? "?"}` | `tokensBefore/tokensAfter` |
| `branch_summary` | `branch` | `branch summary` | detail 截断 120 字符 |
| `custom_message` | `inject` | `inject ${customType}` | source=customType；不估算 token |
| `ttsr_injection` | `inject` | `inject rules: ${injectedRules.join(", ")}` | source="ttsr" |
| `model_change` | `switch` | `model ${model}${role ? " ("+role+")" : ""}` | detail=resolvedModelIsFallback ? "fallback" : undefined |
| `thinking_level_change` | `switch` | `thinking ${configured ?? thinkingLevel ?? "?"}` | |
| `service_tier_change` | `switch` | `service tier ${...}` | |
| `mode_change` | `mode` | `mode ${mode}` | |
| `reset_boundary` | `reset` | `context reset` | |
| toolResult with `prunedAt` | `prune` | `prune ${toolName}` | inferred=true；detail=toolCallId |

- `custom_message` 的正文不读取、不存；`compaction.summary` 也不读取。
- 未知 entry type 忽略；不报错。
- 同一时间戳的事件保持文件顺序。

### 4.4 文件活动

只统计**文件系统**工具；URL/internal（`http(s)://`、`artifact://`、`xd://`、`ssh://`）排除。

| tool | 计数 | 行/字节 |
| --- | --- | --- |
| `read` | reads++ | `details.summary.lines ?? details.totalLines ?? displayContent.text 行数` 计入 linesRead；`details.fileSize` 计入 bytesRead |
| `write` | writes++ | `content` 行数计入 linesAdded、UTF-8 字节计入 bytesWritten；`resolvedPath ?? args.path` |
| `edit` / `ast_edit` | edits++ | 从 `details.diff` 或 `perFileResults[].diff` 统计 `+`/`-`（排除 `+++`/`---`）；多文件按 `path` 拆分 |
| `glob` / `grep` / `find` / `ast_grep` / `lsp` | searches++ | 无行数 |
| 其他 | 不统计 | |

- 路径归一化统一由 `ContextTimelineInput.normalizePath(path)` 完成；适配器提供 cwd + additionalDirectories 解析。fold 对所有 `args.path`、`details.resolvedPath`、`perFileResults[].path`、`sourcePath` 调用该函数一次；resolver 必须先剥离 read 选择器（`:1-10`、`-20`、`raw`、`conflicts`、`img`、逗号范围）再解析；返回空串/URL 时跳过。live 与 journal 不得各自实现不同规则；测试覆盖相对路径、绝对路径、additionalDirectories、选择器、URL/internal。
- 文件工具在 assistant toolCall 阶段先登记：`write` 的 lines/bytes 与 `edit` 的 edits 计数不依赖 result；result 到达后只补齐 diff 行数、read 行数/字节，不重复计数。遍历结束仍无 result 的调用计入 `incompleteFileCalls`。
- 同一 toolCall 的 result 可能缺失（中断）：调用侧可确定的计数保留；read 无 result 只计 reads++，不计 linesRead/bytesRead。
- `linesRead` 使用 read 返回的行数，不是模型实际保留的 token；这是“读了多少”的近似，口径在 UI 标注。
- `edit` 的 `oldText`/`newText` 不做全文 diff（体积大）；优先 `diff`。两者都缺失时只计 edits++。
- `prunedAt` 不影响文件活动（历史读/写仍发生）。

### 4.5 Live 适配

`buildLiveContextTimeline(session, limits)`：

- entries = `sessionManager.getBranchView()`。
- cwd = `sessionManager.getCwd()`；additional dirs = `sessionManager.getAdditionalDirectories()`（若存在）。
- `normalizePath` 由 live 适配器注入：用 cwd + additional dirs 解析相对路径；共享 fold 不读文件系统。
- entries 直接传给 fold（结构兼容）；无需复制。
- `agents: []`；`sessionId = session.agent.sessionId`。
- 事件/文件均从 entries 即时计算，不读盘。

`AgentSession.getContextTimeline(options?: { limits?: Partial<ContextTimelineLimits> }): ContextTimeline` 暴露给 TUI/测试。

### 4.6 Journal 适配

`buildSessionContextTimeline(file, limits)`：

1. 用现有 trace 路径守卫解析并确认文件在 sessions dir 下；读取时复用 trace 的**解压读取**逻辑（支持 `.jsonl.gz`），再 `parseAllSessionEntries`（lenient；坏行跳过）。
2. active branch 必须**精确镜像 live replay**，不能直接用 trace 的 `activeChain`：
   - 按文件顺序重放 leaf：`leaf = entry.activeLeafId !== undefined ? entry.activeLeafId : entry.id`（`activeLeafId=null` 表示清空）。
   - 无 entry → 空；`leaf === null` → 空。
   - `leaf` 不存在于 id 集合（rollback/rewrite 后的悬空 leaf）→ 取**最新的自选 entry**（`sessionEntryLeafId(entry) === entry.id`）作为 leaf；仍无 → 空。
   - 从 leaf 沿 `parentId` 回溯（遇到缺失 parent 即停止），得到 id 集合，再按文件顺序过滤 entries。
   - `ContextJournalEntry` 必须携带 `activeLeafId?: string | null`。
3. `normalizePath` 用 session header 的 `cwd` + `additionalDirectories` 构造；root fold 时注入。
4. root fold；子 transcript：
   - 复用 trace 的**递归**子 transcript 发现（包括 `.jsonl.gz`、嵌套子 agent、`__advisor*` 标记），排除 root 自身；结果排序稳定。
   - 每个子文件同样 active-leaf replay + fold（只取 steps 汇总，不返回完整 timeline）。
   - `ContextAgentUsage`：`trackId` 用相对 root 的路径键；`status` 按 `classifyAgentType`（main/subagent/advisor）；`requests` = steps 数；`peakTokens` = max；`lastTokens` = 最后一步；`costTotal` = sum usage.costTotal。
5. root timeline `agents` 填 root + children（root `status="main"`）。
6. ETag fingerprint：root + **与 fleet 完全相同的子文件集合**，按路径排序，逐个 `mtimeMs:size`（必要时加 inode/birthtime）后 hash；请求头 `If-None-Match` 相同则 304。race/缺失子文件时退化为“变化”而不是复用旧 body。
7. 失败：路径越界 → `TracePathError`（400）；不存在 → 404；解析失败（无有效 entry）返回空 timeline（200）而不是 500。

### 4.7 截断与上限

```ts
const DEFAULT_LIMITS = {
  maxSteps: 1000,          // API
  maxEvents: 200,          // matches AC-07
  maxFiles: 500,           // matches AC-07
  maxBrowserEntries: 500,  // total named entries across returned step.details
  maxToolSchemas: 200,     // persisted details
  maxSkills: 200,
  maxSystemParts: 20,      // capture clamps to [2, 20]
};
const TUI_LIMITS = {
  ...DEFAULT_LIMITS,
  maxSteps: 200,
  maxEvents: 100,
  maxFiles: 50,
  maxBrowserEntries: 0,    // TUI has no Browser tab
};
```

- 上限是“返回/持久化的最大条目数”，不是静默丢数据：`omitted*`、`detailsOmittedSteps` 与 `truncated` 必须反映。
- `maxBrowserEntries` 是**全局预算**：从最新 step 向前累加 `toolSchemas + skills + systemPromptParts` 条目数；超出时该 step 不返回 details，计入 `detailsOmittedSteps`。API 不接受客户端覆盖。
- API 的 steps/events/files/browser 上限与 AC-07 一致；TUI 固定使用 TUI_LIMITS。
- 持久化明细的上限发生在捕获时，因此历史无法恢复被省略的条目；`omitted*` 永久记录。

## 5. TUI 设计

### 5.1 入口

`/context` 保持原命令与 autocomplete；`handleContextCommand()`：

1. `computeSessionContextBreakdown(session, {snapcompactSavings:true})`（保留现有行为）。
2. `session.getContextTimeline({limits: TUI_LIMITS})`。
3. `showCommandReport({title:"Context", head: contextUsageHead(breakdown), interactive:true, body: new ContextInsightsView({timeline, breakdown, theme, onRefresh: () => session.getContextTimeline({limits: TUI_LIMITS})})})`。

**交互键转发（B2）**：现有 `ReportPanel` 只处理关闭/滚动，不调用 `body.handleInput`，直接替换 body 会让 Tab/1-4/d/r 全部失效。实现必须同时修改 host：

- `showCommandReport` 增加 `interactive?: boolean`；为 true 时无论排版是否 fit，都使用可聚焦 overlay（native sheet 或 ANSI fullscreen）并 `holdFocus`，确保 ReportPanel 收到按键。
- `ReportPanel.handleInput` 先处理自己的关闭/滚动键；未消费的按键再委托给 `body.handleInput(data)`（若存在），返回值决定是否消费。`Esc` 仍由 panel 优先处理。
- native 的 `handleNativeEvent` 同样把非关闭事件（`select`/`activate`/`hover`）转发给 body，TabBar 的点击/hover 才能工作。
- host 级测试用 fake interactive body，分别在 native 与 ANSI fullscreen 断言 Tab/1-4/d/r 到达 body、Esc 关闭、滚动键不被 body 抢走。仅测组件本身不足以覆盖 B2。

无模型（`contextWindow<=0`）仍打开，Overview 显示现有“unavailable”文本，Trend/Events/Files 可用（若有历史）。

### 5.2 组件

`packages/tui/src/status-line/context-insights.ts`：

- `ContextInsightsView extends Container`，实现 `handleInput`、`describe`、`render`。
- 顶部 `TabBar("", tabs, theme, activeIndex)`：
  - `overview` Overview
  - `trend` Trend
  - `events` Events
  - `files` Files
- `showHint=false`，由底部 footer 统一提示，避免窄屏重复。
- 键盘：
  - `Tab`/`Right` 下一页；`Shift+Tab`/`Left` 上一页（TabBar.handleInput）。
  - `1`..`4` 直接跳页（先于 TabBar 处理）。
  - `d` 切换 Trend 的 Δ 列。
  - `r` 调用 `onRefresh()`，用返回的新 timeline 替换数据，保留当前 tab 与滚动位置（clamp 到新长度）；若 host 未提供回调，忽略且 footer 不显示 r。不重建 report。
  - `Up`/`Down`/`PageUp`/`PageDown` 滚动当前页（`ScrollView`；文件/事件表分行）。
- 每个 tab 内容：
  - **Overview**：现有 `ContextUsageView`（waffle + legend） + KPI 行（Current, Peak, Steps, Compactions, Injects, Files）。KPI 用 `MetricRow`/`Text`，不新造图表。若 `legacySteps>0`，加一行 `History composition unavailable for N step(s)`。
  - **Trend**：最近 20 步；每步一行：`#index time total Δ [stacked bar] markers`。stacked bar 用 5 种主题色的 `█`（每类按比例，最小 1 格），宽 24；窄屏(<80)隐藏 bar，只留数字。Δ 列 `d` 切换；压缩步骤前加 `⟦c⟧`，reset 加 `⟦r⟧`，model switch 加 `⟦m⟧`。无 composition 的步骤显示 `n/a`，不画 0。
  - **Events**：最近 20 行表格 `time kind label`；`prune` 标 `~`；`inject` 标 `+`；`compact` 标 `↓`。滚动查看更多。
  - **Files**：最近 20 行 `path R/W/E/S +lines -lines`；路径中间截断；按活动量排序（与 API 相同）。
  - footer：`Tab/←→ pages · 1-4 jump · d delta · ↑↓ scroll`，有 `onRefresh` 时追加 `· r refresh`，再追加 `· Full view: omp stats`。
- ANSI fallback：`render(width)` 返回上述文本行；`describe()` 返回 `col([tabBar, body, footer])`；表格用 `node("table")`，KPI 用 `row`/`text`。不依赖图表/图片能力。

### 5.3 降级

- 空会话：Overview 显示现有 breakdown；Trend/Events/Files 显示 `No steps/events/files yet.`
- 旧 steps：`composition` 缺失 → Trend `n/a`，Overview 的当前 composition 仍显示，但标注 `current estimate`，不冒充历史。
- 宽度 <80：隐藏 Trend bar、缩短路径、footer 换行。
- 无 native 能力：纯文本；不调用 `chart`/`image`。

### 5.4 测试

- 组件单测：tab 切换、数字键、d、窄屏、legacy、空态。
- VirtualTerminal E2E：真实 `InteractiveMode` + `/context`，断言四页标题与关键行；不调用真实模型（构造 fixture session）。

## 6. Web 设计

### 6.1 路由与导航

- `DashboardSection` 增加 `"context"`；`NAV` 的 Insights 组增加 `{id:"context", label:"Context", icon: Gauge, hotkey:"x"}`。
- `useHashRoute`：`setSection` 对 `context` 也保留 `session`（与 traces 相同）。
- `App` 增加 `ContextRoute`，props `{active, range, session, onOpenSession}`。
- 未选 session：全局页；选中 session：详情页（返回按钮清除 session）。

### 6.2 全局页 `ContextRoute`

- 数据：`GET /api/context/overview?range=${range}`，`useQuery` 轮询 30s（与 sessions 一致）。
- 内容：
  - KPI `StatGrid`：Sessions、Requests、Avg prompt、Peak prompt、Total tokens。
  - **Activity heatmap（跟随 range）**：`ContextHeatmap`（CSS grid；1h/24h/7d 用小时桶，30d/90d 用天桶；颜色按 requests 分位；hover 显示桶时间/requests/prompt tokens）。热力图、KPI、会话行必须使用**同一个 cutoff 窗口**，不得拿 7 天热力图对比 30 天 KPI。
  - 会话表：复用 `Table`；行来自 range 聚合（requests/peak/avg/total 都按 cutoff 过滤），`listSessionSummaries` 只用于 title/folder/models 元数据；列 Session（title+folder）、Models、Requests、Peak prompt、Avg prompt、Last active。点击行 `onOpenSession(file)`。
  - 覆盖：按 range 内最后活动倒序返回最多 200 行；`omittedSessions`/`omittedRequests`/`omittedPromptTokens` 汇总剩余 root，保证 `Σheatmap = Σrows + omitted`（requests 与 promptTokens）。UI 显示 “+N sessions / +M requests not shown”。空 range `EmptyState`。
- 不显示全局 composition（没有 DB 表）；在页面副标题说明“composition 在会话详情”，并标注 `DB approximation · session detail is authoritative`。

### 6.3 会话详情 `ContextDetail`

- 数据：`GET /api/session/context?file=...`，`useQuery` 15s 轮询，ETag 304 不重建；`stale` 时不渲染上一会话数据（沿用 TraceView 模式）。
- 顶部：返回、会话标题、模型、请求数、峰值、压缩数、旧步骤徽标。
- 六个标签页（本地 state；不需要 URL 子路由）：
  1. **Composition**：waffle（复用/新建 CSS grid）+ legend；五类占比；下方三张表来自选中 step 的 `details`：Tools（name/tokens/share，显示 `omittedToolSchemas`）、Skills、System parts（`prompt[i]` token；`systemPromptPartsOmitted>0` 时最后一行标注 `parts[i..n]`）。选 step 下拉（默认最后一步）；legacy step 显示 `Composition unavailable`；`details` 因 `maxBrowserEntries` 预算缺失时显示 `Details unavailable for this step`，但 composition 仍可显示。
  2. **Trend**：每步堆叠柱（5 色）+ total 线（可选）+ 压缩/切换 marker；`Δ` 切换；hover tooltip 显示 step #/time/total/Δ/events；点击柱选中 step 并联动其他页。使用现有 `Chart`/`TimeChart` 或轻量 SVG；不引入新图表库。显示最近 200 步（API 1000，前端可缩放）。
  3. **Browser**：左侧 steps 列表（#/time/total）；选中后右侧树：Categories → named entries，全部来自 `step.details`。Tools/Skills 显示 tokens/share 与 omitted 计数；Messages 显示 messageCount/pending tokens（不显示正文）；System parts 显示序号/tokens 与合并信息。搜索框过滤名称；legacy 或 details 缺失显示明确提示。
  4. **Events**：表格 time/kind/label/detail；筛选 chips（inject/compact/prune/switch/mode/reset/branch）；`inferred` 显示 `~` 与 tooltip 说明；点击事件跳到其 `stepIndex`（若目标 step 不在返回窗口则禁用跳转并提示 truncated）。
  5. **Files**：表格 path/R/W/E/S/lines/bytes/last；排序与搜索；点击行在 Traces 中打开对应 session（v1 不定位到具体 tool span；在 tooltip 说明）。
  6. **Fleet**：agents 表（label/agent/model/requests/peak/last/cost/status）；点击子 agent 行切换到该 transcript 的 context（调用同一 endpoint，`file=child`），顶部显示 “Viewing subagent”; 返回 root。
- 响应式：≥1100px 双栏（steps 列表 + 内容）；窄屏单栏。legacy 徽标在顶部。
- 隐私：Browser 不显示消息/system prompt 正文；Files 只显示路径与计数。

### 6.4 客户端类型

`packages/stats/src/shared-types.ts` 以 `export type { ContextTimeline, ... } from "@oh-my-pi/pi-ai";` 暴露共享类型；`client/api.ts` 增加 `getContextOverview(range)`、`getSessionContext(file, signal, previous?)`；`client/types.ts` re-export。避免客户端复制 schema。

### 6.5 测试

- `context-ui.test.tsx`：mount ContextRoute/ContextDetail，mock fetch；断言 KPI、六个 tab、legacy、truncated、点击 session 回调。
- 浏览器 E2E 在 T-07：启动真实 stats server，用 puppeteer-core 打开 `#/context`，点击 tab，截图/文本断言；若本机无 Chrome，脚本 fail（不静默跳过）。

## 7. 降级与边界

| 场景 | 行为 |
| --- | --- |
| 旧快照无 `details` | `composition=undefined`；`legacySteps++`；TUI/Web 显示“组成不可得”；**不**用当前配置补算 |
| 只有 usage、无 snapshot | 生成 step，`anchored=false`；显示 total；composition 不可得 |
| `promptTokens < Σcategories` | `unattributed` 为负，原样显示；UI 用 warning 色标注 “estimate overshoot” |
| 空会话/无模型 | 明确空态；不抛错 |
| `aborted`/`error` | 不写明细；有 usage 仍可作为 step（anchored=false）；不伪造事件 |
| compaction | 事件带 before/after；下一步 delta 标注 baseline reset |
| reset/branch | 事件；deltaKind=reset；不把前一条历史算进新 baseline |
| 模型切换 | 事件；step 的 contextWindow 可能变化；top-level 取最后一步 |
| fork/rewind/late usage | 精确镜像 live `activeLeafId` replay；`activeLeafId=null` → 空分支；悬空 leaf → 最新自选 fallback；非 active 条目不计入 |
| 子 transcript 缺失/损坏 | Fleet 只显示可用项；root timeline 不受影响 |
| 坏 JSONL 行 | lenient 解析跳过；空 timeline 200，不 500 |
| 路径越界 | 400；不存在 404 |
| 超大会话 | steps/events/files/browser 预算 + omitted/truncated；不静默丢 |
| details 预算溢出 | 该 step `details=undefined`，`detailsOmittedSteps++`；composition 仍显示 |
| 未完成的文件 toolCall | 调用侧计数保留，`incompleteFileCalls++`；read 无 result 不计行数/字节 |
| system parts 0/1/20/21 | cap clamp 到 [2,20]；0 part 空数组；21 part 合并到最后并记 `systemPromptPartsOmitted` |
| 时钟回拨 | 事件按文件顺序关联；时间戳只显示；step delta 按顺序 |
| 重复 entry id | 只处理第一次；测试覆盖 |
| 多 workspace roots | 适配器注入 `normalizePath`；共享 fold 不依赖 cwd |
| 工具名重复 | 先按 name 合并原始权重，再归一化；Browser 显示合并后的 tokens |

## 8. 测试策略（TDD）

### 8.1 红先绿后

每个任务先写行为测试并观察失败，再实现。提交历史中 `test:` 必须早于对应 `feat/fix`；不得倒填。测试驱动**已交付入口**（`getContextTimeline`、`/context` 组件、HTTP 路由、React 路由），不是只测内部 helper。

### 8.2 任务级矩阵

| 任务 | 必测行为 | 负向对照 |
| --- | --- | --- |
| T-01 共享 fold | 步骤/类别/事件/文件/上限/legacy；fixture golden；details 预算 | 旧快照不补算；负 unattributed；重复 id；坏条目；尾部事件；目标 step 被窗口省略；details 预算溢出；activeLeafId null→空、悬空→fallback；未完成 toolCall |
| T-02 捕获与 live | 请求时 details；五类与 parts/tools/skills 求和；成功/aborted/error；live 与 fold 一致；归一化 | 无模型；空 messages；历史 anchor 补建不写 details；tool roster 变化；全零权重；0/1/20/21 parts |
| T-03 TUI | 四页/按键/窄屏/legacy/空态；VirtualTerminal；host 键转发；modern-only + maxBrowserEntries=0 时 legacySteps=0 且 Trend 有 composition | 无模型仍可打开；无 native 能力不调 chart/image；滚动键不被 body 抢走 |
| T-04 全局 API | KPI/heatmap/session 行同窗口；空 range；>100 roots | 无数据；旧请求+新请求；子 transcript 折入；非法 range；range 外数据不计入 |
| T-05 会话 API | 与核心 fold 逐字段一致；ETag 304；fleet；旧会话；gzip/递归子文件 | 路径越界 400、缺失 404、坏行 200 空、子文件缺失、ETag 子文件变化 |
| T-06 Web UI | 六页/联动/legacy/truncated/点击；非最新 step details | 空数据、请求失败、窄屏、stale 不渲染旧会话、details 缺失提示 |
| T-07 E2E/文档 | 真实 TUI + 真实 stats server/browser；同一会话数字一致；changelog | 不安装；构建产物运行；无浏览器则失败 |

### 8.3 共享 fixture

- 新增 `packages/ai/test/fixtures/context-session.ts`（或 `.jsonl`）：包含 6 个助手步骤、1 次 compaction、1 次 ttsr injection、1 次 model switch、1 次 reset、read/write/edit/search 工具调用、1 个 pruned result、1 个旧快照步骤、1 个只有 usage 的步骤、1 个 `activeLeafId` 指向早先 leaf 的 late-usage 条目、1 个尾部 injection、1 个未完成文件 toolCall、1 个 21-part/全零权重的边界快照。
- T-01/T-02/T-05 共用该 fixture；断言函数放在 `packages/ai/test/context-insights-assertions.ts`，避免三份断言漂移。另含一个“非最新 step 的 details 仍可读”的子 fixture。
- fixture 的期望值由**独立规则**计算（手算表/固定 JSON），不是调用被测函数生成后冻结。

### 8.4 验证器自证（RL-08 / RL-09）

- S1/S2/S2-R 验证器均带变异测试：能对缺失章节、缺类别、假 verdict、self-review、open blocking finding 转红。
- 任务 validator 必须能在自己的副本里弄坏并转红；不能只跑现有产物。
- 不用“旧测试仍绿”代替新验收。

## 9. 风险与开放问题

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 每轮额外 token 估算 | 请求延迟 | 复用 roster 缓存；按 tool/skill 拆分只做一次；基准测试 T-02 |
| 快照体积 | 会话文件变大 | 持久化上限 200 tools/200 skills/20 parts；响应 details 预算 500 条；只存计数与名称；记录 omitted |
| 类别与 provider 总量偏差 | 用户误读 | `unattributed` 有符号显式展示；UI 说明“估算”；不摊派 |
| stats 解析大文件 | 页面慢 | ETag 304；按需解析；上限 1000；后续可加缓存/DB |
| `prunedAt` 推断 | 时间/归属可能不准 | `inferred=true`；tooltip 说明；不参与 delta 计算 |
| TUI 窄屏 | 信息挤压 | 四页 + 数字优先；<80 列隐藏 bar |
| active branch 解析与 live 不一致 | 口径漂移 | 精确镜像 `activeLeafId` replay；null→空/dangling→fallback/late-usage/rewind fixtures 与 live 逐字段对比（AC-01） |
| 子 transcript 读取失败 | Fleet 缺项 | 只显示可用项；root 不受影响 |
| details 预算导致旧 step 无下钻 | Browser 不完整 | 显式 `detailsOmittedSteps` + 提示；composition 仍可用 |
| 旧会话无明细 | Trend 组成缺失 | 显式 legacy；不补算 |
| 安装覆盖风险 | 破坏当前环境 | 开发期只用源码/dist；安装前备份 + 用户确认 |

开放问题（S2-R 需给结论）：

1. 全局页是否需要 compactions/injections KPI？当前设计不显示（DB 无数据）；若需要，必须新增 DB 表或按需扫描，超出本期。
2. 全局 KPI 的 prompt tokens 取 DB 的 `input + cache_read + cache_write`；`usage.contextTokens` 没有独立列。会话详情以快照为准，可能高于全局 KPI。当前决定：全局页标注 “DB approximation · session detail is authoritative”；是否接受由 S2-H 确认。
3. Trend 的 `deltaKind=compaction` 是否应把 `tokensAfter` 与下一步相比，而不是与压缩前一步相比？当前按“相邻 step 数值差 + 标记”实现，避免发明新的 baseline。
4. TUI 的 `r` 刷新保留当前 tab/滚动位置；由 `onRefresh` 返回新 timeline，组件替换数据并 clamp 滚动位置。若 host 不提供回调，`r` 不显示在 footer。
