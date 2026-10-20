import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { chatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { FocusSummaryComponent, formatFocusSummary } from "@oh-my-pi/pi-tui/chat/focus-summary";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const WIDTH = 80;

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

beforeAll(async () => {
	await initTheme(false);
});

afterAll(() => {
	chatTranscriptDisplayPreferences.focusMode = false;
});

describe("focus mode answer visibility", () => {
	it("hides an interim answer only while focus mode is on", () => {
		const component = new AssistantMessageComponent(assistantMessage("interim work"));
		component.setFocusInterim(true);

		chatTranscriptDisplayPreferences.focusMode = true;
		expect(component.render(WIDTH)).toEqual([]);

		chatTranscriptDisplayPreferences.focusMode = false;
		expect(Bun.stripANSI(component.render(WIDTH).join("\n"))).toContain("interim work");
	});

	it("keeps the final answer visible in focus mode", () => {
		chatTranscriptDisplayPreferences.focusMode = true;
		const component = new AssistantMessageComponent(assistantMessage("final answer"));
		expect(Bun.stripANSI(component.render(WIDTH).join("\n"))).toContain("final answer");
	});
});

describe("focus mode tool folding", () => {
	it("folds and reveals a read group, overriding hidden tool activity", () => {
		const group = new ReadToolGroupComponent();
		group.updateArgs({ path: "a.txt" }, "r1");
		group.updateResult({ content: [{ type: "text", text: "ok" }] }, false, "r1");
		group.setToolActivityVisible(false);
		chatTranscriptDisplayPreferences.focusMode = true;

		expect(group.render(80)).toEqual([]);
		group.setFocusExpanded(true);
		expect(group.render(80).length).toBeGreaterThan(0);
		group.setFocusExpanded(false);
		expect(group.render(80)).toEqual([]);
	});
	it("keeps the user's own tool-activity toggle when focus mode is off", () => {
		const group = new ReadToolGroupComponent();
		group.updateArgs({ path: "a.txt" }, "r1");
		group.updateResult({ content: [{ type: "text", text: "ok" }] }, false, "r1");
		group.setToolActivityVisible(false);
		chatTranscriptDisplayPreferences.focusMode = false;

		expect(group.render(80)).toEqual([]);
		group.setFocusExpanded(true);
		expect(group.render(80)).toEqual([]);
	});
});

describe("focus activity summary", () => {
	it("pluralizes tools and subagents", () => {
		expect(formatFocusSummary({ tools: 1, subagents: 1 })).toBe("✻ 1 tool · 1 subagent");
		expect(formatFocusSummary({ tools: 3, subagents: 2 })).toBe("✻ 3 tools · 2 subagents");
	});

	it("omits subagents when a turn spawned none", () => {
		expect(formatFocusSummary({ tools: 4, subagents: 0 })).toBe("✻ 4 tools");
	});

	it("describes a click that expands and folds the turn's hidden work", () => {
		const onToggle = vi.fn();
		const summary = new FocusSummaryComponent({ tools: 2, subagents: 0 }, { onToggle });
		expect(summary.describe().p?.actions).toEqual({ click: "toggle" });

		summary.handleNativeEvent({ type: "action", act: "toggle" } as never);
		expect(onToggle).toHaveBeenLastCalledWith(true);
		expect(Bun.stripANSI(summary.render(80).join(""))).toContain("▾");

		summary.handleNativeEvent({ type: "action", act: "toggle" } as never);
		expect(onToggle).toHaveBeenLastCalledWith(false);
		expect(Bun.stripANSI(summary.render(80).join(""))).toContain("▸");
	});
});
