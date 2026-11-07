'use strict';
// Tests unitaires de la fabrique createProviderFlows : parcours Claude,
// Antigravity, OrcaRouter et Ollama exercés sans Electron, sans réseau et sans
// horloge réelle. Chaque service injecté par main.cjs est remplacé par un double
// observable ; les timers (setInterval) et la date sont simulés par node:test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { createProviderFlows, chooseOrcaAccountRef, CLAUDE_CONNECTED_MESSAGE } = require('../lib/provider-flows.cjs');
const { ORCA_ORIGIN, validateAccountRef } = require('../lib/orca-account.cjs');
const { OLLAMA_ORIGIN, SETTINGS_URL } = require('../lib/ollama-account.cjs');
const { isTracked } = require('../lib/domain.cjs');
const { assumeOllamaFree } = require('../lib/connector-sync.cjs');
const { assertSnapshot, healthSuccess, healthFailure, strategyFor } = require('../lib/connector-contract.cjs');

const T0 = Date.parse('2026-11-04T10:00:00.000Z');
const MINUTE = 60 * 1000;
const DATA_DIR = path.join(os.tmpdir(), 'lasmium-provider-flows-tests');
// Même liste que main.cjs : les deux fenêtres internes n'acceptent que ces origines.
const ACCOUNT_ORIGINS = [...new Set([OLLAMA_ORIGIN, ORCA_ORIGIN, ORCA_ORIGIN.replace('://www.', '://'), 'https://accounts.google.com'])];

// --- Outils ------------------------------------------------------------------

// Horloge simulée : setInterval/clearInterval et Date (Date.now, new Date()).
// Les rappels des timers sont asynchrones : `flush` vide les microtâches en
// attente après chaque avancée.
function clock(t, now = T0) {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now });
  const flush = async () => { for (let round = 0; round < 10; round++) await new Promise(resolve => setImmediate(resolve)); };
  return {
    flush,
    tick: ms => t.mock.timers.tick(ms),
    async advance(ms) { t.mock.timers.tick(ms); await flush(); },
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function coded(code, message = code) { return Object.assign(new Error(message), { code }); }

function snapshotAt(ms, extra = {}) {
  return { updatedAt: new Date(ms).toISOString(), connectorVersion: 'test-v1', balances: [{ currency: 'USD', remaining: 12 }], ...extra };
}
function claudeSnapshotAt(ms, extra = {}) {
  return {
    updatedAt: new Date(ms).toISOString(), connectorVersion: 'claude-live-v1', quotaRemaining: 80,
    quotaWindows: [{ label: '5 heures', remaining: 80, resetAt: null }, { label: 'Semaine', remaining: 91, resetAt: null }],
    ...extra,
  };
}
function antigravitySnapshotAt(ms, extra = {}) {
  return {
    updatedAt: new Date(ms).toISOString(), connectorVersion: 'antigravity-local-v1', quotaRemaining: 70,
    quotaWindows: [{ label: 'Gemini · Semaine', remaining: 70, resetAt: null }, { label: 'Claude/GPT · Semaine', remaining: 85, resetAt: null }],
    ...extra,
  };
}
function ollamaSnapshotAt(ms, extra = {}) {
  return {
    updatedAt: new Date(ms).toISOString(), connectorVersion: 'ollama-monthly-credits-v1', planTier: 'pro',
    balances: [{ currency: 'USD', remaining: 47.5, total: 60, used: 12.5 }], quotaRemaining: 79, usageCredits: null,
    ...extra,
  };
}

// --- Doubles Electron ----------------------------------------------------------

// BrowserWindow simulé : seules les méthodes utilisées par provider-flows sont
// fournies. `close()` émet « closed » immédiatement, comme une fenêtre détruite.
function windowFactory(windows, defaults) {
  return class FakeBrowserWindow {
    constructor(options = {}) {
      this.options = options;
      this.destroyed = false;
      this.listeners = new Map();
      this.loaded = [];
      this.shown = 0;
      this.focused = 0;
      this.loadError = defaults.loadError || null;
      const contents = { url: 'about:blank', scriptResult: null, scriptError: null, executions: 0 };
      contents.getURL = () => contents.url;
      contents.executeJavaScript = async () => {
        contents.executions++;
        if (contents.scriptError) throw contents.scriptError;
        return contents.scriptResult;
      };
      this.webContents = contents;
      windows.push(this);
    }
    on(event, listener) { this.listeners.set(event, [...(this.listeners.get(event) || []), listener]); }
    emit(event) { for (const listener of this.listeners.get(event) || []) listener(); }
    async loadURL(url) {
      this.loaded.push(url);
      if (this.loadError) throw this.loadError;
      this.webContents.url = url;
    }
    isDestroyed() { return this.destroyed; }
    show() { this.shown++; }
    focus() { this.focused++; }
    close() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('closed');
    }
  };
}

// Session Electron partitionnée : gestionnaires de permission, écouteurs,
// cookies et fetch (interdit : aucun réseau dans ces tests).
function sessionDouble(name) {
  const stored = [];
  const session = {
    name,
    lasmiumConfigured: undefined,
    listeners: new Map(),
    permissionRequestHandler: null,
    permissionCheckHandler: null,
    flushes: 0,
    cleared: 0,
    fetchCalls: 0,
    setPermissionRequestHandler(handler) { session.permissionRequestHandler = handler; },
    setPermissionCheckHandler(handler) { session.permissionCheckHandler = handler; },
    on(event, listener) { session.listeners.set(event, [...(session.listeners.get(event) || []), listener]); },
    async fetch() { session.fetchCalls++; throw new Error('Aucun accès réseau dans les tests.'); },
    cookies: {
      stored,
      async set(cookie) { stored.push(cookie); },
      async get() { return [...stored]; },
      async flushStore() { session.flushes++; },
    },
    async clearStorageData() { session.cleared++; stored.length = 0; },
  };
  return session;
}

// Navigateur système Ollama (lib/account-browser.cjs → openNativeOllamaLogin) :
// phase « login » tant que Chrome/Edge est ouvert, « verifying » une fois fermé,
// « closed » après la lecture des cookies ou une fermeture explicite.
function ollamaBrowserDouble({ cookies = [], phase = 'login' } = {}) {
  const browser = {
    current: phase,
    cookies,
    closed: 0,
    reads: 0,
    phaseCalls: 0,
    phase: () => { browser.phaseCalls++; return browser.current; },
    async readOllamaCookies() {
      browser.reads++;
      if (browser.current === 'login') throw coded('OLLAMA_LOGIN_PENDING', 'Termine la connexion Ollama dans Chrome ou Edge, puis ferme cette fenêtre. La vérification démarrera ensuite automatiquement.');
      if (browser.current === 'closed') throw new Error('La connexion a été fermée. Rouvre le compte.');
      browser.current = 'closed';
      return browser.cookies;
    },
    async close() { browser.closed++; browser.current = 'closed'; },
  };
  return browser;
}

// Navigateur système OrcaRouter (lib/account-browser.cjs → openNativeOrcaLogin).
function orcaBrowserDouble({ session = null, phase = 'login', readError = null } = {}) {
  const browser = {
    current: phase,
    session,
    closed: 0,
    reads: 0,
    phase: () => browser.current,
    async readOrcaSession() {
      browser.reads++;
      if (browser.current === 'login') throw coded('ORCA_LOGIN_PENDING', 'Termine la connexion OrcaRouter dans Chrome ou Edge, puis ferme cette fenêtre. Le portefeuille sera récupéré automatiquement.');
      if (readError) throw readError;
      browser.current = 'closed';
      return browser.session;
    },
    async close() { browser.closed++; browser.current = 'closed'; },
  };
  return browser;
}

// --- Harnais -------------------------------------------------------------------

