import { describe, expect, it } from "bun:test";
import { routeViewportActivation } from "@oh-my-pi/pi-tui/prompt/composer";

describe("routeViewportActivation", () => {
	it("runs the action of the span under the row", () => {
		let calls = 0;
		const spans = [
			{ start: 0, end: 2, candidates: () => [], activate: () => calls++ },
			{ start: 2, end: 4, candidates: () => [] },
		];
		expect(routeViewportActivation(spans, 1)).toBe(true);
		expect(calls).toBe(1);
	});

	it("ignores rows outside spans and spans without an action", () => {
		let calls = 0;
		const spans = [
			{ start: 0, end: 2, candidates: () => [], activate: () => calls++ },
			{ start: 2, end: 4, candidates: () => [] },
		];
		expect(routeViewportActivation(spans, 3)).toBe(false);
		expect(routeViewportActivation(spans, 9)).toBe(false);
		expect(routeViewportActivation(spans, -1)).toBe(false);
		expect(calls).toBe(0);
	});
});
