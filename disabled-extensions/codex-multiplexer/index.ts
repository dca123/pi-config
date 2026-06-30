import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentEndEvent, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  classifyRateLimitError,
  chooseAccountLabelForAuth,
  decodeCodexTokenMetadata,
  emptyConfig,
  formatUsageLine,
  getCodexAuthIdentity,
  normalizeConfig,
  parseCodexUsageSnapshot,
  pickNextRoundRobinAccount,
  recordRateLimitEvent,
  saveAccount,
  switchAccount,
  clearStats,
} from "./core.mjs";

type AuthCredential = { type?: string; access?: string; refresh?: string; expires?: number; accountId?: string; [key: string]: unknown };
type CodexConfig = ReturnType<typeof emptyConfig>;

const CODEX_PROVIDER = "openai-codex";
const USAGE_BASE_URL = "https://chatgpt.com/backend-api";
const USAGE_CACHE_MS = 60_000;
const AUTH_SYNC_PATCH = Symbol.for("pi.codexMultiplexer.authSyncPatch");

let usageDisplayGeneration = 0;
let internalCodexAuthSetDepth = 0;

function configPath(): string {
  return join(getAgentDir(), "codex-multiplexer.json");
}

function loadConfig(): CodexConfig {
  const path = configPath();
  if (!existsSync(path)) return emptyConfig();
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return emptyConfig();
  }
}

function saveConfig(config: CodexConfig): void {
  const path = configPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
}

function getAuthStorage(ctx: ExtensionContext | ExtensionCommandContext): any {
  return ctx.modelRegistry.authStorage;
}

function getCurrentCodexAuth(ctx: ExtensionContext | ExtensionCommandContext): AuthCredential | undefined {
  return getAuthStorage(ctx).get(CODEX_PROVIDER) as AuthCredential | undefined;
}

function setCurrentCodexAuth(ctx: ExtensionContext | ExtensionCommandContext, auth: AuthCredential): void {
  internalCodexAuthSetDepth += 1;
  try {
    getAuthStorage(ctx).set(CODEX_PROVIDER, auth as any);
  } finally {
    internalCodexAuthSetDepth -= 1;
  }
}

function getAccountLabels(config: CodexConfig): string[] {
  return Object.keys(config.accounts || {});
}

function getTotalSwitches(config: CodexConfig): number {
  return Array.isArray(config.stats?.switches) ? config.stats.switches.length : 0;
}

function getDisplayAccountForExtension(
  config: CodexConfig,
  currentAuth: AuthCredential | undefined,
): { label: string; auth: AuthCredential; saved: boolean } | undefined {
  const active = config.active;
  const savedAccount = active ? config.accounts?.[active] : undefined;
  if (savedAccount) {
    return { label: active, auth: savedAccount.auth, saved: true };
  }
  if (currentAuth?.type === "oauth") {
    return { label: "current", auth: currentAuth, saved: false };
  }
  return undefined;
}

function formatAuthState(auth: AuthCredential | undefined): string {
  if (!auth || auth.type !== "oauth") return "not logged in";
  if (typeof auth.expires !== "number") return "expiry unknown";

  const diffMinutes = Math.round((auth.expires - Date.now()) / 60_000);
  if (diffMinutes <= 0) return "expired";

  const days = Math.floor(diffMinutes / (60 * 24));
  const hours = Math.floor((diffMinutes % (60 * 24)) / 60);
  const minutes = diffMinutes % 60;
  if (days > 0) return `valid ~${days}d ${hours}h`;
  if (hours > 0) return `valid ~${hours}h ${minutes}m`;
  return `valid ~${minutes}m`;
}

function saveLoggedInCodexAuth(auth: AuthCredential, makeActive: boolean): { label: string } {
  const config = loadConfig();
  const label = chooseAccountLabelForAuth(config, auth);
  saveAccount(config, label, auth, Date.now());
  if (makeActive) config.active = label;
  saveConfig(config);
  return { label };
}

