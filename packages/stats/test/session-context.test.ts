import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import * as context from "../src/context";
import { handleApi } from "../src/server";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-session-context-");

function assistant(id: string, parentId: string | null = null, input = 100) {
	return {
		type: "message", id, parentId, timestamp: "2026-10-21T00:00:00.000Z",
		message: { role: "assistant", timestamp: 1792540800000, model: "model-a", provider: "test",
			content: [], usage: { input, output: 10, cacheRead: 20, cacheWrite: 0, cost: { total: 0.25 } } },
	};
}

async function fixture(name: string, entries: unknown[]) {
	const file = path.join(getSessionsDir(), "--work--project", `${name}.jsonl`);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
	return file;
}

function request(file: string, etag?: string) {
	return handleApi(new Request(`http://localhost/api/session/context?${new URLSearchParams({ file })}`, {
		headers: etag ? { "If-None-Match": etag } : undefined,
	}));
}

describe("session context", () => {
	it("serves the active branch, not a stale sibling, with a reusable ETag", async () => {
		const file = await fixture("route", [
			{ type: "session", id: "session-route", cwd: "/work/project" },
			assistant("a1"), assistant("stale", "a1", 900), assistant("a2", "a1", 200),
		]);
		const response = await request(file);
		expect(response.status).toBe(200);
		const timeline = await response.json();
		expect(timeline.steps.map((step: { id: string }) => step.id)).toEqual(["a1", "a2"]);
		expect(timeline.steps.map((step: { promptTokens: number }) => step.promptTokens)).toEqual([120, 220]);
		expect(timeline.source).toBe("journal");
		expect(timeline.agents).toHaveLength(1);
		expect(timeline.agents[0]).toMatchObject({ trackId: "main", requests: 2, peakTokens: 220, lastTokens: 220 });
		const etag = response.headers.get("ETag");
		expect(etag).toBeTruthy();
		const unchanged = await request(file, etag!);
		expect(unchanged.status).toBe(304);
		expect(unchanged.headers.get("ETag")).toBe(etag);
		expect(await unchanged.text()).toBe("");
	});

	it("exposes the timeline adapter contract", async () => {
		const file = await fixture("adapter", [assistant("a1")]);
		expect("buildSessionContextTimeline" in context).toBe(true);
		if (!("buildSessionContextTimeline" in context) || typeof context.buildSessionContextTimeline !== "function") {
			throw new Error("timeline adapter missing");
		}
		expect((await context.buildSessionContextTimeline(file)).steps).toHaveLength(1);
	});
});
