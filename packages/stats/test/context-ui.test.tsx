import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContextRoute } from "../src/client/routes/ContextRoute";
import type { ContextOverview, ContextTimeline } from "../src/client/types";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let root: Root | null = null;
let sequence = 0;

function installGlobal(name: string, value: unknown): void {
	originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
}

function setupDom(): HTMLElement {
	const domWindow = parseHTML('<html><body><div id="root"></div></body></html>').window;
	for (const [name, value] of [
		["window", domWindow],
		["document", domWindow.document],
		["navigator", domWindow.navigator],
		["Node", domWindow.Node],
		["Element", domWindow.Element],
		["HTMLElement", domWindow.HTMLElement],
		["HTMLIFrameElement", domWindow.HTMLIFrameElement],
		["SVGElement", domWindow.SVGElement],
		["IS_REACT_ACT_ENVIRONMENT", true],
		["ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }],
	] as const) installGlobal(name, value);
	const container = domWindow.document.getElementById("root");
	if (!container) throw new Error("Expected test root");
	root = createRoot(container as unknown as Element);
	return container as unknown as HTMLElement;
}

function makeOverview(range: ContextOverview["range"] = "24h"): ContextOverview {
	return {
		range,
		cutoff: 1_700_000_000_000,
		heatmapBucketMs: 3_600_000,
		kpi: { sessions: 2, requests: 3, avgPromptTokens: 120, peakPromptTokens: 240, totalTokens: 600 },
		heatmap: [{ bucket: 1_700_000_000_000, requests: 2, promptTokens: 240 }],
		sessions: [
			{
				file: `/tmp/context-${++sequence}.jsonl`, folder: "/tmp", title: "Context test", models: ["model-a"],
				startedAt: 1_700_000_000_000, endedAt: 1_700_000_010_000, requests: 2, totalTokens: 300,
				promptTokens: 200, peakPromptTokens: 180, avgPromptTokens: 100,
			},
		],
		omittedSessions: 1,
		omittedRequests: 4,
		omittedPromptTokens: 10,
	};
}

const timeline: ContextTimeline = {
	schemaVersion: 1, sessionId: "s", file: "/tmp/detail.jsonl", cwd: "/tmp", source: "journal",
	steps: [
		{ id: "a", index: 0, timestamp: 1_700_000_000_000, model: "model-a", promptTokens: 100, anchored: true,
			composition: { systemPrompt: 20, systemTools: 10, systemContext: 10, skills: 10, messages: 50 },
			compositionEstimated: true, details: { contextWindow: 1000, categories: { systemPrompt: 20, systemTools: 10, systemContext: 10, skills: 10, messages: 50 }, toolSchemas: [{ name: "read", tokens: 10 }], skills: [{ name: "skill", tokens: 10 }], systemPromptParts: [20], messageCount: 2, pendingMessageTokens: 0 },
			unattributed: 0, contextWindow: 1000, deltaKind: "first", eventIds: [], filePaths: ["src/a.ts"],
		},
		{ id: "b", index: 1, timestamp: 1_700_000_001_000, model: "model-a", promptTokens: 120, anchored: true,
			composition: { systemPrompt: 20, systemTools: 10, systemContext: 10, skills: 10, messages: 70 },
			compositionEstimated: true, details: { contextWindow: 1000, categories: { systemPrompt: 20, systemTools: 10, systemContext: 10, skills: 10, messages: 70 }, toolSchemas: [{ name: "write", tokens: 10 }], skills: [{ name: "skill", tokens: 10 }], systemPromptParts: [20], messageCount: 3, pendingMessageTokens: 0 },
			unattributed: 0, contextWindow: 1000, deltaTokens: 20, deltaKind: "grow", eventIds: ["e"], filePaths: ["src/a.ts"],
		},
	],
	omittedSteps: 0, detailsOmittedSteps: 0, composition: { systemPrompt: 20, systemTools: 10, systemContext: 10, skills: 10, messages: 70 }, contextWindow: 1000,
	peakTokens: 120, events: [{ id: "e", timestamp: 1_700_000_001_000, kind: "compact", label: "Compaction", stepIndex: 1 }], omittedEvents: 0,
	files: [{ path: "src/a.ts", reads: 1, writes: 1, edits: 0, searches: 0, linesRead: 2, linesAdded: 1, linesRemoved: 0, bytesRead: 40, bytesWritten: 20, lastTimestamp: 1_700_000_001_000 }], omittedFiles: 0, incompleteFileCalls: 1,
	agents: [{ trackId: "child", label: "child", agent: "worker", model: "model-a", requests: 1, peakTokens: 50, lastTokens: 50, status: "subagent" }], legacySteps: 0, truncated: false,
};

function response(payload: unknown, headers?: HeadersInit): Response {
	return Response.json(payload, { headers });
}

async function renderRoute(file: string | null = null, range: "24h" | "all" = "24h") {
	const container = setupDom();
	const fetchStub = Object.assign(async (input: FetchInput, _init?: FetchInit) => {
		const url = input.toString();
		if (url.includes("/api/context/overview")) return response(makeOverview(range === "all" ? "90d" : range));
		return response(timeline, { ETag: '"v1"' });
	}, { preconnect: globalThis.fetch.preconnect });
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
	await act(async () => { root?.render(<ContextRoute active range={range} session={file} onOpenSession={() => {}} />); });
	await act(async () => { await Promise.resolve(); });
	return container;
}

afterEach(async () => {
	if (root) await act(async () => { root?.unmount(); });
	root = null;
	vi.restoreAllMocks();
	for (const [name, descriptor] of originalGlobals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	originalGlobals.clear();
});

describe("Context page", () => {
	it("renders KPI values, densified heatmap and omission text", async () => {
		const container = await renderRoute();
		expect(container.textContent).toContain("Sessions");
		expect(container.textContent).toContain("2");
		expect(container.textContent).toContain("+1 sessions");
		expect(container.querySelectorAll(".context-heatmap-cell").length).toBeGreaterThan(1);
	});

	it("maps all to a bounded 90d request and labels it", async () => {
		const container = await renderRoute(null, "all");
		expect(container.textContent).toContain("90d");
		expect(container.textContent).not.toContain("range=all");
	});

	it("opens the six-tab detail and shares selected step", async () => {
		const container = await renderRoute("/tmp/detail.jsonl");
		for (const label of ["Composition", "Trend", "Browser", "Events", "Files", "Fleet"]) expect(container.textContent).toContain(label);
		const trend = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Trend"));
		trend?.dispatchEvent(new Event("click", { bubbles: true }));
		await act(async () => {});
		expect(container.textContent).toContain("Composition");
	});

	it("renders file activity and fleet controls without message bodies", async () => {
		const container = await renderRoute("/tmp/detail.jsonl");
		expect(container.textContent).toContain("src/a.ts");
		expect(container.textContent).toContain("Viewing subagent");
		expect(container.textContent).not.toContain("message body");
	});
});
