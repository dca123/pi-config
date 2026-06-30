const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';
const OPENAI_PROFILE_CLAIM = 'https://api.openai.com/profile';

export function emptyConfig() {
  return {
    version: 1,
    active: undefined,
    autoSwitch: true,
    accounts: {},
    usageCache: {},
    stats: {
      switches: [],
      rateLimitEvents: [],
      successfulTurns: {},
    },
  };
}

export function normalizeConfig(raw) {
  const parsed = getRecord(raw) || {};
  const config = emptyConfig();
  config.active = typeof parsed.active === 'string' ? parsed.active : undefined;
  config.autoSwitch = typeof parsed.autoSwitch === 'boolean' ? parsed.autoSwitch : true;
  config.accounts = getRecord(parsed.accounts) || {};
  config.usageCache = getRecord(parsed.usageCache) || {};

  const stats = getRecord(parsed.stats) || {};
  config.stats = {
    switches: Array.isArray(stats.switches) ? stats.switches : [],
    rateLimitEvents: Array.isArray(stats.rateLimitEvents) ? stats.rateLimitEvents : [],
    successfulTurns: getRecord(stats.successfulTurns) || {},
  };
  return config;
}

const RATE_LIMIT_PATTERNS = [
  /usage.?limit/i,
  /rate.?limit/i,
  /limit.*reached/i,
  /too many requests/i,
  /429/,
  /quota/i,
  /exhausted/i,
];

export function classifyRateLimitError(message) {
  if (!message) return false;
  return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}

function getRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value;
}

export function decodeCodexTokenMetadata(accessToken) {
  const parts = String(accessToken || '').split('.');
  if (parts.length < 2) return {};

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const auth = getRecord(payload[OPENAI_AUTH_CLAIM]);
    const profile = getRecord(payload[OPENAI_PROFILE_CLAIM]);
    return {
      accountId: typeof auth?.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : undefined,
      planType: typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : undefined,
      email: typeof profile?.email === 'string' ? profile.email : undefined,
    };
  } catch {
    return {};
  }
}

export function getCodexAuthIdentity(auth) {
  const metadata = decodeCodexTokenMetadata(auth?.access);
  return {
    accountId: typeof auth?.accountId === 'string' ? auth.accountId : metadata.accountId,
    planType: metadata.planType,
    email: metadata.email,
  };
}

function labelsEqual(left, right) {
  if (!left || !right) return false;
  return String(left).toLowerCase() === String(right).toLowerCase();
}

export function findAccountLabelForAuth(config, auth) {
  const identity = getCodexAuthIdentity(auth);
  const accounts = getRecord(config?.accounts) || {};

  if (identity.email) {
    for (const [label, account] of Object.entries(accounts)) {
      const accountIdentity = getCodexAuthIdentity(account?.auth);
      if (labelsEqual(accountIdentity.email, identity.email)) return label;
    }
  }

  if (identity.accountId) {
    for (const [label, account] of Object.entries(accounts)) {
      const accountIdentity = getCodexAuthIdentity(account?.auth);
      if (accountIdentity.accountId === identity.accountId) return label;
    }
  }

  return undefined;
}

function sanitizeLabel(value) {
  const label = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return label || 'codex';
}

export function chooseAccountLabelForAuth(config, auth) {
  const existing = findAccountLabelForAuth(config, auth);
  if (existing) return existing;

  const identity = getCodexAuthIdentity(auth);
  const base = identity.email ? sanitizeLabel(identity.email.split('@')[0]) : sanitizeLabel(identity.accountId || 'codex');
  const accounts = getRecord(config?.accounts) || {};
  if (!accounts[base]) return base;

  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!accounts[candidate]) return candidate;
  }

  return `${base}-${Date.now()}`;
}

function normalizeWindow(value) {
  const raw = getRecord(value);
  if (!raw) return undefined;

  const usedPercent = typeof raw.used_percent === 'number' ? raw.used_percent : 0;
  const windowSeconds = typeof raw.limit_window_seconds === 'number' ? raw.limit_window_seconds : 0;
  const resetAt = typeof raw.reset_at === 'number' ? raw.reset_at : undefined;
  return {
    remainingPercent: Math.max(0, Math.min(100, 100 - usedPercent)),
    windowSeconds,
    resetAt,
  };
}

