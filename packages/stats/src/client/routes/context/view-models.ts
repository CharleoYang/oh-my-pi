import { densify } from "../../data/series";
import type { ContextEvent, ContextFileActivity, ContextOverview, ContextStep } from "../../types";

export const CATEGORY_KEYS = ["systemPrompt", "systemTools", "systemContext", "skills", "messages"] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];

export function categoryRows(step: ContextStep | undefined) {
	return CATEGORY_KEYS.map(key => ({
		key,
		label:
			key === "systemPrompt"
				? "System prompt"
				: key === "systemTools"
					? "System tools"
					: key === "systemContext"
						? "System context"
						: key[0]!.toUpperCase() + key.slice(1),
		tokens: step?.composition?.[key] ?? null,
	}));
}

export function categoryShare(value: number | null, step: ContextStep | undefined): number {
	const total = step?.promptTokens ?? 0;
	return value === null || total <= 0 ? 0 : value / total;
}

export function heatmapBuckets(
	overview: Pick<ContextOverview, "cutoff" | "heatmapBucketMs">,
	now = Date.now(),
): number[] {
	const size = Math.max(1, overview.heatmapBucketMs);
	const start = Math.floor(overview.cutoff / size) * size;
	const end = Math.floor(now / size) * size;
	const count = Math.max(1, Math.floor((end - start) / size) + 1);
	return Array.from({ length: count }, (_, index) => start + index * size);
}

export function denseHeatmap(overview: ContextOverview, now = Date.now()) {
	const buckets = heatmapBuckets(overview, now);
	return {
		buckets,
		requests: densify(
			overview.heatmap.map(point => ({ timestamp: point.bucket, value: point.requests })),
			buckets,
			point => point.value,
		),
		promptTokens: densify(
			overview.heatmap.map(point => ({ timestamp: point.bucket, value: point.promptTokens })),
			buckets,
			point => point.value,
		),
	};
}

export function eventKinds(events: readonly ContextEvent[]): string[] {
	return [...new Set(events.map(event => event.kind))].sort();
}

export function filterContextEvents(events: readonly ContextEvent[], kinds: readonly string[]): ContextEvent[] {
	if (kinds.length === 0) return [...events];
	return events.filter(event => kinds.includes(event.kind));
}

export function sortFiles(
	files: readonly ContextFileActivity[],
	sort: keyof ContextFileActivity = "lastTimestamp",
	direction: "asc" | "desc" = "desc",
) {
	return [...files].sort((a, b) => {
		const left = a[sort];
		const right = b[sort];
		if (typeof left === "number" && typeof right === "number") return (left - right) * (direction === "asc" ? 1 : -1);
		return String(left).localeCompare(String(right)) * (direction === "asc" ? 1 : -1);
	});
}