// Reproduit l'injection faite par main.cjs : record / markHealth* s'appuient
// sur le contrat réel (validation, santé, stratégie), les lecteurs sont des
// doubles reconfigurables via `services`, et `calls` trace l'ordre des effets.
function harness() {
  const providers = ['claude', 'antigravity', 'orcarouter', 'ollama'].map(id => ({
    id, name: id, active: true, subscriptionStatus: 'active', accountSession: null, snapshot: null, error: null, lastAttempt: null,
  }));
  const state = { providers, connectorHealth: {}, settings: { autoRefresh: true }, history: [] };
  const calls = [];
  const windows = [];
  const windowDefaults = {};
  const BrowserWindow = windowFactory(windows, windowDefaults);
  const mainWindow = { id: 'main' };
  const sessions = { orca: sessionDouble('orca'), ollama: sessionDouble('ollama') };
  const busy = new Map();
  const disconnecting = new Set();
  const flags = { quitting: false, stateless: false };
  const services = {
    claudeRead: async () => claudeSnapshotAt(Date.now()),
    cliSubscription: async () => identity(),
    cliLogin: async () => identity(),
    antigravityRead: async () => antigravitySnapshotAt(Date.now()),
    fetchWallet: async () => snapshotAt(Date.now(), { connectorVersion: 'orca-wallet-v1' }),
    fetchOllamaCredits: async () => ollamaSnapshotAt(Date.now()),
    openOllamaBrowser: async () => ollamaBrowserDouble(),
    // Par défaut, ni Chrome ni Edge : la fenêtre intégrée OrcaRouter sert de recours.
    openOrcaBrowser: async () => { throw new Error('Chrome ou Edge est nécessaire.'); },
    syncOne: async () => {},
  };
  // Comme lib/claude-live-usage.cjs : un succès programme la prochaine lecture
  // (une minute), un échec retient son code et un cooldown (cinq minutes ici).
  const claudeReader = {
    reads: 0,
    credentialsChanges: 0,
    status: { nextAttemptAt: null, errorCode: null },
    info: () => ({ ...claudeReader.status }),
    async read() {
      claudeReader.reads++;
      try {
        const snapshot = await services.claudeRead();
        claudeReader.status = { nextAttemptAt: new Date(Date.now() + MINUTE).toISOString(), errorCode: null };
        return snapshot;
      } catch (error) {
        claudeReader.status = { nextAttemptAt: new Date(Date.now() + 5 * MINUTE).toISOString(), errorCode: error.code || null };
        throw error;
      }
    },
    // Comme le vrai lecteur : un fichier de jeton réécrit lève un cooldown d'authentification.
    credentialsChanged() {
      claudeReader.credentialsChanges++;
      if (claudeReader.status.errorCode?.startsWith('auth-')) claudeReader.status = { nextAttemptAt: null, errorCode: null };
    },
  };
  function record(p, snapshot) {
    assertSnapshot(p.id, snapshot);
    p.snapshot = snapshot;
    p.error = null;
    state.connectorHealth[p.id] = healthSuccess(state.connectorHealth[p.id], { providerId: p.id, strategy: strategyFor(p), snapshot });
    state.history.unshift({ providerId: p.id, ...snapshot });
    calls.push(['record', p.id, snapshot.updatedAt]);
  }
  function markHealthSuccess(p, snapshot) {
    state.connectorHealth[p.id] = healthSuccess(state.connectorHealth[p.id], { providerId: p.id, strategy: strategyFor(p), snapshot });
    calls.push(['markHealthSuccess', p.id]);
  }
  function markHealthFailure(p, error) {
    state.connectorHealth[p.id] = healthFailure(state.connectorHealth[p.id], { providerId: p.id, strategy: strategyFor(p), error });
    calls.push(['markHealthFailure', p.id, error.code || null]);
  }
  let flows;
  flows = createProviderFlows({
    BrowserWindow,
    secureAccountWindow: (window, origins) => { calls.push(['secure', window, origins]); },
    ACCOUNT_ORIGINS,
    ORCA_ORIGIN,
    OLLAMA_ORIGIN,
    SETTINGS_URL,
    dataDir: DATA_DIR,
    getState: () => (flags.stateless ? undefined : state),
    getMainWindow: () => mainWindow,
    provider: id => { const p = providers.find(item => item.id === id); if (!p) throw new Error('Service inconnu.'); return p; },
    isTracked,
    isConnected: p => Boolean(p.accountSession),
    disconnecting,
    busy,
    isQuitting: () => flags.quitting,
    broadcast: () => { calls.push('broadcast'); },
    persist: async () => { calls.push('persist'); },
    publicState: () => ({ providers: providers.map(p => ({ ...p })), connections: flows.info() }),
    record,
    markHealthSuccess,
    markHealthFailure,
    showMain: () => { calls.push('showMain'); },
    syncOne: (id, options) => { calls.push(['syncOne', id, options]); return services.syncOne(id, options); },
    claudeReader,
    claudeCli: {
      subscription: () => { calls.push(['cli-status']); return services.cliSubscription(); },
      login: () => { calls.push(['cli-login']); return services.cliLogin(); },
    },
    antigravityTransport: { fetchAntigravityQuota: () => { calls.push(['antigravity']); return services.antigravityRead(); } },
    fetchWallet: (ref, fetchImpl) => { calls.push(['fetchWallet', ref, fetchImpl]); return services.fetchWallet(ref, fetchImpl); },
    validateAccountRef,
    orcaSession: () => sessions.orca,
    fetchOllamaCredits: (fetchImpl, at, options) => { calls.push(['fetchOllamaCredits', at, options]); return services.fetchOllamaCredits(fetchImpl, at, options); },
    ollamaSession: () => sessions.ollama,
    openOllamaBrowser: dir => { calls.push(['openOllamaBrowser', dir]); return services.openOllamaBrowser(dir); },
    openOrcaBrowser: dir => { calls.push(['openOrcaBrowser', dir]); return services.openOrcaBrowser(dir); },
    assumeOllamaFree,
  });
  const p = Object.fromEntries(providers.map(item => [item.id, item]));
  const labels = () => calls.map(call => (Array.isArray(call) ? call[0] : call));
  const first = label => labels().indexOf(label);
  const count = label => labels().filter(item => item === label).length;
  const find = label => calls.find(call => Array.isArray(call) && call[0] === label);
  const all = label => calls.filter(call => Array.isArray(call) && call[0] === label);
  return { flows, state, p, calls, labels, first, count, find, all, windows, windowDefaults, sessions, busy, disconnecting, flags, services, claudeReader, mainWindow };
}

const idle = { status: 'idle', message: '' };
// Identité renvoyée par `claude auth status` pour un abonnement Max.
function identity() { return { loggedIn: true, method: 'claude.ai', subscription: 'max', plan: 'Max', email: 'moi@example.test' }; }

// --- Fabrique ------------------------------------------------------------------

test('la fabrique démarre à l’état idle et tolère l’absence d’isQuitting', async () => {
  const flows = createProviderFlows({ ORCA_ORIGIN, getState: () => undefined });
  assert.deepEqual(flows.info(), { claude: idle, antigravity: idle, orcarouter: idle, ollama: idle });
  assert.deepEqual(flows.pending(), []);
  assert.doesNotThrow(() => flows.syncClaudeWhenDue());
  await flows.closeAll({ reset: true });
  assert.equal(flows.chooseOrcaAccountRef, chooseOrcaAccountRef);
});

// --- Claude ------------------------------------------------------------------
// Une seule connexion : l'abonnement Claude via Claude Code (comme Codex).

const fableSnapshotAt = ms => claudeSnapshotAt(ms, {
  connectorVersion: 'claude-live-usage-v1',
  quotaWindows: [
    { label: '5 heures', remaining: 89, resetAt: null },
    { label: 'Semaine', remaining: 77, resetAt: null },
    { label: 'Fable · Semaine', remaining: 64, resetAt: null },
  ],
});

test('verifyClaude lit les quotas de l’abonnement et enregistre la session claude-live-local', async t => {
  clock(t);
  const h = harness();
  const live = fableSnapshotAt(T0);
  h.services.claudeRead = async () => live;
  const result = await h.flows.verifyClaude();
  assert.equal(h.claudeReader.reads, 1);
  assert.equal(h.claudeReader.credentialsChanges, 0, 'une lecture automatique ne lève aucun cooldown');
  assert.deepEqual(h.p.claude.accountSession, { kind: 'claude-live-local' });
  assert.equal(h.p.claude.snapshot, live);
  assert.ok(h.p.claude.snapshot.quotaWindows.some(window => window.label === 'Fable · Semaine'));
  assert.equal(h.p.claude.lastAttempt, new Date(T0).toISOString());
  assert.equal(h.p.claude.error, null);
  const nextRefresh = new Date(T0 + MINUTE).toISOString();
  assert.deepEqual(h.p.claude.claudeSync, { nextAttemptAt: nextRefresh, errorCode: null }, 'le cooldown du lecteur est persisté');
  assert.equal(h.state.connectorHealth.claude.strategy, 'claude-direct');
  assert.deepEqual(result.connections.claude, { status: 'connected', message: CLAUDE_CONNECTED_MESSAGE, nextAttemptAt: nextRefresh, errorCode: null });
  assert.deepEqual(h.labels().slice(-2), ['persist', 'broadcast']);
  assert.equal(h.count('cli-status') + h.count('cli-login'), 0, 'une lecture n’interroge pas Claude Code');
  // Même relevé : pas de doublon d'historique ; « Vérifier » lève le cooldown.
  await h.flows.verifyClaude({ manual: true });
  assert.equal(h.claudeReader.credentialsChanges, 1);
  assert.equal(h.count('record'), 1);
  assert.equal(h.count('markHealthSuccess'), 1);
  assert.equal(h.state.history.length, 1);
});

test('verifyClaude conserve l’identité de l’abonnement et convertit une ancienne session Claude Desktop', async t => {
  clock(t);
  const h = harness();
  h.p.claude.accountSession = { kind: 'claude-live-local', plan: 'Max', email: 'moi@example.test' };
  await h.flows.verifyClaude();
  assert.deepEqual(h.p.claude.accountSession, { kind: 'claude-live-local', plan: 'Max', email: 'moi@example.test' });
  const old = harness();
  old.p.claude.accountSession = { kind: 'claude-desktop-local', resumeLiveAfter: new Date(T0).toISOString() };
  await old.flows.verifyClaude();
  assert.deepEqual(old.p.claude.accountSession, { kind: 'claude-live-local' }, 'plus de mode Claude Desktop');
  assert.equal(old.claudeReader.reads, 1);
});

test('un échec de lecture conserve les dernières valeurs, sans repli, avec un message clair', async t => {
  clock(t);
  for (const code of ['rate-limit', 'auth-rate-limit', 'network', 'auth-required']) {
    const h = harness();
    const previous = claudeSnapshotAt(T0 - 30 * MINUTE);
    h.p.claude.accountSession = { kind: 'claude-live-local', plan: 'Max' };
    h.p.claude.snapshot = previous;
    h.services.claudeRead = async () => { throw coded(code, `Message ${code}.`); };
    await assert.rejects(h.flows.verifyClaude(), { code, message: `Message ${code}.` }, code);
    assert.equal(h.p.claude.snapshot, previous, `${code} : dernières valeurs conservées`);
    assert.deepEqual(h.p.claude.accountSession, { kind: 'claude-live-local', plan: 'Max' }, code);
    assert.equal(h.p.claude.error, `Message ${code}.`, code);
    assert.equal(h.count('record'), 0, code);
    assert.equal(h.count('markHealthFailure'), 1, code);
    assert.equal(h.state.connectorHealth.claude.strategy, 'claude-direct', code);
    const info = h.flows.info().claude;
    assert.equal(info.status, 'error', code);
    assert.equal(info.errorCode, code, code);
    assert.equal(info.nextAttemptAt, new Date(T0 + 5 * MINUTE).toISOString(), `${code} : prochain essai exposé`);
    assert.deepEqual(h.flows.pending(), [], code);
  }
});

