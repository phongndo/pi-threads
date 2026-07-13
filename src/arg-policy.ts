import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export function buildPiArgs(input: {
	readonly name: string;
	readonly extraArgs: readonly string[];
	readonly inheritedArgs?: readonly string[];
	readonly projectTrusted: boolean;
	readonly sessionFile?: string | undefined;
}): readonly string[] {
	const childArgs = mergeChildArgs(input.inheritedArgs ?? [], input.extraArgs);
	return [
		...childArgs,
		...(input.sessionFile === undefined ? [] : ["--session", input.sessionFile]),
		"--mode",
		"rpc",
		"--name",
		input.name,
		input.projectTrusted ? "--approve" : "--no-approve",
	] as const;
}

type CliFlagSpec = {
	readonly canonical: string;
	readonly takesValue: boolean;
	readonly allowExtra: boolean;
	readonly inherit: boolean;
	readonly valueKind?: "cli-path";
};

const CLI_FLAG_SPECS = new Map<string, CliFlagSpec>(
	[
		flagSpec(["--provider"], { takesValue: true, allowExtra: true, inherit: true }),
		flagSpec(["--model"], { takesValue: true, allowExtra: true, inherit: true }),
		flagSpec(["--models"], { takesValue: true, allowExtra: true, inherit: true }),
		flagSpec(["--thinking"], { takesValue: true, allowExtra: true, inherit: true }),
		flagSpec(["--exclude-tools", "-xt"], {
			takesValue: true,
			allowExtra: true,
			inherit: true,
		}),
		flagSpec(["--no-tools", "-nt"], { takesValue: false, allowExtra: true, inherit: true }),
		flagSpec(["--no-builtin-tools", "-nbt"], {
			takesValue: false,
			allowExtra: true,
			inherit: true,
		}),
		flagSpec(["--offline"], { takesValue: false, allowExtra: true, inherit: true }),
		flagSpec(["--no-extensions", "-ne"], {
			takesValue: false,
			allowExtra: true,
			inherit: true,
		}),
		flagSpec(["--no-skills", "-ns"], { takesValue: false, allowExtra: true, inherit: true }),
		flagSpec(["--no-prompt-templates", "-np"], {
			takesValue: false,
			allowExtra: true,
			inherit: true,
		}),
		flagSpec(["--no-themes"], { takesValue: false, allowExtra: true, inherit: true }),
		flagSpec(["--no-context-files", "-nc"], {
			takesValue: false,
			allowExtra: true,
			inherit: true,
		}),
		flagSpec(["--tools", "-t"], { takesValue: true, allowExtra: false, inherit: true }),
		flagSpec(["--extension", "-e"], {
			takesValue: true,
			allowExtra: false,
			inherit: true,
			valueKind: "cli-path",
		}),
		flagSpec(["--skill"], {
			takesValue: true,
			allowExtra: false,
			inherit: true,
			valueKind: "cli-path",
		}),
		flagSpec(["--prompt-template"], {
			takesValue: true,
			allowExtra: false,
			inherit: true,
			valueKind: "cli-path",
		}),
		flagSpec(["--theme"], {
			takesValue: true,
			allowExtra: false,
			inherit: true,
			valueKind: "cli-path",
		}),
	].flat(),
);

const VALUE_FLAGS_TO_SKIP = new Set([
	"--api-key",
	"--append-system-prompt",
	"--export",
	"--fork",
	"--mode",
	"--name",
	"-n",
	"--session",
	"--session-dir",
	"--session-id",
	"--system-prompt",
]);

const OPTIONAL_VALUE_FLAGS_TO_SKIP = new Set(["--list-models"]);

const SENSITIVE_BOOLEAN_FLAGS = new Set([
	"--approve",
	"-a",
	"--continue",
	"-c",
	"--help",
	"-h",
	"--no-approve",
	"-na",
	"--print",
	"-p",
	"--resume",
	"-r",
	"--verbose",
	"--version",
	"-v",
]);

