import type { ThreadPhase } from "./domain.ts";

/**
 * Explicit send-acceptance state machine.
 *
 * Replaces the previous free-boolean AwaitingSend shape:
 * - awaiting_activity: initial prompt accepted; stay busy until real activity
 * - waiting_for_idle_settle: send accepted; settle after N idle confirmations
 *   (optionally ignore pre-existing run activity until the current turn ends)
 * - observed_activity: send/prompt work observed; clear once the thread is idle
 */
export type AwaitingSend =
	| {
			readonly kind: "awaiting_activity";
			readonly pendingMessageBaseline: number | null;
	  }
	| {
			readonly kind: "waiting_for_idle_settle";
			readonly remainingConfirmations: number;
			readonly pendingMessageBaseline: number | null;
			readonly ignoreRunActivityUntilIdle: boolean;
	  }
	| {
			readonly kind: "observed_activity";
	  };

export type AwaitingSendEvent =
	| { readonly type: "run_activity" }
	| { readonly type: "allow_run_activity" }
	| { readonly type: "pending_messages"; readonly count: number }
	| { readonly type: "child_appears_idle" }
	| { readonly type: "clear_if_idle"; readonly phase: ThreadPhase };

export type AwaitingSendTransition = {
	readonly state: AwaitingSend | null;
	/** Set by pending_messages when the queue proves new accepted work. */
	readonly observedNewActivity: boolean;
	/** Suggested phase after child_appears_idle; undefined for other events. */
	readonly phase: ThreadPhase | undefined;
};

export function acceptedSendState(input: {
	readonly observedActivity: boolean;
	readonly ignoreRunActivityUntilIdle: boolean;
	readonly idleRefreshesToSettle: number;
	readonly pendingMessageBaseline: number | null;
}): AwaitingSend {
	if (input.observedActivity) return { kind: "observed_activity" };
	return {
		kind: "waiting_for_idle_settle",
		remainingConfirmations: input.idleRefreshesToSettle,
		pendingMessageBaseline: input.pendingMessageBaseline,
		ignoreRunActivityUntilIdle: input.ignoreRunActivityUntilIdle,
	};
}

export function acceptedInitialPromptState(pendingMessageBaseline: number | null): AwaitingSend {
	return {
		kind: "awaiting_activity",
		pendingMessageBaseline,
	};
}

export function transitionAwaitingSend(
	state: AwaitingSend,
	event: AwaitingSendEvent,
): AwaitingSendTransition {
	switch (event.type) {
		case "run_activity":
			return transitionRunActivity(state);
		case "allow_run_activity":
			return transitionAllowRunActivity(state);
		case "pending_messages":
			return transitionPendingMessages(state, event.count);
		case "child_appears_idle":
			return transitionChildAppearsIdle(state);
		case "clear_if_idle":
			return transitionClearIfIdle(state, event.phase);
	}
}

function idleResult(state: AwaitingSend): AwaitingSendTransition {
	return { state, observedNewActivity: false, phase: undefined };
}

function transitionRunActivity(state: AwaitingSend): AwaitingSendTransition {
	if (state.kind === "waiting_for_idle_settle" && state.ignoreRunActivityUntilIdle) {
		return idleResult(state);
	}
	if (state.kind === "observed_activity") return idleResult(state);
	return { state: { kind: "observed_activity" }, observedNewActivity: false, phase: undefined };
}

function transitionAllowRunActivity(state: AwaitingSend): AwaitingSendTransition {
	if (state.kind === "waiting_for_idle_settle" && state.ignoreRunActivityUntilIdle) {
		return {
			state: { ...state, ignoreRunActivityUntilIdle: false },
			observedNewActivity: false,
			phase: undefined,
		};
	}
	return idleResult(state);
}

function transitionPendingMessages(state: AwaitingSend, count: number): AwaitingSendTransition {
	if (state.kind === "observed_activity") {
		return { state, observedNewActivity: false, phase: undefined };
	}
	const baseline = state.pendingMessageBaseline;
	if (baseline === null || count > baseline) {
		return {
			state: { kind: "observed_activity" },
			observedNewActivity: true,
			phase: undefined,
		};
	}
	return { state, observedNewActivity: false, phase: undefined };
}

function transitionChildAppearsIdle(state: AwaitingSend): AwaitingSendTransition {
	// Precondition: allow_run_activity has already been applied for this refresh.
	if (state.kind === "observed_activity") {
		return { state: null, observedNewActivity: false, phase: "idle" };
	}
	if (state.kind === "awaiting_activity") {
		return { state, observedNewActivity: false, phase: "busy" };
	}
	const remaining = state.remainingConfirmations - 1;
	if (remaining <= 0) {
		return { state: null, observedNewActivity: false, phase: "idle" };
	}
	return {
		state: { ...state, remainingConfirmations: remaining },
		observedNewActivity: false,
		phase: "busy",
	};
}

function transitionClearIfIdle(state: AwaitingSend, phase: ThreadPhase): AwaitingSendTransition {
	if (state.kind === "observed_activity" && phase === "idle") {
		return { state: null, observedNewActivity: false, phase: undefined };
	}
	return idleResult(state);
}
