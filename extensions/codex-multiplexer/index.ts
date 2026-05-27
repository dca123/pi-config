import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentEndEvent, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  classifyRateLimitError,
  decodeCodexTokenMetadata,
  emptyConfig,
  formatUsageLine,
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
  getAuthStorage(ctx).set(CODEX_PROVIDER, auth as any);
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

function formatUsageDetails(label: string, snapshot: any, totalSwitches: number): string {
  const fiveHour = snapshot?.fiveHour?.remainingPercent === undefined ? "unknown" : `${Math.round(snapshot.fiveHour.remainingPercent)}% left`;
  const weekly = snapshot?.weekly?.remainingPercent === undefined ? "unknown" : `${Math.round(snapshot.weekly.remainingPercent)}% left`;
  const plan = snapshot?.planType && snapshot.planType !== "unknown" ? snapshot.planType : "unknown plan";
  return [
    `Codex ${label}`,
    `Plan: ${plan}`,
    `5h window: ${fiveHour}`,
    `7d window: ${weekly}`,
    `Switches: ${totalSwitches}`,
  ].join("\n");
}

async function updateUsageDisplay(ctx: ExtensionContext | ExtensionCommandContext, force = false, notifyDetails = false): Promise<void> {
  const config = loadConfig();
  const displayAccount = getDisplayAccountForExtension(config, getCurrentCodexAuth(ctx));
  if (!displayAccount) {
    ctx.ui.setStatus("codex", ctx.ui.theme.fg("dim", "codex --"));
    return;
  }

  const active = displayAccount.label;
  const cached = config.usageCache?.[active];
  const cacheFresh = cached && Date.now() - cached.fetchedAt < USAGE_CACHE_MS;

  // Always paint something immediately so the bottom row reflects the new
  // account before the network roundtrip completes. Use cached snapshot if
  // we have one, otherwise a "loading" placeholder.
  const totalSwitches = getTotalSwitches(config);
  if (cached) {
    ctx.ui.setStatus("codex", ctx.ui.theme.fg("dim", formatUsageLine({ label: active, snapshot: cached.snapshot, totalSwitches })));
  } else {
    ctx.ui.setStatus("codex", ctx.ui.theme.fg("dim", `${active} | usage …`));
  }

  if (!force && cacheFresh) {
    if (notifyDetails) ctx.ui.notify(formatUsageDetails(active, cached!.snapshot, totalSwitches), "info");
    return;
  }

  try {
    const snapshot = await fetchUsageSnapshot(displayAccount.auth, ctx.signal);
    config.usageCache[active] = { fetchedAt: Date.now(), snapshot };
    saveConfig(config);
    ctx.ui.setStatus("codex", ctx.ui.theme.fg("dim", formatUsageLine({ label: active, snapshot, totalSwitches: getTotalSwitches(config) })));
    if (notifyDetails) ctx.ui.notify(formatUsageDetails(active, snapshot, getTotalSwitches(config)), "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!cached) ctx.ui.setStatus("codex", ctx.ui.theme.fg("dim", `${active} | usage unknown`));
    ctx.ui.notify(`Codex usage lookup failed: ${message}`, "warning");
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
  const label = args.trim();
  if (!label) {
    ctx.ui.notify("Usage: /codex-save <label>", "warning");
    return;
  }
  const auth = getCurrentCodexAuth(ctx);
  if (!auth || auth.type !== "oauth") {
    ctx.ui.notify("No current Codex OAuth auth found. Run /login for Codex first.", "warning");
    return;
  }
  const config = loadConfig();
  saveAccount(config, label, auth, Date.now());
  if (!config.active) config.active = label;
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
    ctx.ui.notify("No Codex accounts saved. Use /codex-save <label> after /login.", "info");
    return;
  }
  const lines = labels.map((label) => {
    const active = label === config.active ? "*" : " ";
    const cached = config.usageCache?.[label] ? "usage cached" : "usage unknown";
    return `${active} ${label} — ${cached}`;
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

export default function codexMultiplexer(pi: ExtensionAPI) {
  let lastUserPrompt: string | null = null;
  let replayingPrompt: string | null = null;
  let triedForPrompt = new Set<string>();

  pi.on("session_start", async (_event, ctx) => {
    if (restoreActive(ctx)) ctx.ui.notify("Restored active Codex account", "info");
    await updateUsageDisplay(ctx, false);
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
    ctx.ui.notify(`Codex usage limit hit: ${active} → ${next}, retrying prompt`, "warning");
    replayingPrompt = lastUserPrompt;
    pi.sendUserMessage(lastUserPrompt);
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
            "/codex save <label>   save current Codex login",
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