const PACKAGE_SUBCOMMANDS = new Set(["config", "install", "list", "remove", "uninstall", "update"]);

// Derive alias sets from CLI_FLAG_SPECS so adding an alias cannot silently drift.
function flagAliases(...canonicals: readonly string[]): ReadonlySet<string> {
	const aliases = new Set<string>();
	for (const canonical of canonicals) {
		let found = false;
		for (const [alias, spec] of CLI_FLAG_SPECS) {
			if (spec.canonical !== canonical) continue;
			aliases.add(alias);
			found = true;
		}
		if (!found) throw new Error(`Unknown CLI flag spec: ${canonical}`);
	}
	return aliases;
}

const NO_TOOLS_FLAGS = flagAliases("--no-tools");
const NO_BUILTIN_TOOLS_FLAGS = flagAliases("--no-builtin-tools");
const NO_EXTENSIONS_FLAGS = flagAliases("--no-extensions");
const NO_SKILLS_FLAGS = flagAliases("--no-skills");
const NO_PROMPT_TEMPLATES_FLAGS = flagAliases("--no-prompt-templates");
const NO_THEMES_FLAGS = flagAliases("--no-themes");
const TOOLS_FLAGS = flagAliases("--tools");
const EXTENSION_FLAGS = flagAliases("--extension");
const SKILL_FLAGS = flagAliases("--skill");
const PROMPT_TEMPLATE_FLAGS = flagAliases("--prompt-template");
const THEME_FLAGS = flagAliases("--theme");
const EXCLUDE_TOOLS_FLAGS = flagAliases("--exclude-tools");
const MODEL_SCOPE_FLAGS = flagAliases("--models");
const ALLOWED_EXTRA_ARGS_HELP =
	"allowed start.args are safe narrowing flags such as --provider <value>, --model <value>, --models <value>, --thinking <value>, --exclude-tools <value>, --no-tools, --no-builtin-tools, --offline, --no-extensions, --no-skills, --no-prompt-templates, --no-themes, and --no-context-files";
// Pi applies --thinking after scoped model thinking, so it can widen an inherited
// --models scope just like selecting a different model/provider can.
const MODEL_SCOPE_OVERRIDE_FLAGS = flagAliases("--provider", "--model", "--models", "--thinking");
const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const INHERITED_ENABLE_RESTRICTIONS: readonly {
	readonly restrictionFlags: ReadonlySet<string>;
	readonly enableFlags: ReadonlySet<string>;
}[] = [
	{ restrictionFlags: NO_TOOLS_FLAGS, enableFlags: TOOLS_FLAGS },
	{ restrictionFlags: NO_EXTENSIONS_FLAGS, enableFlags: EXTENSION_FLAGS },
	{ restrictionFlags: NO_SKILLS_FLAGS, enableFlags: SKILL_FLAGS },
	{ restrictionFlags: NO_PROMPT_TEMPLATES_FLAGS, enableFlags: PROMPT_TEMPLATE_FLAGS },
	{ restrictionFlags: NO_THEMES_FLAGS, enableFlags: THEME_FLAGS },
];

export function assertAllowedExtraArgs(args: readonly string[]): void {
	parseAllowedExtraArgs(args);
}

