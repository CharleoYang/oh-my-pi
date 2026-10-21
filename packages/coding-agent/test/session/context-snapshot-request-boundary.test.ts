import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const usage = (input: number) => ({
	input,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + 5,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

describe("context snapshot request boundary", () => {
	let session: AgentSession;
	let authStorage: AuthStorage | undefined;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-context-boundary-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Test model not found");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", name: "probe", arguments: { value: "first" } }], usage: usage(100) },
				{ content: ["done"], stopReason: "stop", usage: usage(200) },
			],
		});
		const probeSchema = type({ value: "string" });
		const probe: AgentTool<typeof probeSchema, { value: string }> = {
			name: "probe",
			label: "Probe",
			description: "Probe tool",
			parameters: probeSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `result:${params.value}:${"x".repeat(512)}` }], details: params };
			},
		};
		const agent = new Agent({
			initialState: { model, systemPrompt: ["system"], tools: [probe as AgentTool], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage?.close();
		authStorage = undefined;
		if (fs.existsSync(tempDir)) {
			try {
				removeSyncWithRetries(tempDir);
			} catch {
				// Windows may hold sqlite handles briefly after close; best-effort cleanup.
			}
		}
	});

	it("re-captures composition for every provider request in a tool continuation", async () => {
		await session.prompt("go");
		await session.waitForIdle();
		const assistants = session.agent.state.messages.filter(
			message => message.role === "assistant" && message.contextSnapshot?.details,
		);
		expect(assistants).toHaveLength(2);
		const details = assistants.map(
			message =>
				(message as { contextSnapshot?: { details?: { messageCount: number; categories: { messages: number } } } })
					.contextSnapshot!.details!,
		);
		expect(details[0]!.messageCount).not.toBe(details[1]!.messageCount);
		expect(details[1]!.messageCount).toBeGreaterThan(details[0]!.messageCount);
		expect(details[0]!.categories.messages).not.toBe(details[1]!.categories.messages);
	});
});
