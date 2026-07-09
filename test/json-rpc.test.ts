import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { attachJsonlReader } from "../src/json.ts";
import { RpcClient, RpcTimeoutError, type RpcClientEvent } from "../src/rpc.ts";

describe("attachJsonlReader", () => {
	it("handles partial chunks", async () => {
		const stream = new PassThrough();
		const lines: string[] = [];
		attachJsonlReader(stream, (line) => lines.push(line));

		stream.write("hel");
		expect(lines).toEqual([]);

		stream.write("lo\nwo");
		expect(lines).toEqual(["hello"]);

		await endStream(stream, "rld\n");
		expect(lines).toEqual(["hello", "world"]);
	});

	it("strips CRLF line endings", async () => {
		const stream = new PassThrough();
		const lines: string[] = [];
		attachJsonlReader(stream, (line) => lines.push(line));

		await endStream(stream, "alpha\r\nbeta\r\n");

		expect(lines).toEqual(["alpha", "beta"]);
	});

	it("emits the final line on end", async () => {
		const stream = new PassThrough();
		const lines: string[] = [];
		attachJsonlReader(stream, (line) => lines.push(line));

		await endStream(stream, "tail\r");

		expect(lines).toEqual(["tail"]);
	});

	it("emits an error and skips onLine for an overlong line", async () => {
		const stream = new PassThrough();
		const lines: string[] = [];
		const errors: Error[] = [];
		attachJsonlReader(stream, (line) => lines.push(line), {
			maxLineBytes: 4,
			onError: (error) => errors.push(error),
		});

		await endStream(stream, "abcde\nok\n");

		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toMatch(/exceeded maximum/u);
		expect(lines).toEqual(["ok"]);
	});
});

describe("RpcClient", () => {
	it("emits parse_error on malformed JSON", () => {
		const fake = createRpcProcess();
		const events: RpcClientEvent[] = [];
		const client = new RpcClient(fake.process, (event) => events.push(event));

		fake.stdout.write("{bad json\n");

		expect(client).toBeInstanceOf(RpcClient);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ kind: "parse_error", line: "{bad json" });
	});

	it("matches successful responses to requests", async () => {
		const fake = createRpcProcess();
		const events: RpcClientEvent[] = [];
		const client = new RpcClient(fake.process, (event) => events.push(event));

		const responsePromise = client.request({ type: "get_state" }, 1_000);
		const request = parseWrittenLine(fake.writes());
		expect(request["type"]).toBe("get_state");
		const id = request["id"];
		if (typeof id !== "string") throw new Error("request did not include an id");

		const response = {
			type: "response",
			id,
			command: "get_state",
			success: true,
			data: { ok: true },
			error: null,
		};
		fake.stdout.write(`${JSON.stringify(response)}\n`);

		await expect(responsePromise).resolves.toEqual(response);
		expect(events).toEqual([{ kind: "response", response }]);
	});

	it("rejects pending requests on close", async () => {
		const fake = createRpcProcess();
		const client = new RpcClient(fake.process, () => undefined);

		const responsePromise = client.request({ type: "get_state" }, 1_000);
		const rejection = expect(responsePromise).rejects.toThrow(/RPC process closed/u);
		fake.close();

		await rejection;
	});

	it("writes cancellation responses for UI requests", () => {
		const fake = createRpcProcess();
		const client = new RpcClient(fake.process, () => undefined);

		client.respondToUiRequest("ui_1");

		expect(parseWrittenLine(fake.writes())).toEqual({
			type: "extension_ui_response",
			id: "ui_1",
			cancelled: true,
		});
	});

	it("reports stdio stream errors instead of crashing the parent", () => {
		const fake = createRpcProcess();
		const events: RpcClientEvent[] = [];
		const client = new RpcClient(fake.process, (event) => events.push(event));

		fake.process.stdin.emit("error", new Error("write EPIPE"));
		fake.process.stdout.emit("error", new Error("read ECONNRESET"));

		expect(client).toBeInstanceOf(RpcClient);
		expect(events).toEqual([
			expect.objectContaining({ kind: "parse_error", message: "RPC stdin error: write EPIPE" }),
			expect.objectContaining({
				kind: "parse_error",
				message: "RPC stdout error: read ECONNRESET",
			}),
		]);
	});

	it("refuses new requests once stdin is no longer writable", () => {
		const fake = createRpcProcess();
		const client = new RpcClient(fake.process, () => undefined);

		fake.process.stdin.end();

		expect(() => client.requestWithHandle({ type: "get_state" }, 1_000)).toThrow(
			/RPC process is closed/u,
		);
	});

	it("rejects timed-out requests with operation labels and may-still-process guidance", async () => {
		vi.useFakeTimers();
		try {
			const fake = createRpcProcess();
			const client = new RpcClient(fake.process, () => undefined);

			const responsePromise = client.request({ type: "prompt", message: "hi" }, 50, "send steer");
			const rejection = expect(responsePromise).rejects.toSatisfy((error: unknown) => {
				expect(error).toBeInstanceOf(RpcTimeoutError);
				if (!(error instanceof RpcTimeoutError)) return false;
				expect(error.operationLabel).toBe("send steer");
				expect(error.message).toMatch(/send steer/u);
				expect(error.message).toMatch(/was written and may still be processed/u);
				expect(error.message).toMatch(/poll or wait before retrying/u);
				return true;
			});

			await vi.advanceTimersByTimeAsync(50);
			await rejection;
		} finally {
			vi.useRealTimers();
		}
	});

	it("defaults timeout labels to the command type", async () => {
		vi.useFakeTimers();
		try {
			const fake = createRpcProcess();
			const client = new RpcClient(fake.process, () => undefined);

			const responsePromise = client.request({ type: "get_state" }, 25);
			const rejection = expect(responsePromise).rejects.toThrow(
				/Timed out waiting for RPC response to get_state.*may still be processed/u,
			);

			await vi.advanceTimersByTimeAsync(25);
			await rejection;
		} finally {
			vi.useRealTimers();
		}
	});
});

async function endStream(stream: PassThrough, chunk: string): Promise<void> {
	const ended = once(stream, "end");
	stream.end(chunk);
	await ended;
}

type FakeRpcProcess = {
	readonly process: ChildProcessWithoutNullStreams;
	readonly stdout: PassThrough;
	readonly writes: () => readonly string[];
	readonly close: () => void;
};

function createRpcProcess(): FakeRpcProcess {
	const processEvents = new EventEmitter();
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const writes: string[] = [];
	stdin.on("data", (chunk: Buffer | string) => {
		writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
	});

	const process = Object.assign(processEvents, {
		stdin,
		stdout,
		stderr: new PassThrough(),
	}) as unknown as ChildProcessWithoutNullStreams;

	return {
		process,
		stdout,
		writes: () => writes,
		close: () => {
			processEvents.emit("close", 0, null);
		},
	};
}

function parseWrittenLine(writes: readonly string[]): Record<string, unknown> {
	return JSON.parse(writes.join("")) as Record<string, unknown>;
}
