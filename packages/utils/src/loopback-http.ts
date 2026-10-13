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
 * the endpoint is unreachable, aborted, malformed, or slow past `timeoutMs`.
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
			socket?.end();
		} catch {
			// socket already torn down
		}
		resolve(response);
	};
	const onAbort = () => finish(null);
	const timer = setTimeout(() => finish(null), opts.timeoutMs);
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	let buffered = "";
	let status: number | null = null;
	let headers: Headers | null = null;
	// Offset of the header/body separator once the header block is complete.
	let headerEnd = -1;
	let contentLength: number | null = null;
	const bodySoFar = () => buffered.slice(headerEnd + 4);
	try {
		socket = await Bun.connect({
			hostname,
			port,
			socket: {
				open(s) {
					s.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`);
				},
				data(_s, chunk) {
					buffered += chunk.toString("latin1");
					if (status === null) {
						const match = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(buffered);
						if (!match) return;
						status = Number(match[1]);
					}
					if (headers === null) {
						headerEnd = buffered.indexOf("\r\n\r\n");
						if (headerEnd === -1) return;
						headers = parseHeaders(buffered.slice(0, headerEnd));
						if (!opts.readBody) {
							finish({ status, headers, body: "" });
							return;
						}
						const lengthHeader = headers.get("content-length");
						contentLength = lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
					}
					if (contentLength !== null && bodySoFar().length >= contentLength) {
						finish({ status, headers, body: bodySoFar().slice(0, contentLength) });
					}
				},
				error() {
					finish(null);
				},
				close() {
					// Without Content-Length the peer's close delimits the body.
					finish(status !== null && headers !== null ? { status, headers, body: bodySoFar() } : null);
				},
			},
		});
	} catch {
		finish(null);
	}
	return promise;
}
