import { afterEach, describe, expect, it, vi } from "bun:test";
import { GoalAdmission } from "@oh-my-pi/pi-coding-agent/goals/admission";
import { GoalRuntime } from "@oh-my-pi/pi-coding-agent/goals/runtime";
import { type GoalGuard, type GoalGuardContext, type GoalModeState, type GoalRunDecision, type GoalTokenUsage, goalGuardFromModeData, preparedGoalRunId } from "@oh-my-pi/pi-coding-agent/goals/state";

function harness(guarded = true) {
	let state: GoalModeState | undefined = {
		enabled: true, mode: "active", continuationGuard: guarded ? "trusted" : undefined,
		goal: { id: "g1", objective: "Deliver safely", status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 },
	};
	let sessionId = "s1";
	let generation = 0;
	let idle = true;
	let now = 0;
	let usage: GoalTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let guard: GoalGuard | undefined = {
		beforeRun: async () => ({ decision: "allow", additionalContext: "authorized" }),
		beforeComplete: async () => ({ decision: "allow" }),
	};
	const receipts: GoalGuardContext[] = [];
	let commitRun: (() => Promise<void>) | undefined;
	const preparedJournal: Array<{ type: string; customType: string; data: { goalId: string; continuationGuard?: string; sessionId: string; runId: string } }> = [];
	const identity = (context: GoalGuardContext) => ({ goalId: context.goal.goal.id, continuationGuard: context.goal.continuationGuard, sessionId: context.sessionId, runId: context.runId });
	const reasons: string[] = [];
	const journal: Array<{ mode: string; state?: GoalModeState }> = [];
	let admission: GoalAdmission;
	const runtime = new GoalRuntime({
		getState: () => state,
		setState: next => {
			if (state?.goal.id !== next?.goal.id || !next?.enabled || next.goal.status !== "active") admission?.cancel();
			state = next;
		},
		getCurrentUsage: () => usage,
		emit: () => {},
		persist: (mode, persisted) => journal.push({ mode, state: persisted }),
		sendHiddenMessage: async () => {},
		now: () => now,
		beforeComplete: () => admission.beforeComplete(),
		assertOutsideGuard: () => admission.assertOutsideGuard(),
		guardAvailable: () => Boolean(guard),
		captureControlFence: () => {
			const expectedSession = sessionId;
			const expectedGeneration = generation;
			return () => {
				if (sessionId !== expectedSession || generation !== expectedGeneration) throw new Error("Control session changed");
			};
		},
	});
	admission = new GoalAdmission({
		getState: () => state,
		getSessionId: () => sessionId,
		getGeneration: () => generation,
		getGuard: () => guard,
		isAvailable: () => idle,
		pause: async reason => { reasons.push(reason); await runtime.pauseGoal(); },
		recordRunIntent: async context => { preparedJournal.push({ type: "custom", customType: "goal-run-intent", data: identity(context) }); await commitRun?.(); },
		recordRun: context => { receipts.push(context); preparedJournal.push({ type: "custom", customType: "goal-run", data: identity(context) }); },
		recordPreparedRun: async context => {
			if (preparedGoalRunId(preparedJournal, context.goal.goal.id, context.goal.continuationGuard!, context.sessionId) !== context.runId) {
				preparedJournal.push({ type: "custom", customType: "goal-admission-prepared", data: identity(context) });
			}
		},
		getPreparedRunId: (goalId, guardId) => preparedGoalRunId(preparedJournal, goalId, guardId, sessionId),
		retirePreparedRun: (goalId, continuationGuard, sessionId, runId) => { preparedJournal.push({ type: "custom", customType: "goal-admission-retired", data: { goalId, continuationGuard, sessionId, runId } }); },
		getLatestRunId: (goalId, guardId) => {
			const latest = receipts.at(-1);
			return latest?.goal.goal.id === goalId && latest.goal.continuationGuard === guardId && latest.sessionId === sessionId ? latest.runId : undefined;
		},
	});
	return {
		admission, runtime, receipts, reasons, journal, preparedJournal,
		getState: () => state,
		setRunCommit: (commit: () => Promise<void>) => { commitRun = commit; },
		setGuard: (next: GoalGuard | undefined) => { guard = next; },
		setSession: (next: string) => { sessionId = next; generation++; admission.cancel(); },
		setGeneration: () => { generation++; },
		setIdle: (next: boolean) => { idle = next; },
		setBudget: () => { if (state) { state.goal.tokenBudget = 1; state.goal.tokensUsed = 1; } },
		setUsage: (next: GoalTokenUsage) => { usage = next; },
		advance: (seconds: number) => { now += seconds * 1000; },
	};
}

