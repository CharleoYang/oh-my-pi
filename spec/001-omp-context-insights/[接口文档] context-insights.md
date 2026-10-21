# Context insights — 接口文档

本文是 `spec-001-omp-context-insights` 的实现契约。类型名、字段名、HTTP 路由、错误码与上限均以本文为准；设计与算法见 `设计文档.md`。

## 1. 共享类型（`@oh-my-pi/pi-ai`）

新增文件 `packages/ai/src/context-insights.ts`，并在 `packages/ai/src/index.ts` 导出。

### 1.1 类别与快照明细

```ts
export type ContextCategoryId = "systemPrompt" | "systemTools" | "systemContext" | "skills" | "messages";

export interface ContextCategoryTokens {
  systemPrompt: number;
  systemTools: number;
  systemContext: number;
  skills: number;
  messages: number;
}

export interface ContextNamedTokens {
  name: string;
  tokens: number;
}

export interface ContextSnapshotDetails {
  contextWindow: number;
  categories: ContextCategoryTokens;
  /** Per-tool schema tokens. Sum <= categories.systemTools. */
  toolSchemas?: ContextNamedTokens[];
  /** Entries omitted by the persisted cap (their tokens remain in the category). */
  omittedToolSchemas?: number;
  /** Per-skill tokens. Sum <= categories.skills. */
  skills?: ContextNamedTokens[];
  omittedSkills?: number;
  /** System-prompt part tokens (all systemPrompt indices); part 0 has skills subtracted. */
  systemPromptParts?: number[];
  /** Original parts merged into the last returned part (0 when none). */
  systemPromptPartsOmitted?: number;
  messageCount: number;
  pendingMessageTokens: number;
}

/** Bounded projection attached to a returned step; see maxBrowserEntries. */
export interface ContextStepDetails {
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

`ContextSnapshot`（`packages/ai/src/types.ts`）增加：

```ts
export interface ContextSnapshot {
  promptTokens: number;
  nonMessageTokens: number;
  toolSchemaTokens?: number;
  historyRewriteTokensRemoved?: number;
  compactionEpoch?: number;
  lastMessageTimestamp?: number;
  /** Optional: absent on legacy snapshots. Never synthesized by readers. */
  details?: ContextSnapshotDetails;
}
```

### 1.2 Timeline

```ts
export interface ContextStepUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  costTotal?: number;
}

export interface ContextStep {
  /** Assistant session entry id. */
  id: string;
  /** Absolute step index within the session (0-based). */
  index: number;
  timestamp: number;
  model?: string;
  provider?: string;
  /** Provider-authoritative prompt tokens when a snapshot exists, else usage-derived. */
  promptTokens: number;
  anchored: boolean;
  /** Undefined on legacy steps without ContextSnapshotDetails. */
  composition?: ContextCategoryTokens;
  /** True when composition comes from a request-time estimate (all non-legacy steps). */
  compositionEstimated?: boolean;
  /** Bounded projection; undefined when legacy or over the maxBrowserEntries budget. */
  details?: ContextStepDetails;
  /** promptTokens - sum(composition); signed, never redistributed. */
  unattributed?: number;
  contextWindow?: number;
  deltaTokens?: number;
  deltaKind: "first" | "grow" | "shrink" | "compaction" | "reset" | "model-switch";
  usage?: ContextStepUsage;
  eventIds: string[];
  filePaths: string[];
}

export type ContextEventKind = "inject" | "compact" | "prune" | "switch" | "mode" | "reset" | "branch";

export interface ContextEvent {
  id: string;
  timestamp: number;
  kind: ContextEventKind;
  label: string;
  detail?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  source?: string;
  /** True for prune inferred from ToolResultMessage.prunedAt. */
  inferred?: boolean;
  /** Absolute index of the next step in file order (the step it affects); undefined when trailing. */
  stepIndex?: number;
}

