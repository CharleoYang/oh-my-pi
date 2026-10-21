import {
	DEFAULT_CONTEXT_LIMITS,
	type ContextCategoryId,
	type ContextStep,
	type ContextTimeline,
	type ContextTimelineLimits,
} from "@oh-my-pi/pi-ai";
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { MetricRow } from "../components/metric";
import { TabBar } from "../components/tab-bar";
import { matchesKey } from "../keys";
import { col, keyed, node, span, text } from "../native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { truncateMiddleToWidth } from "../render/render-utils";
import type { Theme, ThemeColor } from "../theme";
import { Container, type Component } from "../tui";
import { getWidthConfigEpoch, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils";
import { ContextUsageView, type ContextBreakdown } from "./context-usage";

export const TUI_CONTEXT_TIMELINE_LIMITS: Readonly<ContextTimelineLimits> = {
	...DEFAULT_CONTEXT_LIMITS,
	maxSteps: 200,
	maxEvents: 100,
	maxFiles: 50,
	maxBrowserEntries: 0,
};

export interface ContextInsightsViewOptions {
	timeline: ContextTimeline;
	breakdown: ContextBreakdown;
	theme: Theme;
	/** Re-read history without changing the active tab or the report host's scroll offset. */
	onRefresh?: () => ContextTimeline | undefined;
}

const CATEGORY_COLORS: Record<ContextCategoryId, ThemeColor> = {
	systemPrompt: "accent",
	systemTools: "warning",
	systemContext: "customMessageLabel",
	skills: "success",
	messages: "userMessageText",
};
const CATEGORY_IDS = Object.keys(CATEGORY_COLORS) as ContextCategoryId[];
const EVENT_MARKERS = { prune: "~", inject: "+", compact: "↓", switch: "", mode: "", reset: "", branch: "" };
const JUMP_KEYS = ["1", "2", "3", "4"] as const;

/** A fixed 24-cell bar; reserve a cell for every nonzero category, then apportion the rest. */
function compositionBar(step: ContextStep, breakdown: ContextBreakdown): TspSpan[] {
	if (!step.composition) return [span("n/a", "muted")];
	const entries = CATEGORY_IDS.filter(id => step.composition![id] > 0);
	const total = entries.reduce((sum, id) => sum + step.composition![id], 0);
	if (total === 0) return [span("—", "dim")];
	const remaining = 24 - entries.length;
	const sizes = entries.map(id => 1 + Math.floor((step.composition![id] / total) * remaining));
	let left = 24 - sizes.reduce((sum, size) => sum + size, 0);
	// Largest remainders keep rounding deterministic without changing category totals.
	const order = entries
		.map((id, index) => ({ index, fraction: ((step.composition![id] / total) * remaining) % 1 }))
		.sort((a, b) => b.fraction - a.fraction);
	for (const entry of order) {
		if (left-- <= 0) break;
		sizes[entry.index]++;
	}
	return entries.map((id, index) =>
		span(
			"█".repeat(sizes[index]!),
			breakdown.categories.find(category => category.id === id)?.color ?? CATEGORY_COLORS[id],
		),
	);
}

/**
 * Four bounded context views, without a frame. render(width) has no viewport
 * height: the active tab is rendered in full and ReportPanel owns scrolling
 * (including preserving/clamping its offset on refresh), not a per-tab ScrollView.
 * Native UI exposes select/activate, but no hover event.
 */
export class ContextInsightsView extends Container {
	#timeline: ContextTimeline;
	readonly #breakdown: ContextBreakdown;
	readonly #theme: Theme;
	readonly #onRefresh: ContextInsightsViewOptions["onRefresh"];
	readonly #tabs: TabBar;
	readonly #overview: ContextUsageView;
	readonly #metrics: MetricRow;
	#deltaVisible = false;
	#renderMemo: { width: number; epoch: number; lines: readonly string[] } | undefined;
	#nativeMemo:
		| { cols: number; table: boolean; meter: boolean; hour12: boolean | undefined; node: NativeNode }
		| undefined;

	constructor(options: ContextInsightsViewOptions) {
		super();
		this.#timeline = options.timeline;
		this.#breakdown = options.breakdown;
		this.#theme = options.theme;
		this.#onRefresh = options.onRefresh;
		const theme = options.theme;
		this.#tabs = new TabBar(
			"",
			[
				{ id: "overview", label: "Overview", short: "Ov" },
				{ id: "trend", label: "Trend", short: "Tr" },
				{ id: "events", label: "Events", short: "Ev" },
				{ id: "files", label: "Files", short: "Fi" },
			],
			{
				label: value => theme.fg("muted", value),
				activeTab: value => theme.bold(theme.fg("accent", value)),
				inactiveTab: value => theme.fg("muted", value),
				hint: value => theme.fg("dim", value),
			},
		);
		this.#tabs.showHint = false;
		this.#tabs.onTabChange = () => this.invalidate();
		this.#overview = new ContextUsageView(options.breakdown, theme);
		this.#metrics = new MetricRow([], { separator: "  ·  ", overflow: "wrap" });
		this.#updateMetrics();
	}

	#updateMetrics(): void {
		const timeline = this.#timeline;
		this.#metrics.setMetrics([
			{ leading: "Current", value: formatNumber(this.#breakdown.usedTokens) },
			{ leading: "Peak", value: formatNumber(timeline.peakTokens) },
			{
				leading: "Steps",
				value: `${timeline.steps.length}${timeline.omittedSteps ? ` (+${timeline.omittedSteps} omitted)` : ""}`,
			},
			{ leading: "Compactions", value: String(timeline.events.filter(event => event.kind === "compact").length) },
			{ leading: "Injects", value: String(timeline.events.filter(event => event.kind === "inject").length) },
			{
				leading: "Files",
				value: `${timeline.files.length}${timeline.omittedFiles ? ` (+${timeline.omittedFiles} omitted)` : ""}`,
			},
		]);
	}

	debugState(): { activeTab: string; deltaVisible: boolean } {
		return { activeTab: this.#tabs.getActiveTab().id, deltaVisible: this.#deltaVisible };
	}

	handleInput(data: string): boolean {
		for (let index = 0; index < JUMP_KEYS.length; index++) {
			if (!matchesKey(data, JUMP_KEYS[index]!)) continue;
			this.#tabs.setActiveIndex(index);
			return true;
		}
		if (matchesKey(data, "d")) {
			this.#deltaVisible = !this.#deltaVisible;
			this.invalidate();
			return true;
		}
		if (matchesKey(data, "r")) {
			if (!this.#onRefresh) return false;
			const timeline = this.#onRefresh();
			if (timeline) {
				this.#timeline = timeline;
				this.#updateMetrics();
				this.invalidate();
			}
			return true;
		}
		return this.#tabs.handleInput(data);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "select" || event.type === "activate") this.#tabs.handleNativeEvent(event);
	}

	#footer(): string {
		return `Tab/←→ pages · 1-4 jump · d delta · ↑↓ scroll${this.#onRefresh ? " · r refresh" : ""} · Full view: omp stats`;
	}

	#overviewNotes(): string[] {
		const notes = ["current estimate"];
		if (this.#timeline.legacySteps)
			notes.push(`History composition unavailable for ${this.#timeline.legacySteps} step(s)`);
		return notes;
	}

	#trendRows(width: number, hour12?: boolean): TspSpan[][] {
		const rows: TspSpan[][] = [];
		for (const step of this.#timeline.steps.slice(-20)) {
			const marker =
				step.deltaKind === "reset"
					? "⟦r⟧ "
					: step.deltaKind === "compaction"
						? "⟦c⟧ "
						: step.deltaKind === "model-switch"
							? "⟦m⟧ "
							: "";
			const delta =
				step.deltaKind === "first" || step.deltaTokens === undefined
					? "—"
					: `${step.deltaTokens > 0 ? "+" : ""}${step.deltaTokens}`;
			const time = new Date(step.timestamp).toLocaleTimeString(undefined, {
				hour: "2-digit",
				minute: "2-digit",
				hour12: hour12 ?? false,
			});
			const parts = [
				span(
					`${marker}#${step.index} ${time} ${formatNumber(step.promptTokens)}${this.#deltaVisible ? ` Δ ${delta}` : ""} `,
				),
			];
			if (!step.composition) parts.push(span("n/a", "muted"));
			else if (width >= 80) parts.push(...compositionBar(step, this.#breakdown));
			if (step.compositionEstimated) parts.push(span(" estimated", "dim"));
			if (step.unattributed !== undefined && step.unattributed < 0)
				parts.push(span(` ⚠ estimate overshoot (${step.unattributed})`, "warning"));
			rows.push(parts);
		}
		return rows;
	}

	#listNotes(tab: string): string[] {
		const t = this.#timeline;
		const omitted =
			tab === "trend"
				? t.omittedSteps + Math.max(0, t.steps.length - 20)
				: tab === "events"
					? t.omittedEvents + Math.max(0, t.events.length - 20)
					: t.omittedFiles + Math.max(0, t.files.length - 20);
		const notes = omitted ? [`+${omitted} more ${tab === "trend" ? "steps" : tab} not shown`] : [];
		if (tab === "files" && t.incompleteFileCalls) notes.push(`${t.incompleteFileCalls} incomplete file call(s)`);
		return notes;
	}

	#tableData(
		tab: "events" | "files",
		hour12?: boolean,
	): { headers: string[]; rows: { id: string; values: string[] }[] } {
		if (tab === "events")
			return {
				headers: ["time", "kind", "label"],
				rows: this.#timeline.events.slice(-20).map(event => ({
					id: event.id,
					values: [
						new Date(event.timestamp).toLocaleTimeString(undefined, {
							hour: "2-digit",
							minute: "2-digit",
							hour12: hour12 ?? false,
						}),
						`${EVENT_MARKERS[event.kind]}${event.kind}`,
						event.label,
					],
				})),
			};
		return {
			headers: ["path", "R/W/E/S", "+lines", "-lines"],
			rows: this.#timeline.files.slice(0, 20).map(file => ({
				id: file.path,
				values: [
					file.path,
					`${file.reads}/${file.writes}/${file.edits}/${file.searches}`,
					`+${file.linesAdded}`,
					`-${file.linesRemoved}`,
				],
			})),
		};
	}

	override render(width: number): readonly string[] {
		width = Math.max(1, Math.floor(width));
		const epoch = getWidthConfigEpoch();
		if (this.#renderMemo?.width === width && this.#renderMemo.epoch === epoch) return this.#renderMemo.lines;
		const tab = this.#tabs.getActiveTab().id;
		const lines = [...this.#tabs.render(width), ""];
		if (tab === "overview") {
			lines.push(
				...this.#overview.render(width),
				"",
				...this.#metrics.render(width),
				...this.#overviewNotes().map(note => this.#theme.fg("muted", note)),
			);
		} else if (tab === "trend") {
			lines.push(
				...this.#trendRows(width).map(parts =>
					parts.map(part => (part.s ? this.#theme.fg(part.s as ThemeColor, part.t) : part.t)).join(""),
				),
			);
			if (!this.#timeline.steps.length) lines.push(this.#theme.fg("muted", "No steps yet."));
			lines.push(...this.#listNotes(tab));
		} else {
			const table = this.#tableData(tab as "events" | "files");
			if (!table.rows.length) lines.push(this.#theme.fg("muted", `No ${tab} yet.`));
			else {
				lines.push(table.headers.join("  "));
				for (const entry of table.rows) {
					if (tab === "files") {
						const suffix = `  ${entry.values.slice(1).join("  ")}`;
						lines.push(
							truncateMiddleToWidth(entry.values[0]!, Math.max(1, width - visibleWidth(suffix))) + suffix,
						);
					} else lines.push(entry.values.join("  "));
				}
			}
			lines.push(...this.#listNotes(tab));
		}
		lines.push("", this.#theme.fg("dim", this.#footer()));
		const wrapped = lines.flatMap(line => wrapTextWithAnsi(line, width)).map(line => truncateToWidth(line, width));
		this.#renderMemo = { width, epoch, lines: wrapped };
		return wrapped;
	}

	override describe(cx: DescribeContext): NativeNode {
		const table = cx.supports("table");
		const meter = cx.supports("meter");
		const memo = this.#nativeMemo;
		if (memo && memo.cols === cx.cols && memo.table === table && memo.meter === meter && memo.hour12 === cx.hour12)
			return memo.node;
		const tab = this.#tabs.getActiveTab().id;
		let body: NativeNode;
		if (tab === "overview") {
			body = col(
				[
					this.#overview.describe(cx),
					this.#metrics.describe(cx),
					...this.#overviewNotes().map(note => text(note, { tone: "muted" })),
				],
				{ gap: "sm" },
			);
		} else if (tab === "trend") {
			const rows = this.#trendRows(cx.cols, cx.hour12);
			body = col([
				...rows.map(parts => text(parts, { wrap: "word" })),
				...(!rows.length ? [text("No steps yet.", { tone: "muted" })] : []),
				...this.#listNotes(tab).map(note => text(note, { tone: "muted" })),
			]);
		} else {
			const data = this.#tableData(tab as "events" | "files", cx.hour12);
			const contents = !data.rows.length
				? text(`No ${tab} yet.`, { tone: "muted" })
				: table
					? node("table", {
							cols: data.headers.map((head, index) => ({
								id: String(index),
								head,
								align: tab === "files" && index > 0 ? "end" : "start",
								truncate: tab === "files" && index === 0 ? "middle" : "end",
							})),
							rows: data.rows.map(entry => ({
								id: entry.id,
								cells: Object.fromEntries(entry.values.map((value, index) => [String(index), value])),
							})),
						})
					: col([
							text(data.headers.join("  ")),
							...data.rows.map(entry => {
								const suffix = `  ${entry.values.slice(1).join("  ")}`;
								const line =
									tab === "files"
										? truncateMiddleToWidth(entry.values[0]!, Math.max(1, cx.cols - visibleWidth(suffix))) +
											suffix
										: entry.values.join("  ");
								return text(line, { wrap: "word" });
							}),
						]);
			body = col([contents, ...this.#listNotes(tab).map(note => text(note, { tone: "muted" }))]);
		}
		const root = col(
			[
				keyed(this.#tabs.describe(cx), "tabs"),
				keyed(body, tab),
				text(this.#footer(), { wrap: "word", role: "omp.context.footer" }),
			],
			{ gap: "sm", role: "omp.context.insights" },
		);
		this.#nativeMemo = { cols: cx.cols, table, meter, hour12: cx.hour12, node: root };
		return root;
	}

	override invalidate(): void {
		this.#renderMemo = undefined;
		this.#nativeMemo = undefined;
		this.#tabs.invalidate();
		this.#overview.invalidate();
		this.#metrics.invalidate();
		super.invalidate();
	}

	override releaseRenderCaches(): void {
		this.#renderMemo = undefined;
		this.#nativeMemo = undefined;
		this.#overview.releaseRenderCaches();
		super.releaseRenderCaches();
	}

	override dispose(): void {
		this.#tabs.onTabChange = undefined;
		for (const component of [this.#tabs, this.#overview, this.#metrics] as Component[]) component.dispose?.();
		this.releaseRenderCaches();
		super.dispose();
	}
}
