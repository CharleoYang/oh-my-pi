/**
 * App-server transport replay: feed a tokens-like JSONL transcript to the real
 * `omp --mode app-server` CLI and assert the Codex-shaped wire contract end to
 * end — every stdout line is pure JSON, request/response ids correlate, the
 * thread lifecycle emits the documented notifications in order, and malformed
 * / pre-initialize / unknown frames map to the documented JSON-RPC errors.
 *
 * This complements the in-process `app-server-mode.test.ts` connection tests:
 * those prove the AppServerConnection envelope mapping, this one proves the
 * stdin/stdout transport does not leak banner/progress bytes onto the
 * protocol-owned stdout channel.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";

type AppServerProc = Bun.Subprocess<"pipe", "pipe", "pipe">;

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

const cleanupRoots: string[] = [];
let activeProc: AppServerProc | undefined;

/** SIGTERM → SIGKILL teardown so a blocked stdin read never trips the 5s hook. */
async function teardown(proc: AppServerProc): Promise<void> {
	try {
		proc.stdin.end();
	} catch {
		// already closed
	}
	for (const stream of [proc.stdout, proc.stderr] as Array<ReadableStream<Uint8Array> | undefined>) {
		if (!stream) continue;
		try {
			stream.cancel();
		} catch {
			// already released
		}
	}
	try {
		proc.kill("SIGTERM");
	} catch {
		// already exited
	}
	// Real child-process lifecycle: deterministic timer control cannot drive a
	// spawned CLI, so bound the SIGTERM→SIGKILL escalation by racing the actual
	// exit signal against a grace cap instead of waiting a fixed duration.
	const exited = proc.exited;
	const raced = await Promise.race([
		exited.then(() => "exited" as const),
		Bun.sleep(200).then(() => "timeout" as const),
	]);
	if (raced === "exited") return;
	try {
		proc.kill("SIGKILL");
	} catch {
		// already exited
	}
	await Promise.race([exited, Bun.sleep(1500)]);
}

afterEach(async () => {
	if (activeProc) {
		await teardown(activeProc);
		activeProc = undefined;
	}
	for (const root of cleanupRoots.splice(0)) {
		await fs.promises.rm(root, { recursive: true, force: true });
	}
});

/** Read every line emitted on stdout until EOF. */
async function readAllLines(stream: ReadableStream<Uint8Array>): Promise<string[]> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const lines: string[] = [];
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let newlineIdx = buffer.indexOf("\n");
		while (newlineIdx >= 0) {
			lines.push(buffer.slice(0, newlineIdx));
			buffer = buffer.slice(newlineIdx + 1);
			newlineIdx = buffer.indexOf("\n");
		}
	}
	if (buffer.trim().length > 0) lines.push(buffer);
	return lines;
}

interface ReplayResult {
	proc: AppServerProc;
	stdoutLines: string[];
	messages: Record<string, unknown>[];
	stderrText: string;
}

async function launchReplay(transcript: string[]): Promise<ReplayResult> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-app-server-transport-"));
	cleanupRoots.push(root);
	const xdg = path.join(root, "xdg");
	const agentDir = path.join(root, "agent");
	await fs.promises.mkdir(xdg, { recursive: true });
	await fs.promises.mkdir(agentDir, { recursive: true });

	// Pin an explicit model so createAgentSession skips cold-cache online model
	// discovery; the adapter never calls the model for the handshake frames this
	// replay exercises. Keep HOME unset for the same transpile-cache reason as
	// the ACP hygiene test.
	const proc = Bun.spawn(["bun", cliEntry, "--mode", "app-server", "--model", "anthropic/claude-sonnet-4-5"], {
		cwd: repoRoot,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			XDG_DATA_HOME: xdg,
			XDG_CONFIG_HOME: xdg,
			PI_CODING_AGENT_DIR: agentDir,
			PI_NO_TITLE: "1",
			NO_COLOR: "1",
		},
	});
	activeProc = proc;

	const stderrChunks: Uint8Array[] = [];
	const stderrPump = (async () => {
		const reader = proc.stderr.getReader();
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				if (value) stderrChunks.push(value);
			}
		} catch {
			// cancelled by teardown — expected
		} finally {
			try {
				reader.releaseLock();
			} catch {
				// already released
			}
		}
	})();

	for (const line of transcript) {
		proc.stdin.write(new TextEncoder().encode(`${line}\n`));
	}
	proc.stdin.flush();
	proc.stdin.end();

	const stdoutLines = await readAllLines(proc.stdout);
	await proc.exited;
	await stderrPump;
	activeProc = undefined;

	const messages = stdoutLines.map((line, index) => {
		const parsed: unknown = JSON.parse(line);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`stdout line ${index} is not a JSON object: ${line}`);
		}
		return parsed as Record<string, unknown>;
	});
	return { proc, stdoutLines, messages, stderrText: Buffer.concat(stderrChunks).toString("utf8") };
}

