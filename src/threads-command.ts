import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ThreadSnapshot } from "./domain.ts";
import {
	formatPoll,
	formatThreadStateBadge,
	formatThreadSummary,
	formatThreadTitle,
	formatThreadUserStatus,
} from "./format.ts";
import type { ThreadManager } from "./thread-manager.ts";

type StateFilter = "all" | "live" | "closed";
const FILTER_CYCLE: readonly StateFilter[] = ["all", "live", "closed"];
export const PI_THREAD_ENTRY_MESSAGE_TYPE = "pi-threads-entry";

export function registerThreadsCommand(
	pi: ExtensionAPI,
	manager: ThreadManager,
	options: { readonly beforeUse?: (ctx: ExtensionCommandContext) => void } = {},
): void {
	pi.registerCommand("threads", {
		description: "List and manage Pi threads interactively",
		getArgumentCompletions: (_prefix: string) => [
			{ value: "live", label: "live", description: "Show only live threads" },
			{ value: "all", label: "all", description: "Show all threads" },
			{ value: "closed", label: "closed", description: "Show only closed threads" },
		],
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			options.beforeUse?.(ctx);
			const trimmed = args?.trim().toLowerCase() || "";
			const filter: StateFilter = trimmed === "live" || trimmed === "closed" ? trimmed : "all";

			if (ctx.mode === "tui") {
				await showThreadsTui(ctx, manager, manager.list({ action: "list", state: "all" }), filter);
			} else if (ctx.hasUI) {
				const threads = manager.list({ action: "list", state: filter });
				if (threads.length === 0) {
					ctx.ui.notify(`No ${filter} threads found`, "info");
					return;
				}
				await showThreadsRpc(ctx, manager, threads);
			} else {
				const threads = manager.list({ action: "list", state: filter });
				ctx.ui.notify(`Found ${threads.length} ${filter} thread(s)`, "info");
			}
		},
	});
}

