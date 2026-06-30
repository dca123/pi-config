import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, formatSkillsForPrompt, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

type Loadout = {
	description?: string;
	tools: string[];
	visibleSkills?: string[];
	instructions?: string;
};

type LoadoutConfig = {
	loadouts: Record<string, Loadout>;
};

type LoadoutState = {
	name: string | null;
};

type OriginalState = {
	tools: string[];
};

type ApplyResult =
	| { status: "applied"; name: string }
	| { status: "not-found"; name: string }
	| { status: "not-idle" }
	| { status: "invalid-tools"; name: string };

const LOADOUT_STATE_ENTRY = "loadout-state";

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseLoadout(value: unknown): Loadout | undefined {
	if (!value || typeof value !== "object") return undefined;

	const input = value as Record<string, unknown>;
	if (!isStringArray(input.tools)) return undefined;

	return {
		description: typeof input.description === "string" ? input.description : undefined,
		tools: input.tools,
		visibleSkills: isStringArray(input.visibleSkills) ? input.visibleSkills : undefined,
		instructions: typeof input.instructions === "string" ? input.instructions : undefined,
	};
}

function loadConfigFile(path: string): LoadoutConfig {
	if (!existsSync(path)) return { loadouts: {} };

	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { loadouts?: Record<string, unknown> };
		const loadouts: Record<string, Loadout> = {};

		for (const [name, value] of Object.entries(parsed.loadouts ?? {})) {
			const loadout = parseLoadout(value);
			if (loadout) {
				loadouts[name] = loadout;
			}
		}

		return { loadouts };
	} catch {
		return { loadouts: {} };
	}
}

function loadCatalog(cwd: string): LoadoutConfig {
	const globalConfig = loadConfigFile(join(getAgentDir(), "loadouts.json"));
	const projectConfig = loadConfigFile(join(cwd, ".pi", "loadouts.json"));

	return {
		loadouts: {
			...globalConfig.loadouts,
			...projectConfig.loadouts,
		},
	};
}

function describeLoadout(name: string, loadout: Loadout): string {
	const parts: string[] = [];

	if (loadout.description) {
		parts.push(loadout.description);
	}

	parts.push(`tools:${loadout.tools.join(",")}`);

	if (loadout.visibleSkills) {
		parts.push(`skills:${loadout.visibleSkills.join(",")}`);
	}

	return `${name} — ${parts.join(" | ")}`;
}

function restoreSkillsSection(systemPrompt: string, skills: Skill[]): string {
	const skillsSection = formatSkillsForPrompt(skills);
	const pattern = /\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;

	if (pattern.test(systemPrompt)) {
		return systemPrompt.replace(pattern, skillsSection);
	}

	if (!skillsSection) return systemPrompt;

	return `${systemPrompt}${skillsSection}`;
}

function removeSkillsSection(systemPrompt: string): string {
	return systemPrompt.replace(
		/\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/,
		"",
	);
}

function buildLoadoutPrompt(systemPrompt: string, ctx: { loadout: Loadout; skills: Skill[] }): string {
	let nextPrompt = systemPrompt;

	if (ctx.loadout.visibleSkills) {
		const visibleNames = new Set(ctx.loadout.visibleSkills);
		const visibleSkills = ctx.skills.filter((skill) => visibleNames.has(skill.name));
		nextPrompt = visibleSkills.length === 0 ? removeSkillsSection(nextPrompt) : restoreSkillsSection(nextPrompt, visibleSkills);
	}

	if (ctx.loadout.instructions) {
		nextPrompt = `${nextPrompt}\n\n${ctx.loadout.instructions}`;
	}

	return nextPrompt;
}

function getLastLoadoutState(ctx: ExtensionContext): LoadoutState | undefined {
	let state: LoadoutState | undefined;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== LOADOUT_STATE_ENTRY) continue;
		const data = entry.data as Partial<LoadoutState> | undefined;
		if (typeof data?.name === "string" || data?.name === null) {
			state = { name: data.name };
		}
	}

	return state;
}