export function collectInheritedPiArgs(
	argv: readonly string[] = process.argv,
	resourceBaseCwd: string = process.cwd(),
): readonly string[] {
	const args = processArgvToPiArgs(argv);
	const inherited: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) continue;
		if (arg === "--") break;

		// Pi's built-in parser only recognizes value flags in `--flag value` form.
		// Inline assignments such as `--model=opus` are exposed as extension
		// unknownFlags instead, so reinterpreting them here would make child Pi
		// processes inherit settings the parent did not actually apply.
		if (arg.includes("=")) {
			continue;
		}

		const spec = CLI_FLAG_SPECS.get(arg);
		if (spec?.inherit === true) {
			if (spec.takesValue) {
				const value = args[i + 1];
				if (value !== undefined) {
					inherited.push(spec.canonical, normalizeInheritedValue(spec, value, resourceBaseCwd));
					i++;
				}
			} else {
				inherited.push(spec.canonical);
			}
			continue;
		}

		if (VALUE_FLAGS_TO_SKIP.has(arg) && i + 1 < args.length) {
			i++;
			continue;
		}

		if (
			OPTIONAL_VALUE_FLAGS_TO_SKIP.has(arg) &&
			i + 1 < args.length &&
			!isFlagLike(args[i + 1]!) &&
			!args[i + 1]!.startsWith("@")
		) {
			i++;
			continue;
		}

		if (SENSITIVE_BOOLEAN_FLAGS.has(arg)) continue;

		if (arg.startsWith("--") && !arg.includes("=")) {
			const next = args[i + 1];
			if (next !== undefined && !isFlagLike(next) && !next.startsWith("@")) i++;
		}
	}

	return inherited;
}

function normalizeInheritedValue(
	spec: CliFlagSpec,
	value: string,
	resourceBaseCwd: string,
): string {
	if (spec.valueKind !== "cli-path" || !isLocalCliPath(value)) return value;
	return resolveCliPath(value, resourceBaseCwd);
}

function isLocalCliPath(value: string): boolean {
	const trimmed = value.trim();
	return !(
		trimmed.startsWith("npm:") ||
		trimmed.startsWith("git:") ||
		trimmed.startsWith("github:") ||
		trimmed.startsWith("http:") ||
		trimmed.startsWith("https:") ||
		trimmed.startsWith("ssh:")
	);
}

function resolveCliPath(value: string, resourceBaseCwd: string): string {
	const normalized = normalizeCliPath(value);
	const normalizedResourceBaseCwd = normalizeCliPath(resourceBaseCwd);
	return path.isAbsolute(normalized)
		? path.resolve(normalized)
		: path.resolve(normalizedResourceBaseCwd, normalized);
}

function normalizeCliPath(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
		return path.join(os.homedir(), value.slice(2));
	}
	if (value.startsWith("file://")) return fileURLToPath(value);
	return value;
}

export function shouldApproveChildCwd(
	parentProjectTrusted: boolean,
	parentCwd: string,
	childCwd: string,
): boolean {
	return parentProjectTrusted && isCwdInsideOrEqual(parentCwd, childCwd);
}

export function isCwdInsideOrEqual(parentCwd: string, childCwd: string): boolean {
	const parent = realpathOrResolve(parentCwd);
	const child = realpathOrResolve(childCwd);
	const relative = path.relative(parent, child);
	return relative === "" || (!escapesToParent(relative) && !path.isAbsolute(relative));
}

function escapesToParent(relativePath: string): boolean {
	return relativePath === ".." || relativePath.startsWith(`..${path.sep}`);
}

