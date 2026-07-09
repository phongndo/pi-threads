import { describe, expect, it } from "vitest";
import {
	acceptedInitialPromptState,
	acceptedSendState,
	transitionAwaitingSend,
	type AwaitingSend,
} from "../src/awaiting-send.ts";

const awaitingActivity = acceptedInitialPromptState(0);
const waitingSettle = acceptedSendState({
	observedActivity: false,
	ignoreRunActivityUntilIdle: false,
	idleRefreshesToSettle: 1,
	pendingMessageBaseline: 0,
});
const waitingBusySettle = acceptedSendState({
	observedActivity: false,
	ignoreRunActivityUntilIdle: true,
	idleRefreshesToSettle: 2,
	pendingMessageBaseline: 1,
});
const observed = acceptedSendState({
	observedActivity: true,
	ignoreRunActivityUntilIdle: false,
	idleRefreshesToSettle: 1,
	pendingMessageBaseline: null,
});

describe("awaiting-send state machine", () => {
	it("constructs named states for initial prompt and accepted send", () => {
		expect(awaitingActivity).toEqual({
			kind: "awaiting_activity",
			pendingMessageBaseline: 0,
		});
		expect(waitingSettle).toEqual({
			kind: "waiting_for_idle_settle",
			remainingConfirmations: 1,
			pendingMessageBaseline: 0,
			ignoreRunActivityUntilIdle: false,
		});
		expect(waitingBusySettle).toEqual({
			kind: "waiting_for_idle_settle",
			remainingConfirmations: 2,
			pendingMessageBaseline: 1,
			ignoreRunActivityUntilIdle: true,
		});
		expect(observed).toEqual({ kind: "observed_activity" });
	});

	it("run_activity observes work unless pre-existing run activity is ignored", () => {
		expect(transitionAwaitingSend(awaitingActivity, { type: "run_activity" })).toEqual({
			state: { kind: "observed_activity" },
			observedNewActivity: false,
			phase: undefined,
		});
		expect(transitionAwaitingSend(waitingSettle, { type: "run_activity" })).toEqual({
			state: { kind: "observed_activity" },
			observedNewActivity: false,
			phase: undefined,
		});
		expect(transitionAwaitingSend(waitingBusySettle, { type: "run_activity" })).toEqual({
			state: waitingBusySettle,
			observedNewActivity: false,
			phase: undefined,
		});
		expect(transitionAwaitingSend(observed, { type: "run_activity" })).toEqual({
			state: observed,
			observedNewActivity: false,
			phase: undefined,
		});
	});

	it("allow_run_activity clears the ignore flag on waiting_for_idle_settle", () => {
		expect(transitionAwaitingSend(waitingBusySettle, { type: "allow_run_activity" })).toEqual({
			state: {
				kind: "waiting_for_idle_settle",
				remainingConfirmations: 2,
				pendingMessageBaseline: 1,
				ignoreRunActivityUntilIdle: false,
			},
			observedNewActivity: false,
			phase: undefined,
		});
		expect(transitionAwaitingSend(waitingSettle, { type: "allow_run_activity" })).toEqual({
			state: waitingSettle,
			observedNewActivity: false,
			phase: undefined,
		});
		expect(transitionAwaitingSend(awaitingActivity, { type: "allow_run_activity" })).toEqual({
			state: awaitingActivity,
			observedNewActivity: false,
			phase: undefined,
		});
	});

	it("pending_messages observes only when the queue grows past the baseline", () => {
		expect(
			transitionAwaitingSend(awaitingActivity, { type: "pending_messages", count: 0 }),
		).toEqual({
			state: awaitingActivity,
			observedNewActivity: false,
			phase: undefined,
		});
		expect(
			transitionAwaitingSend(awaitingActivity, { type: "pending_messages", count: 1 }),
		).toEqual({
			state: { kind: "observed_activity" },
			observedNewActivity: true,
			phase: undefined,
		});
		expect(
			transitionAwaitingSend(waitingBusySettle, { type: "pending_messages", count: 2 }),
		).toEqual({
			state: { kind: "observed_activity" },
			observedNewActivity: true,
			phase: undefined,
		});
		expect(
			transitionAwaitingSend(waitingBusySettle, { type: "pending_messages", count: 1 }),
		).toEqual({
			state: waitingBusySettle,
			observedNewActivity: false,
			phase: undefined,
		});
		expect(transitionAwaitingSend(observed, { type: "pending_messages", count: 9 })).toEqual({
			state: observed,
			observedNewActivity: false,
			phase: undefined,
		});

		const nullBaseline = acceptedInitialPromptState(null);
		expect(transitionAwaitingSend(nullBaseline, { type: "pending_messages", count: 0 })).toEqual({
			state: { kind: "observed_activity" },
			observedNewActivity: true,
			phase: undefined,
		});
	});

	it("child_appears_idle settles idle sends after the configured confirmations", () => {
		// Idle-accepted send: one confirmation settles immediately.
		expect(transitionAwaitingSend(waitingSettle, { type: "child_appears_idle" })).toEqual({
			state: null,
			observedNewActivity: false,
			phase: "idle",
		});

		// Busy-accepted send: first idle confirmation keeps busy; second settles.
		const afterFirst = transitionAwaitingSend(waitingBusySettle, {
			type: "allow_run_activity",
		}).state as AwaitingSend;
		const mid = transitionAwaitingSend(afterFirst, { type: "child_appears_idle" });
		expect(mid).toEqual({
			state: {
				kind: "waiting_for_idle_settle",
				remainingConfirmations: 1,
				pendingMessageBaseline: 1,
				ignoreRunActivityUntilIdle: false,
			},
			observedNewActivity: false,
			phase: "busy",
		});
		expect(transitionAwaitingSend(mid.state!, { type: "child_appears_idle" })).toEqual({
			state: null,
			observedNewActivity: false,
			phase: "idle",
		});
	});

	it("child_appears_idle keeps initial prompts busy until activity is observed", () => {
		expect(transitionAwaitingSend(awaitingActivity, { type: "child_appears_idle" })).toEqual({
			state: awaitingActivity,
			observedNewActivity: false,
			phase: "busy",
		});
	});

	it("child_appears_idle clears observed activity as idle", () => {
		expect(transitionAwaitingSend(observed, { type: "child_appears_idle" })).toEqual({
			state: null,
			observedNewActivity: false,
			phase: "idle",
		});
	});

	it("clear_if_idle only drops observed_activity while the thread is idle", () => {
		expect(transitionAwaitingSend(observed, { type: "clear_if_idle", phase: "idle" })).toEqual({
			state: null,
			observedNewActivity: false,
			phase: undefined,
		});
		expect(transitionAwaitingSend(observed, { type: "clear_if_idle", phase: "busy" })).toEqual({
			state: observed,
			observedNewActivity: false,
			phase: undefined,
		});
		expect(transitionAwaitingSend(waitingSettle, { type: "clear_if_idle", phase: "idle" })).toEqual(
			{
				state: waitingSettle,
				observedNewActivity: false,
				phase: undefined,
			},
		);
	});

	it("covers the accepted-idle-send-without-agent-activity path", () => {
		// recordAcceptedSend while idle → waiting_for_idle_settle(1)
		// refresh sees idle → allow_run_activity (no-op) → child_appears_idle settles
		let state: AwaitingSend | null = acceptedSendState({
			observedActivity: false,
			ignoreRunActivityUntilIdle: false,
			idleRefreshesToSettle: 1,
			pendingMessageBaseline: 0,
		});
		state = transitionAwaitingSend(state, { type: "allow_run_activity" }).state;
		const settled = transitionAwaitingSend(state!, { type: "child_appears_idle" });
		expect(settled.state).toBeNull();
		expect(settled.phase).toBe("idle");
	});

	it("covers the initial-prompt-must-observe-activity path", () => {
		let state: AwaitingSend | null = acceptedInitialPromptState(0);
		// Early idle-looking refresh must not settle.
		state = transitionAwaitingSend(state, { type: "allow_run_activity" }).state;
		const early = transitionAwaitingSend(state!, { type: "child_appears_idle" });
		expect(early.state?.kind).toBe("awaiting_activity");
		expect(early.phase).toBe("busy");

		// Real activity then idle settle.
		state = transitionAwaitingSend(early.state!, { type: "run_activity" }).state;
		expect(state).toEqual({ kind: "observed_activity" });
		const done = transitionAwaitingSend(state!, { type: "child_appears_idle" });
		expect(done.state).toBeNull();
		expect(done.phase).toBe("idle");
	});
});
