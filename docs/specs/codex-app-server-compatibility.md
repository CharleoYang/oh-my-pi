# OMP / Codex app-server compatibility boundary

## Finding

The current OMP `--mode rpc` wire contract is not the Codex app-server contract.
OMP starts with a `ready` frame and accepts commands shaped as `{type: ...}`
(`prompt`, `new_session`, `get_state`, ...). Its responses are OMP-specific
`{type: "response", command, success, data}` frames.

The official Codex app-server uses newline-delimited JSON-RPC messages with the
`jsonrpc: "2.0"` member intentionally omitted. It requires this lifecycle:

1. `initialize` request (`id`, `method`, `params.clientInfo`, capabilities)
2. `initialized` notification
3. `thread/start` (or `thread/resume`)
4. `turn/start` with `threadId` and `input`
5. `turn/*` and `item/*` notifications, including `item/agentMessage/delta`
6. `turn/completed`

Codex also keeps stdout protocol-only, writes diagnostics to stderr, and uses
bounded queues/backpressure. The Codex source explicitly documents
`clientInfo.name` as an input to OpenAI compliance logs. Therefore simply
renaming OMP frames or pretending to be an official client is not a safe fix.

## Recommended smallest implementation

Add an explicit `--mode app-server` (or `omp app-server`) adapter that owns a
Codex-shaped JSONL transport and translates into the existing `AgentSession`:

- validate the initialize handshake and return an honest OMP client identity;
- map `thread/start` to `new_session`, retaining a stable thread id;
- map `turn/start` input text to `prompt` and correlate the returned turn id;
- translate assistant text/tool lifecycle events into the Codex `item/*` and
  `turn/*` notification names;
- map abort/interrupt and approval requests to existing OMP controls;
- preserve one-message-per-line framing, stdout purity, stderr logging, and
  output backpressure;
- return JSON-RPC errors (`-32600`, `-32601`, `-32602`, `-32001`) instead of
  leaking OMP response envelopes.

The existing upstream Codex Responses transport now preserves an explicitly
provided `User-Agent` for an authorized gateway, while defaulting to the
truthful `omp/<version>` value. Its `originator` remains `pi`; changing only a
header must not claim to be `codex_cli_rs` or `codex_vscode`.

Do not make `--mode rpc` silently change semantics: existing ACP/RPC clients
depend on its current `{type: ...}` protocol. Do not send `clientInfo.name` as
`codex` or `codex_vscode`; the platform may use that field for allowlisting and
compliance attribution. A tokens-platform rejection that remains after wire
compatibility is implemented is an external policy/allowlist gate, not an
in-process harness bug.

## Acceptance probes

- Feed an initialize/initialized/thread-start/turn-start JSONL transcript to the
  adapter and assert exact request/response correlation and notification order.
- Assert no non-JSON bytes are written to stdout, including terminal bells or
  progress spinners; diagnostics must remain on stderr.
- Exercise malformed JSON, pre-initialize requests, unknown methods, and output
  queue saturation; assert the documented JSON-RPC error mapping.
- Replay one real tokens-platform transcript if available. Separate local
  protocol acceptance from the platform's official-client policy decision.
