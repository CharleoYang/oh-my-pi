import type { Component, TUI } from "../tui";
import { getPaddingX, truncateToWidth } from "../utils";
import { type ProgressEstimate, ProgressEstimator, type ProgressPhase } from "./progress-estimator";

// ─── Braille dot constants ───────────────────────────────────────────────────
const BRAILLE_LEVELS = ["⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"] as const;
const BRAILLE_EMPTY = "⣀";
/** Right-column-full glyph used as the partial-cycle frontier marker. */
const BRAILLE_RIGHT_COLUMN_FULL = "⢸";
const BRAILLE_LEVELS_LEN = BRAILLE_LEVELS.length;

/** Completion/failure fill animation duration for settled bars. Long enough
 *  that the final fill to 100% reads as a visible glide, not a snap. */
const COMPLETE_FILL_MS = 600;
/** Repaint cadence while the bar is animating (spin / catch-up glide / fill). */
const FRAME_INTERVAL_MS = 50;

/**
 * One-dot-missing braille patterns whose missing dot orbits the cell — cycling
 * through these renders the filled portion of a running bar as a spinning disk.
 * The order is a clockwise orbit of the missing dot (dots 1→2→3→4→5→6→7→8).
 */
const SPIN_FRAMES = ["⣾", "⣽", "⣻", "⣷", "⣯", "⣟", "⢿", "⡿"] as const;
const SPIN_FRAME_MS = 50;

/** Per-task progress model fed to the component. Running tasks carry raw facts
 *  (`toolCount`) — the component's internal {@link ProgressEstimator} converts
 *  them into a monotonic, never-regressing displayed fill. */
export interface TaskProgress {
	id: string;
	label: string;
	/** 0.0 ~ 1.0. Only used directly for settled fallback; running rows are estimated. */
	progress: number;
	phase: "pending" | "running" | "done" | "failed" | "aborted";
	completedAtMs?: number;
	/** Optional dim suffix shown after the label (e.g. "3 tools · 2 reqs"). */
	meta?: string;
	/** Cumulative distinct tool starts — feeds the rate estimator. */
	toolCount?: number;
	/** Live activity snapshot shown under the bar so the user can see the
	 *  subagent is actually working: what it's running now and its last output. */
	activity?: {
		intent?: string;
		currentTool?: string;
		currentToolArgs?: string;
		/** Most-recent-first output lines from the subagent. */
		output?: string[];
	};
}

/** Color function for a styled text fragment. */
type ColorFn = (text: string) => string;

/** Theme-injected color functions. */
export interface BrailleColorSet {
	accent: ColorFn;
	muted: ColorFn;
	dim: ColorFn;
	success: ColorFn;
	danger: ColorFn;
	warning: ColorFn;
	text: ColorFn;
	bold: ColorFn;
	barFill: ColorFn;
	barTrack: ColorFn;
}

function phaseColor(phase: TaskProgress["phase"]): {
	glyph: string;
	color: "accent" | "dim" | "success" | "danger" | "warning";
} {
	switch (phase) {
		case "pending":
			return { glyph: "○", color: "dim" };
		case "running":
			return { glyph: "◐", color: "accent" };
		case "done":
			return { glyph: "✓", color: "success" };
		case "failed":
			return { glyph: "✗", color: "danger" };
		case "aborted":
			return { glyph: "▲", color: "warning" };
	}
}

/** TaskProgress phase → estimator phase. */
function estimatorPhase(phase: TaskProgress["phase"]): ProgressPhase {
	switch (phase) {
		case "running":
			return "running";
		case "done":
			return "completed";
		case "failed":
			return "failed";
		case "aborted":
			return "cancelled";
		default:
			return "pending";
	}
}

/** Braille level (0..7) → glyph. Level 0 maps to the empty glyph. */
function levelGlyph(level: number): string {
	if (level <= 0) return BRAILLE_EMPTY;
	return BRAILLE_LEVELS[Math.min(BRAILLE_LEVELS_LEN - 1, level) - 1];
}

/** Collapse all whitespace runs (newlines, tabs) to single spaces. */
function replaceWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Accumulated braille bar from a raw dot-tick count (0..width×7). Filled cells
 * render `filledColor`; empty cells render `emptyColor` (optionally per-cell).
 * When a full cycle is complete and a partial cycle is in progress, the
 * frontier cell renders `⢸` (right-column-full) as a distinct progress marker.
 */
