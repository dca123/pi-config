# Codex Multiplexer Contract

Local Pi extension for managing multiple `openai-codex` OAuth subscription accounts.

## Non-goals

- No external npm/package dependencies.
- No support for OpenAI API-key provider.
- No project-specific account pools in v1.
- No git commits.

## Storage

Path: `~/.pi/agent/codex-multiplexer.json`

```json
{
  "version": 1,
  "active": "work",
  "autoSwitch": true,
  "accounts": {
    "work": {
      "label": "work",
      "auth": { "type": "oauth", "access": "...", "refresh": "...", "expires": 123 },
      "createdAt": 123,
      "lastUsedAt": 123
    }
  },
  "usageCache": {
    "work": { "fetchedAt": 123, "snapshot": {} }
  },
  "stats": {
    "switches": [],
    "rateLimitEvents": [],
    "successfulTurns": {}
  }
}
```

Stats are retained forever until `/codex-stats-clear`.

## Commands

### `/codex-save [label]`
Copies current `openai-codex` OAuth credentials from Pi auth storage into multiplexer storage under `<label>`.
When omitted, the label is derived from the Codex token email. Labels are custom user labels for observability. Existing labels are overwritten.

Successful `/login` calls for `openai-codex` automatically save or update the matching multiplexer account and make it active.

### `/codex-use <label>`
Restores the saved account auth into Pi's `openai-codex` auth storage, sets `active`, records a manual switch if changing account, and refreshes usage display.

### `/codex-list`
Shows saved labels, active account, and whether each has usage cache. Must not print tokens.

### `/codex-usage`
Fetches usage for active account and updates display. Shows percent left.

### `/codex-stats`
Shows active account, switch counts, rate-limit counts, and recent switch summary. Must not print tokens.

### `/codex-stats-clear`
Clears stats only; keeps accounts and active selection.

### `/codex-auto on|off`
Toggles automatic failover. Default is on.

## Usage

Fetch endpoint: `https://chatgpt.com/backend-api/wham/usage`.

Headers:
- `Authorization: Bearer <access>`
- `Accept: application/json`
- `User-Agent: pi-codex-multiplexer`
- `chatgpt-account-id: <accountId>` when present in JWT metadata or auth object

Display format:

```txt
codex work │ 5h 37% left reset ~1h │ 7d 78% left reset ~1d │ switches 3
```

Usage fetch failures must not block manual or automatic switching.

## Auto-switch

Enabled by default.

On assistant error matching usage/rate-limit patterns:
1. Record a rate-limit event.
2. Select next account by round-robin after current active account.
3. Exclude accounts already tried for this original prompt.
4. Restore selected account into Pi auth storage.
5. Notify loudly: `Codex usage limit hit: work → spare, retrying prompt`.
6. Replay the last user prompt once on that account.
7. Continue until all accounts are tried, then stop and warn.

No fallback to other providers.

## Startup

On `session_start`, if `active` is set and exists, restore it into `openai-codex` auth storage and update status/usage display. This is a startup restore, not a manual switch.

## Pure API

The extension core exposes pure functions for TDD:

- `emptyConfig()`
- `normalizeConfig(raw)`
- `classifyRateLimitError(message)`
- `decodeCodexTokenMetadata(accessToken)`
- `parseCodexUsageSnapshot(data)`
- `formatUsageLine({ label, snapshot, totalSwitches })`
- `pickNextRoundRobinAccount(labels, active, tried)`
- `saveAccount(config, label, auth, now)`
- `switchAccount(config, label, now, reason)`
- `recordSwitchEvent(config, event)`
- `recordRateLimitEvent(config, event)`
- `clearStats(config)`