function realpathOrResolve(value: string): string {
	const resolved = path.resolve(value);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

function flagSpec(
	aliases: readonly [string, ...string[]],
	options: Omit<CliFlagSpec, "canonical">,
): readonly (readonly [string, CliFlagSpec])[] {
	const canonical = aliases[0];
	return aliases.map((alias) => [alias, { canonical, ...options }] as const);
}

function parseAllowedExtraArgs(args: readonly string[]): readonly string[] {
	const allowed: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) continue;
		if (arg.includes("=")) {
			throw new Error(
				`Unsupported child Pi arg for pi-dispatch: ${arg}. Repair: inline --flag=value forms are not allowed; pass flag and value as separate array items, e.g. "args": ["--model", "sonnet"].`,
			);
		}
		if (arg === "--" || PACKAGE_SUBCOMMANDS.has(arg) || !isFlagLike(arg)) {
			throw new Error(
				`Unsupported child Pi arg for pi-dispatch: ${arg}. Repair: remove package subcommands, prompts, and positional args; ${ALLOWED_EXTRA_ARGS_HELP}.`,
			);
		}

		const spec = CLI_FLAG_SPECS.get(arg);
		if (spec?.allowExtra !== true) {
			throw new Error(
				`Unsupported child Pi arg for pi-dispatch: ${arg}. Repair: remove this flag or replace it with an allowlisted restriction; ${ALLOWED_EXTRA_ARGS_HELP}. Children always run in RPC mode and cannot set session, approval, extension-loading, or one-shot flags through start.args.`,
			);
		}

		allowed.push(arg);
		if (spec.takesValue) {
			const value = args[i + 1];
			if (value === undefined || isFlagLike(value)) {
				throw new Error(
					`Unsupported child Pi arg for pi-dispatch: ${arg} requires a value. Repair: pass the value as the next array item, e.g. "args": ["${arg}", "value"].`,
				);
			}
			allowed.push(value);
			i++;
		}
	}

	return allowed;
}

function mergeChildArgs(
	inheritedArgs: readonly string[],
	extraArgs: readonly string[],
): readonly string[] {
	const allowedExtraArgs = parseAllowedExtraArgs(extraArgs);
	assertNoInheritedModelScopeOverride(inheritedArgs, allowedExtraArgs);
	const filteredInheritedArgs = stripInheritedEnablesForRestrictions(
		inheritedArgs,
		allowedExtraArgs,
	);

	const childExcludeToolValues = collectFlagValues(allowedExtraArgs, EXCLUDE_TOOLS_FLAGS);
	if (childExcludeToolValues.length > 0) {
		const inheritedExcludeToolValue = collectLastFlagValue(
			filteredInheritedArgs,
			EXCLUDE_TOOLS_FLAGS,
		);
		const mergedExcludeTools = mergeCommaSeparatedValues([
			...(inheritedExcludeToolValue === undefined ? [] : [inheritedExcludeToolValue]),
			...childExcludeToolValues,
		]);
		const argsWithoutInheritedExcludeTools = removeFlags(
			filteredInheritedArgs,
			EXCLUDE_TOOLS_FLAGS,
		);
		const argsWithoutChildExcludeTools = removeFlags(allowedExtraArgs, EXCLUDE_TOOLS_FLAGS);
		return mergedExcludeTools.length === 0
			? [...argsWithoutInheritedExcludeTools, ...argsWithoutChildExcludeTools]
			: [
					...argsWithoutInheritedExcludeTools,
					...argsWithoutChildExcludeTools,
					"--exclude-tools",
					mergedExcludeTools.join(","),
				];
	}

	return [...filteredInheritedArgs, ...allowedExtraArgs];
}

function stripInheritedEnablesForRestrictions(
	inheritedArgs: readonly string[],
	restrictionArgs: readonly string[],
): readonly string[] {
	let filteredArgs = inheritedArgs;
	for (const restriction of INHERITED_ENABLE_RESTRICTIONS) {
		if (hasFlag(restrictionArgs, restriction.restrictionFlags)) {
			filteredArgs = removeFlags(filteredArgs, restriction.enableFlags);
		}
	}
	if (
		!hasFlag(restrictionArgs, NO_TOOLS_FLAGS) &&
		hasFlag(restrictionArgs, NO_BUILTIN_TOOLS_FLAGS)
	) {
		filteredArgs = filterInheritedToolAllowlistForNoBuiltinTools(filteredArgs);
	}
	return filteredArgs;
}

function assertNoInheritedModelScopeOverride(
	inheritedArgs: readonly string[],
	allowedExtraArgs: readonly string[],
): void {
	if (!hasFlag(inheritedArgs, MODEL_SCOPE_FLAGS)) return;
	if (!hasFlag(allowedExtraArgs, MODEL_SCOPE_OVERRIDE_FLAGS)) return;

	throw new Error(
		"Unsupported child Pi arg for pi-dispatch: child model/provider/thinking args cannot override an inherited --models scope. Repair: omit --provider/--model/--models/--thinking from start.args or start the parent with a narrower model scope.",
	);
}

