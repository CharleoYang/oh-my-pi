/**
 * Codex app-server compatible JSONL adapter.
 *
 * This is intentionally separate from OMP's established `--mode rpc` wire
 * protocol. It accepts the small, stable app-server lifecycle and translates
 * it to an existing AgentSession without claiming to be an official Codex
 * client or altering OMP's tool approval policy.
 */
import { once } from "node:events";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	getAgentDir,
	getTestCodexUserAgent,
	isRecord,
	readLines,
	Snowflake,
	USER_AGENT,
	VERSION,
} from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent, AgentSessionEventListener } from "../../session/agent-session-events";
import { USER_INTERRUPT_LABEL } from "../../session/messages";

type AppServerRequestId = number | string;

interface AppServerSessionManager {
	getCwd(): string;
	getSessionId(): string;
}

/** The AgentSession boundary used by the protocol adapter. */
export interface AppServerSession {
	model: Model | undefined;
	sessionManager: AppServerSessionManager;
	newSession(): Promise<boolean>;
	sendUserMessage(content: string): Promise<void>;
	abort(options?: { reason?: string }): Promise<void>;
	subscribe(listener: AgentSessionEventListener): () => void;
	dispose(): Promise<void>;
}

export type AppServerOutput = (message: Record<string, unknown>) => void;

interface ActiveTurn {
	id: string;
	threadId: string;
	startedAt: number;
	assistantItemId: string | undefined;
}

interface ActiveThread {
	id: string;
	createdAt: number;
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

function requestId(value: unknown): AppServerRequestId | undefined {
	return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function textFromMessage(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content
		.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
		.map(part => part.text)
		.join("");
}

function isAssistantMessage(message: AgentMessage): boolean {
	return message.role === "assistant";
}

function platformOs(): "macos" | "linux" | "windows" {
	if (process.platform === "darwin") return "macos";
	if (process.platform === "win32") return "windows";
	return "linux";
}

function platformFamily(): "unix" | "windows" {
	return process.platform === "win32" ? "windows" : "unix";
}

function parseTextInput(value: unknown): { text: string } | { error: string } {
	if (!Array.isArray(value) || value.length === 0)
		return { error: "params.input must contain at least one text input" };
	const text: string[] = [];
	for (const part of value) {
		if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
			return { error: "OMP app-server mode currently supports only input items with type: text" };
		}
		text.push(part.text);
	}
	return { text: text.join("\n") };
}

/**
 * Stateful per-connection adapter. The exported class keeps protocol behavior
 * testable without creating a process or a model-backed AgentSession.
 */
export class AppServerConnection {
	#initialized = false;
	#ready = false;
	#thread: ActiveThread | undefined;
	#turn: ActiveTurn | undefined;
	#interruptRequested = false;
	#unsubscribe: (() => void) | undefined;

	constructor(
		readonly session: AppServerSession,
		readonly output: AppServerOutput,
	) {
		this.#unsubscribe = session.subscribe(event => this.#onSessionEvent(event));
	}

	dispose(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}

	async handle(value: unknown): Promise<void> {
		if (!isRecord(value) || typeof value.method !== "string") {
			this.#error(undefined, -32600, "request must be an object with a string method");
			return;
		}

		const id = requestId(value.id);
		const params = value.params;
		switch (value.method) {
			case "initialize":
				await this.#initialize(id, params);
				return;
			case "initialized":
				this.#initializedNotification(id, params);
				return;
			case "thread/start":
				await this.#startThread(id, params);
				return;
			case "thread/resume":
				this.#resumeThread(id, params);
				return;
			case "turn/start":
				await this.#startTurn(id, params);
				return;
			case "turn/interrupt":
				await this.#interruptTurn(id, params);
				return;
			default:
				if (id !== undefined)
					this.#error(id, -32601, `method not supported by OMP app-server mode: ${value.method}`);
		}
	}

