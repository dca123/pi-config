import { z } from "zod";

/**
 * The contract between the extension and agent-generated check functions.
 * A check() inspects whatever it needs (process, files, logs) and reports the
 * current liveness/terminal state of one long-lived task.
 *
 * The framework deliberately has NO built-in stale/timeout heuristic: a healthy
 * silent task and a hung silent task are indistinguishable from outside, so the
 * check() owns all liveness logic and returns "failed" on its own threshold.
 */
export const WatchStatusSchema = z.object({
  // terminal states are "complete" and "failed"; "running" means keep polling.
  state: z.enum(["running", "complete", "failed"]),
  // one-line status: progress text while running, verdict on terminal.
  summary: z.string(),
  // optional richer payload, injected into the thread on terminal states.
  detail: z.string().optional(),
});

export type WatchStatus = z.infer<typeof WatchStatusSchema>;

/** Shape of the check.ts default export. No args — uses Node builtins. */
export type CheckFn = () => WatchStatus | Promise<WatchStatus>;

/** Persisted per-watch metadata. */
export interface WatchMeta {
  id: string;
  name: string;
  intervalSeconds: number;
  // lifecycle: "running" while armed; terminal once the check resolves.
  state: "running" | "complete" | "failed" | "cancelled";
  createdAt: string;
  startedAt: string;
  // last observed status (for status snapshots and post-reload context).
  lastSummary?: string;
  endedAt?: string;
}

/** History entry for iterative improvement (à la sweep). */
export interface HistoryEntry {
  timestamp: string;
  request: string;
  implementation: string;
}
