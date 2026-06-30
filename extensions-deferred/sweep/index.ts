/**
 * Sweep — autonomous task loop extension for Pi.
 *
 * The agent (or user) creates a sweep: a TypeScript derivation function that
 * scans the codebase and returns the next task, plus a rules.md with standing
 * instructions. The extension drives the loop:
 *
 *   derive() → inject task into context → agent works → agent_end → derive() → …
 *
 * Files live at .pi/sweep/<slug>-<id>/:
 *   derive.ts          — agent-generated, returns SweepTask (Zod-validated)
 *   rules.md           — standing instructions (constant across iterations)
 *   derive.history.json — improvement history (previous implementations + requests)
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  discoverSweeps,
  findSweep,
  generateId,
  slugify,
  sweepBaseDir,
  loadAndRunDerive,
  readRules,
  type SweepManifest,
} from "./loader.ts";
import type { SweepTask, HistoryEntry } from "./schema.ts";

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

interface SweepRuntime {
  active: SweepManifest | null;
  lastTask: SweepTask | null;
  running: boolean;
  confirmMode: boolean;
  pendingResumeTimer: ReturnType<typeof setTimeout> | null;
}

function createRuntime(): SweepRuntime {
  return {
    active: null,
    lastTask: null,
    running: false,
    confirmMode: false,
    pendingResumeTimer: null,
  };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function sweepExtension(pi: ExtensionAPI) {
  const SETTLED_WINDOW_MS = 800;
  const MAX_AUTO_RESUME = 200;
  let autoResumeTurns = 0;

  let runtime = createRuntime();

  const cancelPendingResume = () => {
    if (runtime.pendingResumeTimer) {
      clearTimeout(runtime.pendingResumeTimer);
      runtime.pendingResumeTimer = null;
    }
  };

  // ── Widget ──────────────────────────────────────────────────────────

  const updateWidget = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    if (!runtime.active || !runtime.lastTask) {
      ctx.ui.setStatus("sweep", undefined);
      ctx.ui.setWidget("sweep", undefined);
      return;
    }

    const task = runtime.lastTask;
    const manifest = runtime.active;
    const { completed, total } = task.progress;

    ctx.ui.setStatus(
      "sweep",
      ctx.ui.theme.fg(
        task.done ? "success" : "accent",
        task.done
          ? `✅ sweep done (${total}/${total})`
          : `🔧 sweep ${completed}/${total}`,
      ),
    );

    ctx.ui.setWidget("sweep", (_tui, theme) => ({
      render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

        // Progress bar
        const barWidth = Math.min(20, Math.floor(safeWidth * 0.2));
        const filled = Math.round((completed / Math.max(total, 1)) * barWidth);
        const bar =
          theme.fg("success", "█".repeat(filled)) +
          theme.fg("dim", "░".repeat(barWidth - filled));

        const status = runtime.running
          ? theme.fg("accent", "running")
          : runtime.confirmMode
            ? theme.fg("warning", "paused (confirm)")
            : theme.fg("dim", "stopped");

        const titleLine = [
          theme.fg("accent", "🔧"),
          theme.fg("muted", ` ${manifest.id}`),
          theme.fg("dim", " │ "),
          bar,
          theme.fg("text", ` ${completed}/${total}`),
          theme.fg("dim", ` (${pct}%)`),
          theme.fg("dim", " │ "),
          status,
        ].join("");

        const lines = [truncateToWidth(titleLine, safeWidth)];

        if (task.task && !task.done) {
          lines.push(
            truncateToWidth(
              `  ${theme.fg("muted", "Next:")} ${theme.fg("text", task.task.title)}`,
              safeWidth,
            ),
          );
        }

        return lines;
      },
      invalidate() {},
    }));
  };

  // ── Derive + inject ─────────────────────────────────────────────────

  const runDerive = async (
    ctx: ExtensionContext,
  ): Promise<SweepTask | null> => {
    if (!runtime.active) return null;

    try {
      const task = await loadAndRunDerive(runtime.active.derivePath);
      runtime.lastTask = task;
      updateWidget(ctx);
      return task;
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : String(err);
      if (ctx.hasUI) ctx.ui.notify(`Sweep derive error: ${msg}`, "error");
      return null;
    }
  };

  // Inject standing rules + per-task instructions into agent context
  pi.on("before_agent_start", async (event, ctx) => {
    if (!runtime.active || !runtime.running) return;

    const task = runtime.lastTask ?? (await runDerive(ctx));
    if (!task || task.done) return;
    if (!task.task) return;

    let extra = "";

    // Standing rules
    const rules = readRules(runtime.active);
    if (rules) {
      extra += `\n\n## Sweep Standing Instructions (${runtime.active.id})\n${rules}`;
    }

    // Per-task instructions
    extra +=
      `\n\n## Current Sweep Task (${task.progress.completed + 1}/${task.progress.total})` +
      `\n### ${task.task.title}` +
      `\n${task.task.instructions}`;

    return {
      systemPrompt: event.systemPrompt + extra,
    };
  });

  // Auto-continue after agent finishes
  pi.on("agent_end", async (_event, ctx) => {
    if (!runtime.active || !runtime.running) return;
    cancelPendingResume();

    if (autoResumeTurns >= MAX_AUTO_RESUME) {
      if (ctx.hasUI)
        ctx.ui.notify(
          `Sweep auto-resume limit reached (${MAX_AUTO_RESUME})`,
          "info",
        );
      runtime.running = false;
      updateWidget(ctx);
      return;
    }

    // Re-derive to see if the task changed
    const task = await runDerive(ctx);
    if (!task || task.done) {
      runtime.running = false;
      updateWidget(ctx);
      if (ctx.hasUI) ctx.ui.notify("Sweep complete! 🎉", "info");
      return;
    }

    if (runtime.confirmMode) {
      // In confirm mode, don't auto-resume — just update widget
      runtime.running = false;
      updateWidget(ctx);
      if (ctx.hasUI)
        ctx.ui.notify(
          `Task done. ${task.progress.completed}/${task.progress.total}. /sweep continue to proceed.`,
          "info",
        );
      return;
    }

    // Auto-resume after settled window
    runtime.pendingResumeTimer = setTimeout(() => {
      if (!runtime.running || !runtime.active) return;
      autoResumeTurns++;
      pi.sendUserMessage(
        `Continue with the next sweep task. The sweep derivation function has been re-evaluated and the next task is injected into your context.`,
      );
    }, SETTLED_WINDOW_MS);
  });

  // ── Session lifecycle ───────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    runtime = createRuntime();
    autoResumeTurns = 0;
    updateWidget(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    cancelPendingResume();
    if (ctx.hasUI) {
      ctx.ui.setStatus("sweep", undefined);
      ctx.ui.setWidget("sweep", undefined);
    }
  });

  // Custom compaction: preserve sweep context so the agent doesn't lose
  // track of what it's doing across context resets.
  pi.on("session_before_compact", async (event, ctx) => {
    if (!runtime.active || !runtime.running) return;
    cancelPendingResume();

    const task = runtime.lastTask;
    const rules = readRules(runtime.active);

    let summary = `## Sweep in progress: ${runtime.active.id}\n`;
    summary += `Progress: ${task?.progress.completed ?? "?"}/${task?.progress.total ?? "?"}\n`;
    summary += `Auto-resume turns used: ${autoResumeTurns}/${MAX_AUTO_RESUME}\n\n`;

    if (rules) {
      summary += `### Standing Instructions\n${rules}\n\n`;
    }

    if (task?.task) {
      summary += `### Current Task\n**${task.task.title}**\n${task.task.instructions}\n\n`;
    }

    summary +=
      "The sweep extension is active and will continue injecting tasks " +
      "into context after compaction. The derive function re-evaluates on " +
      "each iteration, so progress is always current.";

    return {
      compaction: {
        summary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });

  // Auto-resume after compaction
  pi.on("session_compact", async (_event, ctx) => {
    if (!runtime.active || !runtime.running) return;

    runtime.pendingResumeTimer = setTimeout(() => {
      if (!runtime.running || !runtime.active) return;
      autoResumeTurns++;
      pi.sendUserMessage(
        "Continue with the next sweep task after compaction. " +
          "The derive function has been re-evaluated and task instructions are in your context.",
      );
    }, SETTLED_WINDOW_MS);
  });

  // ── Tools ───────────────────────────────────────────────────────────

  pi.registerTool({
    name: "sweep_create",
    label: "Create Sweep",
    description:
      "Create a new sweep: an autonomous task loop driven by a TypeScript derivation function. " +
      "The derive function scans the codebase and returns the next task. " +
      "The extension validates the output against the SweepTask schema, " +
      "then drives the loop (derive → inject task → agent works → repeat).",
    promptSnippet:
      "Create autonomous task sweep with a TypeScript derivation function",
    promptGuidelines: [
      'Use sweep_create when the user asks to "set up a sweep", "create a sweep", or wants an autonomous multi-step refactor loop.',
      "The derive_code parameter is a TypeScript function body that scans the codebase and returns a SweepTask. " +
        "It must export a default function returning { done: boolean, progress: { completed: number, total: number }, task?: { title: string, instructions: string } }. " +
        "The function runs in Node.js with full fs/child_process access — use execSync, readdirSync, etc. to scan the real codebase. " +
        "Import from 'node:fs', 'node:path', 'node:child_process' as needed.",
      "The rules parameter contains standing instructions (the protocol/process that stays constant across all iterations). " +
        "Per-task instructions go in the task.instructions field returned by derive_code.",
      "After sweep_create succeeds, the sweep is automatically started. The agent will receive task instructions in its context each turn.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description:
          'Human-readable name for this sweep (e.g. "Convert readport adapters to query definitions")',
      }),
      derive_code: Type.String({
        description:
          "Full TypeScript source for derive.ts. Must export a default function returning SweepTask.",
      }),
      rules: Type.String({
        description:
          "Standing instructions in markdown. The protocol/process that stays constant across all iterations.",
      }),
      auto_start: Type.Optional(
        Type.Boolean({
          description:
            "Start the sweep immediately after creation (default: true)",
        }),
      ),
      confirm_mode: Type.Optional(
        Type.Boolean({
          description:
            "Pause between tasks for user confirmation (default: false)",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = `${slugify(params.name)}-${generateId()}`;
      const dir = path.join(sweepBaseDir(ctx.cwd), id);

      // Write files
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "derive.ts"), params.derive_code);
      fs.writeFileSync(path.join(dir, "rules.md"), params.rules);

      const history: HistoryEntry[] = [
        {
          timestamp: new Date().toISOString(),
          request: `Initial creation: ${params.name}`,
          implementation: params.derive_code,
        },
      ];
      fs.writeFileSync(
        path.join(dir, "derive.history.json"),
        JSON.stringify(history, null, 2),
      );

      // Validate by running the derive function once
      const manifest: SweepManifest = {
        id,
        dir,
        derivePath: path.join(dir, "derive.ts"),
        rulesPath: path.join(dir, "rules.md"),
        historyPath: path.join(dir, "derive.history.json"),
        name: id,
      };

      let task: SweepTask;
      try {
        task = await loadAndRunDerive(manifest.derivePath);
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text:
                `❌ Sweep created at ${dir} but derive.ts validation failed:\n\n${msg}\n\n` +
                `Fix the derive.ts file and run /sweep start ${id}`,
            },
          ],
          details: { id, error: msg },
        };
      }

      // Auto-start
      const shouldStart = params.auto_start !== false;
      if (shouldStart) {
        runtime.active = manifest;
        runtime.lastTask = task;
        runtime.running = true;
        runtime.confirmMode = params.confirm_mode ?? false;
        autoResumeTurns = 0;
        updateWidget(ctx);
      }

      const statusLine = task.done
        ? "Already done — no tasks remaining."
        : `Ready: ${task.progress.completed}/${task.progress.total} completed. Next: ${task.task?.title ?? "unknown"}`;

      return {
        content: [
          {
            type: "text",
            text:
              `✅ Sweep created: ${id}\n` +
              `   ${statusLine}\n` +
              (shouldStart
                ? "   Sweep started — task instructions are now in your context."
                : `   Run /sweep start ${id} to begin.`),
          },
        ],
        details: { id, task },
      };
    },
  });

  pi.registerTool({
    name: "sweep_status",
    label: "Sweep Status",
    description: "Get current sweep progress by re-running the derivation function.",
    promptSnippet: "Check current sweep progress and next task",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (!runtime.active) {
        return {
          content: [{ type: "text", text: "No active sweep." }],
          details: {},
        };
      }

      const task = await runDerive(ctx);
      if (!task) {
        return {
          content: [
            { type: "text", text: "Failed to run derivation function." },
          ],
          details: {},
        };
      }

      const lines = [
        `Sweep: ${runtime.active.id}`,
        `Progress: ${task.progress.completed}/${task.progress.total}`,
        `Running: ${runtime.running}`,
        `Done: ${task.done}`,
      ];

      if (task.task) {
        lines.push(`Next task: ${task.task.title}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { task },
      };
    },
  });

  pi.registerTool({
    name: "sweep_skip",
    label: "Sweep Skip",
    description:
      "Skip the current sweep task and move to the next one. Use when a task cannot be completed.",
    promptSnippet: "Skip current sweep task",
    promptGuidelines: [
      "Use sweep_skip when the current sweep task cannot be completed — e.g. it requires a decision the agent can't make, " +
        "or the codebase state doesn't match what the derivation function expected.",
    ],
    parameters: Type.Object({
      reason: Type.String({
        description: "Why this task is being skipped",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!runtime.active) {
        return {
          content: [{ type: "text", text: "No active sweep." }],
          details: {},
        };
      }

      // Log the skip to a skips file for the derivation function to check
      const skipsPath = path.join(runtime.active.dir, "skips.json");
      let skips: Array<{ title: string; reason: string; timestamp: string }> =
        [];
      try {
        if (fs.existsSync(skipsPath)) {
          skips = JSON.parse(fs.readFileSync(skipsPath, "utf-8"));
        }
      } catch {
        // ignore
      }

      skips.push({
        title: runtime.lastTask?.task?.title ?? "unknown",
        reason: params.reason,
        timestamp: new Date().toISOString(),
      });
      fs.writeFileSync(skipsPath, JSON.stringify(skips, null, 2));

      // Re-derive to get the next task
      const task = await runDerive(ctx);

      return {
        content: [
          {
            type: "text",
            text: `Skipped: ${params.reason}\n${task?.task ? `Next: ${task.task.title}` : "No more tasks."}`,
          },
        ],
        details: { skipped: params.reason, nextTask: task },
      };
    },
  });

  pi.registerTool({
    name: "sweep_improve",
    label: "Improve Sweep",
    description:
      "Rewrite the derivation function for the active sweep. " +
      "The current implementation and history are provided as context.",
    promptSnippet: "Rewrite the active sweep's derivation function",
    promptGuidelines: [
      "Use sweep_improve when the derivation function needs to be updated — e.g. it's not finding the right files, " +
        "the instructions it generates are wrong, or the progress tracking is inaccurate. " +
        "The current implementation and full history are provided for context.",
    ],
    parameters: Type.Object({
      derive_code: Type.String({
        description: "New TypeScript source for derive.ts",
      }),
      request: Type.String({
        description:
          "What was changed and why (stored in history for future improvements)",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!runtime.active) {
        return {
          content: [{ type: "text", text: "No active sweep." }],
          details: {},
        };
      }

      const manifest = runtime.active;

      // Write new derive.ts
      fs.writeFileSync(manifest.derivePath, params.derive_code);

      // Append to history
      let history: HistoryEntry[] = [];
      try {
        if (fs.existsSync(manifest.historyPath)) {
          history = JSON.parse(fs.readFileSync(manifest.historyPath, "utf-8"));
        }
      } catch {
        // ignore
      }

      history.push({
        timestamp: new Date().toISOString(),
        request: params.request,
        implementation: params.derive_code,
      });
      fs.writeFileSync(
        manifest.historyPath,
        JSON.stringify(history, null, 2),
      );

      // Validate
      let task: SweepTask;
      try {
        task = await loadAndRunDerive(manifest.derivePath);
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `❌ Updated derive.ts but validation failed:\n\n${msg}`,
            },
          ],
          details: { error: msg },
        };
      }

      runtime.lastTask = task;
      updateWidget(ctx);

      return {
        content: [
          {
            type: "text",
            text:
              `✅ Derivation function updated (v${history.length}).\n` +
              `Progress: ${task.progress.completed}/${task.progress.total}`,
          },
        ],
        details: { task, version: history.length },
      };
    },
  });

  // ── Commands ────────────────────────────────────────────────────────

  pi.registerCommand("sweep", {
    description:
      "Manage sweeps: /sweep list | start <id> | stop | continue | delete <id>",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      const subcmd = parts[0] || "list";
      const subarg = parts.slice(1).join(" ");

      switch (subcmd) {
        case "list": {
          const sweeps = discoverSweeps(ctx.cwd);
          if (sweeps.length === 0) {
            ctx.ui.notify("No sweeps found in .pi/sweep/", "info");
            return;
          }

          // Run derive for each to get progress
          const lines: string[] = ["Sweeps:"];
          for (const s of sweeps) {
            let status = "unknown";
            try {
              const task = await loadAndRunDerive(s.derivePath);
              const active = runtime.active?.id === s.id;
              status = task.done
                ? `✅ done (${task.progress.total}/${task.progress.total})`
                : `${task.progress.completed}/${task.progress.total}${active ? " (active)" : ""}`;
            } catch (err) {
              status = `❌ ${err instanceof Error ? err.message.slice(0, 40) : "error"}`;
            }
            lines.push(`  ${s.id}  ${status}`);
          }
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }

        case "start": {
          const id = subarg.trim();
          if (!id) {
            // Auto-start if only one sweep exists
            const sweeps = discoverSweeps(ctx.cwd);
            if (sweeps.length === 1) {
              return startSweep(sweeps[0], false, ctx);
            }
            ctx.ui.notify(
              "Usage: /sweep start <id>  (use /sweep list to see available)",
              "warning",
            );
            return;
          }

          const confirmMode = id.includes("--confirm");
          const cleanId = id.replace("--confirm", "").trim();

          const manifest = findSweep(ctx.cwd, cleanId);
          if (!manifest) {
            ctx.ui.notify(`Sweep not found: ${cleanId}`, "error");
            return;
          }

          return startSweep(manifest, confirmMode, ctx);
        }

        case "stop": {
          if (!runtime.active) {
            ctx.ui.notify("No active sweep.", "info");
            return;
          }
          cancelPendingResume();
          runtime.running = false;
          updateWidget(ctx);
          ctx.ui.notify(`Sweep stopped: ${runtime.active.id}`, "info");
          return;
        }

        case "continue": {
          if (!runtime.active) {
            ctx.ui.notify("No active sweep.", "info");
            return;
          }
          runtime.running = true;
          updateWidget(ctx);

          const task = await runDerive(ctx);
          if (!task || task.done) {
            runtime.running = false;
            updateWidget(ctx);
            ctx.ui.notify("Sweep already complete.", "info");
            return;
          }

          pi.sendUserMessage(
            "Continue with the next sweep task. The task instructions are in your context.",
          );
          return;
        }

        case "delete": {
          const id = subarg.trim();
          if (!id) {
            ctx.ui.notify("Usage: /sweep delete <id>", "warning");
            return;
          }
          const manifest = findSweep(ctx.cwd, id);
          if (!manifest) {
            ctx.ui.notify(`Sweep not found: ${id}`, "error");
            return;
          }

          if (runtime.active?.id === manifest.id) {
            cancelPendingResume();
            runtime.active = null;
            runtime.lastTask = null;
            runtime.running = false;
          }

          fs.rmSync(manifest.dir, { recursive: true, force: true });
          updateWidget(ctx);
          ctx.ui.notify(`Deleted sweep: ${manifest.id}`, "info");
          return;
        }

        default:
          ctx.ui.notify(
            "Usage: /sweep list | start <id> [--confirm] | stop | continue | delete <id>",
            "warning",
          );
      }
    },
  });

  async function startSweep(
    manifest: SweepManifest,
    confirmMode: boolean,
    ctx: ExtensionContext,
  ) {
    let task: SweepTask;
    try {
      task = await loadAndRunDerive(manifest.derivePath);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Failed to start sweep: ${msg}`, "error");
      return;
    }

    runtime.active = manifest;
    runtime.lastTask = task;
    runtime.running = true;
    runtime.confirmMode = confirmMode;
    autoResumeTurns = 0;
    updateWidget(ctx);

    if (task.done) {
      runtime.running = false;
      updateWidget(ctx);
      ctx.ui.notify("Sweep already complete.", "info");
      return;
    }

    ctx.ui.notify(
      `Sweep started: ${manifest.id} (${task.progress.completed}/${task.progress.total})`,
      "info",
    );

    // Kick off the first task
    pi.sendUserMessage(
      "A sweep has been started. The first task instructions are in your context. Begin working on it now.",
    );
  }
}