	async #initialize(id: AppServerRequestId | undefined, params: unknown): Promise<void> {
		if (id === undefined) {
			this.#error(undefined, -32600, "initialize requires an id");
			return;
		}
		if (this.#initialized) {
			this.#error(id, -32600, "initialize may only be called once per connection");
			return;
		}
		if (
			!isRecord(params) ||
			!isRecord(params.clientInfo) ||
			typeof params.clientInfo.name !== "string" ||
			typeof params.clientInfo.version !== "string"
		) {
			this.#error(id, -32602, "initialize.params.clientInfo requires name and version strings");
			return;
		}
		this.#initialized = true;
		this.#result(id, {
			userAgent: getTestCodexUserAgent() ?? USER_AGENT,
			codexHome: getAgentDir(),
			platformFamily: platformFamily(),
			platformOs: platformOs(),
		});
	}

	#initializedNotification(id: AppServerRequestId | undefined, params: unknown): void {
		if (id !== undefined || params !== undefined) {
			this.#error(id, -32600, "initialized is a notification without id or params");
			return;
		}
		if (!this.#initialized) {
			this.#error(undefined, -32001, "initialize must complete before initialized");
			return;
		}
		this.#ready = true;
	}

	async #startThread(id: AppServerRequestId | undefined, params: unknown): Promise<void> {
		if (!this.#requireReady(id)) return;
		if (id === undefined) {
			this.#error(undefined, -32600, "thread/start requires an id");
			return;
		}
		if (params !== undefined && !isRecord(params)) {
			this.#error(id, -32602, "thread/start.params must be an object");
			return;
		}
		const requestedModel = isRecord(params) ? params.model : undefined;
		const requestedProvider = isRecord(params) ? params.modelProvider : undefined;
		if (
			(typeof requestedModel === "string" && requestedModel !== this.session.model?.id) ||
			(typeof requestedProvider === "string" && requestedProvider !== this.session.model?.provider)
		) {
			this.#error(id, -32602, "thread/start model overrides are not supported; configure OMP's model before launch");
			return;
		}
		if (
			isRecord(params) &&
			(params.cwd !== undefined || params.sandbox !== undefined || params.approvalPolicy !== undefined)
		) {
			this.#error(
				id,
				-32602,
				"thread/start cwd, sandbox, and approval overrides are not supported by OMP app-server mode",
			);
			return;
		}
		if (!(await this.session.newSession())) {
			this.#error(id, -32001, "OMP could not create a new session");
			return;
		}
		this.#thread = { id: Snowflake.next() as string, createdAt: nowSeconds() };
		const thread = this.#threadValue("idle");
		this.#result(id, {
			thread,
			model: this.session.model?.id ?? "unknown",
			modelProvider: this.session.model?.provider ?? "unknown",
			serviceTier: null,
			cwd: this.session.sessionManager.getCwd(),
			instructionSources: [],
			approvalPolicy: "on-request",
			approvalsReviewer: "user",
			sandbox: {
				type: "workspaceWrite",
				writableRoots: [this.session.sessionManager.getCwd()],
				networkAccess: false,
			},
			reasoningEffort: null,
		});
		this.#notification("thread/started", { thread });
	}

	#resumeThread(id: AppServerRequestId | undefined, params: unknown): void {
		if (!this.#requireReady(id)) return;
		if (id === undefined) {
			this.#error(undefined, -32600, "thread/resume requires an id");
			return;
		}
		if (!isRecord(params) || typeof params.threadId !== "string") {
			this.#error(id, -32602, "thread/resume.params.threadId must be a string");
			return;
		}
		if (!this.#thread || params.threadId !== this.#thread.id) {
			this.#error(id, -32001, "OMP app-server mode can resume only a thread created by this connection");
			return;
		}
		this.#result(id, {
			thread: this.#threadValue("idle"),
			model: this.session.model?.id ?? "unknown",
			modelProvider: this.session.model?.provider ?? "unknown",
		});
	}

	async #startTurn(id: AppServerRequestId | undefined, params: unknown): Promise<void> {
		if (!this.#requireReady(id)) return;
		if (id === undefined) {
			this.#error(undefined, -32600, "turn/start requires an id");
			return;
		}
		if (!isRecord(params) || typeof params.threadId !== "string") {
			this.#error(id, -32602, "turn/start.params.threadId must be a string");
			return;
		}
		if (!this.#thread || params.threadId !== this.#thread.id) {
			this.#error(id, -32001, "turn/start references an unknown OMP app-server thread");
			return;
		}
		if (this.#turn) {
			this.#error(id, -32001, "this OMP app-server thread already has an active turn");
			return;
		}
		const input = parseTextInput(params.input);
		if ("error" in input) {
			this.#error(id, -32602, input.error);
			return;
		}
		this.#turn = {
			id: Snowflake.next() as string,
			threadId: this.#thread.id,
			startedAt: nowSeconds(),
			assistantItemId: undefined,
		};
		const turn = this.#turnValue("inProgress");
		this.#result(id, { turn });
		this.#notification("turn/started", { threadId: this.#thread.id, turn });
		try {
			await this.session.sendUserMessage(input.text);
		} catch (error) {
			this.#completeTurn("failed", error instanceof Error ? error.message : String(error));
		}
	}

	async #interruptTurn(id: AppServerRequestId | undefined, params: unknown): Promise<void> {
		if (!this.#requireReady(id)) return;
		if (id === undefined) {
			this.#error(undefined, -32600, "turn/interrupt requires an id");
			return;
		}
		if (!isRecord(params) || typeof params.threadId !== "string" || typeof params.turnId !== "string") {
			this.#error(id, -32602, "turn/interrupt requires string threadId and turnId");
			return;
		}
		if (!this.#turn || params.threadId !== this.#turn.threadId || params.turnId !== this.#turn.id) {
			this.#error(id, -32001, "turn/interrupt references no active OMP app-server turn");
			return;
		}
		this.#interruptRequested = true;
		await this.session.abort({ reason: USER_INTERRUPT_LABEL });
		this.#result(id, {});
	}

	#onSessionEvent(event: AgentSessionEvent): void {
		const turn = this.#turn;
		if (!turn) return;
		if (event.type === "message_start" && isAssistantMessage(event.message)) {
			turn.assistantItemId = Snowflake.next() as string;
			this.#notification("item/started", {
				threadId: turn.threadId,
				turnId: turn.id,
				startedAtMs: Date.now(),
				item: { type: "agentMessage", id: turn.assistantItemId, text: textFromMessage(event.message) },
			});
			return;
		}
		if (
			event.type === "message_update" &&
			event.assistantMessageEvent.type === "text_delta" &&
			turn.assistantItemId
		) {
			this.#notification("item/agentMessage/delta", {
				threadId: turn.threadId,
				turnId: turn.id,
				itemId: turn.assistantItemId,
				delta: event.assistantMessageEvent.delta,
			});
			return;
		}
		if (event.type === "message_end" && isAssistantMessage(event.message)) {
			const itemId = turn.assistantItemId ?? (Snowflake.next() as string);
			turn.assistantItemId = undefined;
			this.#notification("item/completed", {
				threadId: turn.threadId,
				turnId: turn.id,
				completedAtMs: Date.now(),
				item: { type: "agentMessage", id: itemId, text: textFromMessage(event.message) },
			});
			return;
		}
		if (event.type === "agent_end" && event.isTerminal !== false)
			this.#completeTurn(this.#interruptRequested ? "interrupted" : "completed");
	}

	#completeTurn(status: "completed" | "interrupted" | "failed", error?: string): void {
		const turn = this.#turn;
		if (!turn) return;
		this.#turn = undefined;
		this.#interruptRequested = false;
		this.#notification("turn/completed", { threadId: turn.threadId, turn: this.#turnValue(status, turn, error) });
	}

	#threadValue(status: "idle" | "active"): Record<string, unknown> {
		const thread = this.#thread;
		if (!thread) throw new Error("thread has not been started");
		const now = nowSeconds();
		return {
			id: thread.id,
			sessionId: this.session.sessionManager.getSessionId(),
			forkedFromId: null,
			parentThreadId: null,
			preview: "",
			ephemeral: false,
			historyMode: "legacy",
			modelProvider: this.session.model?.provider ?? "unknown",
			createdAt: thread.createdAt,
			updatedAt: now,
			recencyAt: now,
			status: status === "idle" ? { type: "idle" } : { type: "active", activeFlags: [] },
			path: null,
			cwd: this.session.sessionManager.getCwd(),
			cliVersion: VERSION,
			source: "appServer",
			canAcceptDirectInput: true,
			threadSource: null,
			agentNickname: null,
			agentRole: null,
			gitInfo: null,
			name: null,
			turns: [],
		};
	}

	#turnValue(
		status: "inProgress" | "completed" | "interrupted" | "failed",
		turn = this.#turn,
		error?: string,
	): Record<string, unknown> {
		if (!turn) throw new Error("turn has not been started");
		const completed = status !== "inProgress";
		return {
			id: turn.id,
			items: [],
			itemsView: completed ? "summary" : "notLoaded",
			status,
			error: error ? { message: error, codexErrorInfo: null, additionalDetails: null } : null,
			startedAt: turn.startedAt,
			completedAt: completed ? nowSeconds() : null,
			durationMs: completed ? Math.max(0, Date.now() - turn.startedAt * 1000) : null,
		};
	}

	#requireReady(id: AppServerRequestId | undefined): boolean {
		if (this.#ready) return true;
		this.#error(id, -32001, "initialize followed by initialized is required before this method");
		return false;
	}

	#result(id: AppServerRequestId, result: Record<string, unknown>): void {
		this.output({ id, result });
	}

	#error(id: AppServerRequestId | undefined, code: number, message: string): void {
		this.output({ id: id ?? null, error: { code, message } });
	}

	#notification(method: string, params: Record<string, unknown>): void {
		this.output({ method, params });
	}
}