async function refreshCurrentCodexAuth(ctx: ExtensionContext | ExtensionCommandContext): Promise<AuthCredential | undefined> {
  const authStorage = getAuthStorage(ctx);
  const apiKey = await authStorage.getApiKey(CODEX_PROVIDER, { includeFallback: false });
  if (!apiKey) return undefined;
  return getCurrentCodexAuth(ctx);
}

async function prepareUsageAuth(
  ctx: ExtensionContext | ExtensionCommandContext,
  label: string,
  auth: AuthCredential,
  saved: boolean,
): Promise<AuthCredential> {
  if (saved) setCurrentCodexAuth(ctx, auth);
  const refreshed = await refreshCurrentCodexAuth(ctx);
  if (!refreshed || refreshed.type !== "oauth") throw new Error("Codex auth is expired. Run /login openai-codex.");

  const config = loadConfig();
  saveAccount(config, label, refreshed, Date.now());
  if (saved || !config.active) config.active = label;
  saveConfig(config);
  return refreshed;
}

function installCodexAuthSync(ctx: ExtensionContext): void {
  const authStorage = getAuthStorage(ctx);
  if (authStorage[AUTH_SYNC_PATCH] && typeof authStorage[AUTH_SYNC_PATCH] === "object") {
    authStorage[AUTH_SYNC_PATCH].ctx = ctx;
    return;
  }

  const originalSet = authStorage.set.bind(authStorage);
  authStorage.set = (provider: string, credential: AuthCredential) => {
    originalSet(provider, credential);
    if (provider !== CODEX_PROVIDER || credential?.type !== "oauth") return;

    const internalSet = internalCodexAuthSetDepth > 0;
    const { label } = saveLoggedInCodexAuth(credential, !internalSet);
    if (internalSet) return;

    const activeCtx = authStorage[AUTH_SYNC_PATCH].ctx as ExtensionContext;
    void updateUsageDisplay(activeCtx, true).catch(() => undefined);
    activeCtx.ui.notify(`Saved Codex login as ${label}`, "info");
  };
  authStorage[AUTH_SYNC_PATCH] = { ctx };
}

async function fetchUsageSnapshot(auth: AuthCredential, signal?: AbortSignal): Promise<any> {
  if (!auth.access) throw new Error("active Codex auth has no access token");
  const metadata = decodeCodexTokenMetadata(auth.access);
  const accountId = typeof auth.accountId === "string" ? auth.accountId : metadata.accountId;
  const headers = new Headers({
    Authorization: `Bearer ${auth.access}`,
    Accept: "application/json",
    "User-Agent": "pi-codex-multiplexer",
  });
  if (accountId) headers.set("chatgpt-account-id", accountId);

  const response = await fetch(`${USAGE_BASE_URL}/wham/usage`, { method: "GET", headers, signal });
  if (!response.ok) throw new Error(`usage lookup failed (${response.status}): ${await response.text()}`);
  const snapshot = parseCodexUsageSnapshot(await response.json());
  if (!snapshot.email && metadata.email) snapshot.email = metadata.email;
  if ((!snapshot.planType || snapshot.planType === "unknown") && metadata.planType) snapshot.planType = metadata.planType;
  return snapshot;
}

function formatUsageDetails(label: string, snapshot: any, totalSwitches: number, auth?: AuthCredential): string {
  const fiveHour = snapshot?.fiveHour?.remainingPercent === undefined ? "unknown" : `${Math.round(snapshot.fiveHour.remainingPercent)}% left`;
  const weekly = snapshot?.weekly?.remainingPercent === undefined ? "unknown" : `${Math.round(snapshot.weekly.remainingPercent)}% left`;
  const plan = snapshot?.planType && snapshot.planType !== "unknown" ? snapshot.planType : "unknown plan";
  const identity = getCodexAuthIdentity(auth);
  return [
    `Codex ${label}`,
    identity.email ? `Email: ${identity.email}` : undefined,
    `Plan: ${plan}`,
    `Auth: ${formatAuthState(auth)}`,
    `5h window: ${fiveHour}`,
    `7d window: ${weekly}`,
    `Switches: ${totalSwitches}`,
  ].filter(Boolean).join("\n");
}

