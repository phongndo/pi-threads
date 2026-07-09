import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord, stringField } from "./json.ts";

/**
 * Thin adapter over Pi SessionManager public APIs and the few private touchpoints
 * pi-threads needs (materialization via `_rewriteFile` / `flushed`, plus
 * cross-session `appendCustomEntry`). Keeps reach-ins in one place so H1/H2
 * persistence work can depend on a stable surface.
 */

export type MaterializableSessionManager = {
	readonly getSessionFile: () => string | undefined;
	readonly getHeader: () => unknown;
	readonly getEntries: () => readonly unknown[];
};

type SessionManagerInternals = MaterializableSessionManager & {
	readonly isPersisted?: () => boolean;
	flushed?: boolean;
} & Record<string, unknown>;

export function materializeSessionManagerFile(sessionManager: MaterializableSessionManager): void {
	const sessionFile = sessionManager.getSessionFile();
	if (sessionFile === undefined || fs.existsSync(sessionFile)) return;
	if (rewriteSessionManagerFile(sessionManager, sessionFile)) return;

	const header = sessionManager.getHeader();
	if (header === null) throw new Error("Cannot materialize Pi session: missing session header.");
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	const lines = [header, ...sessionManager.getEntries()].map((entry) => JSON.stringify(entry));
	fs.writeFileSync(sessionFile, `${lines.join("\n")}\n`, { flag: "wx" });
	markSessionManagerFileFlushed(sessionManager);
}

function rewriteSessionManagerFile(
	sessionManager: MaterializableSessionManager,
	sessionFile: string,
): boolean {
	const internals = sessionManager as SessionManagerInternals;
	if (typeof internals.isPersisted === "function" && !internals.isPersisted.call(sessionManager)) {
		return false;
	}
	const rewriteFile = internals["_rewriteFile"];
	if (typeof rewriteFile !== "function") return false;

	try {
		rewriteFile.call(sessionManager);
	} catch {
		return false;
	}

	if (!fs.existsSync(sessionFile)) return false;
	markSessionManagerFileFlushed(sessionManager);
	return true;
}

function markSessionManagerFileFlushed(sessionManager: MaterializableSessionManager): void {
	(sessionManager as { flushed?: boolean }).flushed = true;
}

/** Append a custom entry to a non-current (or any) session file via SessionManager.open. */
export function appendCustomEntryToSessionFile(
	sessionFile: string,
	sessionDir: string | null | undefined,
	customType: string,
	data: unknown,
): void {
	SessionManager.open(sessionFile, sessionDir ?? undefined).appendCustomEntry(customType, data);
}

export function safeGetSessionFile(
	ctx: Pick<ExtensionContext, "sessionManager">,
): string | undefined {
	try {
		return ctx.sessionManager.getSessionFile?.();
	} catch {
		return undefined;
	}
}

export function safeGetSessionId(ctx: Pick<ExtensionContext, "sessionManager">): string | null {
	try {
		return ctx.sessionManager.getSessionId?.() ?? null;
	} catch {
		return null;
	}
}

export function safeGetSessionDir(
	ctx: Pick<ExtensionContext, "sessionManager">,
): string | undefined {
	try {
		return ctx.sessionManager.getSessionDir?.();
	} catch {
		return undefined;
	}
}

export function safeSessionTimestamp(ctx: Pick<ExtensionContext, "sessionManager">): string | null {
	try {
		const header = ctx.sessionManager.getHeader?.();
		return isRecord(header) ? stringField(header, "timestamp") : null;
	} catch {
		return null;
	}
}

export function safeSessionBranch(
	ctx: Pick<ExtensionContext, "sessionManager">,
): readonly unknown[] {
	try {
		return ctx.sessionManager.getBranch?.() ?? [];
	} catch {
		return [];
	}
}

/**
 * Prefer full-file entries so side-branch registry customs (H5 dual-writer case)
 * remain visible. Fall back to the leaf branch for stubs that only mock getBranch.
 */
export function safeSessionRegistryEntries(
	ctx: Pick<ExtensionContext, "sessionManager">,
): readonly unknown[] {
	try {
		const entries = ctx.sessionManager.getEntries?.();
		if (Array.isArray(entries)) return entries;
	} catch {
		// Fall through to branch.
	}
	return safeSessionBranch(ctx);
}

export function safeGetLeafId(ctx: Pick<ExtensionContext, "sessionManager">): string | null {
	try {
		return ctx.sessionManager.getLeafId?.() ?? null;
	} catch {
		return null;
	}
}

export function sessionHasParentSession(ctx: Pick<ExtensionContext, "sessionManager">): boolean {
	try {
		const header = ctx.sessionManager.getHeader?.();
		return (
			isRecord(header) &&
			typeof header["parentSession"] === "string" &&
			header["parentSession"].length > 0
		);
	} catch {
		return false;
	}
}
