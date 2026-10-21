import { describe, expect, test } from "bun:test";
import type { AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { ContextCategoryTokens } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "../../src/session/agent-session";
import { captureContextSnapshotDetails, createSessionPathResolver } from "../../src/session/context-insights";
import { SessionStatsTracker, type SessionStatsTrackerHost } from "../../src/session/session-stats";
import type { ContextUsageBreakdown } from "../../src/session/agent-session-types";

const breakdown: ContextUsageBreakdown = {
	contextWindow: 1000,
	anchored: true,
	usedTokens: 120,
	systemPromptTokens: 20,
	systemToolsTokens: 30,
	systemContextTokens: 10,
	skillsTokens: 20,
	messagesTokens: 40,
};

function fakeTokenizer(tokens: (text: string | string[]) => number): Tokenizer {
	return {
		countTokens: tokens,
		countMessages: (messages: readonly AgentMessage[]) => messages.length * 10,
	} as unknown as Tokenizer;
}

const lengthTokenizer = fakeTokenizer(text => (Array.isArray(text) ? text.join("").length : text.length));

describe("captureContextSnapshotDetails", () => {
	test("normalizes per-tool, per-skill, and system parts to category totals", () => {
		const details = captureContextSnapshotDetails({
			breakdown,
			contextWindow: 1000,
			systemPrompt: ["system prompt with a long system section", "ctx one", "ctx two"],
			tools: [
				{ name: "read", description: "read files", parameters: {} },
				{ name: "write", description: "write files", parameters: {} },
			],
			skills: [
				{ name: "skill-a", description: "alpha" },
				{ name: "skill-b", description: "beta" },
			],
			model: undefined,
			tokenizer: lengthTokenizer,
			sourceRevision: 4,
			messageCount: 3,
			pendingMessages: [{ role: "user", content: "hi", timestamp: 0 } as AgentMessage],
		});

		expect(details.categories).toEqual({
			systemPrompt: 20,
			systemTools: 30,
			systemContext: 10,
			skills: 20,
			messages: 40,
		} satisfies ContextCategoryTokens);
		expect(details.toolSchemas?.reduce((sum, item) => sum + item.tokens, 0)).toBe(30);
		expect(details.skills?.reduce((sum, item) => sum + item.tokens, 0)).toBe(20);
		expect(details.systemPromptParts?.[0]).toBe(20);
		expect((details.systemPromptParts ?? []).slice(1).reduce((sum, value) => sum + value, 0)).toBe(10);
		expect(details.messageCount).toBe(3);
		expect(details.pendingMessageTokens).toBe(10);
	});

	test("caps tools/skills and records omitted counts", () => {
		const details = captureContextSnapshotDetails({
			breakdown,
			contextWindow: 1000,
			systemPrompt: ["prompt"],
			tools: [
				{ name: "read", description: "read files", parameters: {} },
				{ name: "write", description: "write files", parameters: {} },
				{ name: "edit", description: "edit files", parameters: {} },
			],
			skills: [
				{ name: "skill-a", description: "alpha" },
				{ name: "skill-b", description: "beta" },
			],
			model: undefined,
			tokenizer: lengthTokenizer,
			sourceRevision: 4,
			messageCount: 0,
			pendingMessages: [],
			limits: { maxToolSchemas: 2, maxSkills: 1, maxSystemParts: 20 },
		});
		expect(details.toolSchemas).toHaveLength(2);
		expect(details.omittedToolSchemas).toBe(1);
		expect(details.skills).toHaveLength(1);
		expect(details.omittedSkills).toBe(1);
	});

	test("merges parts beyond the cap and reports the extra count", () => {
		const parts = Array.from({ length: 21 }, (_, index) => `part-${index}`);
		const details = captureContextSnapshotDetails({
			breakdown: { ...breakdown, systemContextTokens: 20, messagesTokens: 30 },
			contextWindow: 1000,
			systemPrompt: parts,
			tools: [],
			skills: [],
			model: undefined,
			tokenizer: lengthTokenizer,
			sourceRevision: 4,
			messageCount: 0,
			pendingMessages: [],
			limits: { maxToolSchemas: 200, maxSkills: 200, maxSystemParts: 20 },
		});
		expect(details.systemPromptParts).toEqual([20, ...Array.from({ length: 18 }, () => 1), 2]);
		expect(details.systemPromptPartsOmitted).toBe(1);
		expect((details.systemPromptParts ?? []).reduce((sum, value) => sum + value, 0)).toBe(40);
	});

	test("does not invent per-entry rows when the tokenizer reports zero weights", () => {
		const details = captureContextSnapshotDetails({
			breakdown,
			contextWindow: 1000,
			systemPrompt: ["prompt"],
			tools: [{ name: "read", description: "read files", parameters: {} }],
			skills: [{ name: "skill-a", description: "alpha" }],
			model: undefined,
			tokenizer: fakeTokenizer(() => 0),
			sourceRevision: 4,
			messageCount: 0,
			pendingMessages: [],
		});
		expect(details.categories.systemTools).toBe(30);
		expect(details.toolSchemas).toEqual([]);
		expect(details.skills).toEqual([]);
		expect(details.systemPromptParts).toEqual([20, 10]);
	});

	test("merges duplicate tool names before allocating or capping", () => {
		const details = captureContextSnapshotDetails({
			breakdown,
			contextWindow: 1000,
			systemPrompt: ["prompt"],
			tools: [
				{ name: "read", description: "same", parameters: {} },
				{ name: "read", description: "same", parameters: {} },
			],
			skills: [],
			model: undefined,
			tokenizer: lengthTokenizer,
			sourceRevision: 4,
			messageCount: 0,
			pendingMessages: [],
			limits: { maxToolSchemas: 1, maxSkills: 200, maxSystemParts: 20 },
		});
		expect(details.toolSchemas).toEqual([{ name: "read", tokens: 30 }]);
		expect(details.omittedToolSchemas).toBeUndefined();
	});

	test("excludes hidden skills and allocates deterministic name-order ties", () => {
		const details = captureContextSnapshotDetails({
			breakdown: { ...breakdown, skillsTokens: 2 },
			contextWindow: 1000,
			systemPrompt: ["prompt"],
			tools: [{ name: "read", description: "", parameters: {} }],
			skills: [
				{ name: "a", description: "" },
				{ name: "b", description: "xx" },
				{ name: "hidden", description: "longer", hide: true },
			],
			model: undefined,
			tokenizer: lengthTokenizer,
			sourceRevision: 4,
			messageCount: 0,
			pendingMessages: [],
		});
		expect(details.skills).toEqual([
			{ name: "a", tokens: 1 },
			{ name: "b", tokens: 1 },
		]);
	});

	test("strips a full compound read selector from resolved paths", () => {
		const resolver = createSessionPathResolver({
			sessionManager: { getCwd: () => "/work", getHeader: () => ({ additionalDirectories: [] }) },
		} as unknown as AgentSession);
		expect(resolver("a.ts:2-4:raw")).toBe("/work/a.ts");
		expect(resolver("a.ts:raw:2-4")).toBe("/work/a.ts");
	});

	test("returns empty detail arrays when the prompt is empty", () => {
		const details = captureContextSnapshotDetails({
			breakdown,
			contextWindow: 1000,
			systemPrompt: [],
			tools: [],
			skills: [],
			model: undefined,
			tokenizer: lengthTokenizer,
			sourceRevision: 4,
			messageCount: 0,
			pendingMessages: [],
		});
		expect(details.systemPromptParts).toEqual([]);
		expect(details.toolSchemas).toEqual([]);
		expect(details.skills).toEqual([]);
	});
});

test("tracker keeps request details on the pending snapshot", () => {
	const tracker = new SessionStatsTracker({
		session: { settings: { revision: 1 } },
		agent: { state: { tools: [] }, tokenizer: lengthTokenizer },
		sessionManager: {},
		modelRegistry: {},
		model: () => undefined,
		sessionId: () => "session-1",
	} as unknown as SessionStatsTrackerHost);
	const details = captureContextSnapshotDetails({
		breakdown,
		contextWindow: 1000,
		systemPrompt: ["system prompt with a long system section"],
		tools: [],
		skills: [],
		model: undefined,
		tokenizer: lengthTokenizer,
		sourceRevision: 1,
		messageCount: 1,
		pendingMessages: [],
	});
	tracker.setPendingSnapshot({ promptTokens: 120, nonMessageTokens: 80, cutoffCount: 0, details });
	expect(tracker.nonMessageSnapshot().details).toEqual(details);
});
