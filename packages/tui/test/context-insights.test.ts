import { beforeAll, describe, expect, it } from "bun:test";
import { foldContextTimeline, type ContextTimeline } from "@oh-my-pi/pi-ai";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { ContextInsightsView, TUI_CONTEXT_TIMELINE_LIMITS } from "@oh-my-pi/pi-tui/status-line/context-insights";
import type { ContextBreakdown } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

const cx = { cols: 120, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
const plainCx = { ...cx, supports: (kind: string) => kind !== "table" };
const composition = { systemPrompt: 100, systemTools: 200, systemContext: 50, skills: 50, messages: 600 };
const breakdown: ContextBreakdown = {
	model: undefined,
	contextWindow: 10000,
	usedTokens: 1000,
	freeTokens: 9000,
	autoCompactBufferTokens: 0,
	categories: [
		{ id: "systemPrompt", label: "System prompt", tokens: 100, color: "accent", glyph: "S" },
		{ id: "systemTools", label: "Tools", tokens: 200, color: "warning", glyph: "T" },
		{ id: "systemContext", label: "Context", tokens: 50, color: "customMessageLabel", glyph: "C" },
		{ id: "skills", label: "Skills", tokens: 50, color: "success", glyph: "K" },
		{ id: "messages", label: "Messages", tokens: 600, color: "userMessageText", glyph: "M" },
	],
};
function timeline(): ContextTimeline {
	return {
		schemaVersion: 1,
		sessionId: "test",
		source: "live",
		omittedSteps: 3,
		detailsOmittedSteps: 2,
		composition,
		peakTokens: 1200,
		costTotal: 0,
		peakTokensTotal: 1200,
		omittedEvents: 2,
		omittedFiles: 4,
		incompleteFileCalls: 1,
		legacySteps: 0,
		truncated: true,
		agents: [],
		steps: [
			{
				id: "a",
				index: 3,
				timestamp: 1000,
				promptTokens: 1000,
				anchored: true,
				composition,
				deltaKind: "first",
				eventIds: [],
				filePaths: [],
			},
			{
				id: "b",
				index: 4,
				timestamp: 2000,
				promptTokens: 800,
				anchored: true,
				composition,
				unattributed: -200,
				deltaTokens: -200,
				deltaKind: "compaction",
				eventIds: ["compact"],
				filePaths: [],
			},
		],
		events: [
			{ id: "prune", timestamp: 1000, kind: "prune", label: "Tool result pruned", detail: "PRIVATE EVENT BODY" },
			{ id: "inject", timestamp: 1500, kind: "inject", label: "Rules injected" },
			{ id: "compact", timestamp: 2000, kind: "compact", label: "Context compacted" },
		],
		files: [
			{
				path: "src/very/long/directory/nested/context-insights-private-file.ts",
				reads: 2,
				writes: 1,
				edits: 3,
				searches: 4,
				linesRead: 20,
				linesAdded: 7,
				linesRemoved: 5,
				bytesRead: 50,
				bytesWritten: 40,
				lastTimestamp: 2000,
			},
		],
	};
}
function view(
	data = timeline(),
	extra: { onRefresh?: () => ContextTimeline | undefined; breakdown?: ContextBreakdown } = {},
): ContextInsightsView {
	return new ContextInsightsView({ timeline: data, breakdown, theme, ...extra });
}
function output(v: ContextInsightsView, width = 120): string {
	return Bun.stripANSI(v.render(width).join("\n"));
}
function nodes(root: NativeNode): NativeNode[] {
	const result = [root];
	for (const child of root.c ?? [])
		if (child && typeof child === "object" && "k" in child) result.push(...nodes(child as NativeNode));
	return result;
}
beforeAll(() => {
	initTheme();
});

describe("ContextInsightsView", () => {
	it("opens Overview with the existing card, six KPIs, and bounded rows", () => {
		const v = view();
		expect(v.debugState().activeTab).toBe("overview");
		const text = output(v);
		for (const label of [
			"Overview",
			"Trend",
			"Events",
			"Files",
			"Current",
			"Peak",
			"Steps",
			"Compactions",
			"Injects",
			"current estimate",
		])
			expect(text).toContain(label);
		expect(text).toContain("+3");
		for (const line of v.render(120)) expect(visibleWidth(line)).toBeLessThanOrEqual(120);
	});
	it("cycles both directions with Tab/arrows and jumps with 1-4", () => {
		const v = view();
		for (const [key, tab] of [
			["\t", "trend"],
			["\x1b[C", "events"],
			["\x1b[Z", "trend"],
			["\x1b[D", "overview"],
			["\x1b[D", "files"],
			["1", "overview"],
			["2", "trend"],
			["3", "events"],
			["4", "files"],
		]) {
			expect(v.handleInput(key)).toBe(true);
			expect(v.debugState().activeTab).toBe(tab);
		}
		expect(v.handleInput("\x1b")).toBe(false);
	});
	it("toggles the Trend delta column only while Trend is active", () => {
		const v = view();
		const overview = output(v);
		expect(v.handleInput("d")).toBe(false);
		expect(v.debugState().deltaVisible).toBe(false);
		expect(output(v)).toBe(overview);
		v.handleInput("2");
		expect(output(v)).not.toContain("Δ");
		expect(v.handleInput("d")).toBe(true);
		expect(output(v)).toContain("Δ");
		expect(output(v)).toContain("-200");
		for (const key of ["1", "3", "4"]) {
			v.handleInput(key);
			expect(v.handleInput("d")).toBe(false);
			expect(v.debugState().deltaVisible).toBe(true);
		}
		v.handleInput("2");
		expect(v.handleInput("d")).toBe(true);
		expect(output(v)).not.toContain("Δ");
		expect(output(v)).toContain("⟦c⟧");
	});
	it("hides bars below 80 columns and wraps the footer even at very narrow widths", () => {
		const v = view();
		v.handleInput("2");
		expect(output(v, 120)).toContain("█");
		expect(output(v, 60)).not.toContain("█");
		for (const width of [1, 12, 40, 60])
			for (const key of ["1", "2", "3", "4"]) {
				v.handleInput(key);
				for (const line of v.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		expect(output(v, 60).replace(/\s+/g, " ")).toContain("Full view: omp stats");
	});
	it("labels legacy history as unavailable without manufacturing a bar", () => {
		const data = timeline();
		data.steps = [{ ...data.steps[0], composition: undefined }];
		data.legacySteps = 1;
		const v = view(data);
		expect(output(v)).toContain("History composition unavailable for 1 step(s)");
		v.handleInput("2");
		expect(output(v)).toContain("n/a");
		expect(output(v)).not.toContain("█");
	});
	it("renders clear empty states while retaining the current Overview", () => {
		const data = timeline();
		data.steps = [];
		data.events = [];
		data.files = [];
		const v = view(data);
		expect(output(v)).toContain("current estimate");
		for (const [key, label] of [
			["2", "steps"],
			["3", "events"],
			["4", "files"],
		]) {
			v.handleInput(key);
			expect(output(v)).toContain(`No ${label} yet.`);
		}
	});
	it("opens without a model and keeps history tabs usable", () => {
		const v = view(timeline(), { breakdown: { ...breakdown, contextWindow: 0 } });
		expect(output(v)).toContain("unavailable");
		v.handleInput("2");
		expect(output(v)).toContain("#3");
	});
	it("renders event markers, file counts, middle-truncated paths and omitted/incomplete notes", () => {
		const v = view();
		v.handleInput("3");
		const events = output(v);
		for (const value of ["~", "+", "↓", "+2 more"]) expect(events).toContain(value);
		v.handleInput("4");
		const files = output(v, 60);
		for (const value of ["R/W/E/S", "2/1/3/4", "+7", "-5", "…", "+4 more", "1 incomplete"])
			expect(files).toContain(value);
	});
	it("uses composition when browser detail budget is zero, not legacy fallback", () => {
		expect(TUI_CONTEXT_TIMELINE_LIMITS).toEqual({
			maxSteps: 200,
			maxEvents: 100,
			maxFiles: 50,
			maxBrowserEntries: 0,
			maxToolSchemas: 200,
			maxSkills: 200,
			maxSystemParts: 20,
		});
		const data = foldContextTimeline({
			sessionId: "budget",
			source: "live",
			limits: TUI_CONTEXT_TIMELINE_LIMITS,
			entries: [
				{
					type: "message",
					id: "a",
					message: {
						role: "assistant",
						timestamp: 1000,
						usage: { input: 1000, output: 1, cacheRead: 0, cacheWrite: 0 },
						contextSnapshot: {
							promptTokens: 1000,
							nonMessageTokens: 400,
							details: {
								contextWindow: 10000,
								categories: composition,
								messageCount: 2,
								pendingMessageTokens: 0,
								toolSchemas: [{ name: "read", tokens: 200 }],
							},
						},
					},
				},
			],
		});
		expect(data.legacySteps).toBe(0);
		expect(data.steps[0].details).toBeUndefined();
		const v = view(data);
		expect(output(v)).not.toContain("History composition unavailable");
		v.handleInput("2");
		expect(output(v)).toContain("█");
	});
	it("refreshes history in place and only advertises refresh when supported", () => {
		let calls = 0;
		const data = timeline();
		const fresh = timeline();
		fresh.steps.push({ ...fresh.steps[1], id: "c", index: 5, promptTokens: 12345 });
		const v = view(data, {
			onRefresh: () => {
				calls++;
				return fresh;
			},
		});
		v.handleInput("2");
		v.handleInput("d");
		expect(output(v)).toContain("r refresh");
		expect(v.handleInput("r")).toBe(true);
		expect(calls).toBe(1);
		expect(output(v)).toContain("#5");
		expect(v.debugState()).toEqual({ activeTab: "trend", deltaVisible: true });
		const staticView = view();
		expect(staticView.handleInput("r")).toBe(false);
		expect(output(staticView)).not.toContain("r refresh");
	});
	it("describes tabs and tables with text fallbacks and native select/activate", () => {
		const v = view();
		const first = v.describe(cx);
		expect(v.describe(cx)).toBe(first);
		expect(nodes(first).some(n => n.k === "tabs")).toBe(true);
		v.handleNativeEvent({ type: "select", key: "tabs", item: "trend" });
		expect(v.debugState().activeTab).toBe("trend");
		v.handleNativeEvent({ type: "activate", key: "tabs", item: "events" });
		expect(v.debugState().activeTab).toBe("events");
		for (const key of ["3", "4"]) {
			v.handleInput(key);
			expect(nodes(v.describe(cx)).some(n => n.k === "table")).toBe(true);
			expect(nodes(v.describe(plainCx)).some(n => n.k === "table")).toBe(false);
			for (const native of [cx, plainCx])
				expect(nodes(v.describe(native)).some(n => n.k === "chart" || n.k === "image")).toBe(false);
		}
		const table = nodes(v.describe(cx)).find(n => n.k === "table");
		expect(table?.k === "table" ? table.p?.cols[0].truncate : undefined).toBe("middle");
	});
	it("shows signed estimate overshoot warnings but never message/event bodies or model titles", () => {
		const v = view();
		for (const key of ["1", "2", "3", "4"]) {
			v.handleInput(key);
			expect(output(v)).not.toContain("PRIVATE EVENT BODY");
			expect(JSON.stringify(v.describe(cx))).not.toContain("PRIVATE EVENT BODY");
		}
		v.handleInput("2");
		expect(output(v)).toContain("estimate overshoot");
		expect(output(v)).toContain("-200");
		expect(output(v)).not.toContain("Context Usage");
	});
});