async function updateUsageDisplay(ctx: ExtensionContext | ExtensionCommandContext, force = false, notifyDetails = false): Promise<void> {
  const generation = ++usageDisplayGeneration;
  const config = loadConfig();
  const displayAccount = getDisplayAccountForExtension(config, getCurrentCodexAuth(ctx));
  if (!displayAccount) {
    ctx.ui.setStatus("codex", ctx.ui.theme.fg("dim", "codex --"));
    return;
  }

  const active = displayAccount.label;
  const cached = config.usageCache?.[active];
  const cachedHasUsageWindow = Boolean(cached?.snapshot?.fiveHour || cached?.snapshot?.weekly);
  const cacheFresh = cached && cachedHasUsageWindow && Date.now() - cached.fetchedAt < USAGE_CACHE_MS;

  // Always paint something immediately so the bottom row reflects the new
  // account before the network roundtrip completes. Use cached snapshot if
  // we have one, otherwise a "loading" placeholder.
  const totalSwitches = getTotalSwitches(config);
  if (cached && cachedHasUsageWindow) {
    ctx.ui.setStatus("codex", ctx.ui.theme.fg("dim", formatUsageLine({ label: active, snapshot: cached.snapshot, totalSwitches })));
  } else {
    ctx.ui.setStatus("codex", ctx.ui.theme.fg("dim", `${active} | usage …`));
  }

  if (!force && cacheFresh) {
    if (notifyDetails) ctx.ui.notify(formatUsageDetails(active, cached!.snapshot, totalSwitches, displayAccount.auth), "info");
    return;
  }

  try {
    const auth = await prepareUsageAuth(ctx, active, displayAccount.auth, displayAccount.saved);
    if (generation !== usageDisplayGeneration) return;

    const snapshot = await fetchUsageSnapshot(auth, ctx.signal);
    if (generation !== usageDisplayGeneration) return;

    const nextConfig = loadConfig();
    nextConfig.usageCache[active] = { fetchedAt: Date.now(), snapshot };
    saveConfig(nextConfig);
    ctx.ui.setStatus("codex", ctx.ui.theme.fg("dim", formatUsageLine({ label: active, snapshot, totalSwitches: getTotalSwitches(nextConfig) })));
    if (notifyDetails) ctx.ui.notify(formatUsageDetails(active, snapshot, getTotalSwitches(nextConfig), auth), "info");
  } catch (error) {
    // Swallow aborts: these fire when the user cancels a query (escape), which
    // triggers agent_end → updateUsageDisplay with an already-aborted signal.
    const aborted =
      ctx.signal?.aborted ||
      (error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message)));
    if (aborted) return;
    // Background refresh failures shouldn't interrupt the user's turn; explicit
    // /codex usage calls still surface the failure because the user asked for it.
    if (generation !== usageDisplayGeneration) return;
    if (!cached || !cachedHasUsageWindow) ctx.ui.setStatus("codex", ctx.ui.theme.fg("dim", `${active} | usage unknown (${formatAuthState(displayAccount.auth)})`));
    if (notifyDetails) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Codex usage lookup failed: ${message}`, "warning");
    }
  }
}

function restoreActive(ctx: ExtensionContext | ExtensionCommandContext): boolean {
  const config = loadConfig();
  if (!config.active) return false;
  const result = switchAccount(config, config.active, Date.now(), "startup-restore");
  if (!result.ok) return false;
  setCurrentCodexAuth(ctx, result.auth);
  saveConfig(config);
  return true;
}

async function handleSave(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const auth = getCurrentCodexAuth(ctx);
  if (!auth || auth.type !== "oauth") {
    ctx.ui.notify("No current Codex OAuth auth found. Run /login for Codex first.", "warning");
    return;
  }
  const config = loadConfig();
  const label = args.trim() || chooseAccountLabelForAuth(config, auth);
  saveAccount(config, label, auth, Date.now());
  config.active = label;
  saveConfig(config);
  ctx.ui.notify(`Saved Codex account as ${label}`, "info");
  await updateUsageDisplay(ctx, true);
}

async function handleUse(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const label = args.trim();
  if (!label) {
    ctx.ui.notify("Usage: /codex-use <label>", "warning");
    return;
  }
  const config = loadConfig();
  const result = switchAccount(config, label, Date.now(), "manual");
  if (!result.ok) {
    ctx.ui.notify(`Unknown Codex account: ${label}`, "warning");
    return;
  }
  setCurrentCodexAuth(ctx, result.auth);
  saveConfig(config);
  ctx.ui.notify(`Switched Codex account to ${label}`, "info");
  await updateUsageDisplay(ctx, true);
}

function handleList(ctx: ExtensionCommandContext): void {
  const config = loadConfig();
  const labels = getAccountLabels(config);
  if (labels.length === 0) {
    ctx.ui.notify("No Codex accounts saved. Use /codex save after /login.", "info");
    return;
  }
  const lines = labels.map((label) => {
    const active = label === config.active ? "*" : " ";
    const cached = config.usageCache?.[label] ? "usage cached" : "usage unknown";
    const auth = config.accounts?.[label]?.auth as AuthCredential | undefined;
    return `${active} ${label} — ${cached}, auth ${formatAuthState(auth)}`;
  });
  ctx.ui.notify(lines.join("\n"), "info");
}

function handleStats(ctx: ExtensionCommandContext): void {
  const config = loadConfig();
  const switches = config.stats?.switches || [];
  const rateLimits = config.stats?.rateLimitEvents || [];
  const last = switches[switches.length - 1];
  const lines = [
    `active: ${config.active || "none"}`,
    `switches: ${switches.length}`,
    `rate-limit events: ${rateLimits.length}`,
  ];
  if (last) lines.push(`last switch: ${last.from || "none"} → ${last.to} (${last.reason})`);
  ctx.ui.notify(lines.join("\n"), "info");
}

function handleStatsClear(ctx: ExtensionCommandContext): void {
  const config = loadConfig();
  clearStats(config);
  saveConfig(config);
  ctx.ui.notify("Cleared Codex multiplexer stats", "info");
}

function handleAuto(args: string, ctx: ExtensionCommandContext): void {
  const value = args.trim().toLowerCase();
  const config = loadConfig();
  if (value === "on") config.autoSwitch = true;
  if (value === "off") config.autoSwitch = false;
  saveConfig(config);
  ctx.ui.notify(`Codex auto-switch is ${config.autoSwitch ? "on" : "off"}`, "info");
}

/**
 * Replay a prompt after an account switch, without racing the agent's
 * streaming lifecycle.
 *
 * At `agent_end` the run loop is still tearing down: `isStreaming` may briefly
 * remain true, and `sendUserMessage` returns void (it is fire-and-forget). If we
 * send while streaming we either hit "Agent is already processing" or queue a
 * followUp into a loop that has already exited (so the retry silently never
 * runs). To stay version-proof we wait for the agent to report idle, then start
 * a clean turn. If it never goes idle within the budget we fall back to a
 * followUp so a switch is never silently dropped.
 */
async function replayPromptWhenIdle(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prompt: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!ctx.isIdle() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    if (ctx.isIdle()) {
      pi.sendUserMessage(prompt);
    } else {
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Codex retry failed: ${message}`, "warning");
  }
}

