import { assertTaskName, humanizeTaskName, type ThreadId } from "./domain.ts";

export const TASK_NAME_MAX_LENGTH = 64;
export const DISPLAY_NAME_MAX_LENGTH = 80;

export function taskNameFromText(value: string | undefined): string | null {
	if (value === undefined) return null;
	const normalized = value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "_")
		.replace(/_+/gu, "_")
		.replace(/^_+|_+$/gu, "");
	if (normalized === "") return null;
	return assertTaskName(truncateTaskName(normalized));
}

export function taskNameWithNumericSuffix(base: string, attempt: number): string {
	const suffix = attempt === 1 ? "" : `_${attempt}`;
	const stemMaxLength = TASK_NAME_MAX_LENGTH - suffix.length;
	if (stemMaxLength < 1) throw new Error(`Unable to generate taskName suffix: ${suffix}`);
	const stem = truncateTaskName(base, stemMaxLength);
	return assertTaskName(`${stem}${suffix}`);
}

export function truncateTaskName(value: string, maxLength = TASK_NAME_MAX_LENGTH): string {
	const truncated = value.slice(0, maxLength).replace(/_+$/u, "");
	return truncated === "" ? value.slice(0, maxLength) : truncated;
}

export function generateDisplayName(prompt: string, taskName: string, id: ThreadId): string {
	return displayNameFromPrompt(prompt) ?? humanizeTaskName(taskName) ?? shortTaskName(id);
}

export function displayNameFromPrompt(prompt: string): string | null {
	const firstUsefulLine = prompt
		.split(/\r?\n/u)
		.map((line) => line.replace(/\s+/gu, " ").trim())
		.find((line) => line !== "" && /[\p{L}\p{N}]/u.test(line));
	if (firstUsefulLine === undefined) return null;
	return truncateDisplayName(firstUsefulLine);
}

export function truncateDisplayName(value: string): string {
	if (value.length <= DISPLAY_NAME_MAX_LENGTH) return value;
	return `${value.slice(0, DISPLAY_NAME_MAX_LENGTH - 3).trimEnd()}...`;
}

export function shortTaskName(id: ThreadId): string {
	return assertTaskName(id.slice(0, "thread_".length + 6));
}