afterEach(() => vi.useRealTimers());

describe("native Goal admission", () => {
	it("ordinary Goals require no guard, retain accounting, and submit unchanged context", async () => {
		const host = harness(false);
		host.setGuard(undefined);
		const submit = vi.fn(async () => {});
		expect(await host.admission.submit(submit)).toBe(true);
		expect(submit).toHaveBeenCalledWith("");
		expect(host.receipts).toHaveLength(0);
		expect(host.preparedJournal).toHaveLength(0);
		host.runtime.onTurnStart("ordinary", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		host.advance(3);
		host.setUsage({ input: 2, output: 1, cacheRead: 100, cacheWrite: 4 });
		await host.runtime.onAgentEnd();
		expect(host.getState()?.goal).toMatchObject({ tokensUsed: 7, timeUsedSeconds: 3 });
	});

	it.each(["session", "generation", "guard", "availability", "abort"] as const)("retains unsubmitted proof when the %s fence closes during intent persistence", async change => {
		const host = harness();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		host.setRunCommit(async () => { entered.resolve(); await release.promise; });
		const run = vi.fn(async () => {});
		const submitted = host.admission.submit(run);
		await entered.promise;
		const parked = preparedGoalRunId(host.preparedJournal, "g1", "trusted", "s1");
		expect(parked).toEqual(expect.any(String));
		if (change === "session") host.setSession("s2");
		else if (change === "generation") host.setGeneration();
		else if (change === "guard") host.setGuard(undefined);
		else if (change === "availability") host.setIdle(false);
		else host.admission.cancel();
		release.resolve();
		expect(await submitted).toBe(false);
		expect(run).not.toHaveBeenCalled();
		expect(host.receipts).toEqual([]);
		expect(preparedGoalRunId(host.preparedJournal, "g1", "trusted", "s1")).toBe(parked);
		await expect(host.admission.beforeComplete()).rejects.toThrow("real matching submitted run");
	});

	it("failed intent persistence creates no submitted proof or completion authority", async () => {
		const host = harness();
		host.setRunCommit(async () => { throw new Error("submitted persistence failed"); });
		const run = vi.fn(async () => {});
		await expect(host.admission.submit(run)).rejects.toThrow("submitted persistence failed");
		expect(run).not.toHaveBeenCalled();
		expect(host.receipts).toEqual([]);
		await expect(host.admission.beforeComplete()).rejects.toThrow("real matching submitted run");
	});

	it("guarded paused creation is durable and cannot replace a live or paused Goal", async () => {
		const host = harness();
		await host.runtime.dropGoal();
		const snapshot = await host.runtime.control({ op: "create", objective: "Paused", continuationGuard: "trusted", paused: true });
		expect(snapshot).toMatchObject({ enabled: false, continuationGuard: "trusted", goal: { status: "paused" } });
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot!.goal)).toBe(true);
		expect(host.journal.at(-1)?.mode).toBe("goal_paused");
		await expect(host.runtime.control({ op: "create", objective: "Another", continuationGuard: "trusted", paused: true })).rejects.toThrow("already has a goal");
		await expect(host.runtime.control({ op: "pause", expectedGoalId: "foreign" })).rejects.toThrow("identity mismatch");
		await host.runtime.control({ op: "resume", expectedGoalId: snapshot!.goal.id });
		await expect(host.runtime.replaceGoal({ objective: "model rewrite" })).rejects.toThrow("guarded Goal");
	});

	it("native wait retains one reservation/candidate and records nothing until submission", async () => {
		vi.useFakeTimers();
		const host = harness();
		const probed = Promise.withResolvers<void>();
		const contexts: GoalGuardContext[] = [];
		host.setGuard({ beforeRun: async context => {
			contexts.push(context);
			if (contexts.length === 1) { probed.resolve(); return { decision: "wait", retryAt: Date.now() + 1000, reason: "lease pending" }; }
			return { decision: "allow", additionalContext: "approved" };
		}, beforeComplete: async () => ({ decision: "allow" }) });
		const submit = vi.fn(async () => {});
		const pending = host.admission.submit(submit);
		await probed.promise;
		await Promise.resolve();
		await Promise.resolve();
		expect(host.receipts).toHaveLength(0);
		expect(await host.admission.submit(submit)).toBe(false);
		for (let tick = 0; tick < 8; tick++) await Promise.resolve();
		vi.advanceTimersByTime(1000);
		expect(await pending).toBe(true);
		expect(contexts).toHaveLength(2);
		expect(contexts[1].runId).toBe(contexts[0].runId);
		expect(host.receipts[0].runId).toBe(contexts[0].runId);
		expect(submit).toHaveBeenCalledTimes(1);
	});

	it("abort unwinds a guard that ignores cancellation and rejects its late allow", async () => {
		const host = harness();
		const entered = Promise.withResolvers<GoalGuardContext>();
		const decision = Promise.withResolvers<GoalRunDecision>();
		host.setGuard({ beforeRun: async context => { entered.resolve(context); return decision.promise; }, beforeComplete: async () => ({ decision: "allow" }) });
		const submit = vi.fn(async () => {});
		const pending = host.admission.submit(submit);
		const context = await entered.promise;
		host.admission.cancel();
		expect(await pending).toBe(false);
		expect(context.signal.aborted).toBe(true);
		decision.resolve({ decision: "allow", additionalContext: "late" });
		await Promise.resolve();
		expect(submit).not.toHaveBeenCalled();
		expect(host.receipts).toHaveLength(0);
	});

	it.each(["session", "generation", "idle", "budget", "handler"])("fences a late allow when %s changes", async change => {
		const host = harness();
		const entered = Promise.withResolvers<void>();
		const decision = Promise.withResolvers<GoalRunDecision>();
		host.setGuard({ beforeRun: async () => { entered.resolve(); return decision.promise; }, beforeComplete: async () => ({ decision: "allow" }) });
		const submit = vi.fn(async () => {});
		const pending = host.admission.submit(submit);
		await entered.promise;
		if (change === "session") host.setSession("s2");
		if (change === "generation") host.setGeneration();
		if (change === "idle") host.setIdle(false);
		if (change === "budget") host.setBudget();
		if (change === "handler") host.setGuard(undefined);
		decision.resolve({ decision: "allow", additionalContext: "late" });
		expect(await pending).toBe(false);
		expect(submit).not.toHaveBeenCalled();
		expect(host.receipts).toHaveLength(0);
	});

	it.each(["pause", "block"] as const)("%s persists paused without model work or fabricated run identity", async decision => {
		const host = harness();
		host.setGuard({ beforeRun: async () => ({ decision, reason: "authority unavailable" }), beforeComplete: async () => ({ decision: "allow" }) });
		const submit = vi.fn(async () => {});
		expect(await host.admission.submit(submit)).toBe(false);
		expect(host.getState()?.goal.status).toBe("paused");
		expect(host.reasons).toEqual(["authority unavailable"]);
		expect(host.journal.at(-1)?.mode).toBe("goal_paused");
		expect(submit).not.toHaveBeenCalled();
		expect(host.receipts).toHaveLength(0);
	});

	it("missing guard restoration blocks immediately instead of becoming an ordinary Goal", async () => {
		const host = harness();
		host.setGuard(undefined);
		await host.runtime.onThreadResumed({ preserveActiveGoal: true });
		expect(host.getState()).toMatchObject({ enabled: false, continuationGuard: "trusted", goal: { status: "paused" } });
		expect(goalGuardFromModeData({ continuationGuard: "trusted" })).toBe("trusted");
		expect(() => goalGuardFromModeData({ continuationGuard: 42 })).toThrow("persisted Goal");
	});

	it("completion cannot invent a run and control from a guard is rejected without deadlocking", async () => {
		const host = harness();
		await expect(host.runtime.completeGoalFromTool()).rejects.toThrow("real matching submitted run");
		host.setGuard({ beforeRun: async () => {
			await expect(host.runtime.control({ op: "pause", expectedGoalId: "g1" })).rejects.toThrow("control inside a guard");
			return { decision: "allow", additionalContext: "allowed" };
		}, beforeComplete: async () => ({ decision: "block", reason: "original Turn unsettled" }) });
		await host.admission.submit(async () => {});
		await expect(host.runtime.completeGoalFromTool()).rejects.toThrow("original Turn unsettled");
		expect(host.getState()?.goal.status).toBe("active");
	});

	it("trusted resumeRunId reuses only the latest real same-session receipt and completion sees the effective id", async () => {
		const host = harness();
		let resumeRunId: string | undefined;
		const candidates: string[] = [];
		let completed: string | undefined;
		host.setGuard({ beforeRun: async context => { candidates.push(context.runId); return { decision: "allow", additionalContext: "original settlement", resumeRunId }; }, beforeComplete: async context => { completed = context.runId; return { decision: "allow" }; } });
		await host.admission.submit(async () => {});
		resumeRunId = host.receipts[0].runId;
		await host.admission.submit(async () => {});
		expect(candidates[1]).not.toBe(candidates[0]);
		expect(host.receipts[1].runId).toBe(host.receipts[0].runId);
		await host.runtime.completeGoalFromTool();
		expect(completed).toBe(resumeRunId);
	});

	it("fresh work omits resumeRunId and never implicitly reuses a completed journal identity", async () => {
		const host = harness();
		await host.admission.submit(async () => {});
		host.admission.cancel();
		await host.admission.submit(async () => {});
		expect(host.receipts[1].runId).not.toBe(host.receipts[0].runId);
	});

	it("foreign or non-journaled resumeRunId is rejected before real work", async () => {
		const host = harness();
		host.setGuard({ beforeRun: async () => ({ decision: "allow", additionalContext: "forged", resumeRunId: "not-submitted" }), beforeComplete: async () => ({ decision: "allow" }) });
		const submit = vi.fn(async () => {});
		await expect(host.admission.submit(submit)).rejects.toThrow("latest submitted run");
		expect(submit).not.toHaveBeenCalled();
		expect(host.receipts).toHaveLength(0);
	});

	it("native internal continuation retains the real submitted identity", async () => {
		const host = harness();
		await host.admission.submit(async () => {});
		await host.admission.submit(async () => {}, () => true, true);
		expect(host.receipts[1].runId).toBe(host.receipts[0].runId);
	});

	it("guarded idle/wait time is not billed while real turn tokens/time are accounted once", async () => {
		const host = harness();
		await host.runtime.pauseGoal();
		await host.runtime.resumeGoal();
		host.advance(100);
		await host.runtime.flushUsage("suppressed");
		expect(host.getState()?.goal.timeUsedSeconds).toBe(0);
		host.runtime.onTurnStart("actual", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		host.advance(2);
		host.setUsage({ input: 3, output: 2, cacheRead: 100, cacheWrite: 1 });
		await host.runtime.onAgentEnd();
		host.advance(100);
		await host.runtime.pauseGoal();
		expect(host.getState()?.goal).toMatchObject({ tokensUsed: 6, timeUsedSeconds: 2 });
	});
	it.each(["foreign-session", "foreign-goal"])("resumeRunId rejects a receipt from %s", async change => {
		const host = harness();
		await host.admission.submit(async () => {});
		const original = host.receipts[0].runId;
		if (change === "foreign-session") host.setSession("s2");
		else {
			await host.runtime.dropGoal();
			const goal = await host.runtime.control({ op: "create", objective: "Other Goal", continuationGuard: "trusted", paused: true });
			await host.runtime.control({ op: "resume", expectedGoalId: goal!.goal.id });
		}
		host.setGuard({ beforeRun: async () => ({ decision: "allow", additionalContext: "foreign", resumeRunId: original }), beforeComplete: async () => ({ decision: "allow" }) });
		const submit = vi.fn(async () => {});
		await expect(host.admission.submit(submit)).rejects.toThrow("latest submitted run");
		expect(submit).not.toHaveBeenCalled();
		expect(host.receipts).toHaveLength(1);
	});
	it("serialized controls reject a session change while waiting for native accounting", async () => {
		const host = harness();
		await host.runtime.pauseGoal();
		const pending = host.runtime.control({ op: "resume", expectedGoalId: "g1" });
		host.setSession("s2");
		await expect(pending).rejects.toThrow("Control session changed");
		expect(host.getState()?.goal.status).toBe("paused");
	});
	it("malformed guard output is an explicit paused protocol failure, never a silent success", async () => {
		const host = harness();
		host.setGuard({ beforeRun: async () => undefined as unknown as GoalRunDecision, beforeComplete: async () => ({ decision: "allow" }) });
		const submit = vi.fn(async () => {});
		await expect(host.admission.submit(submit)).rejects.toThrow("returned no decision");
		expect(host.getState()?.goal.status).toBe("paused");
		expect(host.reasons).toEqual(["Goal guard returned no decision"]);
		expect(submit).not.toHaveBeenCalled();
		expect(host.receipts).toHaveLength(0);
	});
});
