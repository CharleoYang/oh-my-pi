import { AsyncLocalStorage } from "node:async_hooks";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { type GoalGuard, type GoalGuardContext, type GoalModeState, goalSnapshot } from "./state";

export interface GoalAdmissionHost {
	getState(): GoalModeState | undefined;
	getSessionId(): string;
	getGeneration(): number;
	getGuard(id: string): GoalGuard | undefined;
	isAvailable(): boolean;
	pause(reason: string): Promise<void>;
	recordRunIntent(context: GoalGuardContext): Promise<void>;
	recordRun(context: GoalGuardContext): void;
	recordPreparedRun(context: GoalGuardContext): Promise<void>;
	getPreparedRunId(goalId: string, guardId: string): string | undefined;
	retirePreparedRun(goalId: string, guardId: string, sessionId: string, runId: string): void;
	getLatestRunId?(goalId: string, guardId: string): string | undefined;
}

/** Native reservation and final submission seam shared by every host surface. */
export class GoalAdmission {
	readonly #host: GoalAdmissionHost;
	readonly #callback = new AsyncLocalStorage<boolean>();
	#reservation: AbortController | undefined;
	#lastRun: { context: GoalGuardContext; guard: GoalGuard; generation: number; controller: AbortController } | undefined;

	constructor(host: GoalAdmissionHost) { this.#host = host; }

	assertOutsideGuard(): void {
		if (this.#callback.getStore()) throw new Error("Goal guards return decisions; control inside a guard is forbidden");
	}

	getPreparedRunId(): string | undefined {
		const state = this.#host.getState();
		if (!state?.continuationGuard || state.goal.status === "complete" || !this.#host.getGuard(state.continuationGuard)) return undefined;
		return this.#host.getPreparedRunId(state.goal.id, state.continuationGuard);
	}

	retirePreparedRun(runId: string): void {
		this.assertOutsideGuard();
		const state = this.#host.getState();
		if (!state?.continuationGuard || typeof runId !== "string" || !runId.trim() || this.getPreparedRunId() !== runId) {
			throw new Error("Goal prepared retirement requires the current matching unsubmitted admission");
		}
		this.#host.retirePreparedRun(state.goal.id, state.continuationGuard, this.#host.getSessionId(), runId);
		this.#reservation?.abort();
	}

	cancel(): void {
		this.#reservation?.abort();
		this.#lastRun?.controller.abort();
		this.#lastRun = undefined;
	}

	async #cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
		if (signal.aborted) return undefined;
		const cancelled = Promise.withResolvers<undefined>();
		const abort = () => cancelled.resolve(undefined);
		signal.addEventListener("abort", abort, { once: true });
		try { return await Promise.race([work, cancelled.promise]); }
		finally { signal.removeEventListener("abort", abort); }
	}

	async submit(run: (additionalContext: string) => Promise<void>, available: () => boolean = () => true, reuseRun = false): Promise<boolean> {
		const state = this.#host.getState();
		if (!state?.continuationGuard) { await run(""); return true; }
		if (this.#reservation || !state.enabled || state.goal.status !== "active") return false;
		const controller = new AbortController();
		this.#reservation = controller;
		const generation = this.#host.getGeneration();
		const sessionId = this.#host.getSessionId();
		const guard = this.#host.getGuard(state.continuationGuard);
		const previous = this.#lastRun;
		const preparedRunId = this.getPreparedRunId();
		const reusable = preparedRunId === undefined && reuseRun && previous?.context.goal.goal.id === state.goal.id && previous.context.sessionId === sessionId && previous.guard === guard && previous.generation === generation;
		const runId = reusable ? previous.context.runId : preparedRunId ?? String(Snowflake.next());
		let prepared = reusable;
		const current = () => {
			const latest = this.#host.getState();
			return !controller.signal.aborted && generation === this.#host.getGeneration() &&
				sessionId === this.#host.getSessionId() && latest?.goal.id === state.goal.id &&
				latest.continuationGuard === state.continuationGuard && latest.enabled && latest.goal.status === "active" &&
				(latest.goal.tokenBudget === undefined || latest.goal.tokensUsed < latest.goal.tokenBudget) &&
				this.#host.getGuard(state.continuationGuard!) === guard && this.#host.isAvailable() && available();
		};
		try {
			if (!guard) { await this.#host.pause(`Missing Goal guard: ${state.continuationGuard}`); return false; }
			while (current()) {
				const context: GoalGuardContext = Object.freeze({ goal: goalSnapshot(this.#host.getState())!, sessionId, runId, signal: controller.signal });
				if (!prepared) {
					await this.#host.recordPreparedRun(context);
					prepared = true;
				}
				if (!current()) return false;
				const decision = await this.#cancellable(this.#callback.run(true, () => guard.beforeRun(context)), controller.signal);
				if (!decision) {
					if (controller.signal.aborted) return false;
					throw new Error("Goal guard returned no decision");
				}
				if (!current()) return false;
				if (decision.decision === "allow") {
					if (typeof decision.additionalContext !== "string") throw new Error("Invalid Goal guard allow context");
					if (decision.resumeRunId !== undefined && (typeof decision.resumeRunId !== "string" || decision.resumeRunId !== this.#host.getLatestRunId?.(state.goal.id, state.continuationGuard))) {
						throw new Error("Goal resumeRunId does not match the latest submitted run in this Goal/session");
					}
					const submittedContext = decision.resumeRunId ? Object.freeze({ ...context, runId: decision.resumeRunId }) : context;
					// Durable intent is not submitted proof; fences may still close during its write.
					await this.#host.recordRunIntent(submittedContext);
					if (!current()) return false;
					// Publish proof only at dispatch, without an await after the final fence.
					this.#host.recordRun(submittedContext);
					this.#lastRun = { context: submittedContext, guard, generation, controller };
					await run(decision.additionalContext);
					return true;
				}
				if (decision.decision === "wait") {
					if (!Number.isFinite(decision.retryAt)) throw new Error("Invalid Goal guard retryAt");
					const wake = Promise.withResolvers<void>();
					const timer = setTimeout(wake.resolve, Math.max(0, Math.min(decision.retryAt - Date.now(), 2_147_483_647)));
					try { await this.#cancellable(wake.promise, controller.signal); }
					finally { clearTimeout(timer); }
					continue;
				}
				if (decision.decision !== "pause" && decision.decision !== "block") throw new Error("Invalid Goal guard decision");
				if (typeof decision.reason !== "string") throw new Error("Invalid Goal guard reason");
				await this.#host.pause(decision.reason);
				return false;
			}
			return false;
		} catch (error) {
			if (current()) await this.#host.pause(error instanceof Error ? error.message : String(error));
			throw error;
		} finally {
			const latest = this.#host.getState();
			if (!controller.signal.aborted && sessionId === this.#host.getSessionId() && latest?.goal.id === state.goal.id && latest.enabled && guard !== this.#host.getGuard(state.continuationGuard)) {
				await this.#host.pause("Goal guard generation changed or was unloaded");
			}
			if (this.#reservation === controller) this.#reservation = undefined;
		}
	}

	async beforeComplete(): Promise<void> {
		const state = this.#host.getState();
		if (!state?.continuationGuard) return;
		const run = this.#lastRun;
		const current = () => run && run.context.goal.goal.id === this.#host.getState()?.goal.id &&
			run.context.sessionId === this.#host.getSessionId() && run.generation === this.#host.getGeneration() &&
			this.#host.getGuard(state.continuationGuard!) === run.guard && !run.context.signal.aborted;
		if (!current() || !run) throw new Error("Guarded Goal completion requires a real matching submitted run");
		const context = Object.freeze({ ...run.context, goal: goalSnapshot(state)! });
		const result = await this.#cancellable(this.#callback.run(true, () => run.guard.beforeComplete(context)), context.signal);
		if (!current() || !result) throw new Error("Goal completion admission became stale");
		if (result.decision !== "allow") throw new Error(result.reason || "Goal completion blocked");
	}
}
