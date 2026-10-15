import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { type Goal } from "@oh-my-pi/pi-tui/tools/goal";
import type { UsageStatistics } from "../session/session-entries";

export interface GoalModeState {
	enabled: boolean;
	mode: "active" | "exiting";
	reason?: "completed";
	/** Trusted extension identity, never writable by the model goal tool. */
	continuationGuard?: string;
	goal: Goal;
}

export type GoalRuntimeEvent =
	| { type: "goal_updated"; goal: Goal | null; state?: GoalModeState }
	| { type: "goal_continuation_requested"; prompt: string };

export type GoalTokenUsage = Pick<UsageStatistics, "input" | "output" | "cacheRead" | "cacheWrite">;

export type GoalBudgetSteering = "allowed" | "suppressed";
export type GoalTerminalMetricEmission = "emit" | "suppress";

export type GoalSnapshot = Readonly<Omit<GoalModeState, "goal"> & { goal: Readonly<Goal> }>;

export type GoalControlRequest =
	| { op: "create"; objective: string; tokenBudget?: number; continuationGuard: string; paused: true }
	| { op: "pause" | "resume" | "complete" | "drop"; expectedGoalId: string };

export interface ExtensionGoalPort {
	getState(): GoalSnapshot | undefined;
	/** Latest actual submission for the current Goal/guard/session, never an intent. */
	getLatestRunId(): string | undefined;
	/** Positive parked admission proof only; never an actually submitted run. */
	getPreparedRunId(): string | undefined;
	/** Explicit synchronous native control, forbidden inside Goal guards. */
	retirePreparedRun(runId: string): void;
	control(request: GoalControlRequest): Promise<GoalSnapshot | undefined>;
}

export type GoalRunDecision =
	| { decision: "allow"; additionalContext: string; resumeRunId?: string }
	| { decision: "wait"; retryAt: number; reason: string }
	| { decision: "pause" | "block"; reason: string };

export interface GoalGuardContext {
	goal: GoalSnapshot;
	sessionId: string;
	runId: string;
	signal: AbortSignal;
}

export interface GoalGuard {
	beforeRun(context: GoalGuardContext): Promise<GoalRunDecision>;
	beforeComplete(context: GoalGuardContext): Promise<{ decision: "allow" } | { decision: "block"; reason: string }>;
}

export function goalSnapshot(state: GoalModeState | undefined): GoalSnapshot | undefined {
	return state ? Object.freeze({ ...state, goal: Object.freeze({ ...state.goal }) }) : undefined;
}

/** Only the latest active-branch candidate can be parked; actual submission consumes it. */
export function preparedGoalRunId(
	entries: readonly { type: string; customType?: string; data?: unknown }[],
	goalId: string,
	continuationGuard: string,
	sessionId: string,
): string | undefined {
	const matchingData = (entry: (typeof entries)[number]): Record<string, unknown> | undefined => {
		if (entry.type !== "custom" || !entry.data || typeof entry.data !== "object") return undefined;
		const data = entry.data as Record<string, unknown>;
		return data.goalId === goalId && data.continuationGuard === continuationGuard && data.sessionId === sessionId ? data : undefined;
	};
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.customType !== "goal-admission-prepared" && entry.customType !== "goal-run") continue;
		const data = matchingData(entry);
		if (!data) continue;
		if (entry.customType === "goal-run" || typeof data.runId !== "string" || !data.runId.trim()) return undefined;
		const runId = data.runId;
		for (const proof of entries) {
			if (proof.customType !== "goal-admission-retired" && proof.customType !== "goal-run") continue;
			const proofData = matchingData(proof);
			if (!proofData) continue;
			if (proof.customType === "goal-admission-retired" && (typeof proofData.runId !== "string" || !proofData.runId.trim())) return undefined;
			if (proofData.runId === runId) return undefined;
		}
		return runId;
	}
	return undefined;
}

export function goalGuardFromModeData(data: Record<string, unknown> | undefined): string | undefined {
	if (!data || !("continuationGuard" in data)) return undefined;
	if (typeof data.continuationGuard !== "string" || !data.continuationGuard.trim()) {
		throw new Error("Invalid persisted Goal continuationGuard identity");
	}
	return data.continuationGuard;
}

/** Rebuild a persisted goal from `mode_change` data; undefined when the record is malformed. */
export function goalFromModeData(modeData: Record<string, unknown> | undefined): Goal | undefined {
	const goal = modeData?.goal;
	if (!goal || typeof goal !== "object") return undefined;
	const value = goal as Record<string, unknown>;
	if (
		typeof value.id !== "string" ||
		typeof value.objective !== "string" ||
		typeof value.status !== "string" ||
		typeof value.tokensUsed !== "number" ||
		typeof value.timeUsedSeconds !== "number" ||
		typeof value.createdAt !== "number" ||
		typeof value.updatedAt !== "number"
	) {
		return undefined;
	}
	return {
		id: value.id,
		objective: value.objective,
		status: value.status as Goal["status"],
		tokenBudget: typeof value.tokenBudget === "number" ? value.tokenBudget : undefined,
		tokensUsed: value.tokensUsed,
		timeUsedSeconds: value.timeUsedSeconds,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

/**
 * Digest of a turn's tool calls and results. Two continuation turns with the same
 * (or empty) activity made no progress, so automatic continuation stops.
 */
export function goalContinuationActivity(messages: readonly AgentMessage[]): string {
	const digests: string[] = [];
	const record = (value: unknown): void => {
		const serialized = stableStringifyJson(value);
		digests.push(`${serialized.length}:${Bun.hash(serialized).toString(16)}`);
	};
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") record(["call", block.name, block.arguments]);
			}
		} else if (message.role === "toolResult") {
			record(["result", message.toolName, message.content, message.isError === true]);
		}
	}
	return digests.join(":");
}