export interface ContextFileActivity {
  path: string;
  reads: number;
  writes: number;
  edits: number;
  searches: number;
  linesRead: number;
  linesAdded: number;
  linesRemoved: number;
  bytesRead: number;
  bytesWritten: number;
  lastTimestamp: number;
}

export interface ContextAgentUsage {
  trackId: string;
  /** Absolute transcript filename for fleet drill-down. */
  file?: string;
  label: string;
  agent?: string;
  model?: string;
  requests: number;
  peakTokens: number;
  lastTokens?: number;
  costTotal?: number;
  status: "main" | "subagent" | "advisor";
}

export interface ContextTimeline {
  schemaVersion: 1;
  sessionId: string;
  file?: string;
  cwd?: string;
  source: "live" | "journal";
  steps: ContextStep[];
  omittedSteps: number;
  /** Steps with details in the journal but skipped by the maxBrowserEntries budget. */
  detailsOmittedSteps: number;
  /** Last returned step's composition, if any. */
  composition?: ContextCategoryTokens;
  contextWindow?: number;
  peakTokens: number;
  /** Usage cost across every eligible step, including steps beyond `maxSteps`. */
  costTotal: number;
  /** Max promptTokens across every eligible step, including steps beyond `maxSteps`. */
  peakTokensTotal: number;
  events: ContextEvent[];
  omittedEvents: number;
  files: ContextFileActivity[];
  omittedFiles: number;
  /** File tool calls with no matching toolResult in the active branch. */
  incompleteFileCalls: number;
  agents: ContextAgentUsage[];
  legacySteps: number;
  truncated: boolean;
}
```

语义：`unattributed` 有符号；`composition` 缺失即 legacy；`legacySteps` 只统计源快照缺 details/composition 的返回 step，budget 省略只计入 `detailsOmittedSteps`；`compositionEstimated=true` 表示请求时估算；`details` 只对返回窗口内、且在 `maxBrowserEntries` 预算内的最新步骤填充；事件按文件顺序关联到其后的第一条 step，尾部事件 `stepIndex=undefined`；`index` 绝对；窗口只保留最新 N 步；`truncated` 任一列表或 details 预算截断即为 true。

### 1.3 Fold 输入

适配器负责 active branch 过滤与路径归一化。

```ts
export interface ContextUsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  contextTokens?: number;
  total?: number;
  cost?: { total?: number };
}

export interface ContextJournalMessage {
  role?: string;
  timestamp?: number;
  model?: string;
  provider?: string;
  usage?: ContextUsageLike;
  contextSnapshot?: ContextSnapshot;
  /** Assistant content blocks; only toolCall blocks are read. */
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  /** Tool result details; file activity reads only known fields. */
  details?: unknown;
  isError?: boolean;
  prunedAt?: number;
}

export interface ContextJournalEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  /** Active leaf captured at append time; null clears it, undefined means this entry selects itself. */
  activeLeafId?: string | null;
  timestamp?: string;
  message?: ContextJournalMessage;
  model?: string;
  role?: string;
  resolvedModelIsFallback?: boolean;
  thinkingLevel?: string | null;
  configured?: string | null;
  serviceTier?: unknown;
  summary?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  method?: string;
  customType?: string;
  content?: unknown;
  display?: boolean;
  injectedRules?: string[];
  mode?: string;
  data?: Record<string, unknown>;
}

export interface ContextTimelineLimits {
  maxSteps: number;
  maxEvents: number;
  maxFiles: number;
  /** Total named entries across returned step.details. */
  maxBrowserEntries: number;
  maxToolSchemas: number;
  maxSkills: number;
  maxSystemParts: number;
}

export const DEFAULT_CONTEXT_LIMITS: Readonly<ContextTimelineLimits> = {
  maxSteps: 1000,
  maxEvents: 200,
  maxFiles: 500,
  maxBrowserEntries: 500,
  maxToolSchemas: 200,
  maxSkills: 200,
  maxSystemParts: 20,
};

