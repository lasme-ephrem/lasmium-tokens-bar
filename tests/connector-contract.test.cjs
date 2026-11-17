'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ERROR_CODES, normalizeCode, stateForCode, validateSnapshot, assertSnapshot,
  strategyFor, healthSuccess, healthFailure, isStale, publicHealth,
  breakerOpen, strategyChainFor, fallbackStrategyFor,
} = require('../lib/connector-contract.cjs');

const NOW = Date.parse('2026-11-04T02:00:00.000Z');
function snapshot(overrides = {}) {
  return {
    source: 'api',
    connectorVersion: 'test-v1',
    updatedAt: new Date(NOW).toISOString(),
    balances: [{ currency: 'USD', remaining: 12.5 }],
    quotaRemaining: null,
    resetAt: null,
    quotaWindows: [],
    ...overrides,
  };
}

test('un relevé valide passe la validation', () => {
  const valid = snapshot();
  assert.deepEqual(validateSnapshot('openrouter', valid, NOW), { ok: true, issues: [] });
  assert.equal(assertSnapshot('openrouter', valid, NOW), valid);
});

test('les soldes, quotas et dates incohérents sont des dérives de schéma', () => {
  const cases = [
    { balances: [{ currency: 'USD', remaining: NaN }] },
    { balances: [{ currency: 'usd', remaining: 4 }] },
    { balances: [{ currency: 'USD', remaining: 4 }, { currency: 'USD', remaining: 5 }] },
    { quotaRemaining: 101 },
    { quotaRemaining: -1 },
    { quotaWindows: [{ label: 'Semaine', remaining: 140 }] },
    { quotaWindows: [{ label: '', remaining: 20 }] },
    { quotaWindows: [{ label: 'Semaine', remaining: 20, resetAt: 'demain' }] },
    { updatedAt: 'hier' },
    { updatedAt: new Date(NOW + 30 * 60 * 1000).toISOString(), balances: [{ currency: 'USD', remaining: 1 }] },
  ];
  for (const overrides of cases) {
    const result = validateSnapshot('test', snapshot(overrides), NOW);
    assert.equal(result.ok, false, JSON.stringify(overrides));
    assert.throws(() => assertSnapshot('test', snapshot(overrides), NOW), error =>
      error.code === ERROR_CODES.SCHEMA_DRIFT && /dernier relevé est conservé/.test(error.message));
  }
});

test('un relevé vide est refusé, sauf le Free Ollama explicitement sans montant', () => {
  assert.equal(validateSnapshot('test', snapshot({ balances: [], quotaWindows: [] }), NOW).ok, false);
  assert.equal(validateSnapshot('ollama', snapshot({ balances: [], quotaWindows: [], planTier: 'free' }), NOW).ok, true);
});

test('les erreurs connues sont classées sans perdre le code source', () => {
  const mapping = [
    [{ code: 'auth-rate-limit' }, ERROR_CODES.AUTH_RATE_LIMITED],
    [{ code: 'API_RATE_LIMIT' }, ERROR_CODES.RATE_LIMITED],
    [{ code: 'OLLAMA_SIGNIN' }, ERROR_CODES.AUTH_REQUIRED],
    [{ code: 'SCHEMA_DRIFT' }, ERROR_CODES.SCHEMA_DRIFT],
    [{ message: 'Aucun quota retourné par le fournisseur.' }, ERROR_CODES.PARSER_EMPTY],
    [{ message: 'fetch failed' }, ERROR_CODES.NETWORK],
    [{ message: 'Le jeton est expiré.' }, ERROR_CODES.AUTH_REQUIRED],
    [{ message: 'Format inattendu.' }, ERROR_CODES.SCHEMA_DRIFT],
    [{ message: 'Panne mystérieuse.' }, ERROR_CODES.UNKNOWN],
  ];
  for (const [error, expected] of mapping) {
    assert.equal(normalizeCode(error), expected, JSON.stringify(error));
  }
  assert.equal(stateForCode(ERROR_CODES.SCHEMA_DRIFT), 'drift');
  assert.equal(stateForCode(ERROR_CODES.AUTH_RATE_LIMITED), 'auth');
  assert.equal(stateForCode(ERROR_CODES.RATE_LIMITED), 'rate');
});