test('connectClaude : Claude Code déjà connecté à l’abonnement, lecture immédiate sans navigateur', async t => {
  clock(t);
  const h = harness();
  h.services.claudeRead = async () => fableSnapshotAt(T0);
  const result = await h.flows.connectClaude();
  assert.equal(h.count('cli-status'), 1);
  assert.equal(h.count('cli-login'), 0, 'aucune connexion navigateur quand Claude Code est déjà connecté');
  assert.deepEqual(h.p.claude.accountSession, { kind: 'claude-live-local', plan: 'Max', email: 'moi@example.test' });
  assert.equal(h.p.claude.plan, 'Max', 'le forfait est renseigné automatiquement');
  assert.equal(h.claudeReader.credentialsChanges, 1);
  assert.equal(result.connections.claude.status, 'connected');
});

test('connectClaude ouvre la connexion officielle si Claude Code n’est pas connecté ou pas sur l’abonnement', async t => {
  clock(t);
  for (const code of ['auth-unavailable', 'not-subscription']) {
    const h = harness();
    h.services.cliSubscription = async () => { throw coded(code); };
    const states = [];
    h.services.cliLogin = async () => { states.push(h.flows.info().claude.status); return identity(); };
    await h.flows.connectClaude();
    assert.equal(h.count('cli-login'), 1, code);
    assert.deepEqual(states, ['waiting'], `${code} : « termine la connexion dans ton navigateur » pendant la connexion`);
    assert.deepEqual(h.p.claude.accountSession, { kind: 'claude-live-local', plan: 'Max', email: 'moi@example.test' }, code);
    assert.equal(h.flows.info().claude.status, 'connected', code);
  }
  // Connexion présente mais refusée par Anthropic : nouvelle connexion, puis lecture.
  const h = harness();
  let reads = 0;
  h.services.claudeRead = async () => { if (reads++ === 0) throw coded('auth-required', 'Connexion Claude expirée.'); return fableSnapshotAt(T0); };
  await h.flows.connectClaude();
  assert.equal(h.count('cli-login'), 1);
  assert.equal(h.claudeReader.reads, 2);
  assert.equal(h.p.claude.error, null);
});

test('connectClaude rapporte un échec de connexion ou un Claude Code absent sans toucher aux valeurs', async t => {
  clock(t);
  const h = harness();
  const previous = claudeSnapshotAt(T0 - MINUTE);
  h.p.claude.snapshot = previous;
  h.services.cliSubscription = async () => { throw coded('auth-unavailable'); };
  h.services.cliLogin = async () => { throw coded('login-failed', 'La connexion à Claude n’a pas abouti.'); };
  await assert.rejects(h.flows.connectClaude(), { code: 'login-failed' });
  assert.equal(h.p.claude.snapshot, previous);
  assert.equal(h.claudeReader.reads, 0);
  assert.deepEqual(h.flows.info().claude, { status: 'error', message: 'La connexion à Claude n’a pas abouti.', errorCode: 'login-failed' });
  const missing = harness();
  missing.services.cliSubscription = async () => { throw coded('cli-missing', 'Claude Code n’est pas installé sur ce PC.'); };
  await assert.rejects(missing.flows.connectClaude(), { code: 'cli-missing' });
  assert.equal(missing.count('cli-login'), 0, 'sans Claude Code, aucune connexion n’est tentée');
  // Une erreur de lecture non liée à la connexion n'ouvre pas le navigateur.
  const busy = harness();
  busy.services.claudeRead = async () => { throw coded('rate-limit', 'Trop de demandes.'); };
  await assert.rejects(busy.flows.connectClaude(), { code: 'rate-limit' });
  assert.equal(busy.count('cli-login'), 0);
});

test('verifyClaude et connectClaude refusent pendant une déconnexion ou la fermeture et partagent le travail en cours', async t => {
  const { flush } = clock(t);
  const h = harness();
  h.disconnecting.add('claude');
  await assert.rejects(h.flows.verifyClaude(), /Déconnexion en cours/);
  await assert.rejects(h.flows.connectClaude(), /Déconnexion en cours/);
  h.disconnecting.delete('claude');
  h.flags.quitting = true;
  await assert.rejects(h.flows.verifyClaude(), /Déconnexion en cours/);
  await assert.rejects(h.flows.connectClaude(), /Déconnexion en cours/);
  h.flags.quitting = false;
  assert.equal(h.claudeReader.reads, 0);
  // Deux lectures concurrentes partagent le même travail ; Connecter attend sa fin.
  const gate = deferred();
  h.services.claudeRead = () => gate.promise;
  const first = h.flows.verifyClaude();
  const second = h.flows.verifyClaude();
  await flush();
  assert.equal(h.claudeReader.reads, 1);
  assert.equal(h.flows.pending().length, 1);
  assert.equal(h.flows.info().claude.status, 'verifying');
  const third = h.flows.connectClaude();
  await flush();
  assert.equal(h.count('cli-status'), 0, 'Connecter attend la lecture en cours');
  h.services.claudeRead = async () => fableSnapshotAt(Date.now());
  gate.resolve(fableSnapshotAt(T0));
  const results = await Promise.all([first, second, third]);
  assert.equal(results[1].connections, results[0].connections);
  assert.equal(h.count('cli-status'), 1);
  assert.deepEqual(h.flows.pending(), []);
});

test('syncClaudeWhenDue respecte nextAttemptAt, le suivi, l’actualisation automatique et la fermeture', async t => {
  const { tick } = clock(t);
  const h = harness();
  const due = () => h.count('syncOne');
  h.p.claude.accountSession = { kind: 'claude-live-local' };
  h.flows.syncClaudeWhenDue();
  assert.equal(due(), 1);
  assert.deepEqual(h.find('syncOne'), ['syncOne', 'claude', { force: false }]);
  h.claudeReader.status = { nextAttemptAt: new Date(T0 + MINUTE).toISOString(), errorCode: 'rate-limit' };
  h.flows.syncClaudeWhenDue();
  assert.equal(due(), 1, 'un cooldown futur suspend la synchronisation');
  tick(MINUTE);
  h.flows.syncClaudeWhenDue();
  assert.equal(due(), 2, 'le cooldown échu relance la synchronisation');
  // Fichier de connexion réécrit (connexion ou renouvellement par Claude Code) :
  // un cooldown d'authentification est levé, la lecture repart aussitôt.
  h.claudeReader.status = { nextAttemptAt: new Date(T0 + 30 * MINUTE).toISOString(), errorCode: 'auth-required' };
  h.flows.syncClaudeWhenDue({ credentialsChanged: true });
  assert.equal(h.claudeReader.credentialsChanges, 1);
  assert.equal(due(), 3);
  h.state.settings.autoRefresh = false;
  h.flows.syncClaudeWhenDue();
  h.state.settings.autoRefresh = true;
  h.p.claude.accountSession = null;
  h.flows.syncClaudeWhenDue();
  h.p.claude.accountSession = { kind: 'claude-live-local' };
  h.p.claude.active = false;
  h.flows.syncClaudeWhenDue();
  h.p.claude.active = true;
  h.flags.quitting = true;
  h.flows.syncClaudeWhenDue();
  h.flags.quitting = false;
  h.flags.stateless = true;
  h.flows.syncClaudeWhenDue();
  h.flags.stateless = false;
  assert.equal(due(), 3, 'actualisation désactivée, non connecté, suivi inactif, fermeture ou état absent : rien');
  // Un échec de synchronisation est absorbé : aucune promesse non gérée.
  h.services.syncOne = async () => { throw new Error('échec'); };
  h.flows.syncClaudeWhenDue();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(due(), 4);
});

// --- Antigravity -------------------------------------------------------------

test('verifyAntigravity enregistre la session locale et le relevé quand le service est trouvé', async t => {
  const { flush } = clock(t);
  const h = harness();
  const gate = deferred();
  h.services.antigravityRead = () => gate.promise;
  const first = h.flows.verifyAntigravity();
  const second = h.flows.verifyAntigravity();
  await flush();
  assert.equal(h.count('antigravity'), 1, 'une seule lecture pour deux appels concurrents');
  assert.equal(h.flows.pending().length, 1);
  assert.equal(h.flows.info().antigravity.status, 'verifying');
  assert.equal(h.p.antigravity.lastAttempt, new Date(T0).toISOString());
  const snapshot = antigravitySnapshotAt(T0);
  gate.resolve(snapshot);
  const [result] = await Promise.all([first, second]);
  assert.deepEqual(h.p.antigravity.accountSession, { kind: 'antigravity-local' });
  assert.equal(h.p.antigravity.snapshot, snapshot);
  assert.equal(h.p.antigravity.error, null);
  assert.equal(h.state.connectorHealth.antigravity.state, 'ok');
  assert.equal(h.state.connectorHealth.antigravity.strategy, 'antigravity-local');
  assert.equal(result.connections.antigravity.status, 'connected');
  assert.match(result.connections.antigravity.message, /Antigravity connecté/);
  assert.deepEqual(h.labels().slice(-2), ['persist', 'broadcast']);
  assert.deepEqual(h.flows.pending(), []);
});

