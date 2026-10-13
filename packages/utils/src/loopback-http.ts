/**
 * Proxy-proof HTTP/1.1 GET for probing local services.
 *
 * Both `fetch` and Bun's `node:http` honor `HTTP_PROXY`/`HTTPS_PROXY` and
 * forward even `127.0.0.1` requests to the proxy unless `NO_PROXY` covers them,
 * and neither offers a per-request opt-out. A local proxy that answers (or 502s)
 * internal addresses then makes a dead endpoint look alive or a live one look
 * dead: the browser CDP probes tore down healthy daemons (issue #8567) and the
 * stats dashboard reported free ports as occupied (issue #15615). Talking to the
 * socket over raw TCP sidesteps proxy env entirely.
 */
import type { Socket } from "bun";

// A probe may contact an unidentified local listener; never buffer its reply without bounds.
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Answer of a {@link loopbackGet} probe. */
export interface LoopbackResponse {
	status: number;
	headers: Headers;
	/** Latin-1 decoded body; empty unless `readBody` was requested. */
	body: string;
}

/** Options for {@link loopbackGet}. */
export interface LoopbackGetOptions {
	timeoutMs: number;
	signal?: AbortSignal;
	/** Resolve after the body arrives (Content-Length or peer close) instead of after the header block. */
	readBody: boolean;
}

function parseHeaders(block: string): Headers {
	const headers = new Headers();
	for (const line of block.split("\r\n").slice(1)) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		try {
			headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
		} catch {
			// Invalid header name/value: skip it rather than reject the whole response.
		}
	}
	return headers;
}

/**
 * HTTP/1.1 GET over raw TCP that never routes through a proxy. Resolves null when
 * the endpoint is unreachable, aborted, malformed, oversized (16 KiB of headers
 * or 4 MiB of body), or slow past `timeoutMs`.
 *
 * @example
 * const response = await loopbackGet("http://127.0.0.1:9222/json/version", { timeoutMs: 1500, readBody: true });
 * if (response?.status === 200) JSON.parse(response.body);
 */
export async function loopbackGet(url: string, opts: LoopbackGetOptions): Promise<LoopbackResponse | null> {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return null;
	}
	if (opts.signal?.aborted) return null;
	const port = target.port ? Number(target.port) : 80;
	// URL keeps IPv6 literals bracketed; sockets want the bare address.
	const hostname = target.hostname.replace(/^\[(.*)]$/, "$1");
	const requestPath = `${target.pathname}${target.search}` || "/";
	const { promise, resolve } = Promise.withResolvers<LoopbackResponse | null>();
	let socket: Socket<undefined> | undefined;
	let settled = false;
	const finish = (response: LoopbackResponse | null) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
		try {
			if (response === null) socket?.terminate();
			else socket?.end();
		} catch {
			// socket already torn down
		}
		resolve(response);
	};
	const onAbort = () => finish(null);
	const timer = setTimeout(() => finish(null), opts.timeoutMs);
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	const headerParts: string[] = [];
	let headerLength = 0;
	let headerMarker = 0;
	let body: Buffer | undefined;
	let bodyLength = 0;
	let status: number | null = null;
	let headers: Headers | null = null;
	let contentLength: number | null = null;
	try {
		void Bun.connect({
			hostname,
			port,
			socket: {
				open(s) {
					socket = s;
					if (settled) {
						s.terminate();
						return;
					}
					s.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`);
				},
				data(_s, chunk) {
					if (settled) return;
					let offset = 0;
					if (headers === null) {
						// Scan at most the header cap, including a delimiter split across chunks.
						for (; offset < chunk.length && headerLength < MAX_HEADER_BYTES; offset++) {
							headerMarker = (headerMarker << 8) | chunk[offset]!;
							headerLength++;
							if (headerMarker === 0x0d0a0d0a) {
								offset++;
								break;
							}
						}
						headerParts.push(chunk.toString("latin1", 0, offset));
						if (headerMarker !== 0x0d0a0d0a) {
							if (headerLength >= MAX_HEADER_BYTES) finish(null);
							return;
						}
						const header = headerParts.join("");
						const match = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(header);
						if (!match) {
							finish(null);
							return;
						}
						status = Number(match[1]);
						headers = parseHeaders(header.slice(0, -4));
						if (!opts.readBody) {
							finish({ status, headers, body: "" });
							return;
						}
						const lengthHeader = headers.get("content-length");
						contentLength = lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
						if (contentLength !== null && contentLength > MAX_BODY_BYTES) {
							finish(null);
							return;
						}
					}
					const remaining = contentLength === null ? MAX_BODY_BYTES - bodyLength : contentLength - bodyLength;
					const bytes = chunk.length - offset;
					if (bytes > remaining && contentLength === null) {
						finish(null);
						return;
					}
					const take = Math.min(bytes, remaining);
					if (take > 0) {
						const size = bodyLength + take;
						if (!body || body.length < size) {
							const next = Buffer.allocUnsafe(
								Math.min(MAX_BODY_BYTES, Math.max(size, body ? body.length * 2 : 4096)),
							);
							body?.copy(next, 0, 0, bodyLength);
							body = next;
						}
						chunk.copy(body, bodyLength, offset, offset + take);
						bodyLength = size;
					}
					if (contentLength !== null && bodyLength === contentLength && status !== null && headers !== null) {
						finish({ status, headers, body: body?.toString("latin1", 0, bodyLength) ?? "" });
					}
				},
				error() {
					finish(null);
				},
				close() {
					// Without Content-Length the peer's close delimits the body.
					finish(
						status !== null && headers !== null
							? { status, headers, body: body?.toString("latin1", 0, bodyLength) ?? "" }
							: null,
					);
				},
			},
		}).then(
			connected => {
				// Bun.connect has no abort option. The timer may have settled before
				// it resolves, so close a socket that arrives after the deadline.
				if (settled) {
					if (socket !== connected) {
						try {
							connected.terminate();
						} catch {
							// socket already torn down
						}
					}
				} else {
					socket = connected;
				}
			},
			() => finish(null),
		);
	} catch {
		finish(null);
	}
	return promise;
}
