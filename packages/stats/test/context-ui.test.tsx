import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getSessionContext } from "../src/client/api";
import { ContextRoute } from "../src/client/routes/ContextRoute";
import { ContextActivityGrid } from "../src/client/routes/context/ContextActivityGrid";
import { buildActivityCells } from "../src/client/routes/context/view-models";
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
		[
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		],
	] as const)
		installGlobal(name, value);
	const container = domWindow.document.getElementById("root");
	if (!container) throw new Error("Expected test root");
	root = createRoot(container as unknown as Element);
	return container as unknown as HTMLElement;
}

function makeOverview(range: ContextOverview["range"] = "24h"): ContextOverview {
	const now = Date.now();
	const cutoff = now - 24 * 60 * 60 * 1000;
	const bucket = Math.floor((now - 60 * 60 * 1000) / 3_600_000) * 3_600_000;
	return {
		range,
		cutoff,
		heatmapBucketMs: 3_600_000,
		kpi: {
			sessions: 2,
			requests: 3,
			avgPromptTokens: 120,
			peakPromptTokens: 240,
			totalTokens: 600,
			promptTokens: 360,
			inputTokens: 240,
			outputTokens: 60,
			cacheReadTokens: 100,
			cacheWriteTokens: 20,
			cacheRate: 100 / 340,
			costTotal: 0.12,
			unpricedRequests: 1,
		},
		heatmap: [
			{
				bucket,
				requests: 3,
				promptTokens: 360,
				outputTokens: 60,
				totalTokens: 600,
				costTotal: 0.12,
				unpricedRequests: 1,
			},
		],
		models: [
			{ model: "model-a", requests: 3, promptTokens: 360, totalTokens: 600, costTotal: 0.12, unpricedRequests: 1 },
		],
		sessions: [
			{
				file: `/tmp/context-${++sequence}.jsonl`,
				folder: "/tmp",
				title: "Context test",
				models: ["model-a"],
				startedAt: now - 2 * 60 * 60 * 1000,
				endedAt: now - 30 * 60 * 1000,
				requests: 2,
				totalTokens: 300,
				promptTokens: 200,
				peakPromptTokens: 180,
				avgPromptTokens: 100,
				inputTokens: 120,
				outputTokens: 30,
				cacheReadTokens: 50,
				cacheWriteTokens: 10,
				costTotal: 0.12,
				unpricedRequests: 1,
				sparkline: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 100],
			},
		],
		omittedSessions: 1,
		omittedRequests: 1,
		omittedPromptTokens: 10,
	};
}

const timeline: ContextTimeline = {
	schemaVersion: 1,
	sessionId: "s",
	file: "/tmp/detail.jsonl",
	cwd: "/tmp",
	source: "journal",
	steps: [
		{
			id: "a",
			index: 0,
			timestamp: 1_700_000_000_000,
			model: "model-a",
			promptTokens: 100,
			anchored: true,
			composition: { systemPrompt: 20, systemTools: 10, systemContext: 10, skills: 10, messages: 50 },
			compositionEstimated: true,
			details: {
				contextWindow: 1000,
				categories: { systemPrompt: 20, systemTools: 10, systemContext: 10, skills: 10, messages: 50 },
				toolSchemas: [{ name: "read", tokens: 10 }],
				skills: [{ name: "skill", tokens: 10 }],
				systemPromptParts: [20],
				messageCount: 2,
				pendingMessageTokens: 0,
			},
			unattributed: 0,
			contextWindow: 1000,
			deltaKind: "first",
			usage: { input: 20, output: 5, cacheRead: 10, cacheWrite: 5, total: 40, costTotal: 0.01 },
			eventIds: [],
			filePaths: ["src/a.ts"],
		},
		{
			id: "b",
			index: 1,
			timestamp: 1_700_000_001_000,
			model: "model-a",
			promptTokens: 120,
			anchored: true,
			composition: { systemPrompt: 20, systemTools: 10, systemContext: 10, skills: 10, messages: 70 },
			compositionEstimated: true,
			details: {
				contextWindow: 1000,
				categories: { systemPrompt: 20, systemTools: 10, systemContext: 10, skills: 10, messages: 70 },
				toolSchemas: [{ name: "write", tokens: 10 }],
				skills: [{ name: "skill", tokens: 10 }],
				systemPromptParts: [20],
				messageCount: 3,
				pendingMessageTokens: 0,
			},
			unattributed: 0,
			contextWindow: 1000,
			deltaTokens: 20,
			deltaKind: "grow",
			usage: { input: 20, output: 5, cacheRead: 10, cacheWrite: 5, total: 40, costTotal: 0.01 },
			eventIds: ["e"],
			filePaths: ["src/a.ts"],
		},
	],
	omittedSteps: 0,
	detailsOmittedSteps: 0,
	composition: { systemPrompt: 20, systemTools: 10, systemContext: 10, skills: 10, messages: 70 },
	contextWindow: 1000,
	peakTokens: 120,
	peakTokensTotal: 120,
	costTotal: 0.02,
	events: [{ id: "e", timestamp: 1_700_000_001_000, kind: "compact", label: "Compaction", stepIndex: 1 }],
	omittedEvents: 0,
	files: [
		{
			path: "src/a.ts",
			reads: 1,
			writes: 1,
			edits: 0,
			searches: 0,
			linesRead: 2,
			linesAdded: 1,
			linesRemoved: 0,
			bytesRead: 40,
			bytesWritten: 20,
			lastTimestamp: 1_700_000_001_000,
		},
	],
	omittedFiles: 0,
	incompleteFileCalls: 1,
	agents: [
		{
			trackId: "child",
			file: "/tmp/child.jsonl",
			label: "child",
			agent: "worker",
			model: "model-a",
			requests: 1,
			peakTokens: 50,
			lastTokens: 50,
			status: "subagent",
		},
	],
	legacySteps: 0,
	truncated: false,
};

