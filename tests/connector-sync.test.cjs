'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createConnectorSync, assumeOllamaFree } = require('../lib/connector-sync.cjs');
const { breakerOpen, assertSnapshot, healthSuccess, healthFailure, strategyFor } = require('../lib/connector-contract.cjs');

function makeProvider(id, extra = {}) {
  return { id, type: 'api', accountSession: null, snapshot: null, error: null, subscriptionStatus: 'active', lastAttempt: null, ...extra };
}

// `contract: true` branche record / markHealthFailure sur le contrat réel
// (validation du relevé, santé, stratégie), comme main.cjs ; sinon des doubles
// minimaux suffisent et `calls` trace l'ordre des effets.
function harness(overrides = {}, { providers, contract = false } = {}) {
  const p = makeProvider('openrouter');
  const list = providers || [p];
  const state = { providers: list, connectorHealth: {}, settings: {} };
  const calls = [];
  const busy = overrides.busy || new Map();
  const disconnecting = overrides.disconnecting || new Set();
  const record = contract
    ? (provider, snapshot) => {
      assertSnapshot(provider.id, snapshot);
      provider.snapshot = snapshot;
      provider.error = null;
      state.connectorHealth[provider.id] = healthSuccess(state.connectorHealth[provider.id], { providerId: provider.id, strategy: strategyFor(provider), snapshot });
      calls.push('record');
    }
    : (provider, snapshot) => { provider.snapshot = snapshot; calls.push('record'); };
  const markHealthFailure = contract
    ? (provider, error) => {
      state.connectorHealth[provider.id] = healthFailure(state.connectorHealth[provider.id], { providerId: provider.id, strategy: strategyFor(provider), error });
    }
    : (provider, error) => { provider.error = error.message; };
  const sync = createConnectorSync({
    getState: () => state,
    provider: id => { const found = list.find(item => item.id === id); if (!found) throw new Error('Service inconnu.'); return found; },
    isTracked: () => true,
    isConnected: () => true,
    publicState: () => state,
    broadcast: () => {},
    persist: async () => { calls.push('persist'); },
    notify: () => { calls.push('notify'); },
    record,
    markHealthFailure,
    safeStorage: { decryptString: () => 'test-key' },
    credentials: { get: () => Buffer.from('x').toString('base64') },
    fetchUsage: async (id, key, fetchImpl, options) => { calls.push(['fetch', id, options.endpoint]); return { updatedAt: new Date().toISOString(), balances: [] }; },
    apiFetch: async () => {},
    cooldowns: { prune: () => {} },
    endpointFor: id => `https://pack.example/${id}`,
    fetchOllamaCredits: async (fetchImpl, at, options) => { calls.push(['fetchOllamaCredits', options]); return { updatedAt: new Date().toISOString() }; },
    ollamaSession: () => ({ fetch: async () => {} }),
    openAiAccount: { read: async identity => { calls.push(['openai', identity]); } },
    verifyAntigravity: async () => { calls.push(['antigravity']); },
    verifyClaude: async () => { calls.push(['claude']); },
    subscriptionAccounts: { read: async (id, options) => { calls.push(['browser', id, options]); } },
    isBrowserAccount: () => false,
    breakerOpen,
    ...overrides,
    busy,
    disconnecting,
  });
  return { sync, state, p, calls, busy, disconnecting, providers: list };
}

test('la synchronisation API utilise le pack et persiste une seule fois', async () => {
  const { sync, state, calls } = harness();
  await sync.syncOne('openrouter');
  assert.deepEqual(calls.filter(item => Array.isArray(item)), [['fetch', 'openrouter', 'https://pack.example/openrouter']]);
  assert.equal(calls.filter(item => item === 'record').length, 1);
  assert.equal(calls.filter(item => item === 'persist').length, 1);
  assert.equal(state.providers[0].lastAttempt !== null, true);
});

test('le disjoncteur bloque l’automatique mais jamais l’action manuelle', async () => {
  let fetchCalls = 0;
  const environment = harness({
    fetchUsage: async () => { fetchCalls++; return { updatedAt: new Date().toISOString() }; },
  });
  environment.state.connectorHealth.openrouter = { state: 'down', error: { code: 'NETWORK', retryAt: new Date(Date.now() + 60000).toISOString() } };
  await environment.sync.syncOne('openrouter', { force: false });
  assert.equal(fetchCalls, 0);
  await environment.sync.syncOne('openrouter', { force: true });
  assert.equal(fetchCalls, 1);
});

