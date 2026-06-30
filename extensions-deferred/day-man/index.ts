/**
 * Day Man Extension
 *
 * Scoping-only mode for night-man. When enabled, the model helps
 * understand and define problems without suggesting code fixes.
 *
 * - /day-man         — toggle scoping mode on/off
 * - /day-man done    — finish scoping → grill-me or write spec
 * - /day-man review  — review a completed night-man run
 *
 * Blocks `edit` tool (the code-fix tool) but allows `write` for
 * debug probes and everything else for exploration.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import { pathToFileURL } from "node:url";

type ReportEntry = {
	change: string;
	itemName: string;
	session: string;
};

type ReviewHelpers = {
	parseReport: (content: string) => ReportEntry[];
	findLastRunId: (entries: ReportEntry[]) => string | undefined;
	getUniqueRunIds: (entries: ReportEntry[]) => string[];
	getCompleteSessionsForRun: (entries: ReportEntry[], runId: string) => ReportEntry[];
	buildReviewPrompt: (input: {
		specFile: string;
		sessionPath: string;
		learningsFile?: string;
		agentLoopFile: string;
		nightmanSkillPath: string;
	}) => string;
};

let reviewHelpersPromise: Promise<ReviewHelpers> | undefined;

function loadReviewHelpers(): Promise<ReviewHelpers> {
	reviewHelpersPromise ??= import(pathToFileURL(joinPath(homedir(), "Projects/night-man/src/review.js")).href) as Promise<ReviewHelpers>;
	return reviewHelpersPromise;
}

const SCOPING_TOOLS = [
	"read",
	"bash",
	"write",
	"web_search",
	"fetch_content",
	"debug_start",
	"debug_status",
	"debug_read",
	"debug_clear",
	"debug_stop",
];

const SCOPING_SYSTEM_PROMPT = `[DAY MAN — SCOPING MODE]

You are in scoping mode. Your ONLY job is to help the user understand and define the problem.

RULES:
- Do NOT suggest code fixes, implementations, patches, or solutions
- Do NOT write or propose code changes
- Do NOT say "you could fix this by..." or "here's how to solve it..."
- DO explore the codebase to understand the current state
- DO ask clarifying questions about the problem
- DO identify root causes, affected areas, edge cases, and dependencies
- DO summarize what you've learned about the problem scope
- DO use the debug tools if the user wants runtime evidence

Think of yourself as a senior engineer doing problem discovery — not implementation.`;

export default function dayManExtension(pi: ExtensionAPI): void {
	let enabled = false;

	let helpTimeout: ReturnType<typeof setTimeout> | undefined;

	function updateUI(ctx: ExtensionContext): void {
		if (enabled) {
			ctx.ui.setStatus("day-man", ctx.ui.theme.fg("warning", "☀️ scoping"));
		} else {
			ctx.ui.setStatus("day-man", undefined);
		}
		ctx.ui.setWidget("day-man", undefined);
	}

	function flashHelp(ctx: ExtensionContext): void {
		if (helpTimeout) clearTimeout(helpTimeout);
		ctx.ui.setWidget("day-man", [
			ctx.ui.theme.fg("warning", "☀️ Day Man"),
			ctx.ui.theme.fg("muted", "  /day-man            → toggle on/off"),
			ctx.ui.theme.fg("muted", "  /day-man done       → grill or write spec"),
			ctx.ui.theme.fg("muted", "  /day-man review     → review agent output"),
			ctx.ui.theme.fg("muted", "  /day-man bot-review → multi-model review"),
			ctx.ui.theme.fg("muted", "  /day-man help       → show this"),
		]);
		helpTimeout = setTimeout(() => {
			ctx.ui.setWidget("day-man", undefined);
			helpTimeout = undefined;
		}, 5000);
	}

	function enable(ctx: ExtensionContext): void {
		enabled = true;
		pi.setActiveTools(SCOPING_TOOLS);
		persistState();
		updateUI(ctx);
		ctx.ui.notify("☀️ Day Man enabled — scoping mode, no fixes", "info");
	}

	function disable(ctx: ExtensionContext): void {
		enabled = false;
		pi.setActiveTools(pi.getAllTools().map((t) => t.name)); // restore all tools
		persistState();
		updateUI(ctx);
		ctx.ui.notify("Day Man disabled — full access restored", "info");
	}

	function persistState(): void {
		pi.appendEntry("day-man", { enabled });
	}

	// --- Command: /day-man [done|review] ---

	pi.registerCommand("day-man", {
		description: "Toggle scoping mode (no fix suggestions)",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["done", "review", "bot-review", "bot-review show", "bot-review --no-cr", "help"];
			const matches = subcommands.filter((cmd) => cmd.startsWith(prefix));
			return matches.length > 0 ? matches.map((cmd) => ({ value: cmd, label: cmd })) : null;
		},
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim().toLowerCase();

			if (trimmed === "done") {
				if (!enabled) {
					ctx.ui.notify("Day Man is not active", "warning");
					return;
				}
				await handleDone(ctx);
				return;
			}

			if (trimmed === "review") {
				await handleReview(ctx);
				return;
			}

			if (trimmed === "bot-review show") {
				await handleBotReviewShow(ctx);
				return;
			}

			if (trimmed.startsWith("bot-review")) {
				const noCr = trimmed.includes("--no-cr");
				// Extract revision if provided (anything that's not a flag)
				const parts = trimmed.split(/\s+/).filter((p) => p !== "bot-review" && p !== "--no-cr");
				const rev = parts.length > 0 ? parts[0] : undefined;
				await handleBotReview(ctx, noCr, rev);
				return;
			}

			if (trimmed === "help") {
				flashHelp(ctx);
				return;
			}

			// Toggle
			if (enabled) {
				disable(ctx);
			} else {
				enable(ctx);
			}
		},
	});

	// --- Done flow: grill-me or write spec ---

	async function handleDone(ctx: ExtensionContext): Promise<void> {
		const choice = await ctx.ui.select("Scoping complete — what next?", [
			"Grill me — stress-test what I've scoped",
			"Hand off to Night Man",
			"Keep scoping",
		]);

		if (!choice) return;

		if (choice.startsWith("Grill me")) {
			// Stay in day-man mode during grilling (still no fixes)
			pi.sendUserMessage(
				"Interview me relentlessly about every aspect of the problem we just scoped. " +
					"Walk down each branch of the design tree resolving dependencies between decisions one by one. " +
					"If a question can be answered by exploring the codebase, explore the codebase instead. " +
					"For each question, provide your recommended answer.",
				{ deliverAs: "followUp" },
			);
		} else if (choice.startsWith("Hand off")) {
			await handleHandoff(ctx);
		}
		// "Keep scoping" — do nothing
	}

	async function handleHandoff(ctx: ExtensionContext): Promise<void> {
		// 1. Spec or bug?
		const type = await ctx.ui.select("What kind of item is this?", [
			"Spec — new feature or change",
			"Bug — defect to fix",
		]);
		if (!type) return;
		const isBug = type.startsWith("Bug");

		// 2. Check for existing items and ask about dependencies
		let dependsOn = "";
		const existingItems = await findExistingItems();
		if (existingItems.length > 0) {
			const depChoice = await ctx.ui.select(
				"Does this depend on an existing spec/bug?",
				["No dependencies", ...existingItems],
			);
			if (depChoice && depChoice !== "No dependencies") {
				dependsOn = depChoice;
			}
		}

		// 3. Any extra context?
		const extra = await ctx.ui.input("Any extra context?", "Optional — press Enter to skip");

		// 4. Capture current session path for planning context
		const planningSession = ctx.sessionManager.getSessionFile?.() ?? undefined;

		// 5. Disable day-man and send to nightman skill
		disable(ctx);

		const typeLabel = isBug ? "bug" : "spec";
		let prompt =
			`Using the nightman skill, synthesize everything we discussed into a ${typeLabel} file. ` +
			"Do not interview me \u2014 use what we've already covered.";

		if (planningSession) {
			prompt += ` Planning session path: ${planningSession}`;
		}
		if (dependsOn) {
			prompt += ` This depends on: ${dependsOn} \u2014 add it as YAML frontmatter.`;
		}
		if (extra?.trim()) {
			prompt += ` Additional context: ${extra.trim()}`;
		}

		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	}

	// --- Review flow: diagnose agent run failures ---

	async function handleReview(ctx: ExtensionCommandContext): Promise<void> {
		const { readFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const { execSync } = await import("node:child_process");

		const cwd = process.cwd();
		const nightManDir = join(cwd, ".night-man");
		const reportPath = join(nightManDir, "report.md");

		// 1. Check .night-man exists
		try {
			await import("node:fs").then((fs) => fs.accessSync(nightManDir));
		} catch {
			ctx.ui.notify("Not initialized — run night-man init first", "error");
			return;
		}

		// 2. Read and parse report
		let reportContent: string;
		try {
			reportContent = await readFile(reportPath, "utf-8");
		} catch {
			ctx.ui.notify("No report.md found — run night-man run first", "error");
			return;
		}

		const {
			parseReport,
			getUniqueRunIds,
			getCompleteSessionsForRun,
			buildReviewPrompt,
		} = await loadReviewHelpers();

		const entries = parseReport(reportContent);
		if (entries.length === 0) {
			ctx.ui.notify("No runs found in report.md", "warning");
			return;
		}

		// 3. Pick a run
		const runIds = getUniqueRunIds(entries);
		if (runIds.length === 0) {
			ctx.ui.notify("No runs with a run ID found — run night-man run first", "warning");
			return;
		}

		const runOptions = runIds.map((id) => {
			const sessionsInRun = getCompleteSessionsForRun(entries, id);
			const count = sessionsInRun.length;
			return `${id}  (${count} complete)`;
		});

		const runChoice = await ctx.ui.select("Pick a run to review:", runOptions);
		if (!runChoice) return;

		const selectedRunId = runIds[runOptions.indexOf(runChoice)];

		// 4. Filter complete sessions for the chosen run
		const completeSessions = getCompleteSessionsForRun(entries, selectedRunId);
		if (completeSessions.length === 0) {
			ctx.ui.notify(`No complete sessions in ${selectedRunId}`, "warning");
			return;
		}

		// 5. Pick session
		let selected: ReportEntry;
		if (completeSessions.length === 1) {
			selected = completeSessions[0];
			ctx.ui.notify(`Auto-selected: ${selected.itemName}`, "info");
		} else {
			const options = completeSessions.map(
				(e) => `${e.change} — ${e.itemName}`,
			);
			const choice = await ctx.ui.select("Pick a session to review:", options);
			if (!choice) return;

			const idx = options.indexOf(choice);
			selected = completeSessions[idx];
		}

		// 6. Check for dirty working tree
		try {
			const status = execSync("jj status --no-pager 2>&1", {
				cwd,
				encoding: "utf-8",
			});
			// jj status shows "Working copy changes:" if dirty
			if (status.includes("Working copy changes:")) {
				const proceed = await ctx.ui.confirm(
					"Working tree has changes",
					"jj new will create a new change on top. Continue?",
				);
				if (!proceed) return;
			}
		} catch {
			// jj not available or not a jj repo — warn but continue
			ctx.ui.notify("Could not check jj status", "warning");
		}

		// 7. Run jj new
		const changeId = selected.change;
		if (!changeId || changeId === "none") {
			ctx.ui.notify("No jj change ID recorded for this session", "error");
			return;
		}

		try {
			execSync(`jj new ${changeId}`, { cwd, encoding: "utf-8" });
			ctx.ui.notify(`jj new ${changeId} — now reviewing ${selected.itemName}`, "success");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`jj new failed: ${msg}`, "error");
			return;
		}

		// 8. Disable scoping mode if active
		if (enabled) {
			disable(ctx);
		}

		// 9. Determine spec file path (may have been renamed to done-)
		const specFile = resolveSpecPath(cwd, selected.itemName);

		// 10. Resolve paths that live outside the project
		const { existsSync, realpathSync } = await import("node:fs");

		// AGENT_LOOP.md lives alongside night-man.sh, not in the project
		let agentLoopFile = join(cwd, "AGENT_LOOP.md");
		try {
			const nightManBin = execSync("which night-man", { encoding: "utf-8" }).trim();
			const nightManReal = realpathSync(nightManBin);
			const nightManDir = join(nightManReal, "..");
			const resolved = join(nightManDir, "AGENT_LOOP.md");
			if (existsSync(resolved)) {
				agentLoopFile = resolved;
			}
		} catch {
			// fall back to cwd-relative
		}

		// LEARNINGS.md may not exist yet
		const learningsFile = join(cwd, ".night-man", "LEARNINGS.md");
		const learningsPath = existsSync(learningsFile)
			? join(".night-man", "LEARNINGS.md")
			: undefined;

		// 11. Build review prompt
		const prompt = buildReviewPrompt({
			specFile,
			sessionPath: selected.session,
			learningsFile: learningsPath,
			agentLoopFile,
			nightmanSkillPath: "~/.agents/skills/nightman/SKILL.md",
		});

		// 11. Create new session with review context
		const reviewSlug = selected.itemName.replace(/\.md$/, "");
		const reviewDirName = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${reviewSlug}`;
		const reviewsDir = join(cwd, ".night-man", "reviews");

		await ctx.newSession({
			setup: async (sm) => {
				sm.appendMessage({
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				});
			},
			withSession: async (newCtx) => {
				// Symlink the pi-managed session file into .night-man/reviews/
				const sessionFile = newCtx.sessionManager?.getSessionFile?.();
				if (sessionFile) {
					const { mkdirSync, symlinkSync } = await import("node:fs");
					const symlinkDir = join(reviewsDir, reviewDirName);
					try {
						mkdirSync(symlinkDir, { recursive: true });
						const linkPath = join(symlinkDir, "session.jsonl");
						symlinkSync(sessionFile, linkPath);
					} catch {
						// Non-fatal — review still works without the symlink
					}
				}

				await newCtx.sendUserMessage(
					`I'm reviewing the output of night-man run ${selectedRunId}, session for ${selected.itemName}. ` +
					`Read the spec file and run \`jj diff -r @-\` to see what the agent implemented. ` +
					`Then wait for my feedback on what's wrong.`,
				);
			},
		});
	}

	// --- Bot review: multi-model review with consolidation ---

	let botReviewChild: ReturnType<typeof import("node:child_process").spawn> | null = null;

	async function handleBotReview(ctx: ExtensionContext, noCr = false, rev?: string): Promise<void> {
		const { spawn, execSync } = await import("node:child_process");
		const { join } = await import("node:path");
		const { existsSync, realpathSync } = await import("node:fs");

		const cwd = process.cwd();

		// Check we're in a nightman project
		if (!existsSync(join(cwd, ".night-man"))) {
			ctx.ui.notify("Not initialized — run night-man init first", "error");
			return;
		}

		// Check target has content (auto-detect if no rev given)
		try {
			const wcDiff = execSync("jj diff --stat", { cwd, encoding: "utf-8" }).trim();
			const parentDiff = execSync("jj diff -r @- --stat", { cwd, encoding: "utf-8" }).trim();
			if (!rev) {
				// Auto-detect
				if (wcDiff && !wcDiff.includes("0 files changed")) {
					// @ has changes
				} else if (parentDiff && !parentDiff.includes("0 files changed")) {
					// @- has changes
				} else {
					ctx.ui.notify("No changes in @ or @- — nothing to review", "warning");
					return;
				}
			}
		} catch {
			ctx.ui.notify("Failed to check for changes", "error");
			return;
		}

		// Check if already running
		if (botReviewChild && botReviewChild.exitCode === null) {
			ctx.ui.notify("Bot review already running", "warning");
			return;
		}

		// Find bot-review.sh alongside night-man
		let scriptPath: string | undefined;
		try {
			const nightManBin = execSync("which night-man", { encoding: "utf-8" }).trim();
			const nightManReal = realpathSync(nightManBin);
			const nightManDir = join(nightManReal, "..");
			const candidate = join(nightManDir, "bot-review.sh");
			if (existsSync(candidate)) {
				scriptPath = candidate;
			}
		} catch {
			// fall through
		}
		if (!scriptPath) {
			ctx.ui.notify("bot-review.sh not found alongside night-man", "error");
			return;
		}

		// Spawn
		ctx.ui.setStatus("bot-review", ctx.ui.theme.fg("accent", "🤖 reviewing..."));
		ctx.ui.notify("Bot review started", "info");

		const args = [scriptPath, "--cwd", cwd];
		if (rev) args.push("--rev", rev);
		if (noCr) args.push("--no-cr");

		botReviewChild = spawn("bash", args, {
			cwd,
			stdio: "ignore",
			detached: true,
		});
		botReviewChild.unref();

		botReviewChild.on("exit", (code) => {
			if (code === 0) {
				ctx.ui.setStatus("bot-review", ctx.ui.theme.fg("success", "🤖 review ready"));
				ctx.ui.notify("Bot review complete", "success");
			} else {
				ctx.ui.setStatus("bot-review", ctx.ui.theme.fg("error", "🤖 review failed"));
				ctx.ui.notify(`Bot review failed (exit ${code})`, "error");
			}
			botReviewChild = null;
		});

		botReviewChild.on("error", (err) => {
			ctx.ui.setStatus("bot-review", ctx.ui.theme.fg("error", "🤖 review failed"));
			ctx.ui.notify(`Bot review error: ${err.message}`, "error");
			botReviewChild = null;
		});
	}

	async function handleBotReviewShow(ctx: ExtensionContext): Promise<void> {
		const { readdirSync, existsSync } = await import("node:fs");
		const { join } = await import("node:path");

		const cwd = process.cwd();
		const reviewsDir = join(cwd, ".night-man", "reviews");
		if (!existsSync(reviewsDir)) {
			ctx.ui.notify("No reviews found", "warning");
			return;
		}

		// Find all bot-review.md files (nested: slug/timestamp/bot-review.md)
		const { execSync: exec } = await import("node:child_process");
		let latest: string | undefined;
		try {
			latest = exec(
				"find .night-man/reviews -name 'bot-review.md' -type f -print0 | xargs -0 ls -t | head -1",
				{ cwd, encoding: "utf-8" },
			).trim();
		} catch {
			// fall through
		}

		if (!latest) {
			ctx.ui.notify("No bot-review.md found", "warning");
			return;
		}

		const path = latest;
		ctx.ui.setEditorText(path);
		ctx.ui.notify(`Latest: ${path}`, "info");
	}

	function resolveSpecPath(cwd: string, itemName: string): string {
		const { existsSync } = require("node:fs") as typeof import("node:fs");
		const { join } = require("node:path") as typeof import("node:path");

		// Check bugs dir first, then specs dir (both with done- prefix and without)
		for (const dir of ["bugs", "specs"]) {
			const donePath = join(cwd, ".night-man", dir, `done-${itemName}`);
			if (existsSync(donePath)) {
				return join(".night-man", dir, `done-${itemName}`);
			}
			const directPath = join(cwd, ".night-man", dir, itemName);
			if (existsSync(directPath)) {
				return join(".night-man", dir, itemName);
			}
		}

		// Fallback — return the most likely path
		return join(".night-man", "specs", `done-${itemName}`);
	}

	async function findExistingItems(): Promise<string[]> {
		const { readdir } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const items: string[] = [];

		for (const dir of ["specs", "bugs"]) {
			try {
				const files = await readdir(join(process.cwd(), ".night-man", dir));
				for (const f of files) {
					if (f.endsWith(".md") && !f.startsWith("done-")) {
						items.push(`${dir}/${f}`);
					}
				}
			} catch {
				// dir doesn't exist, skip
			}
		}

		return items;
	}

	// --- System prompt injection ---

	pi.on("before_agent_start", async () => {
		if (!enabled) return;
		return {
			message: {
				customType: "day-man-context",
				content: SCOPING_SYSTEM_PROMPT,
				display: false,
			},
		};
	});

	// --- Block edit tool as a safety net ---

	pi.on("tool_call", async (event) => {
		if (!enabled) return;
		if (event.toolName === "edit") {
			return {
				block: true,
				reason: "Day Man (scoping mode): edit is blocked. Use /day-man done to finish scoping first.",
			};
		}
	});

	// --- Filter stale day-man context when disabled ---

	pi.on("context", async (event) => {
		if (enabled) return;
		return {
			messages: event.messages.filter((m) => {
				const msg = m as typeof m & { customType?: string };
				return msg.customType !== "day-man-context";
			}),
		};
	});

	// --- Restore state on session resume ---

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "day-man")
			.pop() as { data?: { enabled: boolean } } | undefined;

		if (last?.data?.enabled) {
			enabled = true;
			pi.setActiveTools(SCOPING_TOOLS);
		}

		updateUI(ctx);
	});
}
