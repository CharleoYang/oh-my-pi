import { col } from "../native/describe";
import type { NativeNode } from "../native/node";
import { type Component, Container } from "../tui";
import { chatTranscriptDisplayPreferences } from "./display-preferences";

/**
 * Intermediate transcript activity (IRC traffic, background notices) that
 * focus mode folds away. Each turn's activity summary expands the components it
 * collected, so this wrapper stays mounted and renders no rows until then.
 */
export class FocusFoldable extends Container {
	#expanded = false;

	constructor(component: Component) {
		super();
		this.addChild(component);
	}

	setFocusExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		this.invalidate();
	}

	override render(width: number): readonly string[] {
		if (chatTranscriptDisplayPreferences.focusMode && !this.#expanded) return [];
		return super.render(width);
	}

	override describe(): NativeNode {
		const folded = chatTranscriptDisplayPreferences.focusMode && !this.#expanded;
		return col(this.children, folded ? { role: "omp.focus.folded", hidden: true } : { role: "omp.focus.folded" });
	}
}