test('assumeOllamaFree conserve le Free vérifié sans inventer un forfait payant', () => {
  assert.equal(assumeOllamaFree({ subscriptionStatus: 'expired' }), true);
  assert.equal(assumeOllamaFree({ snapshot: { planTier: 'free' } }), true);
  assert.equal(assumeOllamaFree({ snapshot: { planTier: 'paid' } }), false);
});

test('syncOne refuse une déconnexion en cours, un service en pause ou expiré et un service non connecté', async () => {
  const h = harness();
  h.disconnecting.add('openrouter');
  await assert.rejects(h.sync.syncOne('openrouter'), /Déconnexion en cours/);
  h.disconnecting.delete('openrouter');
  await assert.rejects(h.sync.syncOne('inconnu'), /Service inconnu/);
  const paused = harness({ isTracked: provider => provider.subscriptionStatus === 'active' });
  paused.p.subscriptionStatus = 'paused';
  await assert.rejects(paused.sync.syncOne('openrouter'), /Ce service est en pause/);
  paused.p.subscriptionStatus = 'expired';
  await assert.rejects(paused.sync.syncOne('openrouter'), /Cet abonnement est expiré/);
  const offline = harness({ isConnected: () => false });
  await assert.rejects(offline.sync.syncOne('openrouter'), /Connecte ce service dans Connexions/);
  for (const environment of [h, paused, offline]) {
    assert.equal(environment.calls.length, 0, 'aucune lecture ni persistance tentée');
    assert.equal(environment.busy.size, 0);
    assert.equal(environment.p.lastAttempt, null);
  }
});

