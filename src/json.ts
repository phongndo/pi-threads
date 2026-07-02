import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

export function attachJsonlReader(stream: Readable, onLine: (line: string) => void): void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	stream.on("data", (chunk: Buffer | string) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

		for (;;) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) break;

			let line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			onLine(line);
		}
	});

	stream.on("end", () => {
		buffer += decoder.end();
		if (buffer.length === 0) return;

		const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
		onLine(line);
		buffer = "";
	});
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
