import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { asThreadId } from "../src/domain.ts";
import { PiThreadParamsSchema, type PiThreadParams } from "../src/schema.ts";
import { assertAllowedExtraArgs, buildPiArgs } from "../src/thread-manager.ts";

describe("pi_thread tagged union schema", () => {
	it("accepts each valid action shape", () => {
		const valid: readonly PiThreadParams[] = [
			{ action: "start", prompt: "Inspect the repo" },
			{ action: "list" },
			{ action: "poll", id: "thread_012345abcdef" },
			{ action: "send", id: "thread_012345abcdef", message: "Continue", mode: "follow_up" },
			{ action: "stop", id: "thread_012345abcdef", force: true },
		];

		for (const input of valid) expect(Value.Check(PiThreadParamsSchema, input)).toBe(true);
	});

	it("rejects impossible action/field combinations", () => {
		const invalid = [
			{ action: "start", id: "thread_012345abcdef" },
			{ action: "list", id: "thread_012345abcdef" },
			{ action: "poll", prompt: "nope" },
			{ action: "send", id: "thread_012345abcdef" },
			{ action: "stop", prompt: "nope" },
			{ action: "unknown" },
		] as const;

		for (const input of invalid) expect(Value.Check(PiThreadParamsSchema, input)).toBe(false);
	});
});

describe("ThreadId", () => {
	it("brands valid ids and rejects invalid ids", () => {
		expect(asThreadId("thread_012345abcdef")).toBe("thread_012345abcdef");
		expect(() => asThreadId("abc")).toThrow(/Invalid thread id/u);
	});
});

describe("child Pi argv", () => {
	it("keeps RPC mode invariant after extra args", () => {
		expect(
			buildPiArgs({ name: "child", extraArgs: ["--model", "sonnet"], projectTrusted: true }),
		).toEqual(["--model", "sonnet", "--mode", "rpc", "--name", "child", "--approve"]);
	});

	it("rejects one-shot or protocol-breaking args", () => {
		expect(() => assertAllowedExtraArgs(["--mode", "json"])).toThrow(/Unsupported/u);
		expect(() => assertAllowedExtraArgs(["--print"])).toThrow(/Unsupported/u);
		expect(() => assertAllowedExtraArgs(["--export", "out.html"])).toThrow(/Unsupported/u);
	});
});
