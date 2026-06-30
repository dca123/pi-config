import { z } from "zod";

/**
 * The contract between the extension and agent-generated derivation functions.
 * The derivation function scans the codebase and returns the next task.
 */
export const SweepTaskSchema = z.object({
  done: z.boolean(),
  progress: z.object({
    completed: z.number(),
    total: z.number(),
  }),
  task: z
    .object({
      title: z.string(),
      instructions: z.string(),
    })
    .optional(),
});

export type SweepTask = z.infer<typeof SweepTaskSchema>;

/**
 * Shape of the derive.ts default export.
 * The function receives no arguments — it uses Node builtins (fs, child_process)
 * to scan the codebase directly.
 */
export type DeriveFn = () => SweepTask | Promise<SweepTask>;

/**
 * History entry for iterative improvement (à la luai.nvim).
 */
export interface HistoryEntry {
  timestamp: string;
  request: string;
  implementation: string;
}