test('verifyAntigravity marque la santé en échec quand l’application est fermée ou ses ports illisibles', async t => {
  clock(t);
  const h = harness();
  const previous = antigravitySnapshotAt(T0 - 5 * MINUTE);
  h.p.antigravity.accountSession = { kind: 'antigravity-local' };
  h.p.antigravity.snapshot = previous;
  const notRunning = coded('ANTIGRAVITY_NOT_RUNNING', 'Antigravity 2.0 est introuvable sur ce PC. Ouvre Antigravity 2.0 et connecte ton compte Google, puis clique sur Vérifier maintenant.');
  h.services.antigravityRead = async () => { throw notRunning; };
  await assert.rejects(h.flows.verifyAntigravity(), { code: 'ANTIGRAVITY_NOT_RUNNING' });
  assert.equal(h.p.antigravity.error, notRunning.message);
  assert.equal(h.p.antigravity.snapshot, previous, 'le dernier relevé est conservé');
  assert.deepEqual(h.p.antigravity.accountSession, { kind: 'antigravity-local' }, 'la session locale n’est pas effacée');
  let health = h.state.connectorHealth.antigravity;
  assert.equal(health.failures, 1);
  assert.equal(health.error.sourceCode, 'ANTIGRAVITY_NOT_RUNNING');
  assert.equal(health.strategy, 'antigravity-local');
  assert.notEqual(health.state, 'ok');
  assert.equal(health.lastAttemptAt, new Date(T0).toISOString());
  assert.deepEqual(h.flows.info().antigravity, { status: 'error', message: notRunning.message });
  assert.deepEqual(h.labels().slice(-2), ['persist', 'broadcast']);
  const noPorts = coded('ANTIGRAVITY_NO_PORTS', 'Antigravity 2.0 est bien détecté, mais ses ports locaux ou son jeton CSRF ne sont pas lisibles. Ferme puis rouvre Antigravity 2.0, puis clique sur Vérifier maintenant.');
  h.services.antigravityRead = async () => { throw noPorts; };
  await assert.rejects(h.flows.verifyAntigravity(), { code: 'ANTIGRAVITY_NO_PORTS' });
  health = h.state.connectorHealth.antigravity;
  assert.equal(health.failures, 2);
  assert.equal(health.error.sourceCode, 'ANTIGRAVITY_NO_PORTS');
  assert.match(h.flows.info().antigravity.message, /ports locaux/);
  assert.deepEqual(h.flows.pending(), []);
  // Déconnexion en cours ou fermeture : aucune lecture tentée.
  h.disconnecting.add('antigravity');
  await assert.rejects(h.flows.verifyAntigravity(), /Déconnexion en cours/);
  h.disconnecting.delete('antigravity');
  h.flags.quitting = true;
  await assert.rejects(h.flows.verifyAntigravity(), /Déconnexion en cours/);
  assert.equal(h.count('antigravity'), 2);
});

// --- OrcaRouter --------------------------------------------------------------

