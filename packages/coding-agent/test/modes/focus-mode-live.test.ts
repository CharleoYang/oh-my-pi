import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolCall, Usage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgDisplayShowTokenUsage } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { chatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { FocusSummaryComponent } from "@oh-my-pi/pi-tui/chat/focus-summary";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";

const TOOL_CALL_ID = "focus-tool-1";

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") {
	return {
		role: "assistant" as const,
		content,
		api: "test",
		provider: "test",
		model: "test-model",
		stopReason,
		usage: zeroUsage(),
		timestamp: 1,
	} satisfies AssistantMessage;
}

const toolCall: ToolCall = {
	type: "toolCall",
	id: TOOL_CALL_ID,
	name: "task",
	arguments: { task: "work" },
};

describe("focus mode in the live event pipeline", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: { "display.smoothStreaming": false, "display.focusMode": true },
		});
		chatTranscriptDisplayPreferences.focusMode = true;
	});

	afterEach(() => {
		chatTranscriptDisplayPreferences.focusMode = false;
		resetSettingsForTest();
	});

	it("folds the interim answer while it is still streaming", async () => {
		const ctx = createInteractiveModeContext({ focusMode: true });
		const controller = new EventController(ctx);
		const started = assistantMessage([]);
		const streaming = assistantMessage([{ type: "text", text: "working" }, toolCall], "toolUse");

		await controller.handleEvent({
			type: "message_start",
			message: started,
		} as Extract<AgentSessionEvent, { type: "message_start" }>);
		await controller.handleEvent({
			type: "message_update",
			message: streaming,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, partial: streaming },
		} as Extract<AgentSessionEvent, { type: "message_update" }>);

		const answer = ctx.chatContainer.children.find(
			(child): child is AssistantMessageComponent => child instanceof AssistantMessageComponent,
		);
		expect(answer?.focusInterim).toBe(true);
		expect(answer?.render(120)).toEqual([]);
	});

	it("folds a superseded text answer when the next answer starts", async () => {
		const ctx = createInteractiveModeContext({ focusMode: true });
		const controller = new EventController(ctx);
		const draft = assistantMessage([{ type: "text", text: "draft" }]);

		await controller.handleEvent({
			type: "message_start",
			message: draft,
		} as Extract<AgentSessionEvent, { type: "message_start" }>);
		await controller.handleEvent({
			type: "message_end",
			message: draft,
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
		const draftComponent = ctx.chatContainer.children.find(
			(child): child is AssistantMessageComponent => child instanceof AssistantMessageComponent,
		);
		expect(draftComponent?.render(120)).not.toEqual([]);

		await controller.handleEvent({
			type: "message_start",
			message: assistantMessage([]),
		} as Extract<AgentSessionEvent, { type: "message_start" }>);

		expect(draftComponent?.focusInterim).toBe(true);
		expect(draftComponent?.render(120)).toEqual([]);
	});

	it("keeps one stats row per turn instead of one per folded request", async () => {
		cfgDisplayShowTokenUsage.set(settings, true);
		const ctx = createInteractiveModeContext({ focusMode: true });
		const controller = new EventController(ctx);
		const billed = { ...zeroUsage(), input: 10, output: 5, totalTokens: 15 };
		const interim = assistantMessage([{ type: "text", text: "working" }, toolCall], "toolUse");
		interim.usage = billed;
		const final = assistantMessage([{ type: "text", text: "answer" }]);
		final.usage = billed;

		await controller.handleEvent({
			type: "message_start",
			message: interim,
		} as Extract<AgentSessionEvent, { type: "message_start" }>);
		await controller.handleEvent({
			type: "message_end",
			message: interim,
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_ID,
			toolName: "task",
			args: { task: "work" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_ID,
			toolName: "task",
			result: { content: [{ type: "text", text: "done" }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await controller.handleEvent({
			type: "message_start",
			message: final,
		} as Extract<AgentSessionEvent, { type: "message_start" }>);
		await controller.handleEvent({
			type: "message_end",
			message: final,
		} as Extract<AgentSessionEvent, { type: "message_end" }>);

		const statsRows = ctx.chatContainer.children.filter(child =>
			Bun.stripANSI(child.render(120).join("")).includes("⤵"),
		);
		expect(statsRows).toHaveLength(1);
	});

	it("hides an answer that ends on a tool call and summarizes the turn's activity", async () => {
		const ctx = createInteractiveModeContext({ focusMode: true });
		const controller = new EventController(ctx);
		const interim = assistantMessage([{ type: "text", text: "working" }, toolCall], "toolUse");

		await controller.handleEvent({
			type: "message_start",
			message: interim,
		} as Extract<AgentSessionEvent, { type: "message_start" }>);
		await controller.handleEvent({
			type: "message_end",
			message: interim,
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
		const answer = ctx.chatContainer.children.find(
			(child): child is AssistantMessageComponent => child instanceof AssistantMessageComponent,
		);
		expect(answer?.focusInterim).toBe(true);
		expect(answer?.render(120)).toEqual([]);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_ID,
			toolName: "task",
			args: { task: "work" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_ID,
			toolName: "task",
			result: { content: [{ type: "text", text: "done" }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await controller.handleEvent({
			type: "agent_end",
			messages: [interim],
			isTerminal: true,
		} as Extract<AgentSessionEvent, { type: "agent_end" }>);

		const summary = ctx.chatContainer.children.find(
			(child): child is FocusSummaryComponent => child instanceof FocusSummaryComponent,
		);
		expect(summary).toBeDefined();
		expect(Bun.stripANSI(summary!.render(120).join(""))).toContain("1 tool · 1 subagent");

		// Clicking the summary expands the turn's folded tool card in place.
		const card = ctx.chatContainer.children.find(
			(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
		);
		expect(card?.render(120)).toEqual([]);
		summary!.toggle();
		expect(card?.render(120).length).toBeGreaterThan(0);
		summary!.toggle();
		expect(card?.render(120)).toEqual([]);
	});
});
