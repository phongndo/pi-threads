import * as path from "node:path";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { ROOT_THREAD_PATH, asThreadId, asThreadPath, joinThreadPath } from "../src/domain.ts";
import {
	assertPiThreadParams,
	PiThreadParamsSchema,
	StrictPiThreadParamsSchema,
	type PiThreadParams,
} from "../src/schema.ts";
import {
	assertAllowedExtraArgs,
	buildPiArgs,
	collectInheritedPiArgs,
} from "../src/thread-manager.ts";

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

	it("inherits parent runtime resource and restriction args without prompts", () => {
		const parentCwd = "/tmp/parent-project";
		expect(
			collectInheritedPiArgs(
				[
					"/usr/bin/node",
					"/opt/pi/dist/cli.js",
					"--models",
					"sonnet,haiku",
					"--provider",
					"anthropic",
					"--model",
					"sonnet",
					"--tools",
					"read,grep",
					"--exclude-tools",
					"bash",
					"--extension",
					".",
					"--extension",
					"npm:@scope/package",
					"--skill",
					"skills/review",
					"--offline",
					"parent prompt",
				],
				parentCwd,
			),
		).toEqual([
			"--models",
			"sonnet,haiku",
			"--provider",
			"anthropic",
			"--model",
			"sonnet",
			"--tools",
			"read,grep",
			"--exclude-tools",
			"bash",
			"--extension",
			path.resolve(parentCwd),
			"--extension",
			"npm:@scope/package",
			"--skill",
			path.resolve(parentCwd, "skills/review"),
			"--offline",
		]);
	});

	it("does not reinterpret inline assignment parent args as inherited Pi flags", () => {
		expect(
			collectInheritedPiArgs([
				"/usr/bin/node",
				"/opt/pi/dist/cli.js",
				"--provider=anthropic",
				"--model=opus",
				"--models=opus,sonnet",
				"--thinking=high",
				"--tools=read,grep",
				"--exclude-tools=bash",
				"--extension=.",
				"-e=./other-extension",
				"--skill=skills/review",
				"--prompt-template=prompts/default.md",
				"--theme=theme.json",
				"--model",
				"sonnet",
			]),
		).toEqual(["--model", "sonnet"]);
	});

	it("keeps inherited args before extra args and enforced child invariants", () => {
		expect(
			buildPiArgs({
				name: "child",
				inheritedArgs: ["--tools", "read,grep", "--extension", "."],
				extraArgs: ["--model", "sonnet", "--exclude-tools", "bash"],
				projectTrusted: false,
			}),
		).toEqual([
			"--tools",
			"read,grep",
			"--extension",
			".",
			"--model",
			"sonnet",
			"--exclude-tools",
			"bash",
			"--mode",
			"rpc",
			"--name",
			"child",
			"--no-approve",
		]);
	});

	it("rejects child model/provider/thinking overrides when inheriting a model scope", () => {
		const inheritedArgs = ["--models", "sonnet,haiku", "--model", "sonnet"] as const;
		const rejected = [
			["--model", "opus"],
			["--models", "opus"],
			["--provider", "openai"],
			["--thinking", "high"],
		] as const;

		for (const extraArgs of rejected) {
			expect(() =>
				buildPiArgs({
					name: "child",
					inheritedArgs,
					extraArgs,
					projectTrusted: true,
				}),
			).toThrow(/inherited --models scope/u);
		}
	});

	it("merges child tool exclusions with inherited exclusions", () => {
		expect(
			buildPiArgs({
				name: "child",
				inheritedArgs: ["--exclude-tools", "bash,write"],
				extraArgs: ["--exclude-tools", "read,bash"],
				projectTrusted: true,
			}),
		).toEqual([
			"--exclude-tools",
			"bash,write,read",
			"--mode",
			"rpc",
			"--name",
			"child",
			"--approve",
		]);
	});

	it("strips inherited resource enables when child args request matching restrictions", () => {
		expect(
			buildPiArgs({
				name: "child",
				inheritedArgs: [
					"--tools",
					"read,grep",
					"--extension",
					".",
					"--skill",
					"skills/review",
					"--prompt-template",
					"prompts/default.md",
					"--theme",
					"theme.json",
					"--exclude-tools",
					"bash",
				],
				extraArgs: [
					"--no-builtin-tools",
					"--no-extensions",
					"--no-skills",
					"--no-prompt-templates",
					"--no-themes",
				],
				projectTrusted: true,
			}),
		).toEqual([
			"--exclude-tools",
			"bash",
			"--no-tools",
			"--no-builtin-tools",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--mode",
			"rpc",
			"--name",
			"child",
			"--approve",
		]);
	});

	it("filters inherited built-in tool allowlists when child args disable built-ins", () => {
		expect(
			buildPiArgs({
				name: "child",
				inheritedArgs: ["--tools", "read,grep,custom_tool", "--exclude-tools", "bash"],
				extraArgs: ["--no-builtin-tools"],
				projectTrusted: true,
			}),
		).toEqual([
			"--exclude-tools",
			"bash",
			"--tools",
			"custom_tool",
			"--no-builtin-tools",
			"--mode",
			"rpc",
			"--name",
			"child",
			"--approve",
		]);

		expect(
			buildPiArgs({
				name: "child",
				inheritedArgs: ["--tools", "read,grep"],
				extraArgs: ["--no-builtin-tools"],
				projectTrusted: true,
			}),
		).toEqual([
			"--no-tools",
			"--no-builtin-tools",
			"--mode",
			"rpc",
			"--name",
			"child",
			"--approve",
		]);
	});

	it("strips inherited tool allowlists when child args disable all tools", () => {
		expect(
			buildPiArgs({
				name: "child",
				inheritedArgs: ["--tools", "read,grep", "--exclude-tools", "bash"],
				extraArgs: ["--no-tools"],
				projectTrusted: true,
			}),
		).toEqual([
			"--exclude-tools",
			"bash",
			"--no-tools",
			"--mode",
			"rpc",
			"--name",
			"child",
			"--approve",
		]);
	});

	it("preserves explicit resources in inherited exact-load restrictions", () => {
		const parentCwd = "/tmp/parent-project";
		expect(
			collectInheritedPiArgs(
				[
					"/usr/bin/node",
					"/opt/pi/dist/cli.js",
					"--no-extensions",
					"--extension",
					"./pi-threads",
					"--no-skills",
					"--skill",
					"skills/review",
					"--no-builtin-tools",
					"--tools",
					"read,grep",
				],
				parentCwd,
			),
		).toEqual([
			"--no-extensions",
			"--extension",
			path.resolve(parentCwd, "pi-threads"),
			"--no-skills",
			"--skill",
			path.resolve(parentCwd, "skills/review"),
			"--no-builtin-tools",
			"--tools",
			"read,grep",
		]);
	});

	it("rejects one-shot or protocol-breaking args", () => {
		const rejected = [
			["install"],
			["--mode", "json"],
			["--print"],
			["--export", "out.html"],
			["--extension", "."],
			["-e", "."],
			["--session", "abc"],
			["--continue"],
			["-c"],
			["--resume"],
			["-r"],
			["--fork", "abc"],
			["--api-key", "secret"],
			["--approve"],
			["--no-approve"],
			["--tools", "read"],
			["--help"],
			["--version"],
			["--list-models"],
			["--model=sonnet"],
			["plain prompt"],
		] as const;

		for (const args of rejected) {
			expect(() => assertAllowedExtraArgs(args)).toThrow(/Unsupported/u);
		}
	});

	it("allows only safe model and restrictive child args", () => {
		expect(() =>
			assertAllowedExtraArgs([
				"--provider",
				"anthropic",
				"--model",
				"sonnet",
				"--thinking",
				"low",
				"--exclude-tools",
				"bash",
				"--no-builtin-tools",
				"--offline",
			]),
		).not.toThrow();
	});
});
