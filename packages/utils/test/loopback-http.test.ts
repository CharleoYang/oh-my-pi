import { expect, it, spyOn, vi } from "bun:test";
import { loopbackGet } from "../src/loopback-http";

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
