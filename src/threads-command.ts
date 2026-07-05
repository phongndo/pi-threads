import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	isThreadExitFailed,
	toThreadRuntimeSnapshot,
	type ThreadPath,
	type ThreadSnapshot,
} from "./domain.ts";
import {
	formatPoll,
	formatThreadEvent,
	formatThreadStateBadge,
	formatThreadSummary,
	formatThreadTitle,
} from "./format.ts";
import type { ThreadManager } from "./thread-manager.ts";

type StatusFilter = "all" | "live" | "working" | "idle" | "closed" | "stale" | "failed";
type VisibilityFilter = "active" | "archived" | "all";
type BrowserStatus = "working" | "idle" | "done" | "stale" | "failed";
const STATUS_FILTER_CYCLE: readonly StatusFilter[] = [
	"all",
	"live",
	"working",
	"idle",
	"closed",
	"stale",
	"failed",
];
const VISIBILITY_FILTER_CYCLE: readonly VisibilityFilter[] = ["active", "archived", "all"];
const THREAD_HELP_ITEMS = [
	"↑/↓ move",
	"←/→ parent/child",
	"tab status",
	"ctrl+v visibility",
	"ctrl+p poll",
	"ctrl+r refresh",
	"ctrl+x stop",
	"type search",
	"esc close",
];

export function registerThreadsCommand(
	pi: ExtensionAPI,
	manager: ThreadManager,
	options: {
		readonly beforeUse?: (ctx: ExtensionCommandContext) => void;
	} = {},
): void {
	pi.registerCommand("threads", {
		description: "Browse Pi threads interactively",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			options.beforeUse?.(ctx);
			const trimmed = args?.trim().toLowerCase() || "";
			const command = parseThreadsCommand(trimmed);
			if (command === null) {
				ctx.ui.notify("Usage: /threads", "error");
				return;
			}

			if (ctx.mode === "tui") {
				await showThreadsTui(
					ctx,
					manager,
					manager.list({ action: "list", state: "all", visibility: "all" }),
					"all",
				);
			} else if (ctx.hasUI) {
				const threads = manager.list({ action: "list", state: "all", visibility: "active" });
				if (threads.length === 0) {
					ctx.ui.notify("No threads found", "info");
					return;
				}
				await showThreadsRpc(ctx, manager, threads);
			} else {
				const threads = manager.list({ action: "list", state: "all", visibility: "active" });
				ctx.ui.notify(`Found ${threads.length} thread(s)`, "info");
			}
		},
	});
}

type ThreadsCommand = { readonly kind: "browse" };

function parseThreadsCommand(value: string): ThreadsCommand | null {
	if (value === "") return { kind: "browse" };
	return null;
}

async function showThreadsTui(
	ctx: ExtensionCommandContext,
	manager: ThreadManager,
	initialThreads: readonly ThreadSnapshot[],
	filter: StatusFilter,
): Promise<void> {
	await ctx.ui.custom<null>((tui, theme, _kb, done) => {
		let unsubscribe: (() => void) | null = null;
		const finish = (result: null): void => {
			unsubscribe?.();
			unsubscribe = null;
			done(result);
		};
		const component = new ThreadsTreeComponent(
			tui,
			theme,
			manager,
			ctx,
			initialThreads,
			filter,
			finish,
		);
		unsubscribe = manager.onChange((threads) => component.updateThreads(threads));
		return component;
	});
}

type ThreadsTui = {
	requestRender: () => void;
};

export class ThreadsTreeComponent implements Component {
	private threads: ThreadSnapshot[];
	private selectedIndex = 0;
	private searchQuery = "";
	private closed = false;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(
		private readonly tui: ThreadsTui,
		private readonly theme: Theme,
		private readonly manager: ThreadManager,
		private readonly ctx: ExtensionCommandContext,
		initialThreads: readonly ThreadSnapshot[],
		private statusFilter: StatusFilter,
		private readonly done: (result: null) => void,
	) {
		this.threads = [...initialThreads];
	}