test('openOrcaAccount ouvre une fenêtre isolée, verrouille la session et attend la connexion', async t => {
  const { advance } = clock(t);
  const h = harness();
  assert.equal(await h.flows.openOrcaAccount(), true);
  assert.equal(h.windows.length, 1);
  const [window] = h.windows;
  assert.equal(window.options.title, 'Connexion au compte OrcaRouter');
  assert.equal(window.options.parent, h.mainWindow);
  assert.deepEqual(window.options.webPreferences, { partition: 'persist:orcarouter-account', nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false });
  assert.deepEqual(h.find('secure'), ['secure', window, ACCOUNT_ORIGINS]);
  assert.deepEqual(window.loaded, [ORCA_ORIGIN + '/console']);
  const session = h.sessions.orca;
  let granted = null;
  session.permissionRequestHandler({}, 'media', value => { granted = value; });
  assert.equal(granted, false, 'toute permission est refusée');
  assert.equal(session.permissionCheckHandler(), false);
  assert.equal(session.lasmiumConfigured, true);
  const downloads = session.listeners.get('will-download');
  assert.equal(downloads.length, 1);
  let prevented = false;
  downloads[0]({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, 'les téléchargements sont bloqués');
  assert.equal(h.flows.info().orcarouter.status, 'waiting');
  assert.match(h.flows.info().orcarouter.message, /Connecte-toi sur le site OrcaRouter/);
  // Fenêtre déjà ouverte : remise au premier plan, sans doublon.
  assert.equal(await h.flows.openOrcaAccount(), true);
  assert.equal(h.windows.length, 1);
  assert.equal(window.shown, 1);
  assert.equal(window.focused, 1);
  // Aucune référence exposée par la page : la détection n'appelle jamais le portefeuille.
  await advance(3000);
  assert.equal(window.webContents.executions, 3);
  assert.equal(h.count('fetchWallet'), 0);
  // Fermeture par l'utilisateur : état idle, détection arrêtée.
  window.close();
  assert.deepEqual(h.flows.info().orcarouter, { status: 'idle', message: 'Fenêtre fermée. Rouvre le compte pour reprendre la connexion.' });
  window.webContents.scriptResult = { userId: 5, workspaceId: 6 };
  await advance(3000);
  assert.equal(window.webContents.executions, 3);
  assert.equal(h.count('fetchWallet'), 0);
  // Réouverture : nouvelle fenêtre, la session n'est configurée qu'une seule fois.
  assert.equal(await h.flows.openOrcaAccount(), true);
  assert.equal(h.windows.length, 2);
  assert.equal(session.listeners.get('will-download').length, 1);
});

test('openOrcaAccount signale un site inaccessible et refuse pendant une déconnexion', async t => {
  clock(t);
  const h = harness();
  h.disconnecting.add('orcarouter');
  await assert.rejects(h.flows.openOrcaAccount(), /Déconnexion en cours/);
  h.disconnecting.delete('orcarouter');
  h.flags.quitting = true;
  await assert.rejects(h.flows.openOrcaAccount(), /Déconnexion en cours/);
  h.flags.quitting = false;
  assert.equal(h.windows.length, 0);
  h.windowDefaults.loadError = new Error('net::ERR_NAME_NOT_RESOLVED');
  await assert.rejects(h.flows.openOrcaAccount(), { message: 'Le site OrcaRouter ne peut pas être ouvert. Vérifie ta connexion Internet.' });
  assert.equal(h.windows.length, 1);
  assert.deepEqual(h.windows[0].loaded, [ORCA_ORIGIN + '/console']);
});

test('la détection OrcaRouter vérifie la session dès que la fenêtre expose une référence valide', async t => {
  const { advance } = clock(t);
  const h = harness();
  const wallet = snapshotAt(T0, { connectorVersion: 'orca-wallet-v1' });
  h.services.fetchWallet = async () => wallet;
  await h.flows.openOrcaAccount();
  const [window] = h.windows;
  // Origine étrangère ou URL illisible : aucune lecture de référence.
  window.webContents.url = 'https://accounts.google.com/signin';
  window.webContents.scriptResult = { userId: 7, workspaceId: 9 };
  await advance(1000);
  window.webContents.url = '';
  await advance(1000);
  assert.equal(window.webContents.executions, 0);
  // Script refusé par la page : ignoré sans casser la détection.
  window.webContents.url = ORCA_ORIGIN.replace('://www.', '://') + '/console';
  window.webContents.scriptError = new Error('Script failed');
  await advance(1000);
  assert.equal(window.webContents.executions, 1);
  assert.equal(h.count('fetchWallet'), 0);
  window.webContents.scriptError = null;
  await advance(1000);
  const fetch = h.find('fetchWallet');
  assert.deepEqual(fetch[1], { userId: 7, workspaceId: 9 });
  assert.equal(typeof fetch[2], 'function', 'fetch lié à la session isolée');
  assert.ok(h.first('persist') < h.first('fetchWallet'), 'la session est enregistrée et persistée avant la première lecture');
  assert.deepEqual(h.p.orcarouter.accountSession, { userId: 7, workspaceId: 9 });
  assert.equal(h.p.orcarouter.snapshot, wallet);
  assert.equal(h.p.orcarouter.lastAttempt, wallet.updatedAt);
  assert.equal(h.p.orcarouter.error, null);
  assert.equal(h.sessions.orca.flushes, 1, 'les cookies sont écrits sur disque après la lecture');
  assert.equal(window.destroyed, true, 'la fenêtre se ferme après la connexion');
  assert.equal(h.count('showMain'), 1);
  assert.deepEqual(h.flows.info().orcarouter, { status: 'connected', message: 'Connexion réussie. Le portefeuille se synchronise automatiquement.' });
  assert.equal(h.state.connectorHealth.orcarouter.strategy, 'orca-session');
  // La détection s'arrête avec la fenêtre.
  await advance(20000);
  assert.equal(h.count('fetchWallet'), 1);
  assert.deepEqual(h.flows.pending(), []);
  assert.equal(h.busy.size, 0);
});

test('la détection OrcaRouter espace les tentatives de 15 s et garde la fenêtre ouverte après ORCA_AUTH', async t => {
  const { advance } = clock(t);
  const h = harness();
  h.services.fetchWallet = async () => { throw coded('ORCA_AUTH', 'Session OrcaRouter expirée.'); };
  await h.flows.openOrcaAccount();
  const [window] = h.windows;
  window.webContents.scriptResult = { userId: 7, workspaceId: 9 };
  await advance(1000);
  assert.equal(h.count('fetchWallet'), 1);
  assert.equal(window.destroyed, false, 'la fenêtre reste ouverte pour se reconnecter');
  assert.equal(h.p.orcarouter.accountSession, undefined);
  assert.equal(h.flows.info().orcarouter.status, 'error');
  assert.equal(h.flows.info().orcarouter.errorCode, 'ORCA_AUTH');
  await advance(14000);
  assert.equal(h.count('fetchWallet'), 1, 'aucune nouvelle tentative avant 15 s');
  await advance(1000);
  assert.equal(h.count('fetchWallet'), 2);
  // Un fournisseur occupé suspend la détection.
  h.busy.set('orcarouter', Promise.resolve());
  await advance(15000);
  assert.equal(h.count('fetchWallet'), 2);
  h.busy.delete('orcarouter');
});

test('verifyOrcaAccount vérifie une session persistée sans fenêtre et enregistre un changement de compte avant la lecture', async t => {
  clock(t);
  const h = harness();
  const stored = { userId: 1, workspaceId: 2 };
  h.p.orcarouter.accountSession = stored;
  const wallet = snapshotAt(T0, { connectorVersion: 'orca-wallet-v1' });
  h.services.fetchWallet = async () => wallet;
  const result = await h.flows.verifyOrcaAccount();
  assert.equal(h.windows.length, 0, 'aucune fenêtre n’est nécessaire');
  assert.deepEqual(h.find('fetchWallet')[1], stored);
  assert.equal(h.p.orcarouter.accountSession, stored);
  assert.equal(h.p.orcarouter.snapshot, wallet);
  assert.equal(h.p.orcarouter.lastAttempt, wallet.updatedAt);
  assert.equal(h.count('persist'), 1, 'une session inchangée n’est persistée qu’après le relevé');
  assert.ok(h.first('fetchWallet') < h.first('persist'));
  assert.equal(h.count('showMain'), 1);
  assert.equal(result.connections.orcarouter.status, 'connected');
  assert.equal(h.busy.size, 0);
  assert.equal(h.labels().at(-1), 'broadcast');
  // Une fenêtre exposant un autre espace de travail fait foi : session mise à jour et persistée avant la lecture.
  await h.flows.openOrcaAccount();
  const [window] = h.windows;
  window.webContents.scriptResult = { userId: 1, workspaceId: 3 };
  h.calls.length = 0;
  await h.flows.verifyOrcaAccount();
  assert.deepEqual(h.p.orcarouter.accountSession, { userId: 1, workspaceId: 3 });
  assert.ok(h.first('persist') < h.first('fetchWallet'));
  assert.equal(h.count('persist'), 2);
  assert.equal(window.destroyed, true);
  // Une fenêtre sur la même identité ne change rien.
  await h.flows.openOrcaAccount();
  h.windows[1].webContents.scriptResult = { userId: 1, workspaceId: 3 };
  h.calls.length = 0;
  await h.flows.verifyOrcaAccount();
  assert.equal(h.count('persist'), 1);
});

test('ORCA_AUTH efface la session ; ORCA_RATE_LIMIT et ORCA_TRANSIENT conservent la session et le dernier relevé', async t => {
  clock(t);
  const stored = { userId: 1, workspaceId: 2 };
  for (const code of ['ORCA_RATE_LIMIT', 'ORCA_TRANSIENT']) {
    const h = harness();
    const previous = snapshotAt(T0 - 10 * MINUTE, { connectorVersion: 'orca-wallet-v1' });
    h.p.orcarouter.accountSession = stored;
    h.p.orcarouter.snapshot = previous;
    h.services.fetchWallet = async () => { throw coded(code, 'Lecture OrcaRouter impossible.'); };
    await h.flows.openOrcaAccount();
    const [window] = h.windows;
    const message = 'Lecture OrcaRouter impossible. Réessai automatique au prochain cycle d’actualisation.';
    await assert.rejects(h.flows.verifyOrcaAccount(), { code, message });
    assert.equal(h.p.orcarouter.accountSession, stored, code);
    assert.equal(h.p.orcarouter.snapshot, previous, code);
    assert.equal(h.p.orcarouter.error, message, code);
    assert.equal(h.state.connectorHealth.orcarouter.error.sourceCode, code);
    assert.deepEqual(h.flows.info().orcarouter, { status: 'error', message, errorCode: code }, code);
    assert.equal(window.destroyed, false, `${code} : une erreur passagère ne ferme plus la fenêtre de connexion`);
    assert.equal(h.count('persist'), 1, code);
    assert.equal(h.busy.size, 0, code);
    assert.equal(h.labels().at(-1), 'broadcast', code);
  }
  const h = harness();
  const previous = snapshotAt(T0 - 10 * MINUTE, { connectorVersion: 'orca-wallet-v1' });
  h.p.orcarouter.accountSession = stored;
  h.p.orcarouter.snapshot = previous;
  h.services.fetchWallet = async () => { throw coded('ORCA_AUTH', 'Session OrcaRouter expirée. Reconnecte-toi.'); };
  await h.flows.openOrcaAccount();
  const [window] = h.windows;
  await assert.rejects(h.flows.verifyOrcaAccount(), { code: 'ORCA_AUTH', message: 'Session OrcaRouter expirée. Reconnecte-toi.' });
  assert.equal(h.p.orcarouter.accountSession, undefined, 'la session est effacée pour exiger une reconnexion');
  assert.equal(h.p.orcarouter.snapshot, previous, 'le dernier relevé reste affiché');
  assert.equal(window.destroyed, false, 'la fenêtre reste ouverte pour se reconnecter');
  assert.equal(h.state.connectorHealth.orcarouter.state, 'auth');
  assert.equal(h.flows.info().orcarouter.errorCode, 'ORCA_AUTH');
  assert.equal(h.count('persist'), 1);
  // Sans session ni fenêtre, validateAccountRef produit ORCA_AUTH sans appel réseau.
  window.close();
  await assert.rejects(h.flows.verifyOrcaAccount(), { code: 'ORCA_AUTH' });
  assert.equal(h.count('fetchWallet'), 1);
  // Un portefeuille incohérent est refusé par le contrat : session et relevé conservés, fenêtre laissée ouverte.
  h.p.orcarouter.accountSession = stored;
  h.services.fetchWallet = async () => ({ updatedAt: new Date().toISOString() });
  await h.flows.openOrcaAccount();
  await assert.rejects(h.flows.verifyOrcaAccount(), { code: 'SCHEMA_DRIFT' });
  assert.equal(h.p.orcarouter.accountSession, stored);
  assert.equal(h.p.orcarouter.snapshot, previous);
  assert.equal(h.state.connectorHealth.orcarouter.state, 'drift');
  assert.equal(h.windows.at(-1).destroyed, false);
});

test('verifyOrcaAccount refuse un fournisseur occupé et partage une vérification en cours', async t => {
  const { flush } = clock(t);
  const h = harness();
  h.p.orcarouter.accountSession = { userId: 1, workspaceId: 2 };
  h.busy.set('orcarouter', Promise.resolve());
  await assert.rejects(h.flows.verifyOrcaAccount(), /synchronisation OrcaRouter est déjà en cours/);
  h.busy.delete('orcarouter');
  h.disconnecting.add('orcarouter');
  await assert.rejects(h.flows.verifyOrcaAccount(), /Déconnexion en cours/);
  h.disconnecting.delete('orcarouter');
  h.flags.quitting = true;
  await assert.rejects(h.flows.verifyOrcaAccount(), /Déconnexion en cours/);
  h.flags.quitting = false;
  assert.equal(h.count('fetchWallet'), 0);
  const gate = deferred();
  h.services.fetchWallet = () => gate.promise;
  const first = h.flows.verifyOrcaAccount();
  await flush();
  assert.equal(h.busy.has('orcarouter'), true, 'le fournisseur est marqué occupé pendant la lecture');
  assert.equal(h.flows.info().orcarouter.status, 'verifying');
  const second = h.flows.verifyOrcaAccount();
  await flush();
  assert.equal(h.count('fetchWallet'), 1);
  assert.equal(h.flows.pending().length, 1);
  gate.resolve(snapshotAt(T0, { connectorVersion: 'orca-wallet-v1' }));
  const results = await Promise.all([first, second]);
  assert.equal(results[1].connections.orcarouter.status, 'connected');
  assert.equal(h.busy.size, 0);
  assert.deepEqual(h.flows.pending(), []);
});

// --- Ollama ------------------------------------------------------------------

test('openOllamaSystemAccount ouvre le navigateur système puis vérifie dès que la fenêtre est fermée', async t => {
  const { advance } = clock(t);
  const h = harness();
  const browser = ollamaBrowserDouble({ cookies: [{ name: 'session', value: 'abc', domain: 'ollama.com' }] });
  h.services.openOllamaBrowser = async () => browser;
  const credits = ollamaSnapshotAt(T0);
  h.services.fetchOllamaCredits = async () => credits;
  assert.equal(await h.flows.openOllamaSystemAccount(), true);
  assert.deepEqual(h.find('openOllamaBrowser'), ['openOllamaBrowser', DATA_DIR]);
  assert.equal(h.flows.info().ollama.status, 'waiting');
  assert.match(h.flows.info().ollama.message, /Chrome ou Edge/);
  // Navigateur déjà en phase de connexion : pas de second lancement.
  assert.equal(await h.flows.openOllamaSystemAccount(), true);
  assert.equal(h.count('openOllamaBrowser'), 1);
  await advance(750);
  assert.equal(browser.reads, 0, 'rien tant que la fenêtre système est ouverte');
  browser.current = 'verifying';
  await advance(750);
  assert.equal(browser.reads, 1);
  assert.deepEqual(h.sessions.ollama.cookies.stored, browser.cookies, 'les cookies lus sont copiés dans la session isolée');
  assert.equal(h.sessions.ollama.flushes, 2);
  const fetch = h.find('fetchOllamaCredits');
  assert.equal(fetch[1].toISOString(), new Date(T0 + 1500).toISOString());
  assert.deepEqual(fetch[2], { assumeFree: false });
  assert.ok(h.first('persist') < h.first('fetchOllamaCredits'), 'la session est enregistrée avant la première lecture');
  assert.deepEqual(h.p.ollama.accountSession, { kind: 'ollama-credits' });
  assert.equal(h.p.ollama.snapshot, credits);
  assert.equal(h.p.ollama.lastAttempt, credits.updatedAt);
  assert.equal(browser.closed, 1);
  assert.equal(h.count('showMain'), 1);
  assert.deepEqual(h.flows.info().ollama, { status: 'connected', message: 'Ollama connecté. Les crédits mensuels sont à jour.' });
  assert.equal(h.state.connectorHealth.ollama.strategy, 'ollama-browser');
  assert.equal(h.busy.size, 0);
  await advance(3000);
  assert.equal(browser.reads, 1, 'la détection s’arrête après la vérification');
  assert.deepEqual(h.flows.pending(), []);
});

test('openOllamaSystemAccount : aucune session après la fermeture du navigateur efface la session et l’explique', async t => {
  const { advance } = clock(t);
  const h = harness();
  h.p.ollama.accountSession = { kind: 'ollama-credits' };
  const browser = ollamaBrowserDouble({ cookies: [] });
  h.services.openOllamaBrowser = async () => browser;
  await h.flows.openOllamaSystemAccount();
  browser.current = 'verifying';
  await advance(750);
  assert.equal(browser.reads, 1);
  assert.equal(browser.closed, 1);
  assert.equal(h.p.ollama.accountSession, undefined);
  assert.equal(h.count('fetchOllamaCredits'), 0);
  assert.match(h.p.ollama.error, /En attente de ta connexion Ollama/);
  assert.equal(h.state.connectorHealth.ollama.error.sourceCode, 'OLLAMA_SIGNIN');
  assert.deepEqual(h.flows.info().ollama, { status: 'error', message: 'Aucune session Ollama détectée après la fermeture du navigateur. Réessaie et termine la connexion Google jusqu’au retour sur Ollama.' });
  assert.equal(h.busy.size, 0);
  assert.deepEqual(h.flows.pending(), []);
  // Relance : le navigateur précédent est oublié, la détection repart.
  const second = ollamaBrowserDouble({ cookies: [{ name: 'session', value: 'ok' }] });
  h.services.openOllamaBrowser = async () => second;
  await h.flows.openOllamaSystemAccount();
  assert.equal(h.count('openOllamaBrowser'), 2);
  assert.equal(h.flows.info().ollama.status, 'waiting');
  // Chrome/Edge introuvable : erreur affichée, aucune promesse laissée en suspens.
  await h.flows.cancelOllama();
  h.services.openOllamaBrowser = async () => { throw new Error('Chrome ou Edge ne peut pas être démarré.'); };
  await assert.rejects(h.flows.openOllamaSystemAccount(), /Chrome ou Edge/);
  assert.deepEqual(h.flows.info().ollama, { status: 'error', message: 'Chrome ou Edge ne peut pas être démarré.' });
  assert.deepEqual(h.flows.pending(), []);
  h.disconnecting.add('ollama');
  await assert.rejects(h.flows.openOllamaSystemAccount(), /Déconnexion en cours/);
});

test('openOllamaAccount ouvre la fenêtre e-mail isolée et vérifie dès l’arrivée sur les réglages', async t => {
  const { advance } = clock(t);
  const h = harness();
  const credits = ollamaSnapshotAt(T0);
  h.services.fetchOllamaCredits = async () => credits;
  assert.equal(await h.flows.openOllamaAccount(), true);
  const [window] = h.windows;
  assert.equal(window.options.title, 'Connexion au compte Ollama');
  assert.equal(window.options.webPreferences.partition, 'persist:ollama-account');
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.options.parent, h.mainWindow);
  assert.deepEqual(h.find('secure'), ['secure', window, ACCOUNT_ORIGINS]);
  assert.deepEqual(window.loaded, [SETTINGS_URL]);
  const session = h.sessions.ollama;
  assert.equal(session.lasmiumConfigured, true);
  assert.equal(session.listeners.get('will-download').length, 1);
  let granted = null;
  session.permissionRequestHandler({}, 'notifications', value => { granted = value; });
  assert.equal(granted, false);
  assert.equal(session.permissionCheckHandler(), false);
  assert.match(h.flows.info().ollama.message, /Connecte-toi sur Ollama\. Les crédits/);
  assert.equal(await h.flows.openOllamaAccount(), true);
  assert.equal(h.windows.length, 1);
  assert.equal(window.shown, 1);
  assert.equal(window.focused, 1);
  // Pages de connexion ou URL illisible : aucune vérification avant le retour sur les réglages.
  for (const url of [OLLAMA_ORIGIN + '/signin', OLLAMA_ORIGIN + '/auth/google', 'https://accounts.google.com/o/oauth2', '']) {
    window.webContents.url = url;
    await advance(1000);
    assert.equal(h.count('fetchOllamaCredits'), 0, url || 'URL vide');
  }
  window.webContents.url = SETTINGS_URL;
  await advance(1000);
  assert.equal(h.count('fetchOllamaCredits'), 1);
  assert.ok(h.first('persist') < h.first('fetchOllamaCredits'), 'la session est enregistrée avant la première lecture');
  assert.deepEqual(h.p.ollama.accountSession, { kind: 'ollama-credits' });
  assert.equal(h.p.ollama.snapshot, credits);
  assert.equal(h.sessions.ollama.flushes, 1);
  assert.equal(window.destroyed, true);
  assert.equal(h.flows.info().ollama.status, 'connected');
  assert.equal(h.count('showMain'), 1);
  await advance(15000);
  assert.equal(h.count('fetchOllamaCredits'), 1, 'la détection s’arrête avec la fenêtre');
  assert.equal(session.listeners.get('will-download').length, 1);
});

