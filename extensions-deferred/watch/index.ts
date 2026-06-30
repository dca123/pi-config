/**
 * watch — non-blocking monitors for long-lived tasks.
 *
 * The agent writes a `check.ts` per watch (the liveness/terminal logic). The
 * framework schedules it on an interval and, on a terminal state, re-injects a
 * wake-up message into the thread via pi.sendMessage(followUp, triggerTurn).
 *
 * Non-blocking by design: watch_create returns immediately, the agent keeps
 * working, and the completion ping wakes it later. Durable: watches persist
 * under .pi/watch/<id>/ and re-arm on session_start, surviving /reload.
 *
 * See SPEC.md for the full rationale.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  discoverWatches,
  findWatch,
  generateId,
  loadAndRunCheck,
  manifestFor,
  readMeta,
  slugify,
  watchBaseDir,
  writeMeta,
  type WatchManifest,
} from "./loader.ts";
import type { HistoryEntry, WatchMeta, WatchStatus } from "./schema.ts";

interface Live {
  manifest: WatchManifest;
  meta: WatchMeta;
  timer: ReturnType<typeof setInterval> | null;
  ticking: boolean;
  lastStatus: WatchStatus | null;
}

export default function watchExtension(pi: ExtensionAPI) {
  const DEFAULT_INTERVAL = 15;
  const MIN_INTERVAL = 2;

  const live = new Map<string, Live>();
  // Captured at session_start so the background timer (which has no per-event
  // ctx) can refresh the widget. UI methods are fire-and-forget and valid for
  // the session lifetime; all uses are wrapped in try/catch.
  let uiCtx: ExtensionContext | null = null;

  // ── Widget ──────────────────────────────────────────────────────────

  const refreshWidget = () => {
    const ctx = uiCtx;
    if (!ctx?.hasUI) return;
    try {
      const running = [...live.values()].filter((l) => l.meta.state === "running");
      if (running.length === 0) {
        ctx.ui.setStatus("watch", undefined);
        ctx.ui.setWidget("watch", undefined);
        return;
      }
      ctx.ui.setStatus(
        "watch",
        ctx.ui.theme.fg("accent", `👁 ${running.length} watching`),
      );
      ctx.ui.setWidget("watch", (_tui, theme) => ({
        render(width: number): string[] {
          const w = Math.max(1, width);
          const lines = [theme.fg("accent", `👁 watch — ${running.length} live`)];
          for (const l of running) {
            const s = l.lastStatus?.summary ?? "(no status yet)";
            const text = `  ${theme.fg("muted", l.meta.id)} ${theme.fg("text", s)}`;
            lines.push(text.length > w ? text.slice(0, w) : text);
          }
          return lines;
        },
        invalidate() {},
      }));
    } catch {
      // UI may be torn down; ignore.
    }
  };

  // ── Scheduler ───────────────────────────────────────────────────────

  const disarm = (l: Live) => {
    if (l.timer) {
      clearInterval(l.timer);
      l.timer = null;
    }
  };

  const tick = async (l: Live) => {
    if (l.ticking) return; // avoid overlap if a check is slow
    l.ticking = true;
    try {
      const status = await loadAndRunCheck(l.manifest.checkPath);
      l.lastStatus = status;
      l.meta.lastSummary = status.summary;

      if (status.state === "running") {
        writeMeta(l.manifest, l.meta);
        refreshWidget();
        return;
      }

      // Terminal: stop, persist, and wake the agent.
      disarm(l);
      l.meta.state = status.state;
      l.meta.endedAt = new Date().toISOString();
      writeMeta(l.manifest, l.meta);
      refreshWidget();

      const verb = status.state === "complete" ? "completed" : "FAILED";
      const body =
        `Watch "${l.meta.name}" (${l.meta.id}) ${verb}.\n` +
        `${status.summary}` +
        (status.detail ? `\n\n${status.detail}` : "");

      pi.sendMessage(
        {
          customType: "watch",
          content: body,
          display: true,
          details: { id: l.meta.id, state: status.state },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch (err) {
      // A throwing check.ts shouldn't kill the watch silently — surface once
      // and keep polling so a transient error (e.g. file mid-write) recovers.
      const msg = err instanceof Error ? err.message : String(err);
      l.lastStatus = { state: "running", summary: `check error: ${msg}` };
      l.meta.lastSummary = l.lastStatus.summary;
      writeMeta(l.manifest, l.meta);
      refreshWidget();
    } finally {
      l.ticking = false;
    }
  };

  const arm = (manifest: WatchManifest, meta: WatchMeta): Live => {
    const existing = live.get(meta.id);
    if (existing) disarm(existing);

    const l: Live = { manifest, meta, timer: null, ticking: false, lastStatus: null };
    live.set(meta.id, l);

    if (meta.state === "running") {
      const intervalMs = Math.max(MIN_INTERVAL, meta.intervalSeconds) * 1000;
      l.timer = setInterval(() => void tick(l), intervalMs);
      // Run once promptly so a watch armed on something already-done resolves
      // without waiting a full interval.
      void tick(l);
    }
    return l;
  };

  // ── Session lifecycle ───────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    uiCtx = ctx;
    for (const l of live.values()) disarm(l);
    live.clear();

    // Re-arm any persisted watch still marked running (durable across /reload).
    for (const manifest of discoverWatches(ctx.cwd)) {
      const meta = readMeta(manifest);
      if (meta && meta.state === "running") arm(manifest, meta);
    }
    refreshWidget();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    for (const l of live.values()) disarm(l);
    if (ctx.hasUI) {
      ctx.ui.setStatus("watch", undefined);
      ctx.ui.setWidget("watch", undefined);
    }
  });

  // ── Tools ───────────────────────────────────────────────────────────

  pi.registerTool({
    name: "watch_create",
    label: "Create Watch",
    description:
      "Start a non-blocking monitor for a long-lived task (test run, ask-codebase query, detached subagent, build). " +
      "You write a TypeScript check() that inspects the task and returns its state; the watch polls it on an interval " +
      "and re-injects a wake-up message into this thread when the task completes or fails. Returns immediately so you can keep working.",
    promptSnippet:
      "Monitor a long-lived task with an agent-written check(); get pinged on completion without blocking",
    promptGuidelines: [
      "Use watch_create instead of a blocking sleep/poll loop when waiting on long-lived work (tests, ask-codebase, detached subagents, builds).",
      "check_code must export a default function returning { state: 'running'|'complete'|'failed', summary: string, detail?: string }. " +
        "It runs in Node.js with fs/child_process — inspect a PID, an exit-code/sentinel file, log mtime, or a JSONL tail. " +
        "The framework has NO built-in hang/timeout detection: encode it yourself by returning 'failed' when your own liveness threshold is exceeded.",
      "watch_create returns immediately. Do not wait — continue other work; you will receive a follow-up message when the watch reaches a terminal state.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Human-readable name, e.g. 'pr-241 rebase' or 'unit tests'." }),
      check_code: Type.String({
        description: "Full TypeScript source for check.ts. Default export returning WatchStatus.",
      }),
      interval_seconds: Type.Optional(
        Type.Number({ description: `Seconds between polls (default ${DEFAULT_INTERVAL}, min ${MIN_INTERVAL}).` }),
      ),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      uiCtx = ctx;
      const id = `${slugify(params.name)}-${generateId()}`;
      const dir = path.join(watchBaseDir(ctx.cwd), id);
      const manifest = manifestFor(dir, id, params.name);

      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(manifest.checkPath, params.check_code);
      fs.writeFileSync(
        manifest.historyPath,
        JSON.stringify(
          [
            {
              timestamp: new Date().toISOString(),
              request: `Initial creation: ${params.name}`,
              implementation: params.check_code,
            } satisfies HistoryEntry,
          ],
          null,
          2,
        ),
      );

      // Validate by running the check once.
      let status: WatchStatus;
      try {
        status = await loadAndRunCheck(manifest.checkPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `❌ Watch created at ${dir} but check.ts validation failed:\n\n${msg}\n\nFix it and re-create, or use watch_improve.`,
            },
          ],
          details: { id, error: msg },
        };
      }

      const now = new Date().toISOString();
      const meta: WatchMeta = {
        id,
        name: params.name,
        intervalSeconds: params.interval_seconds ?? DEFAULT_INTERVAL,
        state: status.state === "running" ? "running" : status.state,
        createdAt: now,
        startedAt: now,
        lastSummary: status.summary,
        endedAt: status.state === "running" ? undefined : now,
      };
      writeMeta(manifest, meta);
      arm(manifest, meta);

      const note =
        status.state === "running"
          ? `Armed (polling every ${meta.intervalSeconds}s). You'll be pinged on completion — keep working.`
          : `Already ${status.state} on first check: ${status.summary}`;

      return {
        content: [{ type: "text", text: `✅ Watch ${id}\n   ${note}` }],
        details: { id, status, intervalSeconds: meta.intervalSeconds },
      };
    },
  });

  pi.registerTool({
    name: "watch_status",
    label: "Watch Status",
    description:
      "Snapshot of all watches: re-runs each live check() on demand and reports state + last summary. " +
      "Use to proactively check whether a long task is progressing, hung (per its own check), done, or failed.",
    promptSnippet: "Get a snapshot of all active watches on demand",
    parameters: Type.Object({}),

    async execute(_id, _params, _signal, _onUpdate, ctx) {
      uiCtx = ctx;
      const manifests = discoverWatches(ctx.cwd);
      if (manifests.length === 0) {
        return { content: [{ type: "text", text: "No watches." }], details: { watches: [] } };
      }

      const rows: Array<Record<string, unknown>> = [];
      const lines: string[] = ["Watches:"];
      for (const m of manifests) {
        const meta = readMeta(m);
        if (!meta) continue;
        let summary = meta.lastSummary ?? "";
        let state = meta.state;
        // For still-running watches, re-run the check for a fresh read.
        if (meta.state === "running") {
          try {
            const s = await loadAndRunCheck(m.checkPath);
            state = s.state === "running" ? "running" : s.state;
            summary = s.summary;
          } catch (err) {
            summary = `check error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        rows.push({ id: m.id, name: meta.name, state, summary });
        lines.push(`  [${state}] ${m.id} — ${summary}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }], details: { watches: rows } };
    },
  });

  pi.registerTool({
    name: "watch_cancel",
    label: "Cancel Watch",
    description: "Stop a watch and mark it cancelled. Use when monitoring is no longer needed.",
    promptSnippet: "Stop an active watch",
    parameters: Type.Object({
      id: Type.String({ description: "Watch id (or unique prefix)." }),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      uiCtx = ctx;
      const manifest = findWatch(ctx.cwd, params.id);
      if (!manifest) {
        return { content: [{ type: "text", text: `Watch not found: ${params.id}` }], details: {} };
      }
      const l = live.get(manifest.id);
      if (l) disarm(l);
      const meta = readMeta(manifest);
      if (meta && meta.state === "running") {
        meta.state = "cancelled";
        meta.endedAt = new Date().toISOString();
        writeMeta(manifest, meta);
      }
      refreshWidget();
      return { content: [{ type: "text", text: `Cancelled watch ${manifest.id}.` }], details: { id: manifest.id } };
    },
  });

  pi.registerTool({
    name: "watch_improve",
    label: "Improve Watch",
    description:
      "Rewrite the check() for an existing watch (e.g. its liveness signal was wrong or too noisy). " +
      "Re-validates, re-arms if still running, and records history.",
    promptSnippet: "Rewrite a watch's check function",
    promptGuidelines: [
      "Use watch_improve when a watch's check() is producing wrong states — false 'failed', never completing, or a bad liveness signal.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Watch id (or unique prefix)." }),
      check_code: Type.String({ description: "New TypeScript source for check.ts." }),
      request: Type.String({ description: "What changed and why (stored in history)." }),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      uiCtx = ctx;
      const manifest = findWatch(ctx.cwd, params.id);
      if (!manifest) {
        return { content: [{ type: "text", text: `Watch not found: ${params.id}` }], details: {} };
      }

      fs.writeFileSync(manifest.checkPath, params.check_code);
      let history: HistoryEntry[] = [];
      try {
        history = JSON.parse(fs.readFileSync(manifest.historyPath, "utf-8"));
      } catch {
        // ignore
      }
      history.push({
        timestamp: new Date().toISOString(),
        request: params.request,
        implementation: params.check_code,
      });
      fs.writeFileSync(manifest.historyPath, JSON.stringify(history, null, 2));

      let status: WatchStatus;
      try {
        status = await loadAndRunCheck(manifest.checkPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `❌ Updated check.ts but validation failed:\n\n${msg}` }],
          details: { error: msg },
        };
      }

      const meta = readMeta(manifest) ?? {
        id: manifest.id,
        name: manifest.name,
        intervalSeconds: DEFAULT_INTERVAL,
        state: "running" as const,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      };
      meta.state = status.state === "running" ? "running" : status.state;
      meta.lastSummary = status.summary;
      if (meta.state !== "running") meta.endedAt = new Date().toISOString();
      writeMeta(manifest, meta);
      arm(manifest, meta);

      return {
        content: [
          {
            type: "text",
            text: `✅ check.ts updated (v${history.length}). State: ${status.state} — ${status.summary}`,
          },
        ],
        details: { status, version: history.length },
      };
    },
  });

  // ── Command ─────────────────────────────────────────────────────────

  pi.registerCommand("watch", {
    description: "Manage watches: /watch list | cancel <id> | delete <id>",
    handler: async (args, ctx) => {
      uiCtx = ctx;
      const [sub = "list", ...rest] = (args || "").trim().split(/\s+/);
      const arg = rest.join(" ").trim();

      if (sub === "list") {
        const manifests = discoverWatches(ctx.cwd);
        if (manifests.length === 0) {
          ctx.ui.notify("No watches in .pi/watch/", "info");
          return;
        }
        const lines = ["Watches:"];
        for (const m of manifests) {
          const meta = readMeta(m);
          lines.push(`  [${meta?.state ?? "?"}] ${m.id} — ${meta?.lastSummary ?? ""}`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "cancel" || sub === "delete") {
        const manifest = findWatch(ctx.cwd, arg);
        if (!manifest) {
          ctx.ui.notify(`Watch not found: ${arg}`, "error");
          return;
        }
        const l = live.get(manifest.id);
        if (l) disarm(l);
        live.delete(manifest.id);
        if (sub === "delete") {
          fs.rmSync(manifest.dir, { recursive: true, force: true });
          ctx.ui.notify(`Deleted watch ${manifest.id}`, "info");
        } else {
          const meta = readMeta(manifest);
          if (meta && meta.state === "running") {
            meta.state = "cancelled";
            meta.endedAt = new Date().toISOString();
            writeMeta(manifest, meta);
          }
          ctx.ui.notify(`Cancelled watch ${manifest.id}`, "info");
        }
        refreshWidget();
        return;
      }

      ctx.ui.notify("Usage: /watch list | cancel <id> | delete <id>", "warning");
    },
  });
}
