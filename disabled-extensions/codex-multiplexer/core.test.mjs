import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyRateLimitError,
  decodeCodexTokenMetadata,
  formatUsageLine,
  getDisplayAccount,
  parseCodexUsageSnapshot,
  pickNextRoundRobinAccount,
  clearStats,
  chooseAccountLabelForAuth,
  emptyConfig,
  findAccountLabelForAuth,
  normalizeConfig,
  recordRateLimitEvent,
  recordSwitchEvent,
  saveAccount,
  switchAccount,
} from './core.mjs';

function fakeJwt(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${encoded}.sig`;
}

test('classifies only usage/rate limit style errors for auto switching', () => {
  assert.equal(classifyRateLimitError('Usage limit reached for model'), true);
  assert.equal(classifyRateLimitError('429 Too Many Requests'), true);
  assert.equal(classifyRateLimitError('quota exhausted'), true);
  assert.equal(classifyRateLimitError('network socket disconnected'), false);
  assert.equal(classifyRateLimitError('invalid api key'), false);
});

test('decodes codex JWT metadata without exposing token data', () => {
  const token = fakeJwt({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct_123',
      chatgpt_plan_type: 'plus',
    },
    'https://api.openai.com/profile': {
      email: 'dev@example.com',
    },
  });

  assert.deepEqual(decodeCodexTokenMetadata(token), {
    accountId: 'acct_123',
    planType: 'plus',
    email: 'dev@example.com',
  });
});

test('parses codex usage windows as percent left', () => {
  const snapshot = parseCodexUsageSnapshot({
    plan_type: 'pro',
    email: 'dev@example.com',
    rate_limit: {
      primary_window: {
        used_percent: 63,
        limit_window_seconds: 5 * 60 * 60,
        reset_at: 2_000,
      },
      secondary_window: {
        used_percent: 22,
        limit_window_seconds: 7 * 24 * 60 * 60,
        reset_at: 3_000,
      },
    },
  });

  assert.equal(snapshot.planType, 'pro');
  assert.equal(snapshot.email, 'dev@example.com');
  assert.equal(snapshot.fiveHour?.remainingPercent, 37);
  assert.equal(snapshot.weekly?.remainingPercent, 78);
});

test('formats usage line with account label and percent left', () => {
  const line = formatUsageLine({
    label: 'work',
    snapshot: {
      planType: 'pro',
      email: '',
      fiveHour: { remainingPercent: 37, resetAt: Date.now() / 1000 + 3600 },
      weekly: { remainingPercent: 78, resetAt: Date.now() / 1000 + 86400 },
    },
    totalSwitches: 3,
  });

  assert.equal(line, 'work | 37% left on 5h');
});

test('picks next round-robin account excluding tried accounts', () => {
  const accounts = ['work', 'personal', 'spare'];
  assert.equal(pickNextRoundRobinAccount(accounts, 'work', new Set()), 'personal');
  assert.equal(pickNextRoundRobinAccount(accounts, 'work', new Set(['personal'])), 'spare');
  assert.equal(pickNextRoundRobinAccount(accounts, 'spare', new Set(['work', 'personal'])), undefined);
});

test('records switch events forever by appending to stats', () => {
  const config = { stats: { switches: [] } };
  recordSwitchEvent(config, {
    from: 'work',
    to: 'spare',
    reason: 'auto-rate-limit',
    message: 'usage limit',
  });

  assert.equal(config.stats.switches.length, 1);
  assert.equal(config.stats.switches[0].from, 'work');
  assert.equal(config.stats.switches[0].to, 'spare');
  assert.equal(config.stats.switches[0].reason, 'auto-rate-limit');
  assert.equal(typeof config.stats.switches[0].at, 'number');
});

test('normalizes missing config with auto-switch enabled by default', () => {
  const config = normalizeConfig(undefined);
  assert.equal(config.version, 1);
  assert.equal(config.autoSwitch, true);
  assert.deepEqual(config.accounts, {});
  assert.deepEqual(config.stats.switches, []);
});

test('saves account under custom observability label without changing token shape', () => {
  const config = emptyConfig();
  const auth = { type: 'oauth', access: 'access-token', refresh: 'refresh-token', expires: 123 };
  saveAccount(config, 'work', auth, 1000);

  assert.equal(config.accounts.work.label, 'work');
  assert.deepEqual(config.accounts.work.auth, auth);
  assert.equal(config.accounts.work.createdAt, 1000);
});

test('switches active account and records manual switch when active changes', () => {
  const config = emptyConfig();
  saveAccount(config, 'work', { type: 'oauth', access: 'a' }, 1000);
  saveAccount(config, 'spare', { type: 'oauth', access: 'b' }, 1000);
  config.active = 'work';

  const result = switchAccount(config, 'spare', 2000, 'manual');

  assert.equal(result.ok, true);
  assert.equal(result.auth.access, 'b');
  assert.equal(config.active, 'spare');
  assert.equal(config.stats.switches.length, 1);
  assert.equal(config.stats.switches[0].reason, 'manual');
});

test('switch account reports missing account without mutating active account', () => {
  const config = emptyConfig();
  config.active = 'work';

  const result = switchAccount(config, 'missing', 2000, 'manual');

  assert.deepEqual(result, { ok: false, reason: 'missing-account' });
  assert.equal(config.active, 'work');
});

test('records rate limit events forever and clearStats preserves accounts', () => {
  const config = emptyConfig();
  saveAccount(config, 'work', { type: 'oauth', access: 'a' }, 1000);
  recordRateLimitEvent(config, { account: 'work', message: 'usage limit', promptHash: 'p1' });
  recordSwitchEvent(config, { from: 'work', to: 'spare', reason: 'auto-rate-limit' });

  assert.equal(config.stats.rateLimitEvents.length, 1);
  assert.equal(config.stats.switches.length, 1);

  clearStats(config);

  assert.equal(config.accounts.work.auth.access, 'a');
  assert.deepEqual(config.stats.rateLimitEvents, []);
  assert.deepEqual(config.stats.switches, []);
});

test('display account falls back to current unsaved Codex auth when no saved active account exists', () => {
  const config = emptyConfig();
  const currentAuth = { type: 'oauth', access: 'current-token' };

  assert.deepEqual(getDisplayAccount(config, currentAuth), {
    label: 'current',
    auth: currentAuth,
    saved: false,
  });
});

test('display account prefers saved active account over current auth', () => {
  const config = emptyConfig();
  saveAccount(config, 'work', { type: 'oauth', access: 'saved-token' }, 1000);
  config.active = 'work';

  assert.deepEqual(getDisplayAccount(config, { type: 'oauth', access: 'current-token' }), {
    label: 'work',
    auth: { type: 'oauth', access: 'saved-token' },
    saved: true,
  });
});

test('matches saved accounts by codex token email before shared account id', () => {
  const config = emptyConfig();
  saveAccount(config, 'ai0', { type: 'oauth', access: fakeJwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'shared-team' },
    'https://api.openai.com/profile': { email: 'ai0@example.com' },
  }) }, 1000);
  saveAccount(config, 'ai1', { type: 'oauth', access: fakeJwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'shared-team' },
    'https://api.openai.com/profile': { email: 'ai1@example.com' },
  }) }, 1000);

  const label = findAccountLabelForAuth(config, { type: 'oauth', access: fakeJwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'shared-team' },
    'https://api.openai.com/profile': { email: 'ai1@example.com' },
  }) });

  assert.equal(label, 'ai1');
});

test('chooses stable email-derived label for newly logged-in codex auth', () => {
  const config = emptyConfig();
  const auth = { type: 'oauth', access: fakeJwt({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' },
    'https://api.openai.com/profile': { email: 'Codex.User+test@example.com' },
  }) };

  assert.equal(chooseAccountLabelForAuth(config, auth), 'codex.user-test');
});