export interface ContextTimelineInput {
  sessionId: string;
  file?: string;
  cwd?: string;
  source: "live" | "journal";
  entries: readonly ContextJournalEntry[];
  limits?: Partial<ContextTimelineLimits>;
  /** Adapter-provided resolver for file-tool paths; must be deterministic and side-effect free. */
  normalizePath?: (path: string) => string;
  agents?: ContextAgentUsage[];
}

export function foldContextTimeline(input: ContextTimelineInput): ContextTimeline;
```

`foldContextTimeline` 契约：

- 未知 entry type、缺失字段、坏消息内容：忽略，不抛错。
- `limits` 会被 clamp 到 `[0, DEFAULT_CONTEXT_LIMITS[field]]`；`maxSystemParts` 额外 clamp 到 `[2, 20]`；非法值使用默认值。
- 输入 entries 已按文件顺序排列；函数不排序 entries。
- 事件按文件顺序关联到其后的第一条 step；不使用 timestamp 关联；尾部事件 `stepIndex=undefined`。
- `details` 从最新 step 向前按 `maxBrowserEntries` 分配；超预算的 step 不返回半份 details，`detailsOmittedSteps++`。
- `normalizePath` 只用于文件工具路径；缺失时使用原字符串（测试必须显式注入以覆盖 live/journal 一致性）。
- 未匹配 toolResult 的文件 toolCall 计入 `incompleteFileCalls`；调用侧可确定计数保留。
- 不使用 `Date.now()`；所有时间来自 entry/message。
- 不读取/返回任何正文（prompt、message、tool 参数、diff 全文）。

## 2. coding-agent 接口

### 2.1 捕获明细

文件：`packages/coding-agent/src/session/context-insights.ts`

```ts
export interface CaptureContextSnapshotDetailsInput {
  breakdown: ContextUsageBreakdown;
  contextWindow: number;
  systemPrompt: readonly string[];
  tools: readonly Pick<Tool, "name" | "description" | "parameters" | "examples">[];
  skills: readonly ContextSkill[];
  model: Model | undefined;
  tokenizer: Tokenizer;
  sourceRevision: number;
  messageCount: number;
  pendingMessages: readonly AgentMessage[];
  limits?: Pick<ContextTimelineLimits, "maxToolSchemas" | "maxSkills" | "maxSystemParts">;
}

export function captureContextSnapshotDetails(
  input: CaptureContextSnapshotDetailsInput,
): ContextSnapshotDetails;
```

规则：

- `categories` 从 `breakdown` 的五类映射；字段名不同（`systemPromptTokens` → `systemPrompt` 等）。
- `toolSchemas`：先按 name 合并重复工具的原始权重，再独立计数后用最大余数法归一到 `categories.systemTools`；按 tokens 降序、name 升序；超过 `maxToolSchemas` 时保留前 N，`omittedToolSchemas` 记剩余条目数，且不再归一（保留项之和 ≤ 类别总量）。
- `skills`：同一规则归一到 `categories.skills`；只统计 `renderedSkills`（read 工具存在且 `hide !== true`）。
- 原始权重全为 0 且类别总量 > 0：`toolSchemas`/`skills` 返回空数组，不发明条目；类别总量保留。
- `systemPromptParts` 覆盖 `systemPrompt` 的所有 part：`parts[0] = max(0, countTokens(part0) - categories.skills)`，随后归一到 `categories.systemPrompt`；`parts[1..]` 归一到 `categories.systemContext`。`maxSystemParts` clamp 到 `[2, 20]`；`systemPrompt` 为空时返回 `[]`；只有 1 个 part 时 `parts=[systemPrompt]`，此时 `categories.systemContext` 必为 0。part 数超过上限时，保留前 `max-1` 个，最后一项吸收剩余部分总量，`systemPromptPartsOmitted` = 被并入的**额外**原始 part 数（`originalCount - returnedCount`；21→20 时为 1，最后一项代表 2 个原始 part）。
- 所有计数为非负有限整数；非有限值按 0 处理。
- “归一”使用确定性最大余数法：按原始权重比例分配整数，余数给小数部分最大的项（并列按 name/序号升序）。原始权重和 > 0 且没有条目被省略时，和恰好等于类别总量；全零权重时 items 返回空数组，等式不适用（显式例外）。

### 2.2 Tracker 集成

`SessionStatsTracker`：

```ts
setPendingSnapshot(snapshot: {
  promptTokens: number;
  nonMessageTokens: number;
  cutoffCount: number;
  details?: ContextSnapshotDetails;
} | undefined): void;