export default function loadoutsExtension(pi: ExtensionAPI) {
	let catalog: LoadoutConfig = { loadouts: {} };
	let activeLoadoutName: string | undefined;
	let originalState: OriginalState | undefined;

	function getActiveLoadout(): Loadout | undefined {
		if (!activeLoadoutName) return undefined;
		return catalog.loadouts[activeLoadoutName];
	}

	function setStatus(ctx: ExtensionContext): void {
		if (!activeLoadoutName) {
			ctx.ui.setStatus("loadout", undefined);
			return;
		}

		ctx.ui.setStatus("loadout", ctx.ui.theme.fg("accent", `loadout:${activeLoadoutName}`));
	}

	function validateTools(loadout: Loadout): string[] {
		const availableTools = new Set(pi.getAllTools().map((tool) => tool.name));
		return loadout.tools.filter((tool) => !availableTools.has(tool));
	}

	function persistActiveLoadout(): void {
		if (!activeLoadoutName) return;
		pi.appendEntry<LoadoutState>(LOADOUT_STATE_ENTRY, { name: activeLoadoutName });
	}

	function applyLoadout(name: string, ctx: ExtensionContext, options?: { persist?: boolean }): ApplyResult {
		if (!ctx.isIdle()) {
			return { status: "not-idle" };
		}

		const loadout = catalog.loadouts[name];
		if (!loadout) {
			return { status: "not-found", name };
		}

		const invalidTools = validateTools(loadout);
		if (invalidTools.length > 0) {
			ctx.ui.notify(`Loadout "${name}" has unknown tools: ${invalidTools.join(", ")}`, "error");
			return { status: "invalid-tools", name };
		}

		if (!originalState) {
			originalState = { tools: pi.getActiveTools() };
		}

		pi.setActiveTools(loadout.tools);
		activeLoadoutName = name;
		setStatus(ctx);

		if (options?.persist !== false) {
			persistActiveLoadout();
		}

		return { status: "applied", name };
	}

	function clearLoadout(ctx: ExtensionContext): void {
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait until pi is idle before clearing loadout", "warning");
			return;
		}

		activeLoadoutName = undefined;
		pi.appendEntry<LoadoutState>(LOADOUT_STATE_ENTRY, { name: null });

		if (originalState) {
			pi.setActiveTools(originalState.tools);
		}

		setStatus(ctx);
		ctx.ui.notify("Loadout cleared", "info");
	}

	async function showSelector(ctx: ExtensionContext): Promise<void> {
		const names = Object.keys(catalog.loadouts).sort();
		if (names.length === 0) {
			ctx.ui.notify("No loadouts found in ~/.pi/agent/loadouts.json or .pi/loadouts.json", "warning");
			return;
		}

		const items: SelectItem[] = names.map((name) => {
			const loadout = catalog.loadouts[name];
			return {
				value: name,
				label: activeLoadoutName === name ? `${name} (active)` : name,
				description: describeLoadout(name, loadout),
			};
		});

		items.push({
			value: "__clear__",
			label: "clear",
			description: "Restore pi's original tool set",
		});

		const result = await ctx.ui.custom<string | undefined>(
			(tui, theme, _keybindings, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Select loadout"))));

				const list = new SelectList(items, Math.min(items.length, 12), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});

				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done(undefined);

				container.addChild(list);
				container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel")));
				container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						list.handleInput(data);
						tui.requestRender();
					},
				};
			},
			{ overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "70%" } },
		);

		if (!result) return;

		if (result === "__clear__") {
			clearLoadout(ctx);
			return;
		}

		const applyResult = applyLoadout(result, ctx);
		if (applyResult.status === "applied") {
			ctx.ui.notify(`Loadout "${result}" applied`, "info");
		}
		if (applyResult.status === "not-idle") {
			ctx.ui.notify("Wait until pi is idle before switching loadouts", "warning");
		}
	}

	pi.registerCommand("loadout", {
		description: "Select a runtime loadout",
		handler: async (args, ctx) => {
			catalog = loadCatalog(ctx.cwd);
			const name = args.trim();

			if (!name) {
				await showSelector(ctx);
				return;
			}

			if (name === "clear") {
				clearLoadout(ctx);
				return;
			}

			const result = applyLoadout(name, ctx);
			if (result.status === "applied") {
				ctx.ui.notify(`Loadout "${name}" applied`, "info");
				return;
			}

			if (result.status === "not-found") {
				ctx.ui.notify(`Unknown loadout "${name}"`, "error");
				return;
			}

			if (result.status === "not-idle") {
				ctx.ui.notify("Wait until pi is idle before switching loadouts", "warning");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		catalog = loadCatalog(ctx.cwd);

		const state = getLastLoadoutState(ctx);
		if (state?.name && catalog.loadouts[state.name]) {
			applyLoadout(state.name, ctx, { persist: false });
		}

		if (state?.name === null) {
			activeLoadoutName = undefined;
		}

		setStatus(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		const loadout = getActiveLoadout();
		if (!loadout) return;

		return {
			systemPrompt: buildLoadoutPrompt(event.systemPrompt, {
				loadout,
				skills: event.systemPromptOptions.skills ?? [],
			}),
		};
	});
}
