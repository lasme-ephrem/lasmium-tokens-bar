// publicState() (main.cjs) sans Electron : la fonction est extraite de la source
// puis reconstruite avec ses dépendances simulées, afin de vérifier l'objet
// réellement exposé au renderer — clés et leur ordre, historique résumé,
// traitement spécial d'Ollama (usageCredits) et de la santé (publicHealth),
// lien de compte par fournisseur et ordre d'évaluation des lectures.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');

// Extrait `function <name>(…) { … }` par équilibrage des accolades : le corps de
// publicState() ne contient ni chaîne ni gabarit avec accolade.
function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `fonction ${name} introuvable dans main.cjs`);
  assert.equal(source.lastIndexOf(marker), start, `fonction ${name} définie plusieurs fois dans main.cjs`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`fonction ${name} incomplète dans main.cjs`);
}

// Variables libres de publicState() dans main.cjs, fournies par le contexte simulé.
const DEPENDENCIES = [
  'state', 'providerFlows', 'updater', 'connectorPacks', 'connectorPackErrors', 'packSummary',
  'lastKnownUsageCredits', 'connectionInfo', 'isConnected', 'busy', 'publicHealth', 'openAiAccount',
  'connectors', 'subscriptionAccounts', 'summary', 'publicAppInfo', 'apiSpending',
];

function buildPublicState(context) {
  const factory = new Function(...DEPENDENCIES, `return (${extractFunction('publicState')});`);
  return factory(...DEPENDENCIES.map(name => context[name]));
}

function fakeContext() {
  const calls = [];
  const history = [{ id: 'h2', providerId: 'ollama' }, { id: 'h1', providerId: 'openai' }];
  const state = {
    providers: [
      { id: 'ollama', name: 'Ollama', snapshot: { updatedAt: 't1', usageCredits: 9 } },
      { id: 'openai', name: 'OpenAI', snapshot: { updatedAt: 't2' } },
      { id: 'grok', name: 'Grok', snapshot: null },
      { id: 'openrouter', name: 'OpenRouter' },
      { id: 'claude' },
      { id: 'antigravity' },
    ],
    history,
    settings: { theme: 'dark' },
    connectorHealth: { ollama: { ok: true }, openai: { ok: false } },
    strategy: { obsolete: true },
  };
  return {
    calls,
    state,
    providerFlows: { info: () => { calls.push('providerFlows.info'); return { antigravity: 'flow-antigravity', claude: 'flow-claude', ollama: 'flow-ollama' }; } },
    updater: { info: () => { calls.push('updater.info'); return { status: 'idle' }; } },
    connectorPacks: new Map([['openrouter', {}]]),
    connectorPackErrors: [{ file: 'a.json', provider: undefined, reason: 'r1', extra: 'ignoré' }, { file: 'b.json', provider: 'grok', reason: 'r2' }],
    packSummary: packs => { calls.push('packSummary'); return { count: packs.size }; },
    lastKnownUsageCredits: (snapshot, entries) => { calls.push('lastKnownUsageCredits'); return `credits:${snapshot.usageCredits}:${entries.length}`; },
    connectionInfo: id => { calls.push(`connectionInfo:${id}`); return { id, mode: 'info' }; },
    isConnected: p => { calls.push(`isConnected:${p.id}`); return p.id === 'openai'; },
    busy: new Set(['grok']),
    publicHealth: (health, snapshot) => { calls.push('publicHealth'); return { health: health ?? null, hasSnapshot: Boolean(snapshot) }; },
    openAiAccount: { info: () => { calls.push('openAiAccount.info'); return { identity: 'openai-account' }; } },
    connectors: { grok: { browserAccount: true }, openrouter: { browserAccount: false }, openai: {}, ollama: {} },
    subscriptionAccounts: { info: id => { calls.push(`subscriptionAccounts.info:${id}`); return { browser: id }; } },
    summary: (providers, _now, options) => { calls.push('summary'); return { total: providers.length, api: options.apiSpending }; },
    apiSpending: {
      providerSpending: p => { calls.push(`providerSpending:${p.id}`); return { total: 10 }; },
      spendingSummary: () => { calls.push('spendingSummary'); return { month: { USD: 10 } }; },
    },
    publicAppInfo: () => { calls.push('publicAppInfo'); return { version: '1.2.3' }; },
  };
}