nonMessageSnapshot(): {
  nonMessageTokens: number;
  toolSchemaTokens: number;
  details?: ContextSnapshotDetails;
};
```

- `agent-session.ts#promptWithMessage` 在 `setPendingSnapshot` 时传入 `captureContextSnapshotDetails(...)`。
- `agent-session.ts#persistSessionMessageIfMissing` 把 `nonMessageSnapshot().details` 写入 `assistantMsg.contextSnapshot.details`（若存在）。
- `recordAnchoredHistoryRewrite` 补建 snapshot 时**不**写 details。

### 2.3 Live timeline

`AgentSession` 新增：

```ts
getContextTimeline(options?: { limits?: Partial<ContextTimelineLimits> }): ContextTimeline;
```

- entries = `this.sessionManager.getBranchView()`；`cwd = this.sessionManager.getCwd()`；`sessionId = this.agent.sessionId`。
- `source: "live"`；`agents: []`。
- 每次调用重新 fold；不缓存（TUI 只在打开/刷新时调用）。
- 无会话条目时返回 `steps: []`、`peakTokens: 0`、`truncated: false`。

### 2.4 TUI 辅助估算（`@oh-my-pi/pi-tui`）

`packages/tui/src/status-line/context-usage.ts` 新增导出：

```ts
export function estimateContextToolSchemaTokensByTool(
  tools: readonly Pick<Tool, "name" | "description" | "parameters" | "examples">[],
  tokenizer: Tokenizer,
  model: Model | undefined,
  sourceRevision?: number,
): ContextNamedTokens[];

export function estimateContextSkillsTokensByName(
  skills: readonly ContextSkill[],
  tokenizer: Tokenizer,
): ContextNamedTokens[];
```

- 与 `estimateToolSchemaTokens` 使用同一组 fragments 与缓存键；结果只用于快照明细。
- 返回排序后的数组；不截断（截断在 `captureContextSnapshotDetails` 中做）。

## 3. TUI 接口

文件：`packages/tui/src/status-line/context-insights.ts`

```ts
export interface ContextInsightsViewOptions {
  timeline: ContextTimeline;
  breakdown: ContextBreakdown;
  theme: Theme;
  /** Re-read the live timeline; the component keeps the active tab and clamps scroll. Omitted disables `r`. */
  onRefresh?: () => ContextTimeline | undefined;
}

export class ContextInsightsView extends Container {
  constructor(options: ContextInsightsViewOptions);
  handleInput(data: string): void;
  describe(cx: DescribeContext): NativeNode;
  render(width: number): readonly string[];
}
```

键盘：

| 键 | 行为 |
| --- | --- |
| `Tab` / `Right` | 下一页（循环） |
| `Shift+Tab` / `Left` | 上一页（循环） |
| `1`..`4` | Overview / Trend / Events / Files |
| `d` | Trend 切换 Δ 列 |
| `r` | 调用 `onRefresh`，用返回的 timeline 替换数据并保留当前 tab/滚动位置（clamp；无回调则忽略） |
| `Up` / `Down` / `PageUp` / `PageDown` | 当前页滚动 |
| `Esc` | 由外层 ReportPanel 关闭 |

### 3.1 Report host 契约