function accumulatedBrailleBar(
	ticks: number,
	width: number,
	filledColor: ColorFn,
	emptyColorForCell: (cellIndex: number) => ColorFn,
): string {
	const dotsPerCell = BRAILLE_LEVELS_LEN;
	const cycleSize = width * dotsPerCell;
	const safeTicks = Math.max(0, Math.ceil(ticks));
	const completedCycles = Math.floor(safeTicks / cycleSize);
	const cycleTicks = safeTicks % cycleSize;
	const activeCells = cycleTicks === 0 ? 0 : Math.ceil(cycleTicks / dotsPerCell);
	const separatorIndex = completedCycles > 0 && activeCells > 0 && activeCells < width ? activeCells : -1;

	const cells: string[] = [];
	for (let i = 0; i < width; i++) {
		if (i === separatorIndex) {
			cells.push(filledColor(BRAILLE_RIGHT_COLUMN_FULL));
			continue;
		}
		const cellStart = i * dotsPerCell;
		const countThisCycle = Math.max(0, Math.min(dotsPerCell, cycleTicks - cellStart));
		const count = countThisCycle > 0 ? countThisCycle : completedCycles > 0 ? dotsPerCell : 0;
		cells.push(count === 0 ? emptyColorForCell(i)(BRAILLE_EMPTY) : filledColor(levelGlyph(count)));
	}
	return `[${cells.join("")}]`;
}

/** Settled fill animation: glide ticks → full bar over {@link COMPLETE_FILL_MS}. */
function completedDisplayTicks(ticks: number, width: number, phaseElapsedMs: number): number {
	const fullBarTicks = width * BRAILLE_LEVELS_LEN;
	if (ticks >= fullBarTicks) return fullBarTicks;
	const fillProgress = Math.max(0, Math.min(1, phaseElapsedMs / COMPLETE_FILL_MS));
	return Math.min(fullBarTicks, Math.ceil(ticks + (fullBarTicks - ticks) * fillProgress));
}

/**
 * Failed bar: achieved ticks render solid `danger`; the frontier that animates
 * to the full width over {@link COMPLETE_FILL_MS} renders `warning` (darker
 * placeholder); the untouched remainder renders `dim`.
 */
function failedBrailleBar(
	ticks: number,
	width: number,
	phaseElapsedMs: number,
	danger: ColorFn,
	warning: ColorFn,
	dim: ColorFn,
): string {
	const redCellCount = Math.ceil(completedDisplayTicks(ticks, width, phaseElapsedMs) / BRAILLE_LEVELS_LEN);
	return accumulatedBrailleBar(ticks, width, danger, cellIndex => (cellIndex < redCellCount ? warning : dim));
}

/**
 * Running-bar variant: filled cells render as a spinning disk — the whole
 * filled band cycles through {@link SPIN_FRAMES} so the missing dot orbits in
 * place (visually "spinning"), while the growing frontier cell still shows its
 * accumulating fill level and the untouched remainder stays dim. The fill edge
 * still advances with `ticks`; only the texture animates.
 */
function spinningFillBar(
	ticks: number,
	width: number,
	nowMs: number,
	filledColor: ColorFn,
	emptyColor: ColorFn,
): string {
	const dotsPerCell = BRAILLE_LEVELS_LEN;
	const cycleSize = width * dotsPerCell;
	const safeTicks = Math.max(0, Math.ceil(ticks));
	const completedCycles = Math.floor(safeTicks / cycleSize);
	const cycleTicks = safeTicks % cycleSize;
	const frame = Math.floor(nowMs / SPIN_FRAME_MS) % SPIN_FRAMES.length;

	const cells: string[] = [];
	for (let i = 0; i < width; i++) {
		const cellStart = i * dotsPerCell;
		const countThisCycle = Math.max(0, Math.min(dotsPerCell, cycleTicks - cellStart));
		const count = countThisCycle > 0 ? countThisCycle : completedCycles > 0 ? dotsPerCell : 0;
		if (count === 0) {
			cells.push(emptyColor(BRAILLE_EMPTY));
		} else if (count < dotsPerCell) {
			cells.push(filledColor(levelGlyph(count))); // growing frontier cell
		} else {
			cells.push(filledColor(SPIN_FRAMES[frame]!)); // spinning filled cell
		}
	}
	return `[${cells.join("")}]`;
}

/** Dispatch bar rendering by phase. `estimate` carries the display ticks. */
function renderBrailleBar(
	estimate: ProgressEstimate,
	phase: TaskProgress["phase"],
	width: number,
	nowMs: number,
	c: BrailleColorSet,
	phaseElapsedMs: number,
): string {
	const ticks = estimate.displayTicks;
	if (phase === "pending") return "";
	switch (phase) {
		case "done": {
			const displayTicks = completedDisplayTicks(ticks, width, phaseElapsedMs);
			return accumulatedBrailleBar(displayTicks, width, c.barFill, () => c.barTrack);
		}
		case "failed":
			return failedBrailleBar(ticks, width, phaseElapsedMs, c.danger, c.warning, c.barTrack);
		case "aborted":
			return accumulatedBrailleBar(ticks, width, c.warning, () => c.barTrack);
		default:
			return spinningFillBar(ticks, width, nowMs, c.barFill, c.barTrack);
	}
}