/** Run the app-server JSONL transport on stdin/stdout. */
export async function runAppServerMode(
	session: AppServerSession,
	input: ReadableStream<Uint8Array> = Bun.stdin.stream(),
): Promise<never> {
	process.env.PI_NOTIFICATIONS = "off";
	let stdoutQueue: Promise<void> = Promise.resolve();
	const output: AppServerOutput = message => {
		const line = `${JSON.stringify(message)}\n`;
		stdoutQueue = stdoutQueue
			.then(async () => {
				if (!process.stdout.write(line)) await once(process.stdout, "drain");
			})
			.catch(() => {});
	};
	const connection = new AppServerConnection(session, output);
	const decoder = new TextDecoder();
	for await (const line of readLines(input)) {
		const text = decoder.decode(line).trim();
		if (!text) continue;
		let request: unknown;
		try {
			request = JSON.parse(text);
		} catch (error) {
			output({ id: null, error: { code: -32700, message: error instanceof Error ? error.message : String(error) } });
			continue;
		}
		try {
			await connection.handle(request);
		} catch (error) {
			output({ id: null, error: { code: -32001, message: error instanceof Error ? error.message : String(error) } });
		}
	}
	connection.dispose();
	await stdoutQueue;
	await session.dispose();
	process.exit(0);
}