- `showCommandReport` 增加 `interactive?: boolean`；`/context` 传 true。
- interactive body 必须通过**可聚焦 overlay** 呈现（native sheet 或 ANSI fullscreen），即使内容能塞进 inline 区域；否则 editor 持有焦点，body 收不到按键。
- `ReportPanel.handleInput`：先处理关闭/滚动键；未消费的按键委托给 `body.handleInput(data)`，由返回值决定是否消费。`Esc` 永远由 panel 优先。
- `ReportPanel.handleNativeEvent`：关闭类事件自己处理，其余 `select`/`activate`/`hover` 转发给 body。
- 新增 host 测试：fake body 记录收到的键；断言 native 与 ANSI fullscreen 下 `Tab`/`1`..`4`/`d`/`r` 都到达 body，`Esc` 关闭，`Up`/`Down` 仍由 panel 滚动。

持久化上限：TUI 使用 `{...DEFAULT_CONTEXT_LIMITS, maxSteps: 200, maxEvents: 100, maxFiles: 50, maxBrowserEntries: 0}`。

## 4. stats 服务端接口

### 4.1 全局概览

```http
GET /api/context/overview?range=24h
```

`range`：`1h | 24h | 7d | 30d | 90d`（与 `TIME_RANGES` 一致）。非法值 → `400 {"error":"invalid range"}`。

响应：

```ts
export interface ContextSessionRow {
  file: string;
  folder: string;
  title: string | null;
  models: string[];
  /** All counters below are filtered by the same range cutoff as the KPI. */
  /** Range-activity bounds (first/last request in the cutoff window), not lifetime. */
  startedAt: number;
  endedAt: number;
  requests: number;
  totalTokens: number;
  /** input + cacheRead + cacheWrite for this root in range. */
  promptTokens: number;
  peakPromptTokens: number;
  avgPromptTokens: number;
}

export interface ContextOverview {
  range: TimeRange;
  cutoff: number;
  /** 1h/24h/7d -> hourly buckets; 30d/90d -> daily buckets. Same window as KPI. */
  heatmapBucketMs: number;
  kpi: {
    sessions: number;
    requests: number;
    /** input + cacheRead + cacheWrite, per request, averaged. */
    avgPromptTokens: number;
    peakPromptTokens: number;
    totalTokens: number;
  };
  heatmap: Array<{ bucket: number; requests: number; promptTokens: number }>;
  sessions: ContextSessionRow[];
  /** Aggregates for range-active roots beyond the 200-row response cap. */
  omittedSessions: number;
  omittedRequests: number;
  omittedPromptTokens: number;
}
```

- KPI、heatmap、`sessions` 使用**同一个 cutoff**；不混用 7 天热力图与 30 天 KPI。
- `promptTokens = input_tokens + cache_read_tokens + cache_write_tokens`。DB 没有独立的 `usage.contextTokens` 列，因此全局 KPI 是 **DB approximation**；会话详情以 `ContextSnapshot.promptTokens` 为准，可能更高。全局页副标题必须标注 `DB approximation · session detail is authoritative`。
- `sessions` **不复用** `listSessionSummaries` 的 lifetime 计数器；用同一 cutoff 的 SQL 按 root session 聚合 requests/total/peak/avg，子 transcript 折入 root。`listSessionSummaries` 只可用于 title/folder 元数据，且不得覆盖范围计数。按 range 内最后活动倒序返回最多 200 行；`omittedSessions`/`omittedRequests`/`omittedPromptTokens` 汇总剩余 root，保证 `Σheatmap.requests = Σsessions.requests + omittedRequests` 与 `Σheatmap.promptTokens = Σsessions.promptTokens + omittedPromptTokens`。
- 空 range 返回零值数组，不 404。
- 无 ETag（与现有 stats 页一致，30s 轮询）。

### 4.2 单会话完整时间线

```http
GET /api/session/context?file=<absolute-or-relative-session-path>
```

