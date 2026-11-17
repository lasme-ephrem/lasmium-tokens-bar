const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSeed } = require('../lib/seed.cjs');
const { sanitizeStateForExport } = require('../lib/privacy-export.cjs');

function fixtureState() {
  const state = createSeed();
  const openai = state.providers.find(provider => provider.id === 'openai');
  openai.accountSession = { kind: 'openai-codex', identity: 'sha256-email', userId: 12345 };
  openai.claudeSync = { nextAttemptAt: '2026-11-03T21:00:00.000Z', errorCode: null };
  openai.manualResets = { 'Codex et Work · Semaine': { date: '2026-11-10', time: '09:30', at: '2026-11-10T08:30:00.000Z' } };
  openai.snapshot = { source: 'api', updatedAt: '2026-11-03T20:00:00.000Z', balances: [], quotaRemaining: 42, identity: 'nested-identity' };
  const ollama = state.providers.find(provider => provider.id === 'ollama');
  ollama.accountSession = { kind: 'ollama-credits', userId: 7, workspaceId: 8, email: 'person@example.test' };
  state.apiCooldowns = { 'openrouter:abc': 996, 'deepseek:def': 997 };
  state.strategy = { enabled: true, contributor: false, inputTokens: 10000, outputTokens: 2000, cachePercent: 0, subscriptionModels: {}, disabledRoutes: [] };
  state.history = [
    { id: 'entry-1', providerId: 'openai', accountSession: { kind: 'openai-codex', identity: 'x' }, quotaRemaining: 42 },
    { id: 'entry-2', providerId: 'openrouter', balances: [{ currency: 'USD', remaining: 10 }] },
  ];
  return state;
}

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) { for (const entry of value) collectKeys(entry, keys); return keys; }
  if (!value || typeof value !== 'object') return keys;
  for (const [key, entry] of Object.entries(value)) { keys.push(key); collectKeys(entry, keys); }
  return keys;
}

test('privacy export exposes the documented structure without sessions, identities or cooldowns', () => {
  const state = fixtureState();
  const before = structuredClone(state);
  const exported = sanitizeStateForExport(state, { version: '0.3.0', app: 'Lasmium TOKENS-HUB', exportedAt: '2026-11-03T20:30:00.000Z' });

  assert.deepEqual(Object.keys(exported).sort(), ['app', 'exportedAt', 'history', 'inventory', 'manualResets', 'settings', 'version']);
  assert.equal(Object.hasOwn(exported, 'strategy'), false, 'le moteur d’ordre de consommation retiré n’est plus exporté');
  assert.equal(exported.app, 'Lasmium TOKENS-HUB');
  assert.equal(exported.version, '0.3.0');
  assert.equal(exported.exportedAt, '2026-11-03T20:30:00.000Z');
  assert.equal(exported.inventory.length, state.providers.length);
  assert.deepEqual(exported.history.map(entry => entry.id), ['entry-1', 'entry-2']);
  assert.equal(exported.history[0].quotaRemaining, 42);

  const keys = collectKeys(exported);
  for (const forbidden of ['accountSession', 'claudeSync', 'apiCooldowns', 'identity', 'email', 'emailHash', 'userId', 'workspaceId']) {
    assert.equal(keys.includes(forbidden), false, `clé interdite exportée : ${forbidden}`);
  }
  assert.equal(JSON.stringify(exported).includes('sha256-email'), false);
  assert.equal(JSON.stringify(exported).includes('person@example.test'), false);

  // Les compléments de date sont conservés, mais dans la section dédiée.
  assert.deepEqual(Object.keys(exported.manualResets), ['openai']);
  assert.equal(exported.inventory.find(provider => provider.id === 'openai').manualResets, undefined);
  assert.equal(exported.manualResets.openai['Codex et Work · Semaine'].date, '2026-11-10');

  // L'état source n'est jamais modifié par l'export.
  assert.deepEqual(state, before);
});

test('privacy export keeps inventory fields and settings and tolerates legacy states', () => {
  const state = fixtureState();
  const exported = sanitizeStateForExport(state);
  const openai = exported.inventory.find(provider => provider.id === 'openai');
  assert.equal(openai.name, 'OpenAI GPT');
  assert.equal(openai.plan, '');
  assert.equal(openai.snapshot.quotaRemaining, 42);
  assert.deepEqual(exported.settings, state.settings);
  // Un ancien inventaire peut encore porter `strategy` : il n'est pas exporté.
  assert.equal(Object.hasOwn(exported, 'strategy'), false);
  assert.equal(exported.app, 'Lasmium TOKENS-HUB');
  assert.match(exported.exportedAt, /^\d{4}-\d{2}-\d{2}T/);

  const legacy = createSeed();
  delete legacy.settings;
  delete legacy.apiCooldowns;
  const minimal = sanitizeStateForExport(legacy, { version: null });
  assert.equal(minimal.settings, null);
  assert.equal(Object.hasOwn(minimal, 'strategy'), false);
  assert.deepEqual(minimal.manualResets, {});
  assert.deepEqual(minimal.history, []);
  assert.equal(minimal.version, null);

  assert.throws(() => sanitizeStateForExport(null), /État exportable invalide/);
  assert.throws(() => sanitizeStateForExport({ settings: {} }), /État exportable invalide/);
});