function matchesWindow(window, seconds) {
  if (!window) return false;
  return Math.abs(window.windowSeconds - seconds) <= 120;
}

export function parseCodexUsageSnapshot(data) {
  const raw = getRecord(data) || {};
  const rateLimit = getRecord(raw.rate_limit) || {};
  const windows = [
    normalizeWindow(rateLimit.primary_window),
    normalizeWindow(rateLimit.secondary_window),
  ].filter(Boolean);

  return {
    planType: typeof raw.plan_type === 'string' ? raw.plan_type : 'unknown',
    email: typeof raw.email === 'string' ? raw.email : '',
    fiveHour: windows.find((window) => matchesWindow(window, 5 * 60 * 60)),
    weekly: windows.find((window) => matchesWindow(window, 7 * 24 * 60 * 60)),
  };
}

function formatReset(resetAt) {
  if (!resetAt) return '--';
  const diffMs = resetAt * 1000 - Date.now();
  if (diffMs <= 0) return 'now';

  const totalMinutes = Math.round(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `~${days}d`;
  if (hours > 0) return `~${hours}h`;
  return `~${minutes}m`;
}

function formatCompactPercent(window) {
  if (!window) return '--';
  return `${Math.round(window.remainingPercent)}%`;
}

export function formatUsageLine(input) {
  const fiveHour = formatCompactPercent(input.snapshot?.fiveHour);
  return `${input.label} | ${fiveHour} left on 5h`;
}

export function getDisplayAccount(config, currentAuth) {
  const active = config.active;
  const savedAccount = active ? config.accounts?.[active] : undefined;
  if (savedAccount) {
    return { label: active, auth: savedAccount.auth, saved: true };
  }
  if (currentAuth?.type === 'oauth') {
    return { label: 'current', auth: currentAuth, saved: false };
  }
  return undefined;
}

export function pickNextRoundRobinAccount(accounts, active, tried) {
  if (!Array.isArray(accounts) || accounts.length === 0) return undefined;
  const activeIndex = accounts.indexOf(active);
  const startIndex = activeIndex >= 0 ? activeIndex : 0;

  for (let step = 1; step <= accounts.length; step += 1) {
    const candidate = accounts[(startIndex + step) % accounts.length];
    if (candidate === active) continue;
    if (tried?.has(candidate)) continue;
    return candidate;
  }

  return undefined;
}

export function saveAccount(config, label, auth, now = Date.now()) {
  if (!config.accounts) config.accounts = {};
  const existing = config.accounts[label];
  config.accounts[label] = {
    label,
    auth: { ...auth },
    createdAt: existing?.createdAt || now,
    lastUsedAt: existing?.lastUsedAt,
  };
}

export function switchAccount(config, label, now = Date.now(), reason = 'manual') {
  const account = config.accounts?.[label];
  if (!account) return { ok: false, reason: 'missing-account' };

  const previous = config.active;
  config.active = label;
  account.lastUsedAt = now;

  if (previous && previous !== label) {
    recordSwitchEvent(config, { at: now, from: previous, to: label, reason });
  }

  return { ok: true, auth: { ...account.auth } };
}

export function recordSwitchEvent(config, event) {
  if (!config.stats) config.stats = {};
  if (!Array.isArray(config.stats.switches)) config.stats.switches = [];
  config.stats.switches.push({
    at: event.at || Date.now(),
    from: event.from,
    to: event.to,
    reason: event.reason,
    message: event.message,
  });
}

export function recordRateLimitEvent(config, event) {
  if (!config.stats) config.stats = {};
  if (!Array.isArray(config.stats.rateLimitEvents)) config.stats.rateLimitEvents = [];
  config.stats.rateLimitEvents.push({
    at: event.at || Date.now(),
    account: event.account,
    message: event.message,
    promptHash: event.promptHash,
  });
}

export function clearStats(config) {
  config.stats = {
    switches: [],
    rateLimitEvents: [],
    successfulTurns: {},
  };
}