async function showThreadsTui(
	ctx: ExtensionCommandContext,
	manager: ThreadManager,
	initialThreads: readonly ThreadSnapshot[],
	filter: StateFilter,
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

export class ThreadsTreeComponent implements Component {
	private threads: ThreadSnapshot[];
	private selectedIndex = 0;
	private searchQuery = "";
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(
		private readonly tui: { requestRender: () => void },
		private readonly theme: Theme,
		private readonly manager: ThreadManager,
		private readonly ctx: ExtensionCommandContext,
		initialThreads: readonly ThreadSnapshot[],
		private filter: StateFilter,
		private readonly done: (result: null) => void,
	) {
		this.threads = [...initialThreads];
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	updateThreads(threads: readonly ThreadSnapshot[]): void {
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
		const liveCount = this.threads.filter((thread) => thread.state === "live").length;
		const closedCount = this.threads.length - liveCount;
		const lines: string[] = [];

		lines.push("");
		lines.push(...new DynamicBorder((s: string) => t.fg("accent", s)).render(width));
		lines.push(
			truncateToWidth(t.bold(`  Pi Threads (${liveCount} live, ${closedCount} closed)`), width),
		);
		lines.push(
			truncateToWidth(
				t.fg(
					"muted",
					"  ↑↓ move · tab filter · enter open closed · ctrl+p poll · ctrl+r refresh · ctrl+x stop · type search · esc close",
				),
				width,
			),
		);
		lines.push(truncateToWidth(this.renderSearchLine(), width));
		lines.push(...new DynamicBorder((s: string) => t.fg("accent", s)).render(width));

		if (filtered.length === 0) {
			const message = this.emptyMessage();
			lines.push(truncateToWidth(t.fg("muted", message), width));
			lines.push(truncateToWidth(t.fg("muted", `  (0/0) [${this.filter}]`), width));
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
				truncateToWidth(
					t.fg("muted", `  (${this.selectedIndex + 1}/${filtered.length}) [${this.filter}]`),
					width,
				),
			);
		}

		lines.push(...new DynamicBorder((s: string) => t.fg("accent", s)).render(width));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	handleInput(data: string): void {
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

		if (matchesKey(data, Key.enter)) {
			void this.handleEnterThread();
			return;
		}

		if (matchesKey(data, Key.tab)) {
			this.cycleFilter();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			if (this.searchQuery !== "") {
				this.searchQuery = "";
				this.selectedIndex = 0;
				this.rerender();
				return;
			}
			this.done(null);
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
		const userStatus = formatThreadUserStatus(thread);
		const statusColor =
			userStatus === "working"
				? "accent"
				: userStatus === "blocked"
					? "warning"
					: userStatus === "failed"
						? "error"
						: "success";
		const status = t.fg(statusColor, userStatus);
		const summary = t.fg("muted", formatThreadSummary(thread, 90));
		const path = t.fg("dim", thread.path);
		const line = `${cursor}${prefix}${badge} ${title}  ${status}  ${path} ${summary}`;
		const themed = isSelected ? t.bg("selectedBg", line) : line;
		return truncateToWidth(themed, width, "");
	}

	private filteredThreads(): readonly ThreadSnapshot[] {
		const stateFiltered =
			this.filter === "all"
				? this.threads
				: this.threads.filter((thread) => thread.state === this.filter);
		const query = this.searchQuery.trim().toLowerCase();
		if (query === "") return stateFiltered;
		const tokens = query.split(/\s+/u).filter(Boolean);
		return stateFiltered.filter((thread) => {
			const haystack = [
				formatThreadTitle(thread),
				thread.name,
				thread.taskName,
				thread.path,
				formatThreadSummary(thread, 160),
			]
				.join(" ")
				.toLowerCase();
			return tokens.every((token) => haystack.includes(token));
		});
	}

	private emptyMessage(): string {
		if (this.threads.length === 0) return "  No threads";
		const filterCount = this.threads.filter((thread) => thread.state === this.filter).length;
		if (this.filter !== "all" && filterCount === 0) return `  No ${this.filter} threads`;
		return "  No matching threads";
	}

	private selectedThread(): ThreadSnapshot | undefined {
		return this.filteredThreads()[this.selectedIndex];
	}

	private async handlePoll(): Promise<void> {
		const thread = this.selectedThread();
		if (!thread) return;

		try {
			const updated = await this.manager.poll(thread.path);
			this.ctx.ui.notify(
				`Polled ${formatThreadTitle(updated)} — ${formatThreadUserStatus(updated)}`,
				"info",
			);
			this.replaceThread(updated);
			this.rerender();
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.ctx.ui.notify(`Poll failed: ${message}`, "error");
		}
	}

	private async handleEnterThread(): Promise<void> {
		const thread = this.selectedThread();
		if (!thread) return;
		const parentSessionFile = this.ctx.sessionManager.getSessionFile();
		if (parentSessionFile === undefined) {
			this.ctx.ui.notify(
				"Cannot enter a thread from a --no-session Pi session because there is no saved parent session to return to.",
				"warning",
			);
			this.rerender();
			return;
		}

		try {
			const updated = await this.manager.poll(thread.path);
			this.replaceThread(updated);
			if (updated.session.kind !== "known") {
				this.ctx.ui.notify(
					`Thread session is not ready yet: ${formatThreadTitle(updated)}`,
					"warning",
				);
				this.rerender();
				return;
			}

			const sessionFile = updated.session.file;
			const threadTitle = formatThreadTitle(updated);
			if (updated.state === "live") {
				this.ctx.ui.notify(
					`Thread ${threadTitle} is still live. Stop it with Ctrl+X or wait for it to close before opening its session.`,
					"warning",
				);
				this.rerender();
				return;
			}

			this.done(null);
			await this.ctx.switchSession(sessionFile, {
				withSession: async (nextCtx) => {
					await nextCtx.sendMessage({
						customType: PI_THREAD_ENTRY_MESSAGE_TYPE,
						content: `Entered Pi thread "${threadTitle}". Use /exit or /thread exit to return to the parent session.`,
						display: true,
						details: {
							parentSessionFile,
							threadId: updated.id,
							threadPath: updated.path,
							threadTitle,
						},
					});
				},
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.ctx.ui.notify(`Enter failed: ${message}`, "error");
		}
	}

	private async handleStop(): Promise<void> {
		const thread = this.selectedThread();
		if (!thread) return;

		try {
			const outcome = await this.manager.stop({ action: "stop", id: thread.path, force: false });
			this.ctx.ui.notify(`Stopped ${formatThreadTitle(outcome.thread)}`, "info");
			this.refreshList();
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.ctx.ui.notify(`Stop failed: ${message}`, "error");
		}
	}

	private replaceThread(thread: ThreadSnapshot): void {
		const index = this.threads.findIndex((candidate) => candidate.id === thread.id);
		if (index >= 0) this.threads[index] = thread;
	}

	private refreshList(): void {
		this.threads = [...this.manager.list({ action: "list", state: "all" })];
		this.selectedIndex = Math.min(
			this.selectedIndex,
			Math.max(0, this.filteredThreads().length - 1),
		);
		this.rerender();
	}

	private cycleFilter(): void {
		const currentIndex = FILTER_CYCLE.indexOf(this.filter);
		this.filter = FILTER_CYCLE[(currentIndex + 1) % FILTER_CYCLE.length]!;
		this.refreshList();
	}

	private rerender(): void {
		this.invalidate();
		this.tui.requestRender();
	}
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
		return `${badge} ${formatThreadTitle(thread)} — ${thread.path}`;
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