- 路径必须在 sessions dir 下；越界 → `400 {"error":"..."}`；不存在 → `404 {"error":"session not found"}`。
- 200 响应体：`ContextTimeline`（`source:"journal"`）。
- 响应头：`ETag: "<fingerprint>"`；`If-None-Match` 命中 → `304` 空体。
- 读取复用 trace 的解压读取（支持 `.jsonl.gz`）与**递归**子 transcript 发现；fingerprint 覆盖 root + 与 fleet 完全相同的子文件集合，按路径排序后逐个 `mtimeMs:size`（必要时 inode/birthtime）哈希。race/缺失子文件视为变化，不复用旧 body。
- active branch 必须精确镜像 live `activeLeafId` replay（`null` → 空分支；悬空 leaf → 最新自选 fallback；late-usage 条目按捕获 leaf 重放），不得直接使用 trace 的 `activeChain`。
- 无有效 entry → 200 空 timeline（`steps:[]`），不是 500。
- 坏行由 lenient parser 跳过。
- `file` 支持 child transcript（Fleet 点击）；返回该 transcript 的 timeline，`agents` 只含自身（children 为该 transcript 的子 agent）。

### 4.3 服务端模块

文件：`packages/stats/src/context.ts`

```ts
export function buildSessionContextTimeline(
  file: string,
  limits?: Partial<ContextTimelineLimits>,
): Promise<ContextTimeline>;

export function getContextOverview(range: TimeRange): Promise<ContextOverview>;
```

- `buildSessionContextTimeline` 内部复用 trace 的路径守卫、解压读取、递归子文件发现，并精确复刻 live active-leaf replay；不 import coding-agent。
- `getContextOverview` 使用 `messages`/`message_rollup`；新增 SQL 查询**按同一 cutoff** 按 root `session_file` 聚合 `MAX/SUM/COUNT`，子 transcript 折入 root；不读取 `listSessionSummaries` 的 lifetime 计数。
- 结果可做短 TTL memo（≤5s），不得缓存超过会话列表轮询周期。

## 5. stats 客户端接口

`packages/stats/src/client/api.ts`：

```ts
export function getContextOverview(
  range: TimeRange,
  signal?: AbortSignal,
): Promise<ContextOverview>;

export function getSessionContext(
  file: string,
  signal?: AbortSignal,
  previous?: ContextTimeline,
): Promise<ContextTimeline>;
```

- 使用现有 `fetchJson`：`previous` + `If-None-Match`，304 返回 `previous`；`cache:"no-store"` 与 trace 一致。
- `client/types.ts` 与 `shared-types.ts` 只 re-export `ContextTimeline`/`ContextOverview` 等共享类型，不复制字段。

`ContextRoute` props：

```ts
export interface ContextRouteProps {
  active: boolean;
  range: TimeRange;
  session: string | null;
  onOpenSession: (file: string | null) => void;
}
```

`ContextDetail` props：

```ts
export interface ContextDetailProps {
  file: string;
  active: boolean;
  onBack: () => void;
  onOpenTrace: (file: string) => void;
}
```

六个 tab id：`composition | trend | browser | events | files | fleet`。

## 6. 兼容、错误与上限

- `schemaVersion: 1`；读取方遇到更高版本显示“unsupported timeline schema”，不猜测字段。
- `ContextSnapshot.details` 缺失：所有读取方必须产生 `composition: undefined`，不得从当前配置补算。
- `promptTokens` 为 0 且无 snapshot 的消息不生成 step。
- 负数/NaN 计数在捕获时 clamp 为 0；`unattributed` 可以是负数。
- 所有列表上限见 `DEFAULT_CONTEXT_LIMITS`；API 不接受客户端覆盖。
- 任何 500 都必须来自真实异常；用户输入错误走 400，不存在走 404。

## 7. 非目标接口

- 不新增 `POST /api/context/*`。
- 不新增 stats DB 表/迁移。
- 不暴露 prompt/message/tool 参数正文。
- 不把 `getContextTimeline` 加入扩展 API（本期仅供 TUI/测试；若后续需要，另开接口评审）。