describe("OMP app-server transport replay", () => {
	it("replays a tokens-like JSONL transcript with pure-JSON stdout, correlated ids, and documented error mapping", async () => {
		const transcript = [
			JSON.stringify({
				id: 1,
				method: "initialize",
				params: { clientInfo: { name: "tokens-replay", version: "1.0" } },
			}),
			JSON.stringify({ method: "initialized" }),
			JSON.stringify({ id: 2, method: "thread/start", params: {} }),
			// Malformed frame → -32700 parse error.
			"not-json{{{",
			// Unknown method after handshake → -32601.
			JSON.stringify({ id: 3, method: "bogus/method", params: {} }),
			// turn/start against an unknown thread → -32001 (pre-thread misuse).
			JSON.stringify({
				id: 4,
				method: "turn/start",
				params: { threadId: "unknown-thread", input: [{ type: "text", text: "hi" }] },
			}),
		];

		const { messages, stderrText } = await launchReplay(transcript);

		// Every stdout line is a JSON object — no banner, progress, or stray
		// non-JSON bytes on the protocol-owned channel. Frames in order:
		// initialize → thread/start → thread/started → -32700 → -32601 → -32001.
		expect(messages.length).toBe(6);
		for (const message of messages) {
			expect(isRecord(message)).toBe(true);
			expect(Object.keys(message).length).toBeGreaterThan(0);
		}

		// initialize → id-correlated result with an honest OMP identity.
		const init = messages[0];
		expect(init.id).toBe(1);
		expect(init.error).toBeUndefined();
		expect(isRecord(init.result)).toBe(true);
		const initResult = init.result as Record<string, unknown>;
		expect(initResult.userAgent).toMatch(/^omp\//);
		expect(initResult.codexHome).toBeTypeOf("string");
		expect(initResult.platformOs).toBe("macos");
		expect(initResult.platformFamily).toBe("unix");

		// thread/start → id-correlated result containing a thread id, followed
		// immediately by the thread/started notification.
		const threadStart = messages[1];
		expect(threadStart.id).toBe(2);
		expect(threadStart.error).toBeUndefined();
		const threadResult = threadStart.result as Record<string, unknown>;
		const thread = threadResult.thread;
		expect(isRecord(thread)).toBe(true);
		const threadId = (thread as Record<string, unknown>).id;
		expect(typeof threadId).toBe("string");

		const threadStarted = messages[2];
		expect(threadStarted.method).toBe("thread/started");
		const startedThread = threadStarted.params as Record<string, unknown>;
		expect(isRecord(startedThread)).toBe(true);
		expect((startedThread.thread as Record<string, unknown>).id).toBe(threadId);

		// Malformed JSON → -32700 parse error with a null id.
		const parseError = messages[3];
		expect(parseError.id).toBeNull();
		expect(parseError.error).toMatchObject({ code: -32700 });

		// Unknown method → -32601.
		const unknownMethod = messages[4];
		expect(unknownMethod.id).toBe(3);
		expect(unknownMethod.error).toMatchObject({ code: -32601 });

		// turn/start on an unknown thread → -32001.
		const unknownThread = messages[5];
		expect(unknownThread.id).toBe(4);
		expect(unknownThread.error).toMatchObject({ code: -32001 });

		// No JSON-RPC/app-server frames may leak onto stderr. Plain diagnostics
		// are allowed; anything that parses as a protocol envelope is a misroute.
		for (const line of stderrText.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed.startsWith("{")) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				continue;
			}
			expect(isRecord(parsed) && ("id" in parsed || "method" in parsed)).toBe(false);
		}
	}, 60_000);
});
