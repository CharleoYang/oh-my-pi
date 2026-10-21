# Context insights — 类图与时序

本文只画结构与调用关系；字段契约见 `接口文档.md`。

## 1. 类型与模块

```mermaid
classDiagram
    direction LR

    class ContextSnapshot {
      +promptTokens: number
      +nonMessageTokens: number
      +toolSchemaTokens?: number
      +historyRewriteTokensRemoved?: number
      +compactionEpoch?: number
      +details?: ContextSnapshotDetails
    }
    class ContextSnapshotDetails {
      +contextWindow: number
      +categories: ContextCategoryTokens
      +toolSchemas?: ContextNamedTokens[]
      +omittedToolSchemas?: number
      +skills?: ContextNamedTokens[]
      +omittedSkills?: number
      +systemPromptParts?: number[]
      +systemPromptPartsOmitted?: number
      +messageCount: number
      +pendingMessageTokens: number
    }
    class ContextStepDetails {
      +contextWindow: number
      +categories: ContextCategoryTokens
      +toolSchemas?: ContextNamedTokens[]
      +skills?: ContextNamedTokens[]
      +systemPromptParts?: number[]
      +systemPromptPartsOmitted?: number
      +messageCount: number
    }
    class ContextTimeline {
      +schemaVersion: 1
      +sessionId: string
      +source: live|journal
      +steps: ContextStep[]
      +omittedSteps: number
      +detailsOmittedSteps: number
      +composition?: ContextCategoryTokens
      +peakTokens: number
      +events: ContextEvent[]
      +files: ContextFileActivity[]
      +incompleteFileCalls: number
      +agents: ContextAgentUsage[]
      +legacySteps: number
      +truncated: boolean
    }
    class ContextStep {
      +id: string
      +index: number
      +promptTokens: number
      +anchored: boolean
      +composition?: ContextCategoryTokens
      +compositionEstimated?: boolean
      +details?: ContextStepDetails
      +unattributed?: number
      +deltaTokens?: number
      +deltaKind: string
      +usage?: ContextStepUsage
      +eventIds: string[]
      +filePaths: string[]
    }
    class ContextEvent {
      +kind: inject|compact|prune|switch|mode|reset|branch
      +label: string
      +tokensBefore?: number
      +tokensAfter?: number
      +inferred?: boolean
      +stepIndex?: number
    }
    class ContextFileActivity {
      +path: string
      +reads: number
      +writes: number
      +edits: number
      +searches: number
      +linesRead: number
      +linesAdded: number
      +linesRemoved: number
      +bytesRead: number
      +bytesWritten: number
    }
    class ContextAgentUsage {
      +trackId: string
      +label: string
      +status: main|subagent|advisor
      +requests: number
      +peakTokens: number
      +lastTokens?: number
    }

    ContextSnapshot --> ContextSnapshotDetails : optional details
    ContextTimeline *-- ContextStep
    ContextTimeline *-- ContextEvent
    ContextTimeline *-- ContextFileActivity
    ContextTimeline *-- ContextAgentUsage
    ContextStep --> ContextSnapshotDetails : composition from details
    ContextStep --> ContextStepDetails : bounded projection
```

## 2. 运行时组件

