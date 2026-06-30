import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { streamSimpleOpenAICodexResponses } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

type FastModeState = {
	enabled: boolean;
};

type AuthCredential = {
	type?: string;
	access?: string;
	expires?: number;
	accountId?: string;
	[key: string]: unknown;
};

type CodexTokenMetadata = {
	accountId?: string;
	planType?: string;
	email?: string;
};

type UsageWindow = {
	remainingPercent: number;
	resetAt?: number;
};

type UsageSnapshot = {
	planType: string;
	email?: string;
	fiveHour?: UsageWindow;
};

type CachedUsage = {
	fetchedAt: number;
	snapshot: UsageSnapshot;
};

const CODEX_PROVIDER = "openai-codex";
const STATUS_KEY = "codex-usage";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_CACHE_MS = 60_000;
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile";
const FAST_MODE_STATE_FILE = join(homedir(), ".pi", "agent", "state", "codex-fast-mode.json");
const SUPPORTED_FAST_MODE_MODEL_IDS = ["gpt-5.4", "gpt-5.5"] as const;
const SUPPORTED_FAST_MODE_LABEL = SUPPORTED_FAST_MODE_MODEL_IDS.join(" or ");

let cachedUsage: CachedUsage | undefined;
let displayGeneration = 0;

function getRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function loadFastModeState(): FastModeState {
	try {
		const raw = readFileSync(FAST_MODE_STATE_FILE, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		const record = getRecord(parsed);
		if (typeof record?.enabled === "boolean") return { enabled: record.enabled };
	} catch {
		return { enabled: false };
	}

	return { enabled: false };
}

function saveFastModeState(state: FastModeState): void {
	mkdirSync(dirname(FAST_MODE_STATE_FILE), { recursive: true });
	writeFileSync(FAST_MODE_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function isCodexFastModeEnabled(): boolean {
	return loadFastModeState().enabled;
}

function isFastModeSupportedModel(modelId: string): boolean {
	return SUPPORTED_FAST_MODE_MODEL_IDS.includes(modelId as (typeof SUPPORTED_FAST_MODE_MODEL_IDS)[number]);
}

function parseFastModeCommandArg(args: string): "on" | "off" | "status" | "help" {
	const arg = args.trim().toLowerCase();
	if (arg === "on" || arg === "off" || arg === "status") return arg;
	return arg ? "help" : "status";
}

function getCurrentCodexAuth(ctx: ExtensionContext | ExtensionCommandContext): AuthCredential | undefined {
	return ctx.modelRegistry.authStorage.get(CODEX_PROVIDER) as AuthCredential | undefined;
}

async function refreshCodexAuth(ctx: ExtensionContext | ExtensionCommandContext): Promise<AuthCredential | undefined> {
	const apiKey = await ctx.modelRegistry.authStorage.getApiKey(CODEX_PROVIDER, { includeFallback: false });
	if (!apiKey) return undefined;
	return getCurrentCodexAuth(ctx);
}

function decodeCodexTokenMetadata(accessToken: string | undefined): CodexTokenMetadata {
	const parts = String(accessToken || "").split(".");
	if (parts.length < 2) return {};

	try {
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
		const payloadRecord = getRecord(payload);
		const auth = getRecord(payloadRecord?.[OPENAI_AUTH_CLAIM]);
		const profile = getRecord(payloadRecord?.[OPENAI_PROFILE_CLAIM]);
		return {
			accountId: typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined,
			planType: typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined,
			email: typeof profile?.email === "string" ? profile.email : undefined,
		};
	} catch {
		return {};
	}
}

function normalizeUsageWindow(value: unknown): UsageWindow | undefined {
	const window = getRecord(value);
	if (!window) return undefined;

	const usedPercent = typeof window.used_percent === "number" ? window.used_percent : 0;
	const windowSeconds = typeof window.limit_window_seconds === "number" ? window.limit_window_seconds : 0;
	if (Math.abs(windowSeconds - 5 * 60 * 60) > 120) return undefined;

	return {
		remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
		resetAt: typeof window.reset_at === "number" ? window.reset_at : undefined,
	};
}

function parseCodexUsageSnapshot(data: unknown, metadata: CodexTokenMetadata): UsageSnapshot {
	const raw = getRecord(data) || {};
	const rateLimit = getRecord(raw.rate_limit) || {};
	const primaryWindow = normalizeUsageWindow(rateLimit.primary_window);
	const secondaryWindow = normalizeUsageWindow(rateLimit.secondary_window);
	const rawEmail = typeof raw.email === "string" ? raw.email : undefined;
	const rawPlanType = typeof raw.plan_type === "string" ? raw.plan_type : undefined;

	return {
		planType: rawPlanType || metadata.planType || "unknown",
		email: rawEmail || metadata.email,
		fiveHour: primaryWindow || secondaryWindow,
	};
}

function formatReset(resetAt: number | undefined): string {
	if (!resetAt) return "--";

	const diffMs = resetAt * 1000 - Date.now();
	if (diffMs <= 0) return "now";

	const totalMinutes = Math.round(diffMs / 60_000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours > 0) return `~${hours}h ${minutes}m`;
	return `~${minutes}m`;
}

function formatPercent(window: UsageWindow | undefined): string {
	if (!window) return "--";
	return `${Math.round(window.remainingPercent)}%`;
}

function formatStatus(snapshot: UsageSnapshot): string {
	return `codex 5h ${formatPercent(snapshot.fiveHour)} left reset ${formatReset(snapshot.fiveHour?.resetAt)}`;
}

function formatDetails(snapshot: UsageSnapshot, auth: AuthCredential | undefined): string {
	const metadata = decodeCodexTokenMetadata(auth?.access);
	const email = snapshot.email || metadata.email;
	return [
		"Codex 5h usage",
		email ? `Email: ${email}` : undefined,
		`Plan: ${snapshot.planType}`,
		`5h window: ${formatPercent(snapshot.fiveHour)} left`,
		`Reset: ${formatReset(snapshot.fiveHour?.resetAt)}`,
	].filter(Boolean).join("\n");
}

async function fetchUsageSnapshot(auth: AuthCredential, signal?: AbortSignal): Promise<UsageSnapshot> {
	if (!auth.access) throw new Error("Codex OAuth auth has no access token");

	const metadata = decodeCodexTokenMetadata(auth.access);
	const accountId = typeof auth.accountId === "string" ? auth.accountId : metadata.accountId;
	const headers = new Headers({
		Authorization: `Bearer ${auth.access}`,
		Accept: "application/json",
		"User-Agent": "pi-codex-usage",
	});
	if (accountId) headers.set("chatgpt-account-id", accountId);

	const response = await fetch(USAGE_URL, { method: "GET", headers, signal });
	if (!response.ok) throw new Error(`usage lookup failed (${response.status}): ${await response.text()}`);
	return parseCodexUsageSnapshot(await response.json(), metadata);
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
	if (signal?.aborted) return true;
	return error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
}

async function updateUsageDisplay(
	ctx: ExtensionContext | ExtensionCommandContext,
	options: { force?: boolean; notify?: boolean } = {},
): Promise<void> {
	const generation = ++displayGeneration;
	const auth = await refreshCodexAuth(ctx);
	if (!auth || auth.type !== "oauth") {
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "codex 5h --"));
		if (options.notify) ctx.ui.notify("No Codex OAuth session. Run /login openai-codex.", "warning");
		return;
	}

	const cacheFresh = cachedUsage && Date.now() - cachedUsage.fetchedAt < USAGE_CACHE_MS;
	if (cachedUsage) ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", formatStatus(cachedUsage.snapshot)));
	if (!options.force && cacheFresh) {
		if (options.notify) ctx.ui.notify(formatDetails(cachedUsage.snapshot, auth), "info");
		return;
	}

	if (!cachedUsage) ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "codex 5h …"));

	try {
		const snapshot = await fetchUsageSnapshot(auth, ctx.signal);
		if (generation !== displayGeneration) return;
		cachedUsage = { fetchedAt: Date.now(), snapshot };
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", formatStatus(snapshot)));
		if (options.notify) ctx.ui.notify(formatDetails(snapshot, auth), "info");
	} catch (error) {
		if (isAbort(error, ctx.signal)) return;
		if (generation !== displayGeneration) return;
		if (!cachedUsage) ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "codex 5h unknown"));
		if (options.notify) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Codex usage lookup failed: ${message}`, "warning");
		}
	}
}

export default function codexUsage(pi: ExtensionAPI): void {
	pi.registerProvider(CODEX_PROVIDER, {
		api: "openai-codex-responses",
		streamSimple(model, context, options) {
			return streamSimpleOpenAICodexResponses(model as never, context, {
				...options,
				onPayload: async (payload, innerModel) => {
					const upstreamPayload =
						typeof options?.onPayload === "function"
							? ((await options.onPayload(payload, innerModel)) ?? payload)
							: payload;

					const payloadRecord = getRecord(upstreamPayload);
					if (!payloadRecord) return upstreamPayload;
					if (innerModel.provider !== CODEX_PROVIDER) return upstreamPayload;
					if (!isFastModeSupportedModel(innerModel.id)) return upstreamPayload;

					if (!isCodexFastModeEnabled()) return upstreamPayload;

					return {
						...payloadRecord,
						service_tier: "priority",
					};
				},
			});
		},
	});

	pi.on("session_start", (_event, ctx) => {
		void updateUsageDisplay(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		void updateUsageDisplay(ctx);
	});

	pi.registerCommand("codex-usage", {
		description: "Show current Codex 5h usage",
		handler: async (_args, ctx) => {
			await updateUsageDisplay(ctx, { force: true, notify: true });
		},
	});

	pi.registerCommand("codex-fast", {
		description: "Toggle Codex priority service tier for openai-codex/gpt-5.4 or gpt-5.5",
		getArgumentCompletions: (prefix) => {
			const options = ["on", "off", "status"];
			const filteredOptions = options.filter((option) => option.startsWith(prefix.trim().toLowerCase()));
			return filteredOptions.length > 0
				? filteredOptions.map((option) => ({ value: option, label: option }))
				: null;
		},
		handler: async (args, ctx) => {
			const action = parseFastModeCommandArg(args);

			if (action === "help") {
				ctx.ui.notify("Usage: /codex-fast [on|off|status]", "info");
				return;
			}

			if (action === "status") {
				ctx.ui.notify(
					`Codex Fast Mode: ${isCodexFastModeEnabled() ? "ON" : "OFF"} (injects service_tier=priority when ON for openai-codex/${SUPPORTED_FAST_MODE_LABEL})`,
					"info",
				);
				return;
			}

			const nextState = { enabled: action === "on" };
			saveFastModeState(nextState);
			ctx.ui.notify(
				nextState.enabled
					? `Codex Fast Mode enabled (openai-codex/${SUPPORTED_FAST_MODE_LABEL} → service_tier=priority)`
					: "Codex Fast Mode disabled",
				"info",
			);
		},
	});
}