test('syncOne attend une synchronisation déjà en cours sans relire le fournisseur', async () => {
  let release;
  const h = harness();
  h.busy.set('openrouter', new Promise(resolve => { release = resolve; }));
  let settled = false;
  const waiting = h.sync.syncOne('openrouter').then(result => { settled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'l’appel attend la fin du travail en cours');
  release();
  assert.equal(await waiting, h.state);
  assert.equal(h.calls.length, 0);
});

test('chaque branche compte délègue à son lecteur, puis persiste et notifie une seule fois', async () => {
  const providers = [
    makeProvider('ollama', { accountSession: { kind: 'ollama-credits' } }),
    makeProvider('openai', { accountSession: { kind: 'openai-codex', identity: 'compte-1' } }),
    makeProvider('antigravity', { accountSession: { kind: 'antigravity-local' } }),
    makeProvider('claude', { accountSession: { kind: 'claude-desktop-local' } }),
    makeProvider('grok', { accountSession: { kind: 'subscription-browser' } }),
  ];
  const h = harness({ isBrowserAccount: id => id === 'grok' }, { providers });
  for (const provider of providers) assert.equal(await h.sync.syncOne(provider.id), h.state);
  assert.deepEqual(h.calls.filter(Array.isArray), [
    ['fetchOllamaCredits', { assumeFree: false }],
    ['openai', 'compte-1'],
    ['antigravity'],
    ['claude'],
    ['browser', 'grok', { background: true }],
  ]);
  assert.equal(h.calls.filter(call => call === 'record').length, 1, 'Ollama enregistre ici ; les autres lecteurs enregistrent eux-mêmes');
  assert.deepEqual(h.calls.filter(call => call === 'persist' || call === 'notify'), Array(5).fill(['persist', 'notify']).flat());
  assert.ok(providers.every(provider => provider.lastAttempt !== null && provider.error === null));
  assert.equal(h.busy.size, 0);
  // Ollama Free vérifié ou abonnement expiré : la lecture suivante assume le Free.
  const ollama = providers[0];
  ollama.snapshot = { planTier: 'free' };
  await h.sync.syncOne('ollama');
  ollama.snapshot = null;
  ollama.subscriptionStatus = 'expired';
  await h.sync.syncOne('ollama');
  const ollamaReads = h.calls.filter(call => Array.isArray(call) && call[0] === 'fetchOllamaCredits').map(call => call[1]);
  assert.deepEqual(ollamaReads, [{ assumeFree: false }, { assumeFree: true }, { assumeFree: true }]);
});

test('une erreur conserve le dernier relevé, marque la santé et n’efface que les sessions explicitement invalides', async () => {
  const cases = [
    ['ollama', 'OLLAMA_SIGNIN', true], ['ollama', 'OLLAMA_TRANSIENT', false], ['ollama', 'OLLAMA_RATE_LIMIT', false],
    ['openai', 'AUTH_REQUIRED', false], ['antigravity', 'ANTIGRAVITY_NOT_RUNNING', false],
    ['claude', 'auth-rate-limit', false], ['grok', 'ACCOUNT_LOGIN_PENDING', false],
  ];
  for (const [id, code, cleared] of cases) {
    const context = `${id} / ${code}`;
    const previous = { updatedAt: '2026-11-04T09:00:00.000Z', balances: [{ currency: 'USD', remaining: 3 }] };
    const session = { kind: id };
    const providers = [makeProvider(id, { accountSession: session, snapshot: previous })];
    const failure = Object.assign(new Error(`Échec ${code}.`), { code });
    const fail = async () => { throw failure; };
    const health = [];
    const h = harness({
      fetchOllamaCredits: fail, openAiAccount: { read: fail }, verifyAntigravity: fail, verifyClaude: fail,
      subscriptionAccounts: { read: fail }, isBrowserAccount: candidate => candidate === 'grok',
      markHealthFailure: (provider, error) => { health.push([provider.id, error.code]); },
    }, { providers });
    assert.equal(await h.sync.syncOne(id), h.state, context);
    assert.equal(providers[0].error, `Échec ${code}.`, context);
    assert.equal(providers[0].snapshot, previous, context);
    assert.deepEqual(health, [[id, code]], context);
    assert.equal(providers[0].accountSession === undefined, cleared, context);
    assert.deepEqual(h.calls.filter(call => !Array.isArray(call)), ['persist', 'notify'], context);
    assert.equal(h.busy.size, 0, context);
    assert.ok(providers[0].lastAttempt, context);
  }
});

test('une clé indéchiffrable ou absente produit un message actionnable sans appel réseau', async () => {
  let fetched = 0;
  const fetchUsage = async () => { fetched++; return { updatedAt: new Date().toISOString() }; };
  const broken = harness({ safeStorage: { decryptString: () => { throw new Error('DPAPI'); } }, fetchUsage });
  await broken.sync.syncOne('openrouter');
  assert.equal(broken.p.error, 'La clé enregistrée ne peut plus être déchiffrée sur ce compte Windows. Renseigne de nouveau la clé dans Connexions.');
  assert.deepEqual(broken.calls, ['persist', 'notify']);
  const missing = harness({ credentials: { get: () => undefined }, fetchUsage });
  await missing.sync.syncOne('openrouter');
  assert.match(missing.p.error, /Renseigne de nouveau la clé/);
  assert.equal(fetched, 0);
  assert.equal(missing.calls.includes('record'), false);
});

test('un relevé incohérent est classé SCHEMA_DRIFT, conserve le snapshot précédent et ouvre le disjoncteur', async () => {
  const previous = { updatedAt: '2026-11-04T09:00:00.000Z', balances: [{ currency: 'USD', remaining: 3 }] };
  let fetched = 0;
  const h = harness({ fetchUsage: async () => { fetched++; return { updatedAt: new Date().toISOString() }; } }, { contract: true });
  h.p.snapshot = previous;
  await h.sync.syncOne('openrouter');
  assert.equal(h.p.snapshot, previous, 'un relevé illisible ne remplace jamais le dernier relevé sain');
  assert.equal(h.p.error, 'Lecture incohérente (relevé sans donnée exploitable). Le dernier relevé est conservé.');
  let health = h.state.connectorHealth.openrouter;
  assert.equal(health.error.code, 'SCHEMA_DRIFT');
  assert.equal(health.state, 'drift');
  assert.equal(health.strategy, 'api-key');
  assert.equal(health.failures, 1);
  assert.equal(breakerOpen(health), true, 'un drift espace les tentatives');
  await h.sync.syncOne('openrouter', { force: false });
  assert.equal(fetched, 1, 'le disjoncteur bloque l’actualisation automatique');
  await h.sync.syncOne('openrouter', { force: true });
  assert.equal(fetched, 2, 'une action manuelle force la lecture');
  health = h.state.connectorHealth.openrouter;
  assert.equal(health.failures, 2);
  assert.equal(health.strategy, 'api-key');
  assert.equal(h.p.snapshot, previous);
});

test('la stratégie du connecteur est enregistrée dans la santé, en succès comme en échec', async () => {
  let failApi = false;
  let claudeReads = 0;
  const providers = [makeProvider('openrouter'), makeProvider('claude', { accountSession: { kind: 'claude-live-local' } })];
  const h = harness({
    fetchUsage: async () => {
      if (failApi) throw Object.assign(new Error('fetch failed'), { code: 'NETWORK' });
      return { updatedAt: new Date().toISOString(), balances: [{ currency: 'USD', remaining: 8 }] };
    },
    verifyClaude: async () => { claudeReads++; throw Object.assign(new Error('Renouvellement limité.'), { code: 'auth-rate-limit' }); },
  }, { providers, contract: true });
  await h.sync.syncOne('openrouter');
  let api = h.state.connectorHealth.openrouter;
  assert.equal(api.strategy, 'api-key');
  assert.equal(api.state, 'ok');
  assert.equal(api.observedAt, providers[0].snapshot.updatedAt);
  await h.sync.syncOne('claude');
  const claude = h.state.connectorHealth.claude;
  assert.equal(claude.strategy, 'claude-direct');
  assert.equal(claude.state, 'auth');
  assert.equal(claude.error.code, 'AUTH_RATE_LIMITED');
  assert.equal(claude.error.sourceCode, 'auth-rate-limit');
  assert.equal(claude.error.retryAt, null, 'une erreur d’authentification reste immédiatement actionnable');
  assert.equal(breakerOpen(claude), false);
  await h.sync.syncOne('claude', { force: false });
  assert.equal(claudeReads, 2, 'non disjonctée, l’actualisation automatique retente');
  failApi = true;
  await h.sync.syncOne('openrouter');
  api = h.state.connectorHealth.openrouter;
  assert.equal(api.strategy, 'api-key', 'la stratégie d’origine est conservée après l’échec');
  assert.equal(api.state, 'down');
  assert.notEqual(api.lastSuccessAt, null, 'le dernier succès reste daté');
  assert.equal(api.observedAt, providers[0].snapshot.updatedAt);
  assert.equal(breakerOpen(api), true);
});

test('syncAll synchronise seulement les services suivis et connectés, transmet force et absorbe les échecs', async () => {
  const providers = [
    makeProvider('openrouter'),
    makeProvider('deepseek', { subscriptionStatus: 'paused' }),
    makeProvider('runinfra', { connected: false }),
    makeProvider('grok', { accountSession: { kind: 'subscription-browser' } }),
    makeProvider('ollama', { accountSession: { kind: 'ollama-credits' } }),
  ];
  const h = harness({
    isTracked: provider => provider.subscriptionStatus !== 'paused',
    isConnected: provider => provider.connected !== false,
    isBrowserAccount: id => id === 'grok',
  }, { providers });
  h.state.connectorHealth.openrouter = { state: 'down', error: { code: 'NETWORK', retryAt: new Date(Date.now() + 60000).toISOString() } };
  h.disconnecting.add('ollama');
  assert.equal(await h.sync.syncAll(), h.state);
  assert.deepEqual(h.calls.filter(Array.isArray), [['browser', 'grok', { background: true }]], 'disjoncté, en pause, non connecté ou en déconnexion : ignorés');
  h.calls.length = 0;
  h.disconnecting.delete('ollama');
  assert.equal(await h.sync.syncAll({ force: true }), h.state);
  assert.deepEqual(h.calls.filter(Array.isArray).map(call => call[0]), ['fetch', 'browser', 'fetchOllamaCredits']);
  assert.equal(h.busy.size, 0);
  assert.equal(providers[1].lastAttempt, null);
  assert.equal(providers[2].lastAttempt, null);
});

test('endpointFor et isBrowserAccount ont des replis sûrs et la fabrique accepte un appel sans options', async () => {
  const h = harness({ endpointFor: undefined, isBrowserAccount: undefined });
  await h.sync.syncOne('openrouter');
  assert.deepEqual(h.calls.filter(Array.isArray), [['fetch', 'openrouter', undefined]]);
  const bare = createConnectorSync();
  assert.equal(typeof bare.syncOne, 'function');
  assert.equal(typeof bare.syncAll, 'function');
  assert.equal(bare.assumeOllamaFree, assumeOllamaFree);
});
