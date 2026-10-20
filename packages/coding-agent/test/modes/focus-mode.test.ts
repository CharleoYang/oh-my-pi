import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { chatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { FocusSummaryComponent } from "@oh-my-pi/pi-tui/chat/focus-summary";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { Component } from "@oh-my-pi/pi-tui";
import { applyFocusModeToTranscript } from "@oh-my-pi/pi-coding-agent/modes/utils/focus-mode";

const NOW = Date.now();

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: NOW,
	};
}

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], attribution: "user", timestamp: NOW };
}

/** Tool calls are interim work; answers without calls end a turn. */
function transcript(): {
	messages: AgentMessage[];
	components: Map<AgentMessage, Component>;
	container: TranscriptContainer;
} {
	const firstInterim = assistant(
		[
			{ type: "text", text: "checking" },
			{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } },
		],
		"toolUse",
	);
	const firstAnswer = assistant([{ type: "text", text: "first answer" }], "stop");
	const secondInterim = assistant(
		[{ type: "toolCall", id: "task-1", name: "task", arguments: { task: "work" } }],
		"toolUse",
	);
	const secondAnswer = assistant([{ type: "text", text: "second answer" }], "stop");
	const messages: AgentMessage[] = [
		user("first prompt"),
		firstInterim,
		{ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [], isError: false, timestamp: NOW },
		firstAnswer,
		user("second prompt"),
		secondInterim,
		{ role: "toolResult", toolCallId: "task-1", toolName: "task", content: [], isError: false, timestamp: NOW },
		secondAnswer,
	];
	const container = new TranscriptContainer();
	const components = new Map<AgentMessage, Component>();
	for (const message of messages) {
		if (message.role === "user") {
			const component = new UserMessageComponent("prompt");
			components.set(message, component);
			container.addChild(component);
			continue;
		}
		if (message.role !== "assistant") continue;
		const component = new AssistantMessageComponent(message);
		components.set(message, component);
		container.addChild(component);
	}
	return { messages, components, container };
}

beforeAll(async () => {
	await initTheme(false);
});

afterAll(() => {
	chatTranscriptDisplayPreferences.focusMode = false;
});

describe("applyFocusModeToTranscript", () => {
	it("tags tool-call answers as interim and keeps final answers visible", () => {
		const { messages, components, container } = transcript();
		applyFocusModeToTranscript(container, components, messages, () => {});

		const answers = [...components.values()].filter(
			(component): component is AssistantMessageComponent => component instanceof AssistantMessageComponent,
		);
		expect(answers.filter(component => component.focusInterim)).toHaveLength(2);
		expect(answers.filter(component => !component.focusInterim)).toHaveLength(2);

		chatTranscriptDisplayPreferences.focusMode = true;
		const visible = container.children
			.filter((child): child is AssistantMessageComponent => child instanceof AssistantMessageComponent)
			.map(child => Bun.stripANSI(child.render(80).join("\n")))
			.join("\n");
		expect(visible).toContain("first answer");
		expect(visible).toContain("second answer");
		expect(visible).not.toContain("checking");
	});

	it("adds one activity summary per turn with subagents counted separately", () => {
		const { messages, components, container } = transcript();
		applyFocusModeToTranscript(container, components, messages, () => {});

		const summaries = container.children.filter(
			(child): child is FocusSummaryComponent => child instanceof FocusSummaryComponent,
		);
		expect(summaries).toHaveLength(2);
		const rendered = summaries.map(summary => Bun.stripANSI(summary.render(80).join("")));
		expect(rendered[0]).toContain("1 tool");
		expect(rendered[0]).not.toContain("subagent");
		expect(rendered[1]).toContain("1 subagent");
	});

	it("expands the folded work through its summary and folds it back", () => {
		const { messages, components, container } = transcript();
		applyFocusModeToTranscript(container, components, messages, () => {});
		chatTranscriptDisplayPreferences.focusMode = true;

		const interim = [...components.values()].find(
			(component): component is AssistantMessageComponent =>
				component instanceof AssistantMessageComponent && component.focusInterim,
		)!;
		expect(interim.render(80)).toEqual([]);

		const summary = container.children.find(
			(child): child is FocusSummaryComponent => child instanceof FocusSummaryComponent,
		)!;
		summary.toggle();
		expect(Bun.stripANSI(interim.render(80).join("\n"))).toContain("checking");

		summary.toggle();
		expect(interim.render(80)).toEqual([]);
	});
});