/**
 * BrailleProgressBar — a TUI component rendering braille-dot progress bars for
 * one or more tasks, with the kimi-code-style estimation and rendering:
 *
 * - A {@link ProgressEstimator} learns typical work from completed members and
 *   projects running progress from the observed tool-call rate, capping running
 *   fill at an unfinished ceiling and gliding the displayed ticks forward
 *   smoothly (never regressing, never fake percentages).
 * - Settled bars animate to 100% over 360ms; failed bars render achieved ticks
 *   in red with a dimmer placeholder frontier; the partial-cycle frontier is
 *   marked with `⢸`.
 *
 * Callers feed raw facts via {@link setTasks} — `toolCount` (cumulative tool
 * starts) and phase transitions — and inject theme-aware color functions so the
 * component stays independent of the coding-agent Theme class.
 *
 * ```ts
 * const bar = new BrailleProgressBar(ui, "Subagents", {
 *   accent:  (s) => theme.fg("accent", s),
 *   muted:   (s) => theme.fg("muted", s),
 *   dim:     (s) => theme.fg("dim", s),
 *   success: (s) => theme.fg("success", s),
 *   danger:  (s) => theme.fg("error", s),
 *   warning: (s) => theme.fg("warning", s),
 *   text:    (s) => theme.fg("text", s),
 *   bold:    (s) => theme.bold(s),
 *   barFill: (s) => theme.fg("accent", s),
 *   barTrack:(s) => theme.fg("dim", s),
 * }, tasks);
 * container.addChild(bar);
 * ```
 */
export class BrailleProgressBar implements Component {
	#ui: TUI | undefined;
	#tasks: TaskProgress[] = [];
	#label: string;
	#color: BrailleColorSet;
	#nowMs = Date.now();
	#timer: ReturnType<typeof setTimeout> | undefined;
	#paddingX = 1;
	#customBgFn?: (text: string) => string;

	/** Rate-based completion estimator, fed incrementally by {@link setTasks}.
	 *  `catchupTimeMs` is tuned snappier than the kimi-code default so the fill
	 *  edge advances briskly between tool events. */
	#estimator = new ProgressEstimator({ catchupTimeMs: 900 });
	#lastPhase = new Map<string, TaskProgress["phase"]>();
	#lastToolCount = new Map<string, number>();

	constructor(ui: TUI | undefined, label: string, color: BrailleColorSet, tasks?: TaskProgress[]) {
		this.#ui = ui;
		this.#label = label;
		this.#color = color;
		if (tasks) this.setTasks(tasks);
	}

	/** Replace the task list. Feeds the estimator with phase transitions and new
	 *  tool counts, then repaints. Idempotent for unchanged tasks. */
	setTasks(tasks: TaskProgress[]): void {
		if (tasksEqual(this.#tasks, tasks)) return;
		this.#nowMs = Date.now();
		this.#feedEstimator(tasks);
		this.#tasks = tasks;
		this.#syncAnimation();
		this.#requestPaint();
	}

	setCustomBgFn(fn: (text: string) => string): void {
		this.#customBgFn = fn;
	}

	#feedEstimator(tasks: TaskProgress[]): void {
		const now = this.#nowMs;
		for (const task of tasks) {
			const id = task.id;
			const prevPhase = this.#lastPhase.get(id);

			// Record newly observed tool calls first (dedup via estimator).
			const toolCount = task.toolCount ?? 0;
			const recorded = this.#lastToolCount.get(id) ?? 0;
			for (let i = recorded + 1; i <= toolCount; i++) {
				this.#estimator.recordToolCall({ memberKey: id, toolCallId: `${id}:tool:${i}`, nowMs: now });
			}
			this.#lastToolCount.set(id, Math.max(recorded, toolCount));

			// Phase transitions (idempotent).
			if (prevPhase !== task.phase) {
				switch (task.phase) {
					case "running":
						this.#estimator.markStarted(id, now);
						break;
					case "done":
						this.#estimator.markCompleted(id, now);
						break;
					case "failed":
						this.#estimator.markFailed(id, now);
						break;
					case "aborted":
						this.#estimator.markCancelled(id, now);
						break;
				}
				this.#lastPhase.set(id, task.phase);
			}
		}
	}

	/** True while any task needs repainting: pending catch-up, a running row, or
	 *  a settled row whose 360ms fill animation hasn't finished. */
	#isAnimating(): boolean {
		const now = this.#nowMs;
		if (this.#estimator.hasPendingCatchup()) return true;
		return this.#tasks.some(
			t =>
				t.phase === "running" ||
				((t.phase === "done" || t.phase === "failed") &&
					t.completedAtMs !== undefined &&
					now - t.completedAtMs < COMPLETE_FILL_MS),
		);
	}