test('publicState expose l’état sans historique ni stratégie, avec les clés attendues dans l’ordre', () => {
  const context = fakeContext();
  const result = buildPublicState(context)();
  assert.deepEqual(Object.keys(result), [
    'providers', 'settings', 'connectorHealth', 'app', 'update', 'connectorPacks', 'connectorPackErrors',
    'historyCount', 'historyRevision', 'summary', 'desktop',
  ]);
  assert.equal('history' in result, false);
  assert.equal('strategy' in result, false);
  assert.deepEqual(result.settings, { theme: 'dark' });
  assert.deepEqual(result.app, { version: '1.2.3' });
  assert.deepEqual(result.update, { status: 'idle' });
  assert.deepEqual(result.connectorPacks, { count: 1 });
  assert.deepEqual(result.connectorPackErrors, [{ file: 'a.json', provider: null, reason: 'r1' }, { file: 'b.json', provider: 'grok', reason: 'r2' }]);
  assert.equal(result.historyCount, 2);
  assert.equal(result.historyRevision, 'h2');
  assert.deepEqual(result.summary, { total: 6, api: { month: { USD: 10 } } }, 'le résumé inclut les dépenses API du mois');
  assert.equal(result.desktop, true);
  // L'état en mémoire n'est jamais modifié : historique et champ obsolète restent en place.
  assert.equal(context.state.history.length, 2);
  assert.deepEqual(context.state.strategy, { obsolete: true });
});

test('publicState : historique vide → révision nulle', () => {
  const context = fakeContext();
  context.state.history = [];
  const result = buildPublicState(context)();
  assert.equal(result.historyCount, 0);
  assert.equal(result.historyRevision, null);
});

test('publicState présente chaque fournisseur : connecteur, connexion, synchronisation, santé et lien de compte', () => {
  const context = fakeContext();
  const providers = buildPublicState(context)().providers;
  const byId = Object.fromEntries(providers.map(p => [p.id, p]));
  assert.deepEqual(providers.map(p => p.id), ['ollama', 'openai', 'grok', 'openrouter', 'claude', 'antigravity']);

  // Ollama : usageCredits recalculé depuis l'historique, le reste du relevé conservé.
  assert.deepEqual(byId.ollama, {
    id: 'ollama', name: 'Ollama',
    snapshot: { updatedAt: 't1', usageCredits: 'credits:9:2' },
    connector: { id: 'ollama', mode: 'info' }, connected: false, syncing: false,
    health: { health: { ok: true }, hasSnapshot: true },
    accountConnection: 'flow-ollama',
  });
  assert.deepEqual(Object.keys(byId.ollama), ['id', 'name', 'snapshot', 'connector', 'connected', 'syncing', 'health', 'accountConnection']);
  assert.notEqual(byId.ollama.snapshot, context.state.providers[0].snapshot, 'le relevé Ollama est copié, pas modifié en place');
  assert.equal(context.state.providers[0].snapshot.usageCredits, 9);

  // Les autres relevés sont transmis tels quels (même référence).
  assert.equal(byId.openai.snapshot, context.state.providers[1].snapshot);
  assert.equal(byId.openai.connected, true);
  assert.deepEqual(byId.openai.health, { health: { ok: false }, hasSnapshot: true });
  assert.deepEqual(byId.openai.accountConnection, { identity: 'openai-account' });

  // Lecteur de compte web : syncing suit `busy`, la santé tolère l'absence de relevé.
  assert.equal(byId.grok.syncing, true);
  assert.equal(byId.grok.snapshot, null);
  assert.deepEqual(byId.grok.health, { health: null, hasSnapshot: false });
  assert.deepEqual(byId.grok.accountConnection, { browser: 'grok' });

  // Ni parcours dédié ni compte web : aucune clé accountConnection.
  assert.equal('accountConnection' in byId.openrouter, false);
  assert.deepEqual(Object.keys(byId.openrouter), ['id', 'name', 'connector', 'connected', 'syncing', 'health']);

  // Suivi des dépenses API : totaux exposés seulement quand le suivi existe.
  context.state.providers[3].spending = { startAmount: 10 };
  const tracked = buildPublicState(context)().providers.find(p => p.id === 'openrouter');
  assert.deepEqual(tracked.spendingTotals, { total: 10 });

  assert.equal(byId.claude.accountConnection, 'flow-claude');
  assert.equal(byId.antigravity.accountConnection, 'flow-antigravity');
});

test('publicState lit ses dépendances dans un ordre stable', () => {
  const context = fakeContext();
  buildPublicState(context)();
  assert.deepEqual(context.calls, [
    'providerFlows.info', 'publicAppInfo', 'updater.info', 'packSummary',
    'lastKnownUsageCredits', 'connectionInfo:ollama', 'isConnected:ollama', 'publicHealth',
    'connectionInfo:openai', 'isConnected:openai', 'publicHealth', 'openAiAccount.info',
    'connectionInfo:grok', 'isConnected:grok', 'publicHealth', 'subscriptionAccounts.info:grok',
    'connectionInfo:openrouter', 'isConnected:openrouter', 'publicHealth',
    'connectionInfo:claude', 'isConnected:claude', 'publicHealth',
    'connectionInfo:antigravity', 'isConnected:antigravity', 'publicHealth',
    'spendingSummary', 'summary',
  ]);
});