	private visibilityFilter: VisibilityFilter = "active";

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	updateThreads(threads: readonly ThreadSnapshot[]): void {
		if (this.closed) return;
		const selectedId = this.selectedThread()?.id;
		this.threads = [...threads];

		const filtered = this.filteredThreads();
		const selectedIndex =
			selectedId === undefined ? -1 : filtered.findIndex((thread) => thread.id === selectedId);
		this.selectedIndex =
			selectedIndex >= 0
				? selectedIndex
				: Math.min(this.selectedIndex, Math.max(0, filtered.length - 1));
		this.rerender();
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

		const t = this.theme;
		const filtered = this.filteredThreads();
		const counts = browserCounts(this.threads);
		const lines: string[] = [];
		lines.push("");
		lines.push(...this.renderBorder(width));
		lines.push(this.renderTitleLine(width, counts));
		lines.push(...this.renderHelpLines(width));
		lines.push(truncateToWidth(this.renderSearchLine(), width));
		lines.push(...this.renderBorder(width));
		lines.push("");

		if (filtered.length === 0) {
			const message = this.emptyMessage();
			lines.push(truncateToWidth(t.fg("muted", message), width));
			lines.push(truncateToWidth(t.fg("muted", "  (0/0)"), width));
		} else {
			const maxVisible = Math.min(filtered.length, 14);
			const startIndex = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible),
			);
			const visibleThreads = filtered.slice(startIndex, startIndex + maxVisible);

			for (let index = 0; index < visibleThreads.length; index += 1) {
				const thread = visibleThreads[index]!;
				const actualIndex = startIndex + index;
				lines.push(
					this.renderThreadRow(thread, filtered, actualIndex === this.selectedIndex, width),
				);
			}

			lines.push(
				truncateToWidth(t.fg("muted", `  (${this.selectedIndex + 1}/${filtered.length})`), width),
			);