export default function codexMultiplexer(pi: ExtensionAPI) {
  let lastUserPrompt: string | null = null;
  let replayingPrompt: string | null = null;
  let triedForPrompt = new Set<string>();

  pi.on("session_start", async (_event, ctx) => {
    installCodexAuthSync(ctx);
    if (restoreActive(ctx)) ctx.ui.notify("Restored active Codex account", "info");
    // updateUsageDisplay paints a cached/placeholder status line synchronously
    // before its network fetch; awaiting it here would block session_start (and
    // therefore time-to-TUI) on a ~67ms (cold ~228ms) usage API round-trip every
    // launch (cache is only 60s). Fire-and-forget so the status updates in the
    // background once the fetch returns.
    void updateUsageDisplay(ctx, false);
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    if (event.prompt !== replayingPrompt) {
      triedForPrompt = new Set<string>();
      replayingPrompt = null;
    }
    lastUserPrompt = event.prompt;
  });

  pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
    await updateUsageDisplay(ctx, false);
    const lastMsg = event.messages?.[event.messages.length - 1] as any;
    if (!lastMsg || lastMsg.role !== "assistant" || lastMsg.stopReason !== "error") return;
    const errorMessage = String(lastMsg.errorMessage || "");
    if (!classifyRateLimitError(errorMessage)) return;

    const config = loadConfig();
    if (!config.autoSwitch || !lastUserPrompt) return;
    const active = config.active;
    if (!active) return;

    triedForPrompt.add(active);
    recordRateLimitEvent(config, { account: active, message: errorMessage, promptHash: String(lastUserPrompt.length) });

    const next = pickNextRoundRobinAccount(getAccountLabels(config), active, triedForPrompt);
    if (!next) {
      saveConfig(config);
      ctx.ui.notify("Codex usage limit hit: all saved accounts exhausted; stopping.", "warning");
      return;
    }

    const result = switchAccount(config, next, Date.now(), "auto-rate-limit");
    if (!result.ok) {
      saveConfig(config);
      ctx.ui.notify(`Codex usage limit hit: failed to switch to ${next}; stopping.`, "warning");
      return;
    }

    setCurrentCodexAuth(ctx, result.auth);
    saveConfig(config);
    triedForPrompt.add(next);
    void updateUsageDisplay(ctx, true).catch(() => undefined);
    ctx.ui.notify(`Codex usage limit hit: ${active} → ${next}, retrying prompt`, "warning");
    replayingPrompt = lastUserPrompt;
    void replayPromptWhenIdle(pi, ctx, lastUserPrompt);
  });

  pi.registerCommand("codex", {
    description: "Manage Codex accounts: /codex help",
    getArgumentCompletions: (prefix: string) => {
      const subcommands = ["help", "save", "use", "list", "usage", "stats", "stats-clear", "auto"];
      const matches = subcommands.filter((command) => command.startsWith(prefix));
      return matches.length > 0 ? matches.map((command) => ({ value: command, label: command })) : null;
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const subcommand = (parts[0] || "help").toLowerCase();
      const rest = parts.slice(1).join(" ");

      switch (subcommand) {
        case "save":
          return handleSave(rest, ctx);
        case "use":
          return handleUse(rest, ctx);
        case "list":
        case "ls":
          return handleList(ctx);
        case "usage":
          return updateUsageDisplay(ctx, true, true);
        case "stats":
          return handleStats(ctx);
        case "stats-clear":
        case "clear-stats":
          return handleStatsClear(ctx);
        case "auto":
          return handleAuto(rest, ctx);
        case "help":
        default:
          return ctx.ui.notify([
            "Codex commands:",
            "/codex save [label]   save current Codex login",
            "/codex use <label>    switch account",
            "/codex list           list accounts",
            "/codex usage          show usage details",
            "/codex stats          show switch stats",
            "/codex stats-clear    clear stats",
            "/codex auto on|off    toggle auto-switch",
          ].join("\n"), "info");
      }
    },
  });
}
