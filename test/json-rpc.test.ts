import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { attachJsonlReader } from "../src/json.ts";
import { RpcClient, type RpcClientEvent } from "../src/rpc.ts";

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
