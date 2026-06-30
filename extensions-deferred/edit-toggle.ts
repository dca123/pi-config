import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const EDIT_TOOLS = ["edit", "write"] as const;
const STATUS_KEY = "edit-toggle";
const DISABLED_PROMPT =
	"Edit and write tools are currently disabled by the user. Treat this as discussion/review mode: help reason through the task, inspect context if useful, and propose changes, but do not attempt to modify files. If implementation is needed, ask the user to re-enable edit tools.";

function areEditToolsDisabled(pi: ExtensionAPI): boolean {
	const activeTools = pi.getActiveTools();
	return EDIT_TOOLS.every((toolName) => !activeTools.includes(toolName));
}

function updateStatus(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (areEditToolsDisabled(pi)) {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "edit disabled"));
		return;
	}

	ctx.ui.setStatus(STATUS_KEY, undefined);
}

// One-shot announcement consumed by the next before_agent_start, so a mid-session
// toggle is called out once instead of silently changing the available tool set.
let pendingNotice: "enabled" | "disabled" | undefined;

function toggleEditTools(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const activeTools = pi.getActiveTools();
	const editToolsDisabled = areEditToolsDisabled(pi);
	const nextTools = editToolsDisabled
		? Array.from(new Set([...activeTools, ...EDIT_TOOLS]))
		: activeTools.filter((toolName) => !EDIT_TOOLS.includes(toolName as (typeof EDIT_TOOLS)[number]));

	pi.setActiveTools(nextTools);
	pendingNotice = editToolsDisabled ? "enabled" : "disabled";
	updateStatus(pi, ctx);
	ctx.ui.notify(editToolsDisabled ? "Edit tools enabled" : "Edit tools disabled", "info");
}

export default function editToggle(pi: ExtensionAPI): void {
	pi.registerShortcut("f3", {
		description: "Toggle edit/write tools",
		handler: async (ctx) => toggleEditTools(pi, ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		updateStatus(pi, ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		updateStatus(pi, ctx);

		const disabled = areEditToolsDisabled(pi);
		const result: {
			systemPrompt?: string;
			message?: { customType: string; content: string; display: boolean };
		} = {};

		if (disabled) {
			result.systemPrompt = `${event.systemPrompt}\n\n${DISABLED_PROMPT}`;
		}

		if (pendingNotice === "disabled") {
			result.message = {
				customType: "edit-toggle-notice",
				content:
					"Edit tools were just disabled. The edit and write tools are now UNAVAILABLE — " +
					"do not attempt to modify files this turn.",
				display: false,
			};
		} else if (pendingNotice === "enabled") {
			result.message = {
				customType: "edit-toggle-notice",
				content: "Edit tools were just enabled. The edit and write tools are now AVAILABLE again.",
				display: false,
			};
		}
		pendingNotice = undefined;

		if (!result.systemPrompt && !result.message) return;
		return result;
	});
}
