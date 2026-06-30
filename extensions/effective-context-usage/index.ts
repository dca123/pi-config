import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/base";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "effective-context-usage";

type EffectiveUsage = {
	contextTokens: number;
	inputTokens: number;
	cachedTokens: number;
	outputTokens: number;
	contextWindow: number;
	percent: number;
};

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && "usage" in message;
}

function hasUsableUsage(message: AssistantMessage): boolean {
	return message.stopReason !== "aborted" && message.stopReason !== "error";
}

function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
}

function calculateInputTokens(usage: Usage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(tokens);
}

function getContextWindow(ctx: ExtensionContext): number | undefined {
	return ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow;
}

function buildEffectiveUsage(message: AssistantMessage, ctx: ExtensionContext): EffectiveUsage | undefined {
	const contextWindow = getContextWindow(ctx);
	if (!contextWindow) return undefined;

	const contextTokens = calculateContextTokens(message.usage);
	return {
		contextTokens,
		inputTokens: calculateInputTokens(message.usage),
		cachedTokens: message.usage.cacheRead + message.usage.cacheWrite,
		outputTokens: message.usage.output,
		contextWindow,
		percent: (contextTokens / contextWindow) * 100,
	};
}

function renderStatus(usage: EffectiveUsage): string {
	const cacheSegment = usage.cachedTokens > 0 ? ` · cache ${formatTokens(usage.cachedTokens)}` : "";
	return `ctx actual ${usage.percent.toFixed(1)}% (${formatTokens(usage.contextTokens)}/${formatTokens(usage.contextWindow)} · in ${formatTokens(usage.inputTokens)} · out ${formatTokens(usage.outputTokens)}${cacheSegment})`;
}

function setStatusFromMessage(message: AssistantMessage, ctx: ExtensionContext): void {
	const usage = buildEffectiveUsage(message, ctx);
	if (!usage) return;
	ctx.ui.setStatus(STATUS_KEY, renderStatus(usage));
}

function findLatestAssistantMessage(ctx: ExtensionContext): AssistantMessage | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		if (!isAssistantMessage(entry.message)) continue;
		if (!hasUsableUsage(entry.message)) continue;
		return entry.message;
	}
	return undefined;
}

export default function effectiveContextUsage(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const message = findLatestAssistantMessage(ctx);
		if (!message) return;
		setStatusFromMessage(message, ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (!isAssistantMessage(event.message)) return;
		if (!hasUsableUsage(event.message)) return;
		setStatusFromMessage(event.message, ctx);
	});

	pi.registerCommand("ctx-actual", {
		description: "Show provider-reported effective context usage from the latest assistant response",
		handler: async (_args, ctx) => {
			const message = findLatestAssistantMessage(ctx);
			if (!message) {
				ctx.ui.notify("No completed assistant response with provider usage found.", "warning");
				return;
			}

			setStatusFromMessage(message, ctx);
			ctx.ui.notify("Updated effective context usage from latest provider-reported usage.", "info");
		},
	});
}
