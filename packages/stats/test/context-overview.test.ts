import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { getContextOverview } from "../src/context";
import { initDb, insertMessageStats } from "../src/db";
import type { MessageStatsInput } from "../src/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-context-overview-");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function message(
	file: string,
	entryId: string,
	timestamp: number,
	input = 100,
	model = "model-a",
): MessageStatsInput {
	return {
		sessionFile: file,
		entryId,
		folder: "/work/project",
		model,
		provider: "test-provider",
		api: "openai-responses",
		timestamp,
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		agentType: "main",
		usage: {
			input,
			output: 10,
			cacheRead: 20,
			cacheWrite: 30,
			totalTokens: input + 60,
		},
	};
}

function sessionFile(name: string): string {
	return path.join(getSessionsDir(), "--work--project", `${name}.jsonl`);
}

describe("context overview", () => {
	it("uses range activity and folds child requests into their root", async () => {
		await initDb();
		const now = Date.now();
		const root = sessionFile("root");
		const second = sessionFile("second");
		const child = path.join(getSessionsDir(), "--work--project", "root", "task", "child.jsonl");
		insertMessageStats([
			message(root, "old", now - 2 * DAY_MS, 10000, "old-model"),
			message(root, "recent", now - 2 * HOUR_MS, 100),
			message(child, "child", now - HOUR_MS, 200, "model-b"),
			message(second, "second", now - 3 * HOUR_MS, 300),
		]);

		const overview = await getContextOverview("24h");
		expect(overview.range).toBe("24h");
		expect(overview.cutoff).toBeGreaterThanOrEqual(now - DAY_MS);
		expect(overview.heatmapBucketMs).toBe(HOUR_MS);
		expect(overview.kpi).toEqual({
			sessions: 2,
			requests: 3,
			avgPromptTokens: 250,
			peakPromptTokens: 350,
			totalTokens: 780,
		});
		expect(overview.sessions).toEqual([
			{
				file: root,
				folder: "/work/project",
				title: null,
				models: ["model-a", "model-b"],
				startedAt: now - 2 * HOUR_MS,
				endedAt: now - HOUR_MS,
				requests: 2,
				totalTokens: 420,
				promptTokens: 400,
				peakPromptTokens: 250,
				avgPromptTokens: 200,
			},
			{
				file: second,
				folder: "/work/project",
				title: null,
				models: ["model-a"],
				startedAt: now - 3 * HOUR_MS,
				endedAt: now - 3 * HOUR_MS,
				requests: 1,
				totalTokens: 360,
				promptTokens: 350,
				peakPromptTokens: 350,
				avgPromptTokens: 350,
			},
		]);
		expect(overview.heatmap).toEqual([
			{ bucket: Math.floor((now - 3 * HOUR_MS) / HOUR_MS) * HOUR_MS, requests: 1, promptTokens: 350 },
			{ bucket: Math.floor((now - 2 * HOUR_MS) / HOUR_MS) * HOUR_MS, requests: 1, promptTokens: 150 },
			{ bucket: Math.floor((now - HOUR_MS) / HOUR_MS) * HOUR_MS, requests: 1, promptTokens: 250 },
		]);
		expect(overview.omittedSessions).toBe(0);
		expect(overview.omittedRequests).toBe(0);
		expect(overview.omittedPromptTokens).toBe(0);
	});
});
