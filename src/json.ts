import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

const DEFAULT_JSONL_MAX_BYTES = 1024 * 1024;

export type JsonlReaderOptions = {
	readonly maxLineBytes?: number;
	readonly maxBufferBytes?: number;
	readonly onError?: (error: Error) => void;
};

export function attachJsonlReader(
	stream: Readable,
	onLine: (line: string) => void,
	options: JsonlReaderOptions = {},
): void {
	const maxLineBytes = normalizeByteLimit(options.maxLineBytes, DEFAULT_JSONL_MAX_BYTES);
	const maxBufferBytes = normalizeByteLimit(options.maxBufferBytes, maxLineBytes);
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	let bufferBytes = 0;
	let discardingOverlongLine = false;

	const reportError = (error: Error) => {
		if (options.onError) {
			options.onError(error);
			return;
		}

		throw error;
	};

	const resetBuffer = () => {
		buffer = "";
		bufferBytes = 0;
	};

	const processText = (text: string) => {
		let startIndex = 0;

		for (;;) {
			const newlineIndex = text.indexOf("\n", startIndex);
			const fragment =
				newlineIndex === -1 ? text.slice(startIndex) : text.slice(startIndex, newlineIndex);

			if (discardingOverlongLine) {
				if (newlineIndex === -1) return;

				discardingOverlongLine = false;
				startIndex = newlineIndex + 1;
				continue;
			}

			const fragmentBytes = Buffer.byteLength(fragment, "utf8");
			const nextBufferBytes = bufferBytes + fragmentBytes;

			if (nextBufferBytes > maxLineBytes || nextBufferBytes > maxBufferBytes) {
				const limit = nextBufferBytes > maxLineBytes ? maxLineBytes : maxBufferBytes;
				const subject = nextBufferBytes > maxLineBytes ? "line" : "buffer";

				resetBuffer();
				reportError(new Error(`JSONL ${subject} exceeded maximum of ${limit} bytes`));

				if (newlineIndex === -1) {
					discardingOverlongLine = true;
					return;
				}

				startIndex = newlineIndex + 1;
				continue;
			}

			buffer += fragment;
			bufferBytes = nextBufferBytes;

			if (newlineIndex === -1) return;

			const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
			resetBuffer();
			onLine(line);
			startIndex = newlineIndex + 1;
		}
	};

	stream.on("data", (chunk: Buffer | string) => {
		processText(typeof chunk === "string" ? chunk : decoder.write(chunk));
	});

	stream.on("end", () => {
		processText(decoder.end());
		if (discardingOverlongLine) {
			discardingOverlongLine = false;
			resetBuffer();
			return;
		}

		if (buffer.length === 0) return;

		const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
		onLine(line);
		resetBuffer();
	});
}

function normalizeByteLimit(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError("JSONL byte limits must be positive safe integers");
	}

	return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" ? value : null;
}

export function numberField(record: Record<string, unknown>, key: string): number | null {
	const value = record[key];
	return typeof value === "number" ? value : null;
}

export function booleanField(record: Record<string, unknown>, key: string): boolean | null {
	const value = record[key];
	return typeof value === "boolean" ? value : null;
}
