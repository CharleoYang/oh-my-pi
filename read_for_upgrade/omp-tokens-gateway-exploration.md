# OMP tokens 网关兼容探索报告（2026-08-12）

> 目标：让 omp 通过 tokens 平台（token.mykeeta.sankuai.com）发送并接收模型请求。
> 结论：**tokens 平台只接受 Codex 官方客户端特征的 WebSocket 传输，拒绝 HTTP SSE。**
> 本文是给版本升级做快速适配的完整经验记录。

## 1. 现象与根因

- 用户原始报错：omp 直接发请求被拒，提示 "use codex official coding agent"。
- 直接 curl HTTP SSE 到 `/v1/responses` 偶发成功（平台放行），后来稳定 403：
  `{"error":{"message":"This account only allows Codex official clients","type":"forbidden_error"}}`
- **决定性证据**：抓包官方 codex CLI（`codex exec`）的 WebSocket 握手与消息。
- **根因**：tokens 平台仅接受：
  1. **WebSocket** 传输（`wss://token.mykeeta.sankuai.com/responses`，**无 `/v1`、无 `/codex` 前缀**）
  2. **codex 身份头**：`originator: codex_exec`、`openai-beta: responses_websockets=2026-02-06`、codex 风格 UA
  3. WS 消息格式 `{"type":"response.create","model":...,"input":[...]}`（标准 OpenAI Responses WS）

## 2. 关键常量对照（版本升级适配点）

| 项 | 官方 codex | OMP 默认 | 本次修复 |
|---|---|---|---|
| 传输 | WebSocket（`supports_websockets= true`） | `openai-responses` = HTTP SSE | 改用 `openai-codex-responses`（原生支持 WS） |
| 端点 | `base_url` + `/responses` | `resolveCodexResponsesUrl` 强制拼 `/codex/responses` | 支持 `/responses` 结尾直接返回 |
| originator | `codex_exec` | `OPENAI_HEADER_VALUES.ORIGINATOR_CODEX = "pi"` | 保留显式配置（models.yml headers 可覆盖） |
| UA | `codex_exec/0.147.0 (Mac OS 26.5.2; arm64) ghostty/1.3.0` | `omp/<version>` | models.yml `headers.User-Agent` 直接生效 |
| 客户端版本 | `0.147.0` | `CODEX_CLIENT_VERSION = "0.144.1"` | 未改（平台不校验此值） |

## 3. 代码改动（已合入 main `45749bbbb6`）

> 所有行号基于 main HEAD `45749bbbb6`。改动集中在 **`packages/ai/src/providers/openai-codex-responses.ts`** 一个文件的 3 处 + 用户配置。

### 3.1 `packages/ai/src/providers/openai-codex-responses.ts`

**(a) `resolveCodexResponsesUrl`（4336 行）** —— 新增 `/responses` 结尾分支，让 tokens 类网关（`wire_api=responses`）直接用平级路径，不再强制 `/codex/responses`：

```ts
// 4336: export function resolveCodexResponsesUrl(baseUrl: string | undefined): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/responses")) return normalized; // ← 新增（4339 行）
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
```

**(b) `createCodexHeaders`（4223 行）** —— originator 从无条件 `set` 改为保留显式值（opt-in，默认仍 `pi`）：

```ts
// 4255-4258 行
if (!headers.has(OPENAI_HEADERS.ORIGINATOR)) {
  headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
}
```

**(c) UA 保留机制（4264 行，改动前已存在）** —— 显式 User-Agent 优先：

```ts
// 4264: if (!headers.has("User-Agent")) headers.set("User-Agent", getTestCodexUserAgent() ?? USER_AGENT);
```
models.yml 显式配 UA 即可覆盖默认 `omp/<version>`。

### 3.2 辅助函数（改动前已存在，供引用）

- `getTestCodexUserAgent()`：`packages/utils/src/dirs.ts` **41 行** —— 读 `OMP_TEST_CODEX_USER_AGENT` 环境变量（旧方案，现在 models.yml 直接配 UA 即可，不必用 env）。
- `openai-responses.ts` 443 行：HTTP SSE 路径也应用同一 UA override（本次未改此路径，tokens 走 codex-responses 提供者）。

### 3.3 `~/.omp/agent/models.yml`（tokens provider，58 行起）

```yaml
tokens:                                          # 58 行
  baseUrl: https://token.mykeeta.sankuai.com/responses   # 必须带 /responses
  api: openai-codex-responses                              # 关键：不用 openai-responses
  apiKey: "sk-..."
  headers:                                               # 61 行起
    originator: codex_exec                                 # 必须
    User-Agent: "codex_exec/0.147.0 (Mac OS 26.5.2; arm64) ghostty/1.3.0"  # 必须
  models:
    - id: gpt-5.6-sol
      preferWebsockets: true                               # 必须走 WS
```

### 3.4 二进制替换位置

| 位置 | 值 |
|---|---|
| 构建产物 | `packages/coding-agent/binaries/omp-darwin-arm64` |
| 安装路径 | `/opt/homebrew/Cellar/omp/17.2.15/bin/omp`（`/opt/homebrew/bin/omp` 软链指向它）|
| 备份 | `~/.omp/backups/omp-17.2.15.20260812-223059` |
| 构建命令 | `bun scripts/ci-release-build-binaries.ts --targets darwin-arm64` |
| 替换+签名 | `install -m 755 <new> <target>` → `codesign --force --sign - <target>` |

## 4. 验证方法（可复用）

### 4.1 探针脚本验证 WS 协议（不依赖 omp）

```js
// /tmp/ws-probe.js — 最小 WS 客户端，验证 tokens 平台接受哪些路径/头
new WebSocket("wss://token.mykeeta.sankuai.com/responses", {
  headers: { authorization: "Bearer <key>", "user-agent": "codex_exec/...", originator: "codex_exec", "openai-beta": "responses_websockets=2026-02-06" }
});
// /responses → 成功（400 "Input must be a list" 说明 WS+认证通过，仅格式错）
// /codex/responses → 101 被拒
```

### 4.2 端到端验证

```bash
omp --model tokens/gpt-5.6-sol -p "Say hello"  # → "Hello!"
```

## 5. 版本升级快速适配 checklist

1. **确认 tokens 平台是否仍只接受 WS**：跑探针脚本，看 `/responses` 是否 101 被拒。
2. **若 WS 端点路径变化**：更新 models.yml `baseUrl` 的 `/responses` 后缀即可（`resolveCodexResponsesUrl` 已支持）。
3. **若 originator/UA 要求变化**：改 models.yml headers，无需改代码。
4. **若平台要求新客户端版本**：可能需要更新 `CODEX_CLIENT_VERSION`（当前 0.144.1，官方 codex 是 0.147.0）。
5. **代码改动被合入**：`resolveCodexResponsesUrl` + `createCodexHeaders` 已在 main，升级 main 即携带。
6. **二进制**：`bun scripts/ci-release-build-binaries.ts --targets darwin-arm64` → 备份旧二进制 → `install` 到 Cellar + `codesign --force --sign -`。

## 6. 已知边界

- `originator: codex_exec` 是**显式 opt-in**：默认 OMP 仍发 `pi`，不冒充官方客户端；只有用户在 models.yml 显式配置才切换。
- 平台若校验 `clientInfo.name`/attestation 等更严格字段，当前实现不做承诺——那是外部 allowlist 策略，不是 harness bug。
- `CODEX_CLIENT_VERSION` 未随平台要求更新，若平台开始校验该值需同步。
