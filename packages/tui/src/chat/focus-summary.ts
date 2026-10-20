import { Text } from "../components/text";
import type { Component } from "../tui";
import { node, span, text } from "../native/describe";
import type { NativeNode, NativeUiEvent } from "../native/node";
import { theme } from "../theme";

/** Hidden work a focus-mode turn folded away. */
export interface FocusActivityCounts {
	tools: number;
	subagents: number;
}

/** `✻ 3 tools · 1 subagent` — the compact stand-in shown under a focus-mode turn. */
export function formatFocusSummary({ tools, subagents }: FocusActivityCounts): string {
	const parts = [`${tools} tool${tools === 1 ? "" : "s"}`];
	if (subagents > 0) parts.push(`${subagents} subagent${subagents === 1 ? "" : "s"}`);
	return `✻ ${parts.join(" · ")}`;
}

export interface FocusSummaryOptions {
	/** Expand or fold the turn's hidden components. */
	onToggle?(expanded: boolean): void;
	requestRender?(): void;
}

/** A transcript component focus mode folds and the summary can reveal again. */
export type FocusExpandable = Component & { setFocusExpanded(expanded: boolean): void };

export function isFocusExpandable(component: Component): component is FocusExpandable {
	return typeof (component as Partial<FocusExpandable>).setFocusExpanded === "function";
}

/**
 * One dim line standing in for the tool activity focus mode hides. Clicking it
 * expands the turn's folded work in place and clicking again folds it back.
 */
export class FocusSummaryComponent extends Text {
	readonly #counts: FocusActivityCounts;
	readonly #onToggle: ((expanded: boolean) => void) | undefined;
	readonly #requestRender: (() => void) | undefined;
	#expanded = false;

	constructor(counts: FocusActivityCounts, options: FocusSummaryOptions = {}) {
		super(theme.fg("dim", formatFocusSummary(counts)), 1, 0);
		this.#counts = counts;
		this.#onToggle = options.onToggle;
		this.#requestRender = options.requestRender;
	}

	get expanded(): boolean {
		return this.#expanded;
	}

	toggle(): void {
		this.#expanded = !this.#expanded;
		const marker = this.#expanded ? "▾" : "▸";
		this.setText(theme.fg("dim", `${marker} ${formatFocusSummary(this.#counts)}`));
		this.#onToggle?.(this.#expanded);
		this.#requestRender?.();
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.act === "toggle") this.toggle();
	}

	/** ANSI-terminal click: the composer routes a left click on these rows here. */
	inlineClick(): void {
		this.toggle();
	}

	/** A native `row` so the terminal can dispatch the click back here. */
	override describe(): NativeNode {
		const marker = this.#expanded ? "▾" : "▸";
		return node(
			"row",
			{
				gap: "xs",
				role: "omp.focus.summary",
				actions: { click: "toggle" },
				title: this.#expanded ? "Fold this turn's hidden work" : "Expand this turn's hidden work",
			},
			[text([span(`${marker} ${formatFocusSummary(this.#counts)}`, "muted")])],
			"focus",
		);
	}
}
