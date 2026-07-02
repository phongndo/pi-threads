import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { ROOT_THREAD_PATH, asThreadId, asThreadPath, joinThreadPath } from "../src/domain.ts";
import {
	assertPiThreadParams,
	PiThreadParamsSchema,
	StrictPiThreadParamsSchema,
	type PiThreadParams,
} from "../src/schema.ts";
import { assertAllowedExtraArgs, buildPiArgs } from "../src/thread-manager.ts";

describe("thread schemas", () => {
	it("exposes an object-root provider schema", () => {
		expect(PiThreadParamsSchema.type).toBe("object");
		expect("anyOf" in PiThreadParamsSchema).toBe(false);
		expect("oneOf" in PiThreadParamsSchema).toBe(false);
	});

	it("accepts each valid action shape", () => {
		const valid: readonly PiThreadParams[] = [
			{ action: "start", prompt: "Inspect the repo", taskName: "inspect_repo", forkTurns: "2" },
			{ action: "list", state: "live", ancestor: "/root" },
			{ action: "poll", id: "/root/inspect_repo" },
			{ action: "send", id: "thread_012345abcdef", message: "Continue", mode: "follow_up" },
			{ action: "wait", id: "inspect_repo", timeoutMs: 10_000 },
			{ action: "stop", id: "thread_012345abcdef", force: true },
		];

		for (const input of valid) {
			expect(Value.Check(PiThreadParamsSchema, input)).toBe(true);
			expect(Value.Check(StrictPiThreadParamsSchema, input)).toBe(true);
			expect(() => assertPiThreadParams(input)).not.toThrow();
		}
	});

	it("strictly rejects impossible action/field combinations", () => {
		const invalid = [
			{ action: "start", id: "thread_012345abcdef" },
			{ action: "list", id: "thread_012345abcdef" },
			{ action: "poll", prompt: "nope" },
			{ action: "send", id: "thread_012345abcdef" },
			{ action: "stop", prompt: "nope" },
			{ action: "wait", id: "thread_012345abcdef", timeoutMs: -1 },
			{ action: "start", prompt: "x", taskName: "Bad Name" },
			{ action: "start", prompt: "x", forkTurns: "0" },
			{ action: "list", parent: "/root/a", ancestor: "/root" },
			{ action: "unknown" },
		] as const;

		for (const input of invalid) {
			expect(Value.Check(StrictPiThreadParamsSchema, input)).toBe(false);
			expect(() => assertPiThreadParams(input)).toThrow(/Invalid thread parameters/u);
		}
	});
});

describe("ThreadId", () => {
	it("brands valid ids and rejects invalid ids", () => {
		expect(asThreadId("thread_012345abcdef")).toBe("thread_012345abcdef");
		expect(() => asThreadId("abc")).toThrow(/Invalid thread id/u);
	});
});

describe("ThreadPath", () => {
	it("validates canonical paths", () => {
		expect(asThreadPath("/root/inspect_repo")).toBe("/root/inspect_repo");
		expect(joinThreadPath(ROOT_THREAD_PATH, "child_1")).toBe("/root/child_1");
		expect(() => asThreadPath("root/nope")).toThrow(/Invalid thread path/u);
		expect(() => joinThreadPath(ROOT_THREAD_PATH, "Bad Name")).toThrow(/Invalid task name/u);
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
