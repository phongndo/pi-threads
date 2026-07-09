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
	formatList,
	formatPoll,
	formatThreadEvent,
	formatThreadStateBadge,
	formatThreadStateText,
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
	"ctrl+x stop (confirm)",
	"type search",
	"esc close",
];
const THREADS_COMMAND_USAGE = [
	"Usage: /threads",
	"",
	"Use /threads to observe managed Pi threads.",
	"Thread lifecycle is managed by Pi through the thread tool.",
	"Ask Pi what you want done in natural language.",
].join("\n");

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
			const trimmed = args?.trim() || "";
			const command = parseThreadsCommand(trimmed);
			if (command === null) {
				ctx.ui.notify(THREADS_COMMAND_USAGE, "error");
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
				// Include archived so command-mode select can reach them (labeled with "archived").
				const threads = manager.list({ action: "list", state: "all", visibility: "all" });
				if (threads.length === 0) {
					ctx.ui.notify("No threads found", "info");
					return;
				}
				await showThreadsRpc(ctx, manager, threads);
			} else {
				const threads = manager.list({ action: "list", state: "all", visibility: "active" });
				ctx.ui.notify(formatList(threads), "info");
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
	/** Selected live thread id awaiting a second ctrl+x confirmation. */
	private pendingStopId: string | null = null;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private cachedBrowserView: BrowserView | undefined;

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
		this.invalidateBrowserView();

		const filtered = this.filteredThreads();
		const selectedIndex =
			selectedId === undefined ? -1 : filtered.findIndex((thread) => thread.id === selectedId);
		this.selectedIndex =
			selectedIndex >= 0
				? selectedIndex
				: Math.min(this.selectedIndex, Math.max(0, filtered.length - 1));
		if (
			this.pendingStopId !== null &&
			!filtered.some((thread) => thread.id === this.pendingStopId)
		) {
			this.pendingStopId = null;
		}
		this.rerender();
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

		const t = this.theme;
		const view = this.browserView();
		const filtered = view.filteredThreads;
		const counts = view.counts;
		const lines: string[] = [];
		lines.push("");
		lines.push(...this.renderBorder(width));
		lines.push(this.renderTitleLine(width, counts));
		lines.push(...this.renderHelpLines(width));
		lines.push(truncateToWidth(this.renderSearchLine(), width));
		lines.push(...this.renderBorder(width));
		lines.push("");

		if (filtered.length === 0) {
			const message = this.emptyMessage(view);
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

		if (matchesKey(data, Key.up)) {
			const filtered = this.filteredThreads();
			if (filtered.length === 0) return;
			this.clearPendingStop();
			this.selectedIndex = this.selectedIndex === 0 ? filtered.length - 1 : this.selectedIndex - 1;
			this.rerender();
			return;
		}

		if (matchesKey(data, Key.down)) {
			const filtered = this.filteredThreads();
			if (filtered.length === 0) return;
			this.clearPendingStop();
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
			if (this.pendingStopId !== null) {
				this.clearPendingStop();
				this.notify("Stop cancelled.", "info");
				this.rerender();
				return;
			}
			if (this.searchQuery !== "") {
				this.searchQuery = "";
				this.selectedIndex = 0;
				this.invalidateBrowserView();
				this.rerender();
				return;
			}
			this.close(null);
			return;
		}

		if (matchesKey(data, Key.backspace)) {
			if (this.searchQuery === "") return;
			this.searchQuery = this.searchQuery.slice(0, -1);
			this.invalidateBrowserView();
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
			void this.requestStop();
			return;
		}

		if (isPrintable(data)) {
			this.clearPendingStop();
			this.searchQuery += data;
			this.selectedIndex = 0;
			this.invalidateBrowserView();
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
		return this.browserView().filteredThreads;
	}

	private browserView(): BrowserView {
		if (this.cachedBrowserView) return this.cachedBrowserView;

		const counts = emptyBrowserCounts();
		const filteredThreads: ThreadSnapshot[] = [];
		let visibleCount = 0;
		let statusCount = 0;
		const visibilityFilter = this.visibilityFilter;
		const statusFilter = this.statusFilter;
		const query = this.searchQuery.trim().toLowerCase();
		const tokens = query === "" ? [] : query.split(/\s+/u).filter(Boolean);

		for (const thread of this.threads) {
			const status = browserStatus(thread);
			if (thread.state === "live") counts.live += 1;
			else counts.closed += 1;
			if (status === "stale") counts.stale += 1;
			if (status === "failed") counts.failed += 1;
			if (thread.archived) counts.archived += 1;

			const isVisible =
				visibilityFilter === "all" || thread.archived === (visibilityFilter === "archived");
			if (isVisible) visibleCount += 1;

			const statusMatches = matchesStatusFilter(thread, statusFilter, status);
			if (statusMatches) statusCount += 1;

			if (!isVisible || !statusMatches) continue;
			if (tokens.length > 0 && !matchesSearchTokens(thread, status, tokens)) continue;
			filteredThreads.push(thread);
		}

		const view = { filteredThreads, counts, visibleCount, statusCount } satisfies BrowserView;
		this.cachedBrowserView = view;
		return view;
	}

	private emptyMessage(view: BrowserView = this.browserView()): string {
		if (this.threads.length === 0) return "  No threads";
		if (view.visibleCount === 0) return `  No ${this.visibilityFilter} threads`;
		if (this.statusFilter !== "all" && view.statusCount === 0)
			return `  No ${this.statusFilter} threads`;
		return "  No matching threads";
	}

	private invalidateBrowserView(): void {
		this.cachedBrowserView = undefined;
		this.invalidate();
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
			`State: ${formatThreadStateText(thread)}  Archived: ${thread.archived ? "yes" : "no"}  Saved session: ${thread.session.kind === "known" ? "yes" : "no"}  Resumable: ${thread.state === "closed" && thread.session.kind === "known" ? "yes" : "no"}  Children: ${children}`,
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
		this.clearPendingStop();
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
		this.clearPendingStop();
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
			// manager.poll emits onChange, which already refreshes this.threads via updateThreads.
			this.notify(`Polled ${formatThreadTitle(updated)} — ${browserStatus(updated)}`, "info");
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.notify(`Poll failed: ${message}`, "error");
		}
	}

	private async requestStop(): Promise<void> {
		const thread = this.selectedThread();
		if (!thread) return;

		// Closed threads are a no-op stop; skip confirmation and report already closed.
		if (thread.state !== "live") {
			this.clearPendingStop();
			await this.handleStop();
			return;
		}

		if (this.pendingStopId !== thread.id) {
			this.pendingStopId = thread.id;
			this.notify(
				`Press ctrl+x again to stop "${formatThreadTitle(thread)}", or esc to cancel.`,
				"warning",
			);
			this.rerender();
			return;
		}

		this.clearPendingStop();
		await this.handleStop();
	}

	private async handleStop(): Promise<void> {
		const thread = this.selectedThread();
		if (!thread) return;

		try {
			const outcome = await this.manager.stop({ action: "stop", id: thread.path, force: false });
			if (this.closed) return;
			const title = formatThreadTitle(outcome.thread);
			this.notify(outcome.alreadyClosed ? `Already closed ${title}` : `Stopped ${title}`, "info");
			this.refreshList();
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.notify(`Stop failed: ${message}`, "error");
		}
	}

	private clearPendingStop(): void {
		this.pendingStopId = null;
	}

	private refreshList(): void {
		if (this.closed) return;
		this.threads = [...this.manager.list({ action: "list", state: "all", visibility: "all" })];
		this.invalidateBrowserView();
		this.selectedIndex = Math.min(
			this.selectedIndex,
			Math.max(0, this.filteredThreads().length - 1),
		);
		this.rerender();
	}

	private cycleStatusFilter(): void {
		this.clearPendingStop();
		const currentIndex = STATUS_FILTER_CYCLE.indexOf(this.statusFilter);
		this.statusFilter = STATUS_FILTER_CYCLE[(currentIndex + 1) % STATUS_FILTER_CYCLE.length]!;
		this.invalidateBrowserView();
		this.selectedIndex = Math.min(
			this.selectedIndex,
			Math.max(0, this.filteredThreads().length - 1),
		);
		this.rerender();
	}

	private cycleVisibilityFilter(): void {
		this.clearPendingStop();
		const currentIndex = VISIBILITY_FILTER_CYCLE.indexOf(this.visibilityFilter);
		this.visibilityFilter =
			VISIBILITY_FILTER_CYCLE[(currentIndex + 1) % VISIBILITY_FILTER_CYCLE.length]!;
		this.invalidateBrowserView();
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

type MutableBrowserCounts = {
	live: number;
	closed: number;
	stale: number;
	failed: number;
	archived: number;
};

type BrowserView = {
	readonly filteredThreads: readonly ThreadSnapshot[];
	readonly counts: BrowserCounts;
	readonly visibleCount: number;
	readonly statusCount: number;
};

function emptyBrowserCounts(): MutableBrowserCounts {
	return {
		live: 0,
		closed: 0,
		stale: 0,
		failed: 0,
		archived: 0,
	};
}

function browserStatus(thread: ThreadSnapshot): BrowserStatus {
	if (thread.state === "live") return thread.phase === "idle" ? "idle" : "working";
	if (thread.exit.kind === "stale") return "stale";
	if (isThreadExitFailed(thread.exit)) return "failed";
	return "done";
}

function matchesStatusFilter(
	thread: ThreadSnapshot,
	filter: StatusFilter,
	status: BrowserStatus = browserStatus(thread),
): boolean {
	if (filter === "all") return true;
	if (filter === "live") return thread.state === "live";
	if (filter === "closed") return thread.state === "closed";
	return status === filter;
}

function matchesSearchTokens(
	thread: ThreadSnapshot,
	status: BrowserStatus,
	tokens: readonly string[],
): boolean {
	const haystack = [
		formatThreadTitle(thread),
		thread.name,
		thread.taskName,
		thread.path,
		status,
		thread.archived ? "archived" : "active",
		thread.session.kind === "known" ? thread.session.file : "",
		formatThreadSummary(thread, 160),
	]
		.join(" ")
		.toLowerCase();
	return tokens.every((token) => haystack.includes(token));
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
