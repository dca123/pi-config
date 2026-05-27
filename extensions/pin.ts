import { complete, getModel } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const pinsFile = join(homedir(), ".pi", "agent", "pins.json");
const summaryModelCandidates = ["claude-haiku-4-6", "claude-haiku-4-5", "claude-haiku"];

type Pin = {
	id: string;
	sessionFile: string;
	cwd: string;
	description: string;
	createdAt: string;
	updatedAt: string;
};

type MessageEntry = {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

const loadPins = (): Pin[] => {
	if (!existsSync(pinsFile)) return [];
	try {
		const data = JSON.parse(readFileSync(pinsFile, "utf8"));
		return Array.isArray(data) ? data : [];
	} catch {
		return [];
	}
};

const savePins = (pins: Pin[]) => {
	writeFileSync(pinsFile, `${JSON.stringify(pins, null, 2)}\n`, "utf8");
};

const textFromContent = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as { type?: string; text?: string; name?: string };
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "toolCall" && typeof block.name === "string") return `[tool: ${block.name}]`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
};

const recentConversation = (entries: MessageEntry[]) => {
	const messages = entries
		.filter((entry) => entry.type === "message" && entry.message?.role)
		.slice(-18)
		.map((entry) => {
			const role = entry.message?.role ?? "unknown";
			const text = textFromContent(entry.message?.content).trim();
			return text ? `${role}: ${text}` : "";
		})
		.filter(Boolean);

	return messages.join("\n\n").slice(-12000);
};

const summarize = async (conversation: string, ctx: { modelRegistry: any }) => {
	const fallback = conversation.split("\n").find((line) => line.startsWith("user:")) ?? "Pinned session";
	if (!conversation.trim()) return "Pinned session";

	const model = summaryModelCandidates
		.map((modelId) => getModel("anthropic", modelId))
		.find(Boolean);
	if (!model) return fallback.slice(0, 180);

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth?.ok || !auth.apiKey) return fallback.slice(0, 180);

	const response = await complete(
		model,
		{
			messages: [
				{
					role: "user" as const,
					content: [
						{
							type: "text" as const,
							text: [
								"Write a concise resume note for this pi session.",
								"Focus on the most recent discussion, current goal, important decisions, files/areas mentioned, and next action.",
								"Use 2-4 short bullet points. No preamble.",
								"",
								conversation,
							].join("\n"),
						},
					],
					timestamp: Date.now(),
				},
			],
		},
		{ apiKey: auth.apiKey, headers: auth.headers, reasoningEffort: "low" },
	);

	return response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
};

export default function (pi: ExtensionAPI) {
	pi.registerCommand("pin", {
		description: "Pin current session for later. Usage: /pin [description], /pin list, /pin remove, /pin help",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const command = args.trim();
			if (command === "help") {
				ctx.ui.notify([
					"/pin — pin current session with auto-summary",
					"/pin <description> — pin current session with custom description",
					"/pin list — list pinned sessions and switch to one",
					"/pin remove — remove a pinned session",
					"/pin help — show this help",
				].join("\n"), "info");
				return;
			}

			if (command === "list") {
				const pins = loadPins().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
				if (pins.length === 0) {
					ctx.ui.notify("No pinned sessions", "info");
					return;
				}

				const labels = pins.map((pin, index) => {
					const firstLine = pin.description.split("\n")[0]?.replace(/^[-*]\s*/, "") || "Pinned session";
					return `${index + 1}. ${firstLine} — ${pin.cwd}`;
				});
				const choice = await ctx.ui.select("Pinned sessions", labels);
				if (!choice) return;

				const pin = pins[labels.indexOf(choice)];
				if (!pin || !existsSync(pin.sessionFile)) {
					ctx.ui.notify("Pinned session file no longer exists", "warning");
					return;
				}

				await ctx.switchSession(pin.sessionFile, {
					withSession: async (nextCtx) => {
						nextCtx.ui.notify("Switched to pinned session", "info");
					},
				});
				return;
			}

			if (command === "remove") {
				const pins = loadPins().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
				const labels = pins.map((pin, index) => `${index + 1}. ${pin.description.split("\n")[0] || pin.sessionFile}`);
				const choice = await ctx.ui.select("Remove pinned session", labels);
				if (!choice) return;
				const remove = pins[labels.indexOf(choice)];
				savePins(loadPins().filter((pin) => pin.id !== remove.id));
				ctx.ui.notify("Removed pinned session", "info");
				return;
			}

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("Current session has no session file", "warning");
				return;
			}

			ctx.ui.notify("Pinning session...", "info");
			const description = command || (await summarize(recentConversation(ctx.sessionManager.getBranch() as MessageEntry[]), ctx));
			const now = new Date().toISOString();
			const pins = loadPins();
			const existing = pins.find((pin) => pin.sessionFile === sessionFile);
			if (existing) {
				existing.cwd = ctx.cwd;
				existing.description = description;
				existing.updatedAt = now;
			} else {
				pins.push({ id: `${Date.now()}`, sessionFile, cwd: ctx.cwd, description, createdAt: now, updatedAt: now });
			}
			savePins(pins);
			ctx.ui.notify("Pinned current session", "info");
		},
	});
}
