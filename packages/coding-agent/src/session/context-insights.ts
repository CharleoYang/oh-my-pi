/**
 * Live context-insights adapter: captures request-time composition details and
 * builds the shared timeline from the active session branch.
 */

import * as path from "node:path";
import type { AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type {
	ContextJournalEntry,
	ContextNamedTokens,
	ContextSnapshotDetails,
	ContextTimeline,
	ContextTimelineLimits,
	Model,
	Tool,
} from "@oh-my-pi/pi-ai";
import { foldContextTimeline } from "@oh-my-pi/pi-ai";
import {
	estimateContextSkillsTokensByName,
	estimateContextToolSchemaTokensByTool,
} from "@oh-my-pi/pi-tui/status-line/context-usage";
import type { AgentSession } from "./agent-session";
import type { ContextUsageBreakdown } from "./agent-session-types";

export interface CaptureContextSnapshotDetailsInput {
	breakdown: ContextUsageBreakdown;
	contextWindow: number;
	systemPrompt: readonly string[];
	tools: readonly Pick<Tool, "name" | "description" | "parameters" | "examples">[];
	skills: readonly { name: string; description?: string; hide?: boolean }[];
	model: Model | undefined;
	tokenizer: Tokenizer;
	sourceRevision?: number;
	messageCount: number;
	pendingMessages: readonly AgentMessage[];
	limits?: Pick<ContextTimelineLimits, "maxToolSchemas" | "maxSkills" | "maxSystemParts">;
}

function nonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Merge duplicate names, then allocate `total` with a deterministic largest remainder. */
function normalizeNamedTokens(items: readonly ContextNamedTokens[], total: number): ContextNamedTokens[] {
	const byName = new Map<string, number>();
	for (const item of items) {
		if (typeof item.name !== "string" || item.name.length === 0) continue;
		const tokens = nonNegative(item.tokens);
		if (tokens <= 0) continue;
		byName.set(item.name, (byName.get(item.name) ?? 0) + tokens);
	}
	const cleaned = [...byName]
		.map(([name, tokens]) => ({ name, tokens }))
		.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
	if (total <= 0 || cleaned.length === 0) return [];
	const weight = cleaned.reduce((sum, item) => sum + item.tokens, 0);
	if (weight <= 0) return [];
	const allocated = cleaned.map(item => ({ ...item, tokens: Math.floor((item.tokens * total) / weight) }));
	let remainder = total - allocated.reduce((sum, item) => sum + item.tokens, 0);
	const fractions = cleaned
		.map((item, index) => ({
			index,
			name: item.name,
			fraction: (item.tokens * total) / weight - Math.floor((item.tokens * total) / weight),
		}))
		.sort((a, b) => b.fraction - a.fraction || a.name.localeCompare(b.name));
	for (let index = 0; remainder > 0 && fractions.length > 0; index = (index + 1) % fractions.length) {
		allocated[fractions[index]!.index]!.tokens++;
		remainder--;
	}
	return allocated.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
}

function normalizeParts(parts: readonly number[], total: number): number[] {
	const cleaned = parts.map(nonNegative);
	if (cleaned.length === 0) return [];
	const weight = cleaned.reduce((sum, value) => sum + value, 0);
	if (total <= 0) return cleaned.map(() => 0);
	if (weight <= 0) return cleaned.map((_, index) => (index === 0 ? total : 0));
	const allocated = cleaned.map(value => Math.floor((value * total) / weight));
	let remainder = total - allocated.reduce((sum, value) => sum + value, 0);
	const fractions = cleaned
		.map((value, index) => ({ index, fraction: (value * total) / weight - Math.floor((value * total) / weight) }))
		.sort((a, b) => b.fraction - a.fraction || a.index - b.index);
	for (let index = 0; remainder > 0 && fractions.length > 0; index = (index + 1) % fractions.length) {
		allocated[fractions[index]!.index]!++;
		remainder--;
	}
	return allocated;
}

/** Capture the bounded composition details persisted with one provider request. */
export function captureContextSnapshotDetails(input: CaptureContextSnapshotDetailsInput): ContextSnapshotDetails {
	const categories = {
		systemPrompt: nonNegative(input.breakdown.systemPromptTokens),
		systemTools: nonNegative(input.breakdown.systemToolsTokens),
		systemContext: nonNegative(input.breakdown.systemContextTokens),
		skills: nonNegative(input.breakdown.skillsTokens),
		messages: nonNegative(input.breakdown.messagesTokens),
	};

	const maxTools = Math.max(0, Math.min(200, input.limits?.maxToolSchemas ?? 200));
	const maxSkills = Math.max(0, Math.min(200, input.limits?.maxSkills ?? 200));
	const maxParts = Math.max(2, Math.min(20, input.limits?.maxSystemParts ?? 20));

	const rawTools = estimateContextToolSchemaTokensByTool(
		input.tools,
		input.tokenizer,
		input.model,
		input.sourceRevision,
	);
	let toolSchemas = normalizeNamedTokens(rawTools, categories.systemTools);
	let omittedToolSchemas = 0;
	if (toolSchemas.length > maxTools) {
		omittedToolSchemas = toolSchemas.length - maxTools;
		toolSchemas = toolSchemas.slice(0, maxTools);
	}

	const hasReadTool = input.tools.some(tool => tool.name === "read");
	const visibleSkills = hasReadTool ? input.skills.filter(skill => skill.hide !== true) : [];
	const rawSkills = estimateContextSkillsTokensByName(visibleSkills, input.tokenizer);
	let skills = normalizeNamedTokens(rawSkills, categories.skills);
	let omittedSkills = 0;
	if (skills.length > maxSkills) {
		omittedSkills = skills.length - maxSkills;
		skills = skills.slice(0, maxSkills);
	}

	const rawParts = (input.systemPrompt ?? []).map(part =>
		typeof part === "string" ? input.tokenizer.countTokens(part) : 0,
	);
	let systemPromptParts: number[] = [];
	let systemPromptPartsOmitted = 0;
	if (rawParts.length > 0) {
		rawParts[0] = Math.max(0, rawParts[0]! - categories.skills);
		const promptPart = normalizeParts([rawParts[0] ?? 0], categories.systemPrompt)[0] ?? 0;
		const allContext = normalizeParts(rawParts.slice(1), categories.systemContext);
		if (allContext.length > maxParts - 1) {
			const kept = allContext.slice(0, maxParts - 2);
			const merged = allContext.slice(maxParts - 2).reduce((sum, value) => sum + value, 0);
			systemPromptParts = [promptPart, ...kept, merged];
		} else {
			systemPromptParts = [promptPart, ...allContext];
		}
		if (systemPromptParts.length === 1 && categories.systemContext > 0) {
			systemPromptParts.push(categories.systemContext);
		}
		systemPromptPartsOmitted = Math.max(0, rawParts.length - systemPromptParts.length);
	}

	const pendingMessageTokens = input.tokenizer.countMessages(input.pendingMessages);

	return {
		contextWindow: nonNegative(input.contextWindow),
		categories,
		toolSchemas,
		...(omittedToolSchemas > 0 ? { omittedToolSchemas } : {}),
		skills,
		...(omittedSkills > 0 ? { omittedSkills } : {}),
		systemPromptParts,
		...(systemPromptPartsOmitted > 0 ? { systemPromptPartsOmitted } : {}),
		messageCount: nonNegative(input.messageCount),
		pendingMessageTokens: nonNegative(pendingMessageTokens),
	};
}

const READ_SELECTOR = /:(?:raw|conflicts|img|[\d.,+-]+)$/i;

function stripReadSelector(value: string): string {
	let result = value;
	while (READ_SELECTOR.test(result)) result = result.replace(READ_SELECTOR, "");
	return result;
}

/** Resolve a file-tool path against the session workspace. */
export function createSessionPathResolver(session: AgentSession): (value: string) => string {
	const cwd = session.sessionManager.getCwd();
	const additional = session.sessionManager.getHeader()?.additionalDirectories ?? [];
	const roots = [cwd, ...additional];
	return value => {
		const stripped = stripReadSelector(value.trim());
		if (stripped.length === 0) return "";
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(stripped)) return "";
		if (path.isAbsolute(stripped)) return path.normalize(stripped);
		// The cwd wins for relative paths; additional roots only make absolute
		// paths in those roots valid (they are already absolute).
		return path.resolve(roots[0] ?? process.cwd(), stripped);
	};
}

/** Build the shared timeline from the live active branch. */
export function buildLiveContextTimeline(
	session: AgentSession,
	options?: { limits?: Partial<ContextTimelineLimits> },
): ContextTimeline {
	return foldContextTimeline({
		sessionId: session.sessionManager.getSessionId(),
		source: "live",
		cwd: session.sessionManager.getCwd(),
		// SessionEntry is structurally mirrored by the shared journal contract;
		// the only nominal mismatch is extension payload `data: unknown`.
		entries: session.sessionManager.getBranchView() as unknown as readonly ContextJournalEntry[],
		limits: options?.limits,
		normalizePath: createSessionPathResolver(session),
		agents: [],
	});
}
