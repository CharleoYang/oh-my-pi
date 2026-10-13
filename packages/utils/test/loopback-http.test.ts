import { expect, it, spyOn, vi } from "bun:test";
import type { Socket } from "bun";
import { type LoopbackResponse, loopbackGet } from "../src/loopback-http";

it("bounds stalled connects on timeout and abort and closes late sockets", async () => {
	for (const stop of ["timeout", "abort"]) {
		const closed = Promise.withResolvers<void>();
		const listener = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data() {},
				open() {},
				close() {
					closed.resolve();
				},
				error() {},
			},
		});
		const connected = await Bun.connect({
			hostname: "127.0.0.1",
			port: listener.port,
			socket: { data() {}, open() {}, close() {}, error() {} },
		});
		const pending = Promise.withResolvers<typeof connected>();
		const controller = new AbortController();
		vi.useFakeTimers();
		const connect = spyOn(Bun, "connect").mockImplementation(() => pending.promise);
		try {
			const response = loopbackGet(`http://127.0.0.1:${listener.port}/`, {
				timeoutMs: 20,
				signal: controller.signal,
				readBody: false,
			});
			if (stop === "timeout") vi.advanceTimersByTime(20);
			else controller.abort();
			expect(await response).toBeNull();

			pending.resolve(connected);
			// A connection that arrives after timeout or abort must not leak.
			await closed.promise;
		} finally {
			connect.mockRestore();
			vi.useRealTimers();
			pending.resolve(connected);
			connected.end();
			listener.stop(true);
		}
	}
});

async function probeReply(
	writeReply: (socket: Socket<undefined>) => void,
	options: { readBody: boolean },
): Promise<LoopbackResponse | null> {
	let replied = false;
	const server = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open() {},
			data(socket) {
				if (replied) return;
				replied = true;
				writeReply(socket);
			},
			close() {},
			error() {},
		},
	});
	vi.useFakeTimers();
	try {
		return await loopbackGet(`http://127.0.0.1:${server.port}/`, { ...options, timeoutMs: 5000 });
	} finally {
		vi.useRealTimers();
		server.stop(true);
	}
}

it("rejects a header without a terminator before buffering more than 16 KiB", async () => {
	const response = await probeReply(
		socket => {
			socket.write(`HTTP/1.1 200 OK\r\nx-padding: ${"x".repeat(16 * 1024)}\r\n`);
		},
		{ readBody: false },
	);
	expect(response).toBeNull();
});

it("rejects a declared body beyond 4 MiB without waiting for it", async () => {
	const response = await probeReply(
		socket => {
			socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${4 * 1024 * 1024 + 1}\r\n\r\n`);
		},
		{ readBody: true },
	);
	expect(response).toBeNull();
});

it("accepts a short declared body coalesced with a large trailing chunk", async () => {
	const response = await probeReply(
		socket => {
			socket.write(`HTTP/1.1 200 OK\r\nContent-Length: 2\r\nX-Target: local\r\n\r\nOK${"x".repeat(20_000)}`);
		},
		{ readBody: true },
	);
	expect(response?.status).toBe(200);
	expect(response?.headers.get("x-target")).toBe("local");
	expect(response?.body).toBe("OK");
});

it("rejects a streamed body beyond 4 MiB without a Content-Length", async () => {
	const payload = Buffer.alloc(4 * 1024 * 1024 + 1, 0x61);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(payload);
						controller.close();
					},
				}),
			),
	});
	vi.useFakeTimers();
	try {
		const response = await loopbackGet(`http://127.0.0.1:${server.port}/`, { readBody: true, timeoutMs: 5000 });
		expect(response).toBeNull();
	} finally {
		vi.useRealTimers();
		server.stop(true);
	}
});