test('openOllamaAccount : fermeture, site inaccessible, connexion attendue et erreurs transitoires', async t => {
  const { advance } = clock(t);
  const h = harness();
  await h.flows.openOllamaAccount();
  h.windows[0].close();
  assert.deepEqual(h.flows.info().ollama, { status: 'idle', message: 'Fenêtre fermée. Rouvre le compte pour reprendre la connexion.' });
  h.windowDefaults.loadError = new Error('net::ERR_INTERNET_DISCONNECTED');
  await assert.rejects(h.flows.openOllamaAccount(), { message: 'Le site Ollama ne peut pas être ouvert. Vérifie ta connexion Internet.' });
  assert.deepEqual(h.flows.info().ollama, { status: 'error', message: 'Le site Ollama ne peut pas être ouvert. Vérifie ta connexion Internet.' });
  h.windows[1].close();
  delete h.windowDefaults.loadError;
  // Détection automatique sur une session encore anonyme : attente, session effacée, fenêtre conservée.
  h.p.ollama.accountSession = { kind: 'ollama-credits' };
  h.services.fetchOllamaCredits = async () => { throw coded('OLLAMA_SIGNIN', 'Session Ollama expirée.'); };
  await h.flows.openOllamaAccount();
  const window = h.windows[2];
  window.webContents.url = SETTINGS_URL;
  await advance(1000);
  assert.equal(h.count('fetchOllamaCredits'), 1);
  assert.equal(h.p.ollama.accountSession, undefined);
  assert.equal(h.p.ollama.error, 'Session Ollama expirée.');
  assert.deepEqual(h.flows.info().ollama, { status: 'waiting', message: 'En attente de ta connexion sur le site officiel Ollama.' });
  assert.equal(window.destroyed, false);
  await advance(14000);
  assert.equal(h.count('fetchOllamaCredits'), 1, 'les tentatives automatiques sont espacées de 15 s');
  // Action manuelle : la même erreur devient visible avec son code.
  await assert.rejects(h.flows.verifyOllamaAccount(), { code: 'OLLAMA_SIGNIN' });
  assert.equal(h.count('fetchOllamaCredits'), 2);
  assert.deepEqual(h.flows.info().ollama, { status: 'error', message: 'Session Ollama expirée.', errorCode: 'OLLAMA_SIGNIN' });
  // Erreur transitoire : session et dernier relevé conservés, fenêtre toujours ouverte.
  const previous = ollamaSnapshotAt(T0 - 5 * MINUTE);
  h.p.ollama.accountSession = { kind: 'ollama-credits' };
  h.p.ollama.snapshot = previous;
  for (const code of ['OLLAMA_RATE_LIMIT', 'OLLAMA_TRANSIENT']) {
    h.services.fetchOllamaCredits = async () => { throw coded(code, `Lecture Ollama impossible (${code}).`); };
    await assert.rejects(h.flows.verifyOllamaAccount(), { code });
    assert.deepEqual(h.p.ollama.accountSession, { kind: 'ollama-credits' }, code);
    assert.equal(h.p.ollama.snapshot, previous, code);
    assert.equal(h.p.ollama.error, `Lecture Ollama impossible (${code}).`, code);
    assert.equal(h.state.connectorHealth.ollama.error.sourceCode, code);
    assert.deepEqual(h.flows.info().ollama, { status: 'error', message: `Lecture Ollama impossible (${code}).`, errorCode: code }, code);
    assert.equal(window.destroyed, false, code);
    assert.equal(h.busy.size, 0, code);
  }
  assert.equal(h.state.connectorHealth.ollama.failures, 4);
});