			lines.push("");
			lines.push(...this.renderSelectedDetails(width));
		}

		lines.push("");
		lines.push(...this.renderBorder(width));

		const screenLines = this.fitToWidth(lines, width);
		this.cachedWidth = width;
		this.cachedLines = screenLines;
		return screenLines;
	}

	handleInput(data: string): void {
		if (this.closed) return;

		const filtered = this.filteredThreads();

		if (matchesKey(data, Key.up)) {
			if (filtered.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? filtered.length - 1 : this.selectedIndex - 1;
			this.rerender();
			return;
		}

		if (matchesKey(data, Key.down)) {
			if (filtered.length === 0) return;
			this.selectedIndex = this.selectedIndex === filtered.length - 1 ? 0 : this.selectedIndex + 1;
			this.rerender();
			return;
		}

		if (matchesKey(data, Key.left)) {
			this.selectParentThread();
			return;
		}

		if (matchesKey(data, Key.right)) {
			this.selectFirstChildThread();
			return;
		}

		if (matchesKey(data, Key.tab)) {
			this.cycleStatusFilter();
			return;
		}

		if (matchesKey(data, Key.ctrl("v"))) {
			this.cycleVisibilityFilter();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			if (this.searchQuery !== "") {
				this.searchQuery = "";
				this.selectedIndex = 0;
				this.rerender();
				return;
			}
			this.close(null);
			return;
		}

		if (matchesKey(data, Key.backspace)) {
			if (this.searchQuery === "") return;
			this.searchQuery = this.searchQuery.slice(0, -1);
			this.selectedIndex = Math.min(
				this.selectedIndex,
				Math.max(0, this.filteredThreads().length - 1),
			);
			this.rerender();
			return;
		}

		if (matchesKey(data, Key.ctrl("p"))) {
			void this.handlePoll();
			return;
		}

		if (matchesKey(data, Key.ctrl("r"))) {
			this.refreshList();
			return;
		}

		if (matchesKey(data, Key.ctrl("x"))) {
			void this.handleStop();
			return;
		}

		if (isPrintable(data)) {
			this.searchQuery += data;
			this.selectedIndex = 0;
			this.rerender();
		}
	}

	private renderSearchLine(): string {
		if (this.searchQuery === "") return this.theme.fg("muted", "  Type to search:");
		return `${this.theme.fg("muted", "  Type to search:")} ${this.theme.fg("accent", this.searchQuery)}`;
	}

	private renderTitleLine(width: number, counts: BrowserCounts): string {
		const leftText = this.theme.bold(
			`  Pi Threads (${counts.live} live, ${counts.closed} closed, ${counts.stale} stale, ${counts.archived} archived)`,
		);
		const rightText = truncateToWidth(this.renderCompactFilterControls(), width, "");
		const availableLeft = Math.max(0, width - visibleWidth(rightText) - 1);
		const left = truncateToWidth(leftText, availableLeft, "");
		const spacing = Math.max(0, width - visibleWidth(left) - visibleWidth(rightText));
		return `${left}${" ".repeat(spacing)}${rightText}`;
	}

	private renderCompactFilterControls(): string {
		const t = this.theme;
		return `${t.fg("muted", "Status: ")}${t.fg("accent", formatFilterValue(this.statusFilter))}${t.fg("muted", " · Visibility: ")}${t.fg("accent", formatFilterValue(this.visibilityFilter))}`;
	}

	private renderHelpLines(width: number): string[] {
		return this.renderHelpItems(THREAD_HELP_ITEMS, width);
	}

	private renderHelpItems(items: readonly string[], width: number): string[] {
		const availableWidth = Math.max(1, width);
		const indent = "  ";
		const separator = " · ";
		const lines: string[] = [];
		let currentLine = "";

		for (const item of items) {
			const candidate = currentLine
				? `${currentLine}${separator}${item}`
				: visibleWidth(`${indent}${item}`) <= availableWidth
					? `${indent}${item}`
					: item;

			if (!currentLine || visibleWidth(candidate) <= availableWidth) {
				currentLine = candidate;
				continue;
			}

			lines.push(...wrapTextWithAnsi(currentLine.trimEnd(), availableWidth));
			currentLine = visibleWidth(`${indent}${item}`) <= availableWidth ? `${indent}${item}` : item;
		}

		if (currentLine) lines.push(...wrapTextWithAnsi(currentLine.trimEnd(), availableWidth));

		return lines.map((line) => this.theme.fg("muted", line));
	}

	private fitToWidth(lines: readonly string[], width: number): string[] {
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private renderBorder(width: number): string[] {
		return new DynamicBorder((s: string) => this.theme.fg("border", s)).render(width);
	}

	private renderThreadRow(
		thread: ThreadSnapshot,
		visibleThreads: readonly ThreadSnapshot[],
		isSelected: boolean,
		width: number,
	): string {
		const t = this.theme;
		const cursor = isSelected ? t.fg("accent", "› ") : "  ";
		const prefix = t.fg("dim", treePrefix(thread, visibleThreads));
		const badge = formatThreadStateBadge(thread, {
			fg: (color, text) => t.fg(color as never, text),
		});
		const title = isSelected
			? t.bold(t.fg("accent", formatThreadTitle(thread)))
			: t.fg("accent", formatThreadTitle(thread));
		const userStatus = browserStatus(thread);
		const statusColor =
			userStatus === "working"
				? "accent"
				: userStatus === "failed"
					? "error"
					: userStatus === "stale"
						? "warning"
						: "success";
		const status = t.fg(statusColor, userStatus);
		const archived = thread.archived ? ` ${t.fg("muted", "[archived]")}` : "";
		const summary = t.fg("muted", formatThreadSummary(thread, 90));
		const path = t.fg("dim", thread.path);
		const line = `${cursor}${prefix}${badge} ${title}  ${status}${archived}  ${path} ${summary}`;
		const themed = isSelected ? t.bg("selectedBg", line) : line;
		return truncateToWidth(themed, width, "");
	}

	private filteredThreads(): readonly ThreadSnapshot[] {
		const visibleThreads = this.threads.filter((thread) => {
			if (this.visibilityFilter === "all") return true;
			return thread.archived === (this.visibilityFilter === "archived");
		});
		const stateFiltered = visibleThreads.filter((thread) =>
			matchesStatusFilter(thread, this.statusFilter),
		);
		const query = this.searchQuery.trim().toLowerCase();
		if (query === "") return stateFiltered;
		const tokens = query.split(/\s+/u).filter(Boolean);
		return stateFiltered.filter((thread) => {
			const haystack = [
				formatThreadTitle(thread),
				thread.name,
				thread.taskName,
				thread.path,
				browserStatus(thread),
				thread.archived ? "archived" : "active",
				thread.session.kind === "known" ? thread.session.file : "",
				formatThreadSummary(thread, 160),
			]
				.join(" ")
				.toLowerCase();
			return tokens.every((token) => haystack.includes(token));
		});
	}

	private emptyMessage(): string {
		if (this.threads.length === 0) return "  No threads";
		const visibleCount = this.threads.filter((thread) => {
			if (this.visibilityFilter === "all") return true;
			return thread.archived === (this.visibilityFilter === "archived");
		}).length;
		if (visibleCount === 0) return `  No ${this.visibilityFilter} threads`;
		const filterCount = this.threads.filter((thread) =>
			matchesStatusFilter(thread, this.statusFilter),
		).length;
		if (this.statusFilter !== "all" && filterCount === 0)
			return `  No ${this.statusFilter} threads`;
		return "  No matching threads";
	}

	private selectedThread(): ThreadSnapshot | undefined {
		return this.filteredThreads()[this.selectedIndex];
	}

	private renderSelectedDetails(width: number): string[] {
		const thread = this.selectedThread();
		if (thread === undefined) return [];

		const t = this.theme;
		const runtime = toThreadRuntimeSnapshot(thread, { detail: "summary" });
		const children = this.threads.filter(
			(candidate) => candidate.parentPath === thread.path,
		).length;
		const parentManaged = this.threads.some((candidate) => candidate.path === thread.parentPath);
		const lines = [
			`Selected: ${formatThreadTitle(thread)}  ${thread.path}`,
			`State: ${browserStateText(thread)}  Archived: ${thread.archived ? "yes" : "no"}  Saved session: ${thread.session.kind === "known" ? "yes" : "no"}  Resumable: ${thread.state === "closed" && thread.session.kind === "known" ? "yes" : "no"}  Children: ${children}`,
			`Parent: ${thread.parentPath}${parentManaged ? " (managed)" : ""}`,
			`Cwd: ${thread.cwd}`,
		];
		if (thread.session.kind === "known") lines.push(`Session: ${thread.session.file}`);
		if (runtime.result.text !== null) lines.push(`Result: ${runtime.result.text}`);

		const rendered = lines.map((line) => truncateToWidth(t.fg("muted", `  ${line}`), width));
		const recentEvents = thread.recentEvents.slice(-5);
		if (recentEvents.length === 0)
			return [...rendered, truncateToWidth(t.fg("muted", "  Timeline: none"), width)];

		rendered.push(truncateToWidth(t.fg("muted", "  Timeline:"), width));
		for (const event of recentEvents) {
			rendered.push(truncateToWidth(t.fg("muted", `  - ${formatThreadEvent(event)}`), width));
		}
		return rendered;
	}

	private selectParentThread(): void {
		const thread = this.selectedThread();
		if (thread === undefined || thread.parentPath === "/root") return;
		if (!this.selectVisiblePath(thread.parentPath)) {
			this.notify("Parent thread is hidden by the current filters or search.", "info");
		}
	}

	private selectFirstChildThread(): void {
		const thread = this.selectedThread();
		if (thread === undefined) return;
		const child = this.filteredThreads()
			.filter((candidate) => candidate.parentPath === thread.path)
			.toSorted((left, right) => left.path.localeCompare(right.path))[0];
		if (child === undefined) {
			this.notify("No visible child thread for the selected row.", "info");
			return;
		}
		this.selectVisiblePath(child.path);
	}

	private selectVisiblePath(threadPath: ThreadPath): boolean {
		const index = this.filteredThreads().findIndex((thread) => thread.path === threadPath);
		if (index < 0) return false;
		this.selectedIndex = index;
		this.rerender();
		return true;
	}

	private async handlePoll(): Promise<void> {
		const thread = this.selectedThread();
		if (!thread) return;

		try {
			const updated = await this.manager.poll(thread.path);
			if (this.closed) return;
			this.notify(`Polled ${formatThreadTitle(updated)} — ${browserStatus(updated)}`, "info");
			this.replaceThread(updated);
			this.rerender();
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.notify(`Poll failed: ${message}`, "error");
		}
	}

	private async handleStop(): Promise<void> {
		const thread = this.selectedThread();
		if (!thread) return;

		try {
			const outcome = await this.manager.stop({ action: "stop", id: thread.path, force: false });
			if (this.closed) return;
			this.notify(`Stopped ${formatThreadTitle(outcome.thread)}`, "info");
			this.refreshList();
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.notify(`Stop failed: ${message}`, "error");
		}
	}

	private replaceThread(thread: ThreadSnapshot): void {
		const index = this.threads.findIndex((candidate) => candidate.id === thread.id);
		if (index >= 0) this.threads[index] = thread;
		else this.threads.push(thread);
	}

	private refreshList(): void {
		if (this.closed) return;
		this.threads = [...this.manager.list({ action: "list", state: "all", visibility: "all" })];
		this.selectedIndex = Math.min(
			this.selectedIndex,
			Math.max(0, this.filteredThreads().length - 1),
		);
		this.rerender();
	}

	private cycleStatusFilter(): void {
		const currentIndex = STATUS_FILTER_CYCLE.indexOf(this.statusFilter);
		this.statusFilter = STATUS_FILTER_CYCLE[(currentIndex + 1) % STATUS_FILTER_CYCLE.length]!;
		this.selectedIndex = Math.min(
			this.selectedIndex,
			Math.max(0, this.filteredThreads().length - 1),
		);
		this.rerender();
	}

	private cycleVisibilityFilter(): void {
		const currentIndex = VISIBILITY_FILTER_CYCLE.indexOf(this.visibilityFilter);
		this.visibilityFilter =
			VISIBILITY_FILTER_CYCLE[(currentIndex + 1) % VISIBILITY_FILTER_CYCLE.length]!;
		this.selectedIndex = Math.min(
			this.selectedIndex,
			Math.max(0, this.filteredThreads().length - 1),
		);
		this.rerender();
	}

	private rerender(): void {
		if (this.closed) return;
		this.invalidate();
		this.tui.requestRender();
	}

	private close(result: null): void {
		if (this.closed) return;
		this.closed = true;
		this.done(result);
	}

	private notify(
		message: string,
		type: "info" | "warning" | "error" = "info",
		options: { readonly allowClosed?: boolean } = {},
	): void {
		if (this.closed && options.allowClosed !== true) return;
		try {
			this.ctx.ui.notify(message, type);
		} catch (err: unknown) {
			if (!isStaleExtensionContextError(err)) throw err;
		}
	}
}

function isStaleExtensionContextError(err: unknown): boolean {
	return err instanceof Error && err.message.includes("This extension ctx is stale");
}

async function showThreadsRpc(
	ctx: ExtensionCommandContext,
	manager: ThreadManager,
	threads: readonly ThreadSnapshot[],
): Promise<void> {
	const theme = ctx.ui.theme;
	const options = threads.map((thread) => {
		const badge = formatThreadStateBadge(thread, {
			fg: (color: string, text: string) => theme.fg(color as never, text),
		});
		return `${badge} ${formatThreadTitle(thread)} — ${browserStatus(thread)}${thread.archived ? " archived" : ""} — ${thread.path}`;
	});

	const choice = await ctx.ui.select("Select a thread to inspect:", options);
	if (!choice) return;

	const index = options.indexOf(choice);
	if (index < 0) return;
	const thread = threads[index]!;

	try {
		const updated = await manager.poll(thread.path);
		ctx.ui.notify(formatPoll(updated));
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`Poll failed: ${message}`, "error");
	}
}

