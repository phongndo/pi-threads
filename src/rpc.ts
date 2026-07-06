import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { attachJsonlReader, booleanField, isRecord, stringField } from "./json.ts";

export type PromptStreamingBehavior = "steer" | "followUp";

export type RpcCommand =
	| {
			readonly type: "prompt";
			readonly message: string;
			readonly streamingBehavior?: PromptStreamingBehavior;
	  }
	| { readonly type: "abort" }
	| { readonly type: "get_state" }
	| { readonly type: "extension_ui_response"; readonly id: string; readonly cancelled: true };

export type RpcResponse = {
	readonly type: "response";
	readonly id: string | null;
	readonly command: string;
	readonly success: boolean;
	readonly data: unknown;
	readonly error: string | null;
};

export type RpcClientEvent =
	| { readonly kind: "response"; readonly response: RpcResponse }
	| { readonly kind: "event"; readonly event: Record<string, unknown> }
	| { readonly kind: "parse_error"; readonly line: string; readonly message: string };

type PendingResponse = {
	readonly resolve: (response: RpcResponse) => void;
	readonly reject: (error: Error) => void;
	readonly timeout: NodeJS.Timeout;
};

export type RpcRequestHandle = {
	readonly id: string;
	readonly response: Promise<RpcResponse>;
};

export class RpcClient {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #pending = new Map<string, PendingResponse>();
	readonly #onEvent: (event: RpcClientEvent) => void;
	#closed = false;

	constructor(child: ChildProcessWithoutNullStreams, onEvent: (event: RpcClientEvent) => void) {
		this.#child = child;
		this.#onEvent = onEvent;

		attachJsonlReader(this.#child.stdout, (line) => this.#handleLine(line), {
			onError: (error) => {
				this.#onEvent({ kind: "parse_error", line: "", message: error.message });
			},
		});
		// Stdio streams emit "error" independently of the process "close"/"error"
		// events (for example EPIPE when a write races the child dying). Without
		// listeners those become uncaught exceptions in the parent process.
		this.#child.stdin.on("error", (error: Error) => {
			this.#onEvent({
				kind: "parse_error",
				line: "",
				message: `RPC stdin error: ${error.message}`,
			});
		});
		this.#child.stdout.on("error", (error: Error) => {
			this.#onEvent({
				kind: "parse_error",
				line: "",
				message: `RPC stdout error: ${error.message}`,
			});
		});
		this.#child.once("close", () => {
			this.#closed = true;
			this.#rejectAll(new Error("Pi RPC process closed"));
		});
	}

	async request(
		command: Exclude<RpcCommand, { readonly type: "extension_ui_response" }>,
		timeoutMs: number,
	): Promise<RpcResponse> {
		return this.requestWithHandle(command, timeoutMs).response;
	}

	requestWithHandle(
		command: Exclude<RpcCommand, { readonly type: "extension_ui_response" }>,
		timeoutMs: number,
	): RpcRequestHandle {
		if (!this.#writable()) throw new Error("Pi RPC process is closed");

		const id = `req_${randomUUID()}`;
		const payload = { ...command, id };

		const responsePromise = new Promise<RpcResponse>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`Timed out waiting for RPC response to ${command.type}`));
			}, timeoutMs);

			this.#pending.set(id, { resolve, reject, timeout });
		});

		this.#write(payload);
		return { id, response: responsePromise };
	}

	respondToUiRequest(id: string): void {
		if (!this.#writable()) return;
		this.#write({ type: "extension_ui_response", id, cancelled: true });
	}

	#writable(): boolean {
		return !this.#closed && this.#child.stdin.writable;
	}

	#write(payload: Record<string, unknown>): void {
		try {
			this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
		} catch (error) {
			this.#onEvent({
				kind: "parse_error",
				line: "",
				message: `RPC stdin write failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	#handleLine(line: string): void {
		if (line.trim() === "") return;

		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			this.#onEvent({
				kind: "parse_error",
				line,
				message: error instanceof Error ? error.message : String(error),
			});
			return;
		}

		if (!isRecord(parsed)) {
			this.#onEvent({ kind: "parse_error", line, message: "RPC line was not a JSON object" });
			return;
		}

		if (parsed["type"] === "response") {
			const response = normalizeResponse(parsed);
			if (response.id !== null) {
				const pending = this.#pending.get(response.id);
				if (pending) {
					clearTimeout(pending.timeout);
					this.#pending.delete(response.id);
					pending.resolve(response);
				}
			}
			this.#onEvent({ kind: "response", response });
			return;
		}

		this.#onEvent({ kind: "event", event: parsed });
	}

	#rejectAll(error: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.#pending.clear();
	}
}

function normalizeResponse(record: Record<string, unknown>): RpcResponse {
	const id = stringField(record, "id");
	return {
		type: "response",
		id,
		command: stringField(record, "command") ?? "unknown",
		success: booleanField(record, "success") ?? false,
		data: record["data"],
		error: stringField(record, "error"),
	};
}