test('verifyOllamaAccount enregistre la session avant la première lecture et décrit un forfait Free sans détail', async t => {
  const { flush } = clock(t);
  const h = harness();
  const free = ollamaSnapshotAt(T0, { planTier: 'free', balances: [], quotaRemaining: null, usageCredits: { currency: 'USD', remaining: 1.05 } });
  h.services.fetchOllamaCredits = async () => free;
  const result = await h.flows.verifyOllamaAccount();
  assert.ok(h.first('persist') < h.first('fetchOllamaCredits'));
  assert.deepEqual(h.find('fetchOllamaCredits')[2], { assumeFree: false });
  assert.deepEqual(h.p.ollama.accountSession, { kind: 'ollama-credits' });
  assert.equal(h.p.ollama.snapshot, free);
  assert.equal(result.connections.ollama.message, 'Session Ollama active. Réserve supplémentaire à jour. Le site ne fournit pas le détail de la limite Free ; aucun montant mensuel n’est estimé.');
  assert.equal(h.count('showMain'), 1);
  assert.equal(h.count('persist'), 2);
  // Free déjà vérifié : la lecture suivante assume le Free ; sans réserve, le message reste honnête.
  h.services.fetchOllamaCredits = async () => ({ ...free, usageCredits: null });
  await h.flows.verifyOllamaAccount();
  assert.deepEqual(h.all('fetchOllamaCredits')[1][2], { assumeFree: true });
  assert.equal(h.flows.info().ollama.message, 'Session Ollama active. Le site ne fournit pas le détail de la limite Free ; aucun montant mensuel n’est estimé.');
  assert.equal(h.count('persist'), 3, 'la session inchangée n’est plus persistée avant la lecture');
  // Fournisseur occupé, déconnexion, fermeture.
  h.busy.set('ollama', Promise.resolve());
  await assert.rejects(h.flows.verifyOllamaAccount(), /synchronisation Ollama est déjà en cours/);
  h.busy.delete('ollama');
  h.disconnecting.add('ollama');
  await assert.rejects(h.flows.verifyOllamaAccount(), /Déconnexion en cours/);
  h.disconnecting.delete('ollama');
  h.flags.quitting = true;
  await assert.rejects(h.flows.verifyOllamaAccount(), /Déconnexion en cours/);
  h.flags.quitting = false;
  assert.equal(h.count('fetchOllamaCredits'), 2);
  // Vérification partagée entre deux appels concurrents.
  const gate = deferred();
  h.services.fetchOllamaCredits = () => gate.promise;
  const first = h.flows.verifyOllamaAccount();
  await flush();
  assert.equal(h.busy.has('ollama'), true);
  const second = h.flows.verifyOllamaAccount();
  await flush();
  assert.equal(h.count('fetchOllamaCredits'), 3);
  assert.equal(h.flows.pending().length, 1);
  gate.resolve(free);
  const results = await Promise.all([first, second]);
  assert.equal(results[1].connections.ollama.status, 'connected');
  assert.equal(h.busy.size, 0);
  assert.deepEqual(h.flows.pending(), []);
});

test('verifyOllamaAccount pendant la connexion système attend sans effacer la session, puis une erreur transitoire garde le navigateur', async t => {
  clock(t);
  const h = harness();
  const browser = ollamaBrowserDouble({ cookies: [{ name: 'session', value: 'ok' }] });
  h.services.openOllamaBrowser = async () => browser;
  h.p.ollama.accountSession = { kind: 'ollama-credits' };
  await h.flows.openOllamaSystemAccount();
  await assert.rejects(h.flows.verifyOllamaAccount(), { code: 'OLLAMA_LOGIN_PENDING' });
  assert.deepEqual(h.p.ollama.accountSession, { kind: 'ollama-credits' });
  assert.equal(h.flows.info().ollama.status, 'waiting');
  assert.match(h.flows.info().ollama.message, /Termine la connexion Ollama/);
  assert.equal(browser.closed, 0);
  assert.equal(h.count('fetchOllamaCredits'), 0);
  assert.equal(h.count('persist'), 0);
  // Cookies lus mais lecture transitoire : la session reste, le navigateur (déjà fermé côté utilisateur) est remplacé à la relance.
  browser.current = 'verifying';
  h.services.fetchOllamaCredits = async () => { throw coded('OLLAMA_TRANSIENT', 'Connexion à Ollama impossible.'); };
  await assert.rejects(h.flows.verifyOllamaAccount(), { code: 'OLLAMA_TRANSIENT' });
  assert.deepEqual(h.sessions.ollama.cookies.stored, browser.cookies);
  assert.deepEqual(h.p.ollama.accountSession, { kind: 'ollama-credits' });
  assert.deepEqual(h.flows.info().ollama, { status: 'error', message: 'Connexion à Ollama impossible.', errorCode: 'OLLAMA_TRANSIENT' });
  assert.equal(browser.current, 'closed');
  assert.equal(browser.closed, 0);
  const replacement = ollamaBrowserDouble();
  h.services.openOllamaBrowser = async () => replacement;
  await h.flows.openOllamaSystemAccount();
  assert.equal(browser.closed, 1, 'le navigateur précédent est fermé avant la relance');
  assert.equal(h.count('openOllamaBrowser'), 2);
  assert.equal(h.flows.info().ollama.status, 'waiting');
});

test('openOllamaEmailAccount ferme le navigateur système avant d’ouvrir la fenêtre e-mail, et inversement', async t => {
  const { advance } = clock(t);
  const h = harness();
  const browser = ollamaBrowserDouble();
  h.services.openOllamaBrowser = async () => browser;
  await h.flows.openOllamaSystemAccount();
  assert.equal(await h.flows.openOllamaEmailAccount(), true);
  assert.equal(browser.closed, 1);
  assert.equal(h.windows.length, 1);
  assert.equal(h.windows[0].options.webPreferences.partition, 'persist:ollama-account');
  assert.match(h.flows.info().ollama.message, /Connecte-toi sur Ollama\. Les crédits/);
  // Seule la fenêtre déclenche désormais une vérification.
  browser.current = 'verifying';
  h.windows[0].webContents.url = OLLAMA_ORIGIN + '/signin';
  await advance(3000);
  assert.equal(browser.reads, 0);
  assert.equal(h.count('fetchOllamaCredits'), 0);
  // Retour au navigateur système : la fenêtre e-mail est fermée et sa détection arrêtée.
  const second = ollamaBrowserDouble();
  h.services.openOllamaBrowser = async () => second;
  await h.flows.openOllamaSystemAccount();
  assert.equal(h.windows[0].destroyed, true);
  assert.equal(h.flows.info().ollama.status, 'waiting');
  assert.match(h.flows.info().ollama.message, /Chrome ou Edge/);
  // Sans navigateur ouvert, l'appel se réduit à openOllamaAccount.
  await h.flows.cancelOllama();
  assert.equal(await h.flows.openOllamaEmailAccount(), true);
  assert.equal(h.windows.length, 2);
  assert.equal(second.closed, 1);
});

// --- Annulations et fermeture --------------------------------------------------

test('cancelOrca, cancelOllama, cancelClaude et cancelAntigravity ferment, annulent et remettent l’état à idle', async t => {
  const { advance, flush } = clock(t);
  const h = harness();
  // OrcaRouter : fenêtre fermée, détection arrêtée même avec une référence valide.
  await h.flows.openOrcaAccount();
  const orcaWindow = h.windows[0];
  orcaWindow.webContents.scriptResult = { userId: 1, workspaceId: 2 };
  await h.flows.cancelOrca();
  assert.equal(orcaWindow.destroyed, true);
  assert.deepEqual(h.flows.info().orcarouter, idle);
  await advance(3000);
  assert.equal(h.count('fetchWallet'), 0);
  // Ollama : navigateur système fermé et détection arrêtée.
  const browser = ollamaBrowserDouble({ cookies: [{ name: 'session', value: 'ok' }] });
  h.services.openOllamaBrowser = async () => browser;
  await h.flows.openOllamaSystemAccount();
  await h.flows.cancelOllama();
  assert.equal(browser.closed, 1);
  assert.deepEqual(h.flows.info().ollama, idle);
  browser.current = 'verifying';
  await advance(3000);
  assert.equal(browser.reads, 0);
  // Ollama : fenêtre e-mail fermée et détection arrêtée.
  await h.flows.openOllamaAccount();
  const ollamaWindow = h.windows[1];
  ollamaWindow.webContents.url = SETTINGS_URL;
  await h.flows.cancelOllama();
  assert.equal(ollamaWindow.destroyed, true);
  assert.deepEqual(h.flows.info().ollama, idle);
  await advance(3000);
  assert.equal(h.count('fetchOllamaCredits'), 0);
  // Claude et Antigravity : le travail en cours est attendu (même en échec) avant la remise à zéro.
  const claudeGate = deferred();
  h.services.claudeRead = () => claudeGate.promise;
  const claudeWork = h.flows.verifyClaude();
  const antigravityGate = deferred();
  h.services.antigravityRead = () => antigravityGate.promise;
  const antigravityWork = h.flows.verifyAntigravity();
  const settled = Promise.allSettled([claudeWork, antigravityWork]);
  await flush();
  assert.equal(h.flows.pending().length, 2);
  let cancelled = false;
  const cancelling = Promise.all([h.flows.cancelClaude(), h.flows.cancelAntigravity()]).then(() => { cancelled = true; });
  await flush();
  assert.equal(cancelled, false, 'les annulations attendent la fin du travail');
  claudeGate.reject(coded('network', 'Lecture impossible.'));
  antigravityGate.reject(coded('ANTIGRAVITY_NOT_RUNNING', 'Antigravity 2.0 est introuvable sur ce PC.'));
  const outcomes = await settled;
  assert.deepEqual(outcomes.map(item => item.status), ['rejected', 'rejected']);
  await cancelling;
  assert.deepEqual(h.flows.info().claude, idle);
  assert.deepEqual(h.flows.info().antigravity, idle);
  assert.deepEqual(h.flows.pending(), []);
  // Sans travail en cours, les annulations sont immédiates.
  await h.flows.cancelClaude();
  await h.flows.cancelAntigravity();
  await h.flows.cancelOrca();
  await h.flows.cancelOllama();
  assert.deepEqual(h.flows.info(), { claude: idle, antigravity: idle, orcarouter: idle, ollama: idle });
});

