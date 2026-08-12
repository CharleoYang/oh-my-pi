import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AppServerConnection, type AppServerSession } from "@oh-my-pi/pi-coding-agent/modes/app-server/app-server-mode";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { parseArgs } from "../src/cli/args";

interface AppServerHarness {
	connection: AppServerConnection;
	messages: Record<string, unknown>[];
	sent: string[];
	abortReasons: string[];
	emit(event: AgentSessionEvent): void;
}

function createHarness(): AppServerHarness {
	const messages: Record<string, unknown>[] = [];
	const sent: string[] = [];
	const abortReasons: string[] = [];
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	const session: AppServerSession = {
		model: undefined,
		sessionManager: {
			getCwd: () => "/workspace",
			getSessionId: () => "omp-session",
		},
		newSession: async () => true,
		sendUserMessage: async message => {
			sent.push(message);
		},
		abort: async options => {
			if (options?.reason) abortReasons.push(options.reason);
		},
		subscribe: eventListener => {
			listener = eventListener;
			return () => {
				listener = undefined;
			};
		},
		dispose: async () => {},
	};
	return {
		connection: new AppServerConnection(session, message => messages.push(message)),
		messages,
		sent,
		abortReasons,
		emit: event => listener?.(event),
	};
}

async function initializeAndStartThread(harness: AppServerHarness): Promise<string> {
	await harness.connection.handle({
		id: 1,
		method: "initialize",
		params: { clientInfo: { name: "app-server-test", version: "1.0" } },
	});
	await harness.connection.handle({ method: "initialized" });
	await harness.connection.handle({ id: 2, method: "thread/start", params: {} });
	const threadStart = harness.messages.find(message => message.id === 2);
	const result = threadStart?.result as { thread?: { id?: string } } | undefined;
	if (!result?.thread?.id) throw new Error("thread/start did not return a thread id");
	return result.thread.id;
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("OMP app-server mode", () => {
	test("exposes the adapter through an explicit CLI mode", () => {
		expect(parseArgs(["--mode", "app-server"]).mode).toBe("app-server");
	});

	test("uses the explicit security-test UA override during the app-server handshake", async () => {
		const previous = process.env.OMP_TEST_CODEX_USER_AGENT;
		const userAgent = "codex_cli_rs/0.147.0 (Mac OS 26.5.2; arm64) test-terminal/1.0";
		process.env.OMP_TEST_CODEX_USER_AGENT = userAgent;
		try {
			const harness = createHarness();
			await harness.connection.handle({
				id: 1,
				method: "initialize",
				params: { clientInfo: { name: "app-server-test", version: "1.0" } },
			});
			expect(harness.messages.at(-1)).toMatchObject({ id: 1, result: { userAgent } });
		} finally {
			if (previous === undefined) delete process.env.OMP_TEST_CODEX_USER_AGENT;
			else process.env.OMP_TEST_CODEX_USER_AGENT = previous;
		}
	});

	test("maps the initialize, thread, and text-turn lifecycle to app-server envelopes", async () => {
		const harness = createHarness();
		const threadId = await initializeAndStartThread(harness);

		await harness.connection.handle({
			id: 3,
			method: "turn/start",
			params: { threadId, input: [{ type: "text", text: "hello" }] },
		});
		const turnStart = harness.messages.find(message => message.id === 3);
		const turn = (turnStart?.result as { turn?: { id?: string } } | undefined)?.turn;
		if (!turn?.id) throw new Error("turn/start did not return a turn id");

		const assistant = assistantMessage("Hello");
		harness.emit({ type: "message_start", message: assistant });
		harness.emit({
			type: "message_update",
			message: assistant,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello", partial: assistant },
		});
		harness.emit({ type: "message_end", message: assistant });
		harness.emit({ type: "agent_end", messages: [] });

		expect(harness.sent).toEqual(["hello"]);
		expect(harness.messages.map(message => message.method ?? `response:${message.id}`)).toEqual([
			"response:1",
			"response:2",
			"thread/started",
			"response:3",
			"turn/started",
			"item/started",
			"item/agentMessage/delta",
			"item/completed",
			"turn/completed",
		]);
		const delta = harness.messages.find(message => message.method === "item/agentMessage/delta");
		expect(delta?.params).toMatchObject({ threadId, turnId: turn.id, delta: "Hello" });
		const completed = harness.messages.find(message => message.method === "turn/completed");
		expect(completed?.params).toMatchObject({ threadId, turn: { id: turn.id, status: "completed" } });
	});

	test("rejects pre-handshake calls and unsupported input instead of silently downgrading them", async () => {
		const harness = createHarness();
		await harness.connection.handle({ id: 1, method: "thread/start", params: {} });
		expect(harness.messages).toEqual([
			{
				id: 1,
				error: { code: -32001, message: "initialize followed by initialized is required before this method" },
			},
		]);

		const threadId = await initializeAndStartThread(harness);
		await harness.connection.handle({
			id: 3,
			method: "turn/start",
			params: { threadId, input: [{ type: "image", url: "https://example.test/image.png" }] },
		});
		expect(harness.messages.at(-1)).toEqual({
			id: 3,
			error: { code: -32602, message: "OMP app-server mode currently supports only input items with type: text" },
		});
	});

	test("maps an interrupt only to the active turn", async () => {
		const harness = createHarness();
		const threadId = await initializeAndStartThread(harness);
		await harness.connection.handle({
			id: 3,
			method: "turn/start",
			params: { threadId, input: [{ type: "text", text: "wait" }] },
		});
		const turnStart = harness.messages.find(message => message.id === 3);
		const turn = (turnStart?.result as { turn?: { id?: string } } | undefined)?.turn;
		if (!turn?.id) throw new Error("turn/start did not return a turn id");

		await harness.connection.handle({ id: 4, method: "turn/interrupt", params: { threadId, turnId: turn.id } });
		expect(harness.abortReasons).toEqual(["Interrupted by user"]);
		expect(harness.messages.at(-1)).toEqual({ id: 4, result: {} });

		harness.emit({ type: "agent_end", messages: [] });
		expect(harness.messages.at(-1)).toMatchObject({
			method: "turn/completed",
			params: { threadId, turn: { id: turn.id, status: "interrupted" } },
		});
	});
});