type BrowserCounts = {
	readonly live: number;
	readonly closed: number;
	readonly stale: number;
	readonly failed: number;
	readonly archived: number;
};

function browserCounts(threads: readonly ThreadSnapshot[]): BrowserCounts {
	return {
		live: threads.filter((thread) => thread.state === "live").length,
		closed: threads.filter((thread) => thread.state === "closed").length,
		stale: threads.filter((thread) => browserStatus(thread) === "stale").length,
		failed: threads.filter((thread) => browserStatus(thread) === "failed").length,
		archived: threads.filter((thread) => thread.archived).length,
	};
}

function browserStatus(thread: ThreadSnapshot): BrowserStatus {
	if (thread.state === "live") return thread.phase === "idle" ? "idle" : "working";
	if (thread.exit.kind === "stale") return "stale";
	if (isThreadExitFailed(thread.exit)) return "failed";
	return "done";
}

function browserStateText(thread: ThreadSnapshot): string {
	if (thread.state === "live") return `live/${thread.phase}`;
	if (thread.exit.kind === "stale") return "closed/stale";
	if (isThreadExitFailed(thread.exit)) return "closed/failed";
	return `closed/${thread.exit.kind}`;
}

function matchesStatusFilter(thread: ThreadSnapshot, filter: StatusFilter): boolean {
	if (filter === "all") return true;
	if (filter === "live") return thread.state === "live";
	if (filter === "closed") return thread.state === "closed";
	return browserStatus(thread) === filter;
}

function formatFilterValue(value: StatusFilter | VisibilityFilter): string {
	return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function treePrefix(thread: ThreadSnapshot, visibleThreads: readonly ThreadSnapshot[]): string {
	const depth = Math.max(0, thread.path.split("/").filter(Boolean).length - 2);
	const parent = parentPath(thread.path);
	const siblings = visibleThreads.filter((candidate) => parentPath(candidate.path) === parent);
	const isLast = siblings[siblings.length - 1]?.path === thread.path;
	return `${"│  ".repeat(depth)}${isLast ? "└─ " : "├─ "}`;
}

function parentPath(threadPath: string): string {
	const index = threadPath.lastIndexOf("/");
	return index <= 0 ? "/root" : threadPath.slice(0, index);
}

function isPrintable(data: string): boolean {
	if (data.length === 0) return false;
	return [...data].every((char) => {
		const code = char.charCodeAt(0);
		return code >= 32 && code !== 127 && !(code >= 0x80 && code <= 0x9f);
	});
}