```mermaid
classDiagram
    direction TB

    class AgentSession {
      +getContextTimeline(options?) ContextTimeline
    }
    class SessionStatsTracker {
      -pendingContextSnapshot
      +setPendingSnapshot(snapshot)
      +nonMessageSnapshot() Snapshot
    }
    class CaptureContextSnapshotDetails {
      +captureContextSnapshotDetails(input) ContextSnapshotDetails
    }
    class FoldContextTimeline {
      +foldContextTimeline(input) ContextTimeline
    }
    class ContextInsightsView {
      +handleInput(data)
      +describe(cx) NativeNode
      +render(width) string[]
    }
    class ReportPanel {
      +handleInput(data) boolean
      +handleNativeEvent(event)
      +interactive: boolean
    }
    class StatsContextModule {
      +buildSessionContextTimeline(file) ContextTimeline
      +getContextOverview(range) ContextOverview
    }
    class ContextRoute {
      +session: string|null
      +onOpenSession(file)
    }
    class ContextDetail {
      +file: string
      +tabs: composition|trend|browser|events|files|fleet
    }

    AgentSession --> SessionStatsTracker : request snapshot
    AgentSession --> FoldContextTimeline : live entries
    SessionStatsTracker --> CaptureContextSnapshotDetails : per request
    CaptureContextSnapshotDetails --> ContextSnapshotDetails : persist
    FoldContextTimeline --> ContextTimeline : shared result
    ContextInsightsView --> ContextTimeline : render
    ReportPanel --> ContextInsightsView : forwards unhandled keys
    StatsContextModule --> FoldContextTimeline : journal entries
    StatsContextModule --> ContextTimeline : HTTP JSON
    ContextRoute --> ContextDetail : selected session
    ContextDetail --> ContextTimeline : fetch /api/session/context
```

## 3. 时序：实时请求到 TUI

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant AS as AgentSession
    participant ST as SessionStatsTracker
    participant CAP as captureContextSnapshotDetails
    participant TUI as ContextInsightsView

    U->>AS: prompt
    AS->>AS: getContextBreakdown(contextWindow, pendingMessages)
    AS->>CAP: breakdown, tools, skills, systemPrompt, tokenizer
    CAP-->>AS: ContextSnapshotDetails (categories, tools, skills, parts)
    AS->>ST: setPendingSnapshot(promptTokens, nonMessageTokens, details)
    AS->>AS: provider request
    AS->>AS: persist assistant.contextSnapshot.details
    AS->>ST: clear pending snapshot
    U->>TUI: /context
    AS->>AS: getContextTimeline() -> fold(active branch, source=live)
    TUI->>TUI: Overview / Trend / Events / Files
```

## 4. 时序：stats 单会话与 ETag

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant S as Stats Server
    participant P as Journal Parser
    participant F as foldContextTimeline
    participant FS as Session Files

    B->>S: GET /api/session/context?file=... (If-None-Match: etag)
    S->>FS: stat root + child transcripts
    alt fingerprint unchanged
        S-->>B: 304 (no body)
    else changed or first load
        S->>P: read root + child JSONL
        P-->>S: entries (lenient)
        S->>S: active parentId chain
        S->>F: foldContextTimeline(entries, source=journal)
        F-->>S: ContextTimeline
        S->>S: attach fleet summaries from child folds
        S-->>B: 200 JSON + ETag
    end
```

## 5. 时序：事件与文件归并

```mermaid
sequenceDiagram
    autonumber
    participant F as foldContextTimeline
    participant E as Entries
    participant M as Assistant/Tool messages
    participant O as Output

    F->>E: walk in file order
    alt compaction / model_change / mode_change / reset / ttsr / custom_message
        E-->>F: event entry
        F->>F: map kind, label, tokensBefore/After
    end
    alt assistant message
        M-->>F: usage + contextSnapshot.details + toolCalls
        F->>F: build ContextStep (composition, unattributed, delta)
    end
    alt toolResult
        M-->>F: prunedAt? / details / toolCallId
        F->>F: prune event (inferred) or file activity
    end
    F->>O: steps, events, files, agents, omitted/legacy counters
```

## 6. 模块依赖规则

- `@oh-my-pi/pi-ai` **不**依赖 `pi-agent-core`、`pi-tui`、`pi-coding-agent` 或 `omp-stats`；fold 只用本地类型。
- `coding-agent` 可以依赖 `pi-ai` 与 `pi-tui`；捕获明细使用 TUI 的 tokenizer 辅助函数。
- `omp-stats` 只依赖 `pi-ai`/`pi-catalog`/`pi-utils`，**不** import coding-agent；journal 结构按接口文档镜像。
- TUI 组件只依赖 `pi-ai` 类型、`pi-tui` 组件与主题，不读盘、不发 HTTP。
- Web 组件只通过 `client/api.ts` 访问服务端；共享类型只做 type-only re-export。