test('la santé conserve le dernier succès lors d’un échec', () => {
  const success = healthSuccess(null, {
    providerId: 'claude', strategy: 'claude-direct', snapshot: snapshot(), now: NOW,
  });
  assert.equal(success.state, 'ok');
  assert.equal(success.lastSuccessAt, new Date(NOW).toISOString());
  const failure = healthFailure(success, {
    providerId: 'claude',
    error: Object.assign(new Error('Session expirée.'), { code: 'auth-invalid' }),
    now: NOW + 60000,
  });
  assert.equal(failure.state, 'auth');
  assert.equal(failure.error.code, ERROR_CODES.AUTH_REQUIRED);
  assert.equal(failure.error.sourceCode, 'auth-invalid');
  assert.equal(failure.lastSuccessAt, success.lastSuccessAt);
  assert.equal(failure.strategy, 'claude-direct');
  assert.equal(failure.lastFailureAt, new Date(NOW + 60000).toISOString());
});

test('la fraîcheur est calculée sur la date du relevé, pas sur la tentative', () => {
  const old = snapshot({ updatedAt: new Date(NOW - 11 * 60 * 1000).toISOString() });
  const health = healthSuccess(null, { providerId: 'claude', snapshot: old, now: NOW });
  assert.equal(isStale(health, old, NOW), true);
  assert.equal(publicHealth(health, old, NOW).state, 'stale');
  const fresh = snapshot({ updatedAt: new Date(NOW - 60 * 1000).toISOString() });
  assert.equal(publicHealth(healthSuccess(null, { providerId: 'claude', snapshot: fresh, now: NOW }), fresh, NOW).state, 'ok');
});

test('la stratégie reflète la session réellement utilisée', () => {
  assert.equal(strategyFor({ id: 'claude', accountSession: { kind: 'claude-live-local' } }), 'claude-direct');
  assert.equal(strategyFor({ id: 'claude', accountSession: { kind: 'claude-desktop-local' } }), 'claude-desktop');
  assert.equal(strategyFor({ id: 'openai' }, {}), 'openai-codex');
  assert.equal(strategyFor({ id: 'ollama' }, {}), 'ollama-browser');
  assert.equal(strategyFor({ id: 'openrouter' }, { openrouter: { mode: 'api' } }), 'api-key');
  assert.equal(strategyFor({ id: 'zai' }, { zai: { mode: 'account', browserAccount: true } }), 'browser-session');
});

test('le disjoncteur espace les erreurs transitoires mais jamais l’authentification', () => {
  const network = Object.assign(new Error('fetch failed'), { code: 'network' });
  const first = healthFailure(null, { providerId: 'x', error: network, now: NOW });
  assert.equal(first.failures, 1);
  assert.equal(breakerOpen(first, NOW + 1000), true);
  assert.equal(breakerOpen(first, NOW + 31 * 1000), false);
  const second = healthFailure(first, { providerId: 'x', error: network, now: NOW + 31000 });
  assert.equal(second.failures, 2);
  assert.ok(Date.parse(second.error.retryAt) > Date.parse(first.error.retryAt));
  const reset = healthSuccess(second, { providerId: 'x', snapshot: snapshot(), now: NOW + 60000 });
  assert.equal(reset.failures, 0);
  assert.equal(breakerOpen(reset, NOW + 61000), false);

  const drift = healthFailure(null, { providerId: 'x', error: Object.assign(new Error('Format inattendu.'), { code: 'SCHEMA_DRIFT' }), now: NOW });
  assert.equal(breakerOpen(drift, NOW + 60 * 1000), true);
  assert.equal(breakerOpen(drift, NOW + 16 * 60 * 1000), false);

  const auth = healthFailure(null, { providerId: 'x', error: Object.assign(new Error('Session expirée.'), { code: 'auth-invalid' }), now: NOW });
  assert.equal(auth.error.retryAt, null);
  assert.equal(breakerOpen(auth, NOW + 1000), false);
});

test('les chaînes de stratégies déclarent le repli sans l’inventer', () => {
  assert.deepEqual(strategyChainFor({ id: 'claude' }, {}), ['claude-direct', 'claude-desktop']);
  assert.deepEqual(strategyChainFor({ id: 'openai' }, {}), ['openai-codex']);
  assert.equal(fallbackStrategyFor({ id: 'claude' }, 'claude-direct', {}), 'claude-desktop');
  assert.equal(fallbackStrategyFor({ id: 'claude' }, 'claude-desktop', {}), null);
  assert.deepEqual(strategyChainFor({ id: 'zai' }, { zai: { browserAccount: true } }), ['browser-session']);
  assert.deepEqual(strategyChainFor({ id: 'openrouter' }, { openrouter: { mode: 'api' } }), ['api-key']);
});