	#syncAnimation(): void {
		if (this.#isAnimating() && this.#timer === undefined) {
			this.#nowMs = Date.now();
			const tick = () => {
				if (this.#timer === undefined) return;
				this.#nowMs = Date.now();
				this.#requestPaint();
				if (!this.#isAnimating()) {
					this.#stopAnimation();
					return;
				}
				this.#timer = setTimeout(tick, FRAME_INTERVAL_MS);
			};
			this.#timer = setTimeout(tick, FRAME_INTERVAL_MS);
		} else if (!this.#isAnimating() && this.#timer !== undefined) {
			this.#stopAnimation();
		}
	}

	#stopAnimation(): void {
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}

	/** Lifecycle teardown: stop the animation timer. Idempotent. */
	dispose(): void {
		this.#stopAnimation();
	}

	#requestPaint(): void {
		const ui = this.#ui;
		if (!ui) return;
		// Loader-style direct write when safe; fall back to a component render.
		if (typeof ui.requestDirectWrite === "function") {
			ui.requestDirectWrite(this);
		} else {
			ui.requestComponentRender(this);
		}
	}

	render(width: number): readonly string[] {
		this.#nowMs = Date.now();
		const paddingX = getPaddingX(this.#paddingX);
		const pad = " ".repeat(paddingX);
		const lines: string[] = [];
		const c = this.#color;
		const now = this.#nowMs;

		// Header — accent bold
		lines.push(`${pad}${c.accent(c.bold(`${c.muted("▸")} ${this.#label}`))}`);

		if (this.#tasks.length === 0) {
			lines.push(`${pad}  ${c.dim("no tasks")}`);
			return lines;
		}

		const avail = Math.max(20, width - paddingX * 2 - 2);
		const count = this.#tasks.length;
		const idW = Math.max(3, String(count).length);
		const perTask = idW + 2 + 20 + 2 + 4 + 2 + 24;
		const cols = Math.max(1, Math.min(count, Math.floor(avail / perTask)));
		const cellW = Math.floor(avail / Math.max(1, cols));
		const bCells = Math.max(8, Math.min(20, cellW - idW - 34));
		const capacityTicks = bCells * BRAILLE_LEVELS_LEN;

		for (const task of this.#tasks) {
			const { glyph, color } = phaseColor(task.phase);
			const estimate = this.#estimator.estimate({
				memberKey: task.id,
				phase: estimatorPhase(task.phase),
				capacityTicks,
				nowMs: now,
			});
			const phaseElapsedMs = task.completedAtMs !== undefined ? Math.max(0, now - task.completedAtMs) : 0;
			const bar = renderBrailleBar(estimate, task.phase, bCells, now, c, phaseElapsedMs);
			const meta = task.meta ? ` ${c.dim(task.meta)}` : "";
			const line = `${pad}  ${c[color](glyph)} ${bar} ${c.text(task.label)}${meta}`;
			lines.push(line);

			// Live activity under a running bar — the current tool plus the last
			// few output lines, so it reads as working rather than hung.
			if (task.phase === "running" && task.activity) {
				const activityBudget = Math.max(16, avail - 4);
				const indent = `${pad}  `;
				const a = task.activity;
				const current =
					a.currentTool !== undefined && a.currentTool !== ""
						? `${a.currentTool}${a.currentToolArgs ? ` ${replaceWhitespace(a.currentToolArgs)}` : ""}`
						: a.intent;
				if (current) {
					lines.push(
						`${indent}  ${c.barTrack("·")} ${c.muted(truncateToWidth(replaceWhitespace(current), activityBudget))}`,
					);
				}
				for (const out of (a.output ?? []).slice(0, 3)) {
					if (!out) continue;
					lines.push(
						`${indent}  ${c.barTrack("·")} ${c.barTrack(truncateToWidth(replaceWhitespace(out), activityBudget))}`,
					);
				}
			}
		}

		return this.#customBgFn ? lines.map(l => this.#customBgFn!(l)) : lines;
	}
}

/** Cheap structural equality — skips redundant repaints when nothing changed. */
function tasksEqual(a: TaskProgress[], b: TaskProgress[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i]!;
		const y = b[i]!;
		if (
			x.id !== y.id ||
			x.phase !== y.phase ||
			x.progress !== y.progress ||
			x.meta !== y.meta ||
			x.toolCount !== y.toolCount ||
			x.completedAtMs !== y.completedAtMs ||
			x.activity?.currentTool !== y.activity?.currentTool ||
			x.activity?.intent !== y.activity?.intent ||
			x.activity?.output?.[0] !== y.activity?.output?.[0] ||
			x.activity?.output?.[1] !== y.activity?.output?.[1] ||
			x.activity?.output?.[2] !== y.activity?.output?.[2]
		) {
			return false;
		}
	}
	return true;
}
