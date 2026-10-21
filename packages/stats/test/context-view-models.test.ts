import { describe, expect, it } from "bun:test";
import { denseHeatmap, filterContextEvents, heatmapBuckets, sortFiles } from "../src/client/routes/context/view-models";

describe("context view models", () => {
	it("densifies response buckets from cutoff using the response bucket size", () => {
		const overview = {
			cutoff: 0,
			heatmapBucketMs: 10,
			heatmap: [{ bucket: 10, requests: 2, promptTokens: 5 }],
		};
		expect(heatmapBuckets(overview, 20)).toEqual([0, 10, 20]);
		expect(
			denseHeatmap(
				{
					...overview,
					sessions: [],
					kpi: { sessions: 0, requests: 2, avgPromptTokens: 0, peakPromptTokens: 0, totalTokens: 0 },
					range: "1h",
					omittedSessions: 0,
					omittedRequests: 0,
					omittedPromptTokens: 0,
				},
				20,
			).requests,
		).toEqual([0, 2, 0]);
	});

	it("filters events and sorts file activity without mutating input", () => {
		const events = [
			{ id: "a", timestamp: 1, kind: "compact", label: "Compact" },
			{ id: "b", timestamp: 2, kind: "reset", label: "Reset" },
		] as const;
		expect(filterContextEvents(events, ["reset"]).map(event => event.id)).toEqual(["b"]);
		const files = [
			{
				path: "b",
				reads: 0,
				writes: 0,
				edits: 0,
				searches: 0,
				linesRead: 0,
				linesAdded: 0,
				linesRemoved: 0,
				bytesRead: 0,
				bytesWritten: 0,
				lastTimestamp: 1,
			},
			{
				path: "a",
				reads: 0,
				writes: 0,
				edits: 0,
				searches: 0,
				linesRead: 0,
				linesAdded: 0,
				linesRemoved: 0,
				bytesRead: 0,
				bytesWritten: 0,
				lastTimestamp: 2,
			},
		] as const;
		expect(sortFiles(files, "path", "asc").map(file => file.path)).toEqual(["a", "b"]);
		expect(files[0]!.path).toBe("b");
	});
});