test('pending et closeAll attendent les travaux, ferment fenêtres et navigateur, annulent les timers et réinitialisent sur demande', async t => {
  const { advance, flush } = clock(t);
  const h = harness();
  const browser = ollamaBrowserDouble();
  h.services.openOllamaBrowser = async () => browser;
  await h.flows.openOrcaAccount();
  await h.flows.openOllamaSystemAccount();
  const orcaWindow = h.windows[0];
  orcaWindow.webContents.scriptResult = { userId: 1, workspaceId: 2 };
  const walletGate = deferred();
  h.services.fetchWallet = () => walletGate.promise;
  await advance(1000);
  assert.equal(h.count('fetchWallet'), 1);
  const claudeGate = deferred();
  h.services.claudeRead = () => claudeGate.promise;
  const claudeWork = h.flows.verifyClaude();
  await flush();
  assert.equal(h.flows.pending().length, 2, 'vérification OrcaRouter et lecture Claude en cours');
  let closed = false;
  const closing = h.flows.closeAll().then(() => { closed = true; });
  await flush();
  assert.equal(closed, false, 'closeAll attend les travaux en cours');
  assert.equal(orcaWindow.destroyed, false);
  walletGate.reject(coded('ORCA_AUTH', 'Session OrcaRouter expirée.'));
  claudeGate.resolve(claudeSnapshotAt(T0 + 1000));
  await closing;
  await claudeWork;
  assert.equal(orcaWindow.destroyed, true, 'la fenêtre laissée ouverte par ORCA_AUTH est fermée');
  assert.equal(browser.closed, 1);
  assert.equal(h.flows.info().claude.status, 'connected', 'sans reset, les états sont conservés');
  assert.equal(h.flows.info().orcarouter.status, 'error');
  assert.deepEqual(h.flows.pending(), []);
  browser.current = 'verifying';
  await advance(5000);
  assert.equal(browser.reads, 0, 'les timers sont annulés');
  assert.equal(h.count('fetchWallet'), 1);
  await h.flows.closeAll({ reset: true });
  assert.deepEqual(h.flows.info(), { claude: idle, antigravity: idle, orcarouter: idle, ollama: idle });
  // closeWindows tolère une fenêtre qui refuse de se fermer et oublie sa référence.
  await h.flows.openOllamaAccount();
  const stubborn = h.windows[1];
  stubborn.close = () => { throw new Error('déjà détruite'); };
  await h.flows.closeAll();
  assert.equal(stubborn.destroyed, false);
  await h.flows.openOllamaAccount();
  assert.equal(h.windows.length, 3);
});

// Un lancement de navigateur système réarme sa détection (750 ms) après son
// propre await. Une annulation qui nettoie le timer avant d'attendre ce
// lancement laisse donc un timer armé ; dès que la fenêtre e-mail remplace la
// référence (openOllamaAccount), il devient orphelin et interroge tout
// navigateur système ouvert ensuite en plus de sa propre détection.
async function phantomDetectionProbe(t, trigger) {
  const { advance, flush } = clock(t);
  const h = harness();
  const gate = deferred();
  const first = ollamaBrowserDouble();
  h.services.openOllamaBrowser = () => gate.promise;
  const opening = h.flows.openOllamaSystemAccount();
  await flush();
  const duplicate = h.flows.openOllamaSystemAccount();
  await flush();
  assert.equal(h.count('openOllamaBrowser'), 1, 'un lancement en cours est partagé');
  const action = trigger(h);
  await flush();
  gate.resolve(first);
  await Promise.all([opening, duplicate, action]);
  assert.equal(first.closed, 1, 'le navigateur lancé pendant l’action est fermé');
  assert.equal(await h.flows.openOllamaAccount(), true);
  assert.equal(h.windows.length, 1);
  await h.flows.cancelOllama();
  assert.equal(h.windows[0].destroyed, true);
  const next = ollamaBrowserDouble();
  h.services.openOllamaBrowser = async () => next;
  assert.equal(await h.flows.openOllamaSystemAccount(), true);
  await advance(3000);
  assert.equal(next.phaseCalls, 4, 'seule la détection du nouveau navigateur l’interroge (4 × 750 ms)');
  return h;
}

test('cancelOllama pendant le lancement du navigateur n’abandonne aucun timer de détection', async t => {
  await phantomDetectionProbe(t, h => h.flows.cancelOllama());
});

test('openOllamaEmailAccount pendant le lancement du navigateur n’abandonne aucun timer de détection', async t => {
  await phantomDetectionProbe(t, h => h.flows.openOllamaEmailAccount());
});

test('closeAll pendant le lancement du navigateur n’abandonne aucun timer de détection', async t => {
  await phantomDetectionProbe(t, h => h.flows.closeAll());
});

// --- OrcaRouter dans Chrome ou Edge ------------------------------------------------

test('openOrcaAccount ouvre Chrome ou Edge, puis lit la session dès que la fenêtre est fermée', async t => {
  const { advance } = clock(t);
  const h = harness();
  const cookies = [{ url: 'https://www.orcarouter.ai/', name: 'session', value: 'abc', path: '/' }];
  const browser = orcaBrowserDouble({ session: { ref: { userId: 12, workspaceId: 34 }, cookies } });
  h.services.openOrcaBrowser = async () => browser;
  assert.equal(await h.flows.openOrcaAccount(), true);
  assert.deepEqual(h.find('openOrcaBrowser'), ['openOrcaBrowser', DATA_DIR]);
  assert.equal(h.windows.length, 0, 'aucune fenêtre intégrée');
  assert.equal(h.flows.info().orcarouter.status, 'waiting');
  assert.match(h.flows.info().orcarouter.message, /Chrome ou Edge.*GitHub, Google, Microsoft/);
  // Navigateur déjà ouvert : pas de second lancement.
  assert.equal(await h.flows.openOrcaAccount(), true);
  assert.equal(h.count('openOrcaBrowser'), 1);
  // « Vérifier maintenant » pendant la connexion : attente, sans effacer la session.
  await assert.rejects(h.flows.verifyOrcaAccount(), { code: 'ORCA_LOGIN_PENDING' });
  assert.equal(h.flows.info().orcarouter.status, 'waiting');
  await advance(750);
  assert.equal(browser.reads, 1, 'rien d’autre tant que la fenêtre système est ouverte');
  browser.current = 'verifying';
  await advance(750);
  assert.equal(browser.reads, 2);
  assert.deepEqual(h.sessions.orca.cookies.stored, cookies, 'les cookies lus sont copiés dans la session isolée');
  assert.deepEqual(h.find('fetchWallet')[1], { userId: 12, workspaceId: 34 });
  assert.deepEqual(h.p.orcarouter.accountSession, { userId: 12, workspaceId: 34 });
  assert.equal(browser.closed, 1);
  assert.equal(h.flows.info().orcarouter.status, 'connected');
  assert.equal(h.count('showMain'), 1);
  await advance(3000);
  assert.equal(browser.reads, 2, 'la détection s’arrête après la vérification');
  assert.deepEqual(h.flows.pending(), []);
});

test('openOrcaAccount : fenêtre fermée sans connexion, session existante conservée, lecture impossible, recours sans Chrome', async t => {
  const { advance } = clock(t);
  // Sans session enregistrée : explication claire, aucune lecture du portefeuille.
  let h = harness();
  let browser = orcaBrowserDouble({ session: { ref: null, cookies: [] } });
  h.services.openOrcaBrowser = async () => browser;
  await h.flows.openOrcaAccount();
  browser.current = 'verifying';
  await advance(750);
  assert.equal(h.count('fetchWallet'), 0);
  assert.equal(h.flows.info().orcarouter.errorCode, 'ORCA_AUTH');
  assert.match(h.flows.info().orcarouter.message, /Aucune session OrcaRouter détectée/);
  assert.equal(browser.closed, 1);
  // Avec une session enregistrée : elle reste utilisée.
  h = harness();
  h.p.orcarouter.accountSession = { userId: 5, workspaceId: 6 };
  browser = orcaBrowserDouble({ session: { ref: null, cookies: [] } });
  h.services.openOrcaBrowser = async () => browser;
  await h.flows.openOrcaAccount();
  browser.current = 'verifying';
  await advance(750);
  assert.deepEqual(h.find('fetchWallet')[1], { userId: 5, workspaceId: 6 });
  assert.equal(h.flows.info().orcarouter.status, 'connected');
  // Lecture du profil impossible : erreur passagère, session conservée.
  h = harness();
  h.p.orcarouter.accountSession = { userId: 5, workspaceId: 6 };
  browser = orcaBrowserDouble({ readError: new Error('pipe fermé') });
  h.services.openOrcaBrowser = async () => browser;
  await h.flows.openOrcaAccount();
  browser.current = 'verifying';
  await advance(750);
  assert.equal(h.flows.info().orcarouter.errorCode, 'ORCA_TRANSIENT');
  assert.deepEqual(h.p.orcarouter.accountSession, { userId: 5, workspaceId: 6 });
  assert.equal(browser.closed, 1);
  // Sans Chrome ni Edge : la fenêtre intégrée s'ouvre.
  h = harness();
  assert.equal(await h.flows.openOrcaAccount(), true);
  assert.equal(h.windows.length, 1);
  assert.equal(h.find('openOrcaBrowser')[0], 'openOrcaBrowser');
  // cancelOrca ferme le navigateur système.
  h = harness();
  browser = orcaBrowserDouble();
  h.services.openOrcaBrowser = async () => browser;
  await h.flows.openOrcaAccount();
  await h.flows.cancelOrca();
  assert.equal(browser.closed, 1);
  assert.deepEqual(h.flows.info().orcarouter, { status: 'idle', message: '' });
});
