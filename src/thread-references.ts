import {
	asThreadId,
	asThreadPath,
	isThreadIdText,
	joinThreadPath,
	threadPathBasename,
	type ThreadId,
	type ThreadPath,
} from "./domain.ts";

export type ThreadReferenceEntry = {
	readonly id: ThreadId;
	readonly name: string;
	readonly taskName: string;
	readonly path: ThreadPath;
};

type ThreadReferenceScope = {
	readonly currentPath: ThreadPath;
	readonly threads: Iterable<ThreadReferenceEntry>;
};

type ListPathReferenceScope = ThreadReferenceScope & {
	readonly selfThreadId: ThreadId | null;
};

export function resolveThreadTarget(targetText: string, scope: ThreadReferenceScope): ThreadId {
	const threads = Array.from(scope.threads);
	return resolveThreadTargetFromList(targetText, scope.currentPath, threads);
}

export function resolveListPathReference(
	reference: string,
	scope: ListPathReferenceScope,
): ThreadPath {
	const threads = Array.from(scope.threads);
	const trimmed = reference.trim();
	if (trimmed === "." || trimmed === "self") return scope.currentPath;
	if (isThreadIdText(trimmed)) {
		const id = asThreadId(trimmed);
		if (scope.selfThreadId === id) return scope.currentPath;
		const thread = threads.find((candidate) => candidate.id === id);
		if (thread !== undefined) return thread.path;
		throw unknownThreadReferenceErrorFromList(reference, threads);
	}

	const pathReference = tryResolvePathReference(reference, scope.currentPath);
	// List filters only compare stored parentPath/path prefixes, so a syntactically
	// valid path is useful even when no managed thread exists at that exact path.
	if (pathReference !== null) return pathReference;

	const id = resolveThreadTargetFromList(reference, scope.currentPath, threads);
	const thread = threads.find((candidate) => candidate.id === id);
	if (thread !== undefined) return thread.path;
	throw unknownThreadReferenceErrorFromList(reference, threads);
}

function tryResolvePathReference(
	referenceText: string,
	currentPath: ThreadPath,
): ThreadPath | null {
	const reference = referenceText.trim();
	try {
		if (reference.startsWith("/")) return asThreadPath(reference);
		if (reference.startsWith("root/")) return asThreadPath(`/${reference}`);
		if (reference.includes("/")) return asThreadPath(`${currentPath}/${reference}`);
		return joinThreadPath(currentPath, reference);
	} catch {
		return null;
	}
}

export function unknownThreadReferenceError(
	reference: string,
	threads: Iterable<ThreadReferenceEntry>,
): Error {
	return unknownThreadReferenceErrorFromList(reference, Array.from(threads));
}

function knownThreadSuggestions(threads: Iterable<ThreadReferenceEntry>): readonly string[] {
	return Array.from(threads)
		.toSorted((left, right) => left.path.localeCompare(right.path))
		.slice(0, 8)
		.map((thread) => `${thread.path} (id: ${thread.id}, taskName: ${thread.taskName})`);
}

function resolveThreadTargetFromList(
	targetText: string,
	currentPath: ThreadPath,
	threads: readonly ThreadReferenceEntry[],
): ThreadId {
	const target = targetText.trim();
	if (isThreadIdText(target)) {
		const id = asThreadId(target);
		if (threads.some((thread) => thread.id === id)) return id;
		throw unknownThreadReferenceErrorFromList(targetText, threads);
	}

	const pathReference = tryResolvePathReference(target, currentPath);
	if (pathReference !== null) {
		const thread = threads.find((candidate) => candidate.path === pathReference);
		if (thread !== undefined) return thread.id;
	}

	const matches = threads.filter(
		(thread) =>
			thread.taskName === target ||
			threadPathBasename(thread.path) === target ||
			thread.name === target,
	);
	if (matches.length === 1) return matches[0]!.id;
	if (matches.length > 1) {
		throw new Error(
			`Ambiguous thread reference "${targetText}". Candidate paths: ${matches
				.map((thread) => thread.path)
				.join(", ")}. Repair: use one of the candidate paths or a thread id instead.`,
		);
	}

	throw unknownThreadReferenceErrorFromList(targetText, threads);
}

function unknownThreadReferenceErrorFromList(
	reference: string,
	threads: readonly ThreadReferenceEntry[],
): Error {
	const suggestions = knownThreadSuggestions(threads);
	const known =
		suggestions.length === 0
			? " No threads are currently managed by this parent."
			: ` Known threads: ${suggestions.join("; ")}.`;
	return new Error(
		`Unknown thread reference: "${reference}". Accepted reference forms: thread id (thread_012345abcdef), canonical path (/root/task), relative path from the current thread (task or parent/task), or unambiguous taskName/name.${known} Repair: use a known path/id, run { "action": "list" }, or start the thread first.`,
	);
}