function response(payload: unknown, headers?: HeadersInit): Response {
	return Response.json(payload, { headers });
}

async function renderRoute(
	file: string | null = null,
	range: "24h" | "all" = "24h",
	requests: string[] = [],
	detail: ContextTimeline = timeline,
) {
	const container = setupDom();
	const fetchStub = Object.assign(
		async (input: FetchInput, _init?: FetchInit) => {
			const url = input.toString();
			requests.push(url);
			if (url.includes("/api/context/overview")) return response(makeOverview(range === "all" ? "90d" : range));
			return response(detail, { ETag: '"v1"' });
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
	await act(async () => {
		root?.render(<ContextRoute active range={range} session={file} onOpenSession={() => {}} />);
	});
	await act(async () => {
		await Promise.resolve();
	});
	return container;
}

afterEach(async () => {
	if (root)
		await act(async () => {
			root?.unmount();
		});
	root = null;
	vi.restoreAllMocks();
	for (const [name, descriptor] of originalGlobals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	originalGlobals.clear();
});

describe("Context page", () => {
	it("renders KPI values, activity cells, session cards and omission text", async () => {
		const container = await renderRoute();
		for (const label of ["Sessions", "Requests", "Prompt tokens", "Cache rate", "Est. cost", "Peak prompt"])
			expect(container.textContent).toContain(label);
		expect(container.textContent).toContain("+1 sessions");
		expect(container.querySelectorAll(".context-activity-cell").length).toBeGreaterThan(1);
		expect(container.querySelectorAll(".context-session-card")).toHaveLength(1);
		expect(container.textContent).toContain("~$0.12");
	});



	it("re-establishes one tab stop when the activity range changes", async () => {
		const container = setupDom();
		const seven = makeOverview("7d");
		const thirty = {
			...makeOverview("30d"),
			cutoff: Date.now() - 30 * 24 * 60 * 60 * 1000,
			heatmapBucketMs: 24 * 60 * 60 * 1000,
			heatmap: [],
		};
		const render = async (overview: ContextOverview) => {
			await act(async () => {
				root?.render(
					<ContextActivityGrid
						overview={overview}
						cells={buildActivityCells(overview)}
						metric="requests"
						selectedKey={null}
						onSelect={() => {}}
					/>,
				);
			});
		};
		await render(seven);
		expect(container.querySelectorAll('.context-activity-cell').length).toBeGreaterThan(0);
		expect([...container.querySelectorAll('.context-activity-cell')].filter(cell => cell.getAttribute('tabindex') === '0')).toHaveLength(1);
		await render(thirty);
		expect(container.querySelectorAll('.context-activity-cell').length).toBeGreaterThan(0);
		expect([...container.querySelectorAll('.context-activity-cell')].filter(cell => cell.getAttribute('tabindex') === '0')).toHaveLength(1);
	});

	it("switches between session cards and the list without losing the rows", async () => {
		const container = await renderRoute();
		expect(container.querySelectorAll(".context-session-card")).toHaveLength(1);
		const list = [...container.querySelectorAll("button")].find(button => button.textContent === "List");
		if (!list) throw new Error("List toggle missing");
		await act(async () => {
			list.click();
		});
		expect(container.querySelectorAll(".context-session-card")).toHaveLength(0);
		expect(container.textContent).toContain("Context test");
		const cards = [...container.querySelectorAll("button")].find(button => button.textContent === "Cards");
		if (!cards) throw new Error("Cards toggle missing");
		await act(async () => {
			cards.click();
		});
		expect(container.querySelectorAll(".context-session-card")).toHaveLength(1);
	});

	it("renders the model mix donut legend and an accessible data table", async () => {
		const container = await renderRoute();
		expect(container.textContent).toContain("Model mix");
		expect(container.textContent).toContain("model-a");
		expect(container.textContent).toContain("Data table");
		const figure = container.querySelector("figure.context-usage-chart");
		expect(figure?.getAttribute("aria-label")).toContain("Prompt");
	});

	it("maps all to a bounded 90d request and labels it", async () => {
		const container = await renderRoute(null, "all");
		expect(container.textContent).toContain("90d");
		expect(container.textContent).not.toContain("range=all");
	});

	it("opens detail tabs and renders file activity and fleet", async () => {
		const container = await renderRoute("/tmp/detail.jsonl");
		for (const label of ["Composition", "Trend", "Browser", "Events", "Files", "Fleet"])
			expect(container.textContent).toContain(label);
		const trend = [...container.querySelectorAll("button")].find(button => button.textContent === "Trend");
		if (!trend) throw new Error("Trend tab missing");
		await act(async () => {
			trend.click();
		});
		expect(container.textContent).toContain("Trend");
		const files = [...container.querySelectorAll("button")].find(button => button.textContent === "Files");
		if (!files) throw new Error("Files tab missing");
		await act(async () => {
			files.click();
		});
		expect(container.textContent).toContain("src/a.ts");
		const fleet = [...container.querySelectorAll("button")].find(button => button.textContent === "Fleet");
		if (!fleet) throw new Error("Fleet tab missing");
		await act(async () => {
			fleet.click();
		});
		expect(container.textContent).toContain("child");
		expect(container.textContent).not.toContain("message body");
	});

	it("keeps the current bar on the latest step when an earlier step is selected", async () => {
		const container = await renderRoute("/tmp/detail.jsonl");
		expect(container.textContent).toContain("Current context");
		expect(container.textContent).toContain("Step #1 · latest");
		expect(container.querySelector('[data-testid="context-current-reserve"]')).toBeTruthy();
		const first = [...container.querySelectorAll("button")].find(button => button.textContent?.startsWith("#0"));
		if (!first) throw new Error("step selector missing");
		await act(async () => {
			first.click();
		});
		expect(container.textContent).toContain("Step #1 · latest");
	});

	it("does not substitute timeline composition for a legacy latest step", async () => {
		const file = `/tmp/legacy-${++sequence}.jsonl`;
		const legacy = {
			...timeline,
			file,
			steps: [{ ...timeline.steps[1]!, composition: undefined, compositionEstimated: undefined }],
			composition: timeline.composition,
		} as ContextTimeline;
		const container = await renderRoute(file, "24h", [], legacy);
		expect(container.textContent).toContain("Composition unavailable for this legacy step.");
		expect(container.querySelectorAll(".context-current-seg")).toHaveLength(0);
	});


	it("bounds current segments and reserve under estimate overshoot", async () => {
		const file = `/tmp/overshoot-${++sequence}.jsonl`;
		const step = {
			...timeline.steps[1]!,
			promptTokens: 80,
			contextWindow: 100,
			composition: { systemPrompt: 20, systemTools: 20, systemContext: 20, skills: 20, messages: 10 },
			unattributed: -10,
		};
		const container = await renderRoute(file, "24h", [], { ...timeline, file, steps: [step] });
		expect(container.textContent).toContain("estimate overshoot");
		const widths = [...container.querySelectorAll<HTMLElement>(".context-current-seg")].map(element =>
			Number.parseFloat(element.style.width),
		);
		expect(widths.reduce((sum, width) => sum + width, 0)).toBeLessThanOrEqual(100.01);
	});

	it("renders an empty zero-prompt track without NaN widths", async () => {
		const file = `/tmp/zero-${++sequence}.jsonl`;
		const step = {
			...timeline.steps[1]!,
			promptTokens: 0,
			contextWindow: 100,
			composition: { systemPrompt: 0, systemTools: 0, systemContext: 0, skills: 0, messages: 0 },
			unattributed: 0,
		};
		const container = await renderRoute(file, "24h", [], { ...timeline, file, steps: [step] });
		expect(container.textContent).toContain("No prompt tokens recorded");
		expect(container.querySelectorAll(".context-current-seg:not(.context-current-reserve)")).toHaveLength(0);
		expect(container.textContent).not.toContain("NaN");
	});

	it("renders token mix, turn stats and no latency claim", async () => {
		const container = await renderRoute("/tmp/detail.jsonl");
		expect(container.textContent).toContain("Token mix");
		expect(container.textContent).toContain("Turn stats");
		expect(container.textContent).toContain("Cache read");
		expect(container.textContent).not.toContain("TTFT");
		expect(container.textContent).not.toContain("latency");
	});

	it("routes a step event chip to Events with its kind active", async () => {
		const container = await renderRoute("/tmp/detail.jsonl");
		const trend = [...container.querySelectorAll("button")].find(button => button.textContent === "Trend");
		if (!trend) throw new Error("Trend tab missing");
		await act(async () => {
			trend.click();
		});
		const event = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Compaction"));
		if (!event) throw new Error("event chip missing");
		await act(async () => {
			event.click();
		});
		const events = [...container.querySelectorAll("button")].find(button => button.textContent === "Events");
		expect(events?.className).toContain("active");
	});

	it("shows only named browser details, never injected private content", async () => {
		const file = `/tmp/private-${++sequence}.jsonl`;
		const withSecret = {
			...timeline,
			file,
			steps: timeline.steps.map(step => ({
				...step,
				details: { ...step.details!, content: "SECRET_PROMPT_BODY", args: "SECRET_ARGS" },
			})),
		} as ContextTimeline;
		const container = await renderRoute(file, "24h", [], withSecret);
		const browser = [...container.querySelectorAll("button")].find(button => button.textContent === "Browser");
		if (!browser) throw new Error("Browser tab missing");
		await act(async () => {
			browser.click();
		});
		expect(container.textContent).toContain("Names and token counts only");
		expect(container.textContent).not.toContain("SECRET_PROMPT_BODY");
		expect(container.textContent).not.toContain("SECRET_ARGS");
	});

	it("drills into a fleet child by its actual filename", async () => {
		const requests: string[] = [];
		const container = await renderRoute("/tmp/detail.jsonl", "24h", requests);
		const fleet = [...container.querySelectorAll("button")].find(button => button.textContent === "Fleet");
		if (!fleet) throw new Error("Fleet tab missing");
		await act(async () => {
			fleet.click();
		});
		const row = container.querySelector("tbody tr");
		if (!row) throw new Error("fleet row missing");
		await act(async () => {
			(row as HTMLElement).click();
		});
		expect(requests.some(url => url.includes("file=%2Ftmp%2Fchild.jsonl"))).toBe(true);
		expect(container.textContent).toContain("Viewing subagent");
	});

	it("rejects unsupported timeline schemas before rendering fields", async () => {
		const file = `/tmp/schema-${++sequence}.jsonl`;
		const container = await renderRoute(file, "24h", [], { file, schemaVersion: 2 } as never);
		expect(container.textContent).toContain("Unsupported context timeline schemaVersion 2");
		expect(container.textContent).not.toContain("Prompt composition");
	});

	it("renders negative prompt deltas on a signed zero baseline", async () => {
		const file = `/tmp/delta-${++sequence}.jsonl`;
		const container = await renderRoute(file, "24h", [], {
			...timeline,
			file,
			steps: [{ ...timeline.steps[1]!, deltaTokens: -100 }],
		});
		const trend = [...container.querySelectorAll("button")].find(button => button.textContent === "Trend");
		if (!trend) throw new Error("Trend tab missing");
		await act(async () => {
			trend.click();
		});
		const deltaButton = [...container.querySelectorAll("button")].find(button => button.textContent === "Δ");
		if (!deltaButton) throw new Error("delta toggle missing");
		await act(async () => {
			deltaButton.click();
		});
		expect(container.textContent).toContain("-100");
		const negative = container.querySelector(".context-delta-fill.negative") as HTMLElement | null;
		expect(negative).toBeTruthy();
		expect(negative?.style.right).toBe("50%");
		expect(negative?.style.width).toBe("50%");
	});

	it("renders system-part details in the Browser tab", async () => {
		const container = await renderRoute("/tmp/detail.jsonl");
		const browser = [...container.querySelectorAll("button")].find(button => button.textContent === "Browser");
		if (!browser) throw new Error("Browser tab missing");
		await act(async () => {
			browser.click();
		});
		expect(container.textContent).toContain("System parts");
		expect(container.textContent).toContain("part 0");
		expect(container.textContent).toContain("20");
	});

	it("revalidates session context with ETag without parsing a 304 body", async () => {
		const payload = { ...timeline, file: `/tmp/etag-${++sequence}.jsonl` };
		const ifNoneMatch: (string | null)[] = [];
		const jsonSpy = vi.spyOn(Response.prototype, "json");
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				const tag = new Headers(init?.headers).get("If-None-Match");
				ifNoneMatch.push(tag);
				return tag === '"v1"' ? new Response(null, { status: 304 }) : response(payload, { ETag: '"v1"' });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		const first = await getSessionContext(payload.file!);
		const second = await getSessionContext(payload.file!, undefined, first);
		expect(ifNoneMatch).toEqual([null, '"v1"']);
		expect(jsonSpy).toHaveBeenCalledTimes(1);
		expect(second).toBe(first);
	});
});
