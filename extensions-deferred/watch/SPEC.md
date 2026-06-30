# watch — non-blocking monitors for long-lived tasks

Modeled on the `sweep` extension. The agent writes a small `check.ts` per watch
(the liveness/terminal logic), and the framework just **schedules** it and
**re-injects** a wake-up message into the thread when it reaches a terminal
state. Generic: tests, `ask-codebase` queries, detached pi subagents, builds —
anything long-lived.

## Why this shape (decisions, all confirmed)

- **Reusable global extension**, not a one-off. (loaded via lazy-all)
- **Non-blocking (option a):** `watch_create` returns immediately with a watch
  id; the agent keeps working. On completion the watch injects "task done" via
  `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`, waking the
  agent inside the same logical run.
- **Durable:** watches persist under `.pi/watch/<slug>-<id>/` and re-arm on
  `session_start` — survive `/reload` (common mid-session).
- **No give-up timeout by default.** Avoiding tool-call timeouts is the whole
  point; a blocking wait is what we're escaping. Watches poll indefinitely until
  their `check.ts` returns a terminal state.
- **Liveness is owned by `check.ts`, not the framework.** There is no built-in
  "stale" heuristic, because a healthy silent test and a hung silent test look
  identical from outside. The agent encodes the right signal per task (process
  exit, sentinel file, log mtime, JSONL tail, exit-code file, etc.). If the agent
  wants hang detection, its `check.ts` returns `failed` on its own threshold.
- **Push + Pull**, symmetric with sweep: push = completion injection; pull =
  `watch_status` runs every live `check.ts` on demand and returns a snapshot.

## The contract

`check.ts` — default export, no args, Node builtins. Returns `WatchStatus`:

```ts
export default function (): WatchStatus {
  return {
    state: "running" | "complete" | "failed", // terminal = complete | failed
    summary: string,   // one-line status (progress text / liveness verdict)
    detail?: string,   // optional richer payload injected on terminal
  };
}
```

- `running`   → keep polling; `summary` shown in widget / returned by status.
- `complete`  → stop, inject `summary` + `detail`, trigger a turn.
- `failed`    → stop, inject `summary` + `detail`, trigger a turn. (this is how
  the agent surfaces "hung" / "exited nonzero" / "timed out per my own rule")

## Tools (sweep-style verbs)

- `watch_create(name, check_code, interval_seconds?)` — write + validate + arm.
- `watch_status()` — run every live check, return snapshot.
- `watch_cancel(id)` — stop + mark cancelled.
- `watch_improve(id, check_code, request)` — rewrite a check, sweep-style history.

## Files

```
.pi/watch/<slug>-<id>/
  check.ts            agent-authored, returns WatchStatus (validated)
  meta.json           { id, name, intervalSeconds, state, createdAt, startedAt }
  check.history.json  improvement history
```
