# @oh-my-pi/omp-stats

Local observability dashboard for AI usage statistics.

## Features

- **Session log parsing**: Reads JSONL session logs from `~/.omp/agent/sessions/`
- **SQLite aggregation**: Stats storage in `bun:sqlite`, with hourly rollups so any range queries in milliseconds
- **Live web dashboard**: Opens instantly, ingests sessions in the background (newest first) and streams progress and updates to the page
- **Incremental sync**: Only processes new/modified log entries; a watcher re-syncs transcripts as they are written

## Metrics Tracked

| Metric | Calculation |
|--------|-------------|
| Tokens/s | `output_tokens / (duration / 1000)` |
| Cache Rate | `cache_read / (input + cache_read) * 100` |
| Cache Savings | `(uncached prompt cost - actual prompt cost) / uncached prompt cost * 100` |
| Error Rate | `count(stopReason=error) / total_calls * 100` |
| API-equivalent estimate | Sum of token usage priced with the matching public API rate card |
| Avg Latency | Mean of `duration` |
| TTFT | Mean of `ttft` (time to first token) |

Subscription-backed models use matching public API prices when an exact public model exists; these values estimate API-equivalent usage rather than the user's bill. Subscription-only models without a public price are reported as N/A and excluded from dollar totals.

## Usage

### Via CLI

```bash
# Start dashboard server (default: http://localhost:3847)
omp stats

# Custom port
omp stats --port 8080

# Print summary to console
omp stats --summary

# Output as JSON (for scripting)
omp stats --json
```

### Programmatic

```typescript
import { getDashboardStats, syncAllSessions } from "@oh-my-pi/omp-stats";

// Sync session logs to database
const { processed, files } = await syncAllSessions();

// Get aggregated stats
const stats = await getDashboardStats();
console.log(stats.overall.totalCost);
console.log(stats.byModel[0].avgTokensPerSecond);
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/stats` | Overall stats with all breakdowns |
| `GET /api/stats/models` | Per-model statistics |
| `GET /api/stats/folders` | Per-folder/project statistics |
| `GET /api/stats/timeseries` | Hourly time series data |
| `GET /api/events` | Server-sent live status: sync progress, data version, rollup backlog |
| `GET /api/status` | Current live status (same shape as the events) |
| `POST /api/sync` | Start a background sync; progress arrives on `/api/events` |
| `GET /api/context/overview?range=24h` | DB approximation: one cutoff for KPIs, heatmap and root-session rows (including children); ranges `1h`, `24h`, `7d`, `30d`, `90d`; 200 rows plus omitted totals |
| `GET /api/session/context?file=<absolute-session-path>` | Authoritative active-branch journal timeline and fleet; `ETag` / `If-None-Match` revalidation returns 304 when unchanged |

Session context responses contain counts, token estimates, tool/skill names and file activity, never prompt/message/tool-result bodies. Responses are bounded to 1000 steps, 200 events, 500 files and 500 named Browser entries across steps. Truncation and omitted counts are explicit; legacy snapshots are not reconstructed from current configuration. Session paths must remain inside the configured sessions directory.

## Data Storage

- **Session logs**: `~/.omp/agent/sessions/` (JSONL files)
- **Stats database**: `~/.omp/stats.db` (SQLite)

Synchronization fetches file metadata and saved cursors in bounded batches and overlaps transcript reads, including on macOS without worker threads. Statistics and cursors commit atomically; unchanged files are skipped, and interrupted batches are retried without double-counting usage.

Full reconciliation replays still scan every transcript. Unchanged transcripts retain their indexed rows while missing or stale records and unfinished links are repaired; modified transcripts are rebuilt. Parsing discards message bodies after extracting statistics rather than retaining entire decoded transcripts.

Range queries read `message_rollup` / `tool_rollup` / `session_rollup`, maintained from the raw tables: triggers mark touched hours and transcripts dirty (from any omp process), and the dashboard re-rolls them newest-first in short transactions. Reads stay exact by aggregating the few dirty hours raw; during an initial build the header shows the indexing backlog.

## Dashboard

| Page | Hash route | Contents |
| --- | --- | --- |
| Context | `#/context?range=24h` | Global KPIs, activity heatmap and clickable session rows; DB approximation, not historical composition |
| Context detail | `#/context?range=24h&s=<encoded-session-path>` | Composition, Trend, Browser, Events, Files and Fleet; shared selected-step state and child-session drill-down |
| Other pages | Overview, Models, Providers, Costs, Requests, Errors, Traces, Tools, Frustration, Projects and Gain | Existing usage, trace and cost reports |

`1`–`6` pick the time range; `g` then `x` opens Context. Context maps the global `all` selection to a visibly labeled `90d` window so its KPIs, heatmap and rows always use the same bounded range. Files opens the session in Traces; Fleet opens child context detail and offers a return to the root.

### Source-only cross-surface acceptance

Run `bun test packages/coding-agent/test/context-insights-e2e.test.ts --timeout=180000` from the repository root. It opens a real VirtualTerminal `/context` report, starts the stats server on an ephemeral loopback port, ingests the same temporary journal and drives the built SPA in headless Chromium. Configuration, agent data, auth, stats DB, browser profile and screenshot output are temporary; no real `~/.omp` writes are required. Chromium must launch: missing/unlaunchable browsers fail `beforeAll`, never skip. The test uses `ensureChromiumExecutable`, an existing system Chrome when available, or `PUPPETEER_EXECUTABLE_PATH`; automatic Chrome for Testing provisioning may download a browser on first use.

The test runs source only and fingerprints `/opt/homebrew/bin/omp` before/after without invoking it. It never runs an installer or `bun link`. Replacing an installed omp requires separate explicit user approval, even after acceptance passes.

## License

MIT
