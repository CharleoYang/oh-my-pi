import { describe, expect, test } from "bun:test";
import type { ContextJournalEntry } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "../../src/session/agent-session";
import { buildLiveContextTimeline } from "../../src/session/context-insights";

const entry = (value: ContextJournalEntry): ContextJournalEntry => value;

function sessionWith(entries: readonly ContextJournalEntry[]): AgentSession {
	return {
		agent: { sessionId: "session-1" },
		sessionManager: {
			getSessionId: () => "session-1",
			getCwd: () => "/work",
			getHeader: () => ({ additionalDirectories: ["/extra"] }),
			getBranchView: () => entries,
		},
	} as unknown as AgentSession;
}

describe("buildLiveContextTimeline", () => {
	test("folds the active branch and resolves file-tool paths", () => {
		const timeline = buildLiveContextTimeline(
			sessionWith([
				entry({
					type: "message",
					id: "a1",
					timestamp: "2026-10-21T00:00:00.000Z",
					message: {
						role: "assistant",
						timestamp: Date.parse("2026-10-21T00:00:00.000Z"),
						model: "model-a",
						provider: "provider-a",
						usage: { input: 90, output: 5, cacheRead: 10, cacheWrite: 0, total: 105 },
						contextSnapshot: {
							promptTokens: 100,
							nonMessageTokens: 60,
							details: {
								contextWindow: 1000,
								categories: {
									systemPrompt: 10,
									systemTools: 20,
									systemContext: 10,
									skills: 10,
									messages: 50,
								},
								messageCount: 2,
								pendingMessageTokens: 0,
							},
						},
						content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts:1-10" } }],
					},
				}),
				entry({
					type: "message",
					id: "r1",
					timestamp: "2026-10-21T00:00:01.000Z",
					message: {
						role: "toolResult",
						timestamp: Date.parse("2026-10-21T00:00:01.000Z"),
						toolCallId: "read-1",
						toolName: "read",
						content: [],
						details: { totalLines: 10 },
					},
				}),
			]),
		);

		expect(timeline.source).toBe("live");
		expect(timeline.sessionId).toBe("session-1");
		expect(timeline.steps).toHaveLength(1);
		expect(timeline.steps[0]?.composition).toEqual({
			systemPrompt: 10,
			systemTools: 20,
			systemContext: 10,
			skills: 10,
			messages: 50,
		});
		expect(timeline.steps[0]?.filePaths).toEqual(["/work/a.ts"]);
		expect(timeline.files).toEqual([
			{
				path: "/work/a.ts",
				reads: 1,
				writes: 0,
				edits: 0,
				searches: 0,
				linesRead: 10,
				linesAdded: 0,
				linesRemoved: 0,
				bytesRead: 0,
				bytesWritten: 0,
				lastTimestamp: Date.parse("2026-10-21T00:00:01.000Z"),
			},
		]);
	});

	test("returns an empty timeline for a fresh session", () => {
		const timeline = buildLiveContextTimeline(sessionWith([]));
		expect(timeline.steps).toEqual([]);
		expect(timeline.events).toEqual([]);
		expect(timeline.files).toEqual([]);
		expect(timeline.peakTokens).toBe(0);
		expect(timeline.truncated).toBe(false);
	});
});