function filterInheritedToolAllowlistForNoBuiltinTools(
	inheritedArgs: readonly string[],
): readonly string[] {
	// --tools is an active-tool allowlist and can re-enable built-ins even when
	// --no-builtin-tools is present. Intersect the effective inherited allowlist
	// with the child's no-built-ins restriction; if nothing remains, force no
	// tools rather than dropping --tools and enabling every extension tool.
	const inheritedToolValue = collectLastFlagValue(inheritedArgs, TOOLS_FLAGS);
	if (inheritedToolValue === undefined) return inheritedArgs;

	const argsWithoutInheritedTools = removeFlags(inheritedArgs, TOOLS_FLAGS);
	const nonBuiltinTools = mergeCommaSeparatedValues([inheritedToolValue]).filter(
		(toolName) => !BUILTIN_TOOL_NAMES.has(toolName),
	);
	return nonBuiltinTools.length === 0
		? [...argsWithoutInheritedTools, "--no-tools"]
		: [...argsWithoutInheritedTools, "--tools", nonBuiltinTools.join(",")];
}

function hasFlag(args: readonly string[], flags: ReadonlySet<string>): boolean {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) continue;
		if (flags.has(arg)) return true;

		const spec = CLI_FLAG_SPECS.get(arg);
		if (spec?.takesValue === true) i++;
	}
	return false;
}

function collectFlagValues(args: readonly string[], flags: ReadonlySet<string>): readonly string[] {
	const values: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) continue;

		const spec = CLI_FLAG_SPECS.get(arg);
		if (flags.has(arg)) {
			const value = args[i + 1];
			if (spec?.takesValue === true && value !== undefined) {
				values.push(value);
				i++;
			}
			continue;
		}

		if (spec?.takesValue === true) i++;
	}
	return values;
}

function collectLastFlagValue(
	args: readonly string[],
	flags: ReadonlySet<string>,
): string | undefined {
	let value: string | undefined;
	for (const nextValue of collectFlagValues(args, flags)) value = nextValue;
	return value;
}

function mergeCommaSeparatedValues(values: readonly string[]): readonly string[] {
	const merged: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		for (const item of value.split(",")) {
			const normalized = item.trim();
			if (normalized === "" || seen.has(normalized)) continue;
			seen.add(normalized);
			merged.push(normalized);
		}
	}
	return merged;
}

function removeFlags(args: readonly string[], flags: ReadonlySet<string>): readonly string[] {
	const result: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) continue;
		const spec = CLI_FLAG_SPECS.get(arg);
		if (!flags.has(arg)) {
			result.push(arg);
			if (spec?.takesValue === true) {
				const value = args[i + 1];
				if (value !== undefined) {
					result.push(value);
					i++;
				}
			}
			continue;
		}

		if (spec?.takesValue === true) i++;
	}
	return result;
}

function processArgvToPiArgs(argv: readonly string[]): readonly string[] {
	if (argv.length <= 1) return [];
	const invokedScript = argv[1];
	if (invokedScript !== undefined && looksLikeNodeScript(invokedScript)) return argv.slice(2);
	const execName = path.basename(argv[0] ?? "").toLowerCase();
	if (/^(node|bun)(\.exe)?$/u.test(execName)) return argv.slice(2);
	return argv.slice(1);
}

function looksLikeNodeScript(value: string): boolean {
	return (
		value.endsWith(".js") ||
		value.endsWith(".mjs") ||
		value.endsWith(".cjs") ||
		value.endsWith(".ts") ||
		value.startsWith("/$bunfs/root/") ||
		fs.existsSync(value)
	);
}

function isFlagLike(value: string): boolean {
	return value.startsWith("-") && !value.startsWith("---");
}
