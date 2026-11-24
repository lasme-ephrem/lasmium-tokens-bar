const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSeed } = require('../lib/seed.cjs');
const { removeUnusedProviders, addClaude, normalizeProviderPresentation } = require('../lib/migrations.cjs');
const { removeImportMetadata } = require('../lib/migrations.cjs');
const { normalizeThemeSettings, addApiCooldowns, MAX_API_COOLDOWNS } = require('../lib/migrations.cjs');

test('Import cleanup preserves account sessions, readings and configured billing information', () => {
  const original = createSeed();
  original.importedFrom = 'legacy.xlsx';
  Object.assign(original.providers[0], { importedCost: '103$', notes: 'My plan', amount: 103, renewalDate: '2026-10-05', accountSession: { kind: 'openai-codex' }, snapshot: { quotaRemaining: 96 } });
  Object.assign(original.providers[1], { importedCost: '109,99$', notes: 'Passage à 219,99 $ indiqué ; date du changement et périodicité à préciser.' });
  original.history.push({ providerId: 'openai', quotaRemaining: 96 });
  const before = structuredClone(original);
  const result = removeImportMetadata(original);
  assert.equal(result.changed, true);
  assert.equal(Object.hasOwn(result.state, 'importedFrom'), false);
  assert.ok(result.state.providers.every(p => !Object.hasOwn(p, 'importedCost')));
  const { importedCost, ...expected } = before.providers[0];
  assert.deepEqual(result.state.providers[0], expected);
  assert.equal(result.state.providers[1].notes, '');
  assert.deepEqual(result.state.history, before.history);
  assert.deepEqual(result.state.settings, before.settings);
  assert.deepEqual(original, before);
  assert.equal(removeImportMetadata(result.state).changed, false);
});

test('OrcaRouter is removed in 0.6.17 with its history, health and cooldowns; everything else survives', () => {
  const original = createSeed();
  original.providers.push({ id: 'orcarouter', type: 'api', active: true, accountSession: { userId: 7, workspaceId: 8 }, snapshot: { source: 'api', connectorVersion: 'orca-wallet-v1', balances: [{ currency: 'USD', remaining: 53.2 }] } });
  original.history = [{ providerId: 'orcarouter', balances: [{ remaining: 53.2 }] }, { providerId: 'deepseek', balances: [{ remaining: 8.43 }] }];
  original.connectorHealth = { orcarouter: { state: 'ok' }, deepseek: { state: 'ok' } };
  original.apiCooldowns = { 'orcarouter:empreinte': 1, 'deepseek:empreinte': 2 };
  const before = structuredClone(original);
  const result = removeUnusedProviders(original);
  assert.equal(result.changed, true);
  assert.deepEqual(result.state.providers, before.providers.filter(p => p.id !== 'orcarouter'));
  assert.deepEqual(result.state.history, [before.history[1]]);
  assert.deepEqual(result.state.connectorHealth, { deepseek: { state: 'ok' } });
  assert.deepEqual(result.state.apiCooldowns, { 'deepseek:empreinte': 2 });
  assert.deepEqual(result.state.settings, before.settings);
  assert.deepEqual(original, before, 'la migration ne modifie pas l’état source');
  assert.equal(removeUnusedProviders(result.state).changed, false);
  assert.equal(createSeed().providers.some(p => p.id === 'orcarouter'), false, 'plus proposé aux nouvelles installations');
});

test('Removing unused providers preserves remaining subscriptions, remaining balances, settings and history', () => {
  const original = createSeed();
  original.providers.find(p => p.id === 'openai').plan = 'Personal edited plan';
  original.providers.find(p => p.id === 'deepseek').snapshot = { balances: [{ currency: 'USD', remaining: 8.43 }] };
  original.providers.push({ id: 'tokenrouter', type: 'api' }, { id: 'opencode-zen', type: 'api' }, { id: 'qwen', type: 'subscription' }, { id: 'opencode-go', type: 'subscription' });
  original.history.push({ providerId: 'deepseek', balances: [{ remaining: 8.43 }] }, { providerId: 'openai', quotaRemaining: 62 }, { providerId: 'tokenrouter', balances: [] }, { providerId: 'qwen', balances: [] }, { providerId: 'opencode-go', quotaRemaining: 10 });
  const before = structuredClone(original);
  const result = removeUnusedProviders(original);
  assert.equal(result.changed, true);
  assert.equal(result.state.providers.length, 9);
  assert.deepEqual(result.state.providers, before.providers.slice(0, 9));
  assert.deepEqual(result.state.history, before.history.slice(0, 2));
  assert.deepEqual(result.state.settings, before.settings);
  assert.deepEqual(original, before);
  assert.equal(removeUnusedProviders(result.state).changed, false);
});
test('Removing Gemini web preserves other accounts and drops the obsolete strategy engine', () => {
  const state=createSeed();
  state.providers.push({id:'gemini',accountSession:{kind:'subscription-browser'},snapshot:{quotaRemaining:100}});
  state.history=[{providerId:'gemini',quotaRemaining:100},{providerId:'antigravity',quotaRemaining:72}];
  state.strategy={enabled:false,contributor:false,inputTokens:4321,disabledRoutes:['openrouter:luna'],subscriptionModels:{gemini:'geminiFlash',ollama:'kimi','antigravity-gemini':'geminiFlash'}};
  const before=structuredClone(state), result=removeUnusedProviders(state);
  assert.equal(result.changed,true);
  assert.equal(result.state.providers.length,9);
  assert.deepEqual(result.state.providers,before.providers.filter(p=>p.id!=='gemini'));
  assert.deepEqual(result.state.history,[before.history[1]]);
  // La fonctionnalité d'ordre de consommation est retirée : le champ disparaît.
  assert.equal(Object.hasOwn(result.state,'strategy'),false);
  assert.deepEqual(result.state.settings,before.settings);
  assert.equal(removeUnusedProviders(result.state).changed,false);
  assert.deepEqual(state,before);
});
test('Obsolete recommendation strategy is dropped non-destructively from existing inventories', () => {
  const state=createSeed();
  state.providers.find(p=>p.id==='openai').notes='Conservé';
  state.history=[{id:'h1',providerId:'openai',quotaRemaining:80}];
  // Forme historique complète, y compris un modèle Gemini devenu caduc.
  state.strategy={enabled:true,contributor:false,inputTokens:20000,outputTokens:2000,cachePercent:10,disabledRoutes:['openrouter:luna'],subscriptionModels:{gemini:'geminiFlash',openai:'astra'}};
  const before=structuredClone(state), result=removeUnusedProviders(state);
  assert.equal(result.changed,true);
  assert.equal(Object.hasOwn(result.state,'strategy'),false);
  // Rien d'autre n'est modifié : inventaire, historique, réglages et champs libres.
  assert.deepEqual(result.state.providers,before.providers);
  assert.deepEqual(result.state.history,before.history);
  assert.deepEqual(result.state.settings,before.settings);
  assert.deepEqual(result.state.apiCooldowns,before.apiCooldowns);
  assert.equal(result.state.providers.find(p=>p.id==='openai').notes,'Conservé');
  assert.equal(Object.hasOwn(result.state,'strategy'),false);
  assert.equal(removeUnusedProviders(result.state).changed,false);
  assert.deepEqual(state,before);
});
test('Adding Claude to older inventory preserves account settings, history and unknown fields', () => {
  const state=createSeed();
  state.providers=state.providers.filter(p=>p.id!=='claude');
  state.providers.find(p=>p.id==='zai').subscriptionStatus='expired';
  state.history=[{providerId:'zai',quotaRemaining:21}];
  const before=structuredClone(state), result=addClaude(state);
  assert.equal(result.changed,true);
  assert.equal(result.state.providers.length,9);
  assert.deepEqual(result.state.providers.filter(p=>p.id!=='claude'),before.providers);
  assert.deepEqual(result.state.history,before.history);
  assert.deepEqual(result.state.settings,before.settings);
  assert.equal(addClaude(result.state).changed,false);
});

test('0.6.19 : RunInfra devient RightNow sans toucher à la clé, au relevé ni à l’historique', () => {
  const state = createSeed();
  const runinfra = state.providers.find(p => p.id === 'runinfra');
  Object.assign(runinfra, { name: 'RunInfra', monogram: 'R', color: '#efa793', active: true, snapshot: { balances: [{ currency: 'USD', remaining: 5.97 }] }, spending: { startAmount: 5 } });
  state.history = [{ providerId: 'runinfra', balances: [{ remaining: 5.97 }] }];
  const before = structuredClone(state), result = normalizeProviderPresentation(state);
  assert.equal(result.changed, true);
  const after = result.state.providers.find(p => p.id === 'runinfra');
  assert.deepEqual({ name: after.name, monogram: after.monogram, color: after.color }, { name: 'RightNow', monogram: 'RN', color: '#76b900' });
  assert.deepEqual({ ...after, name: 'RunInfra', monogram: 'R', color: '#efa793' }, before.providers.find(p => p.id === 'runinfra'));
  assert.deepEqual(result.state.history, before.history);
  assert.deepEqual(state, before);
  assert.equal(normalizeProviderPresentation(result.state).changed, false);
  assert.equal(createSeed().providers.find(p => p.id === 'runinfra').name, 'RightNow');
});

test('Provider presentation migration reorders subscriptions and renames without touching accounts or usage', () => {
  const state = createSeed();
  state.providers.reverse();
  state.providers.find(p => p.id === 'claude').name = 'Claude Pro';
  state.providers.find(p => p.id === 'openai').name = 'OpenAI';
  state.providers.find(p => p.id === 'grok').name = 'Grok';
  for (const p of state.providers) {
    p.accountSession = { kind: 'existing-session' };
    p.snapshot = { quotaRemaining: 83, updatedAt: '2026-09-27T11:00:00Z' };
    p.manualResets = { Semaine: { date: '2026-10-01' } };
  }
  state.history = [{ providerId: 'claude', quotaRemaining: 83 }];
  const before = structuredClone(state), result = normalizeProviderPresentation(state);
  assert.equal(result.changed, true);
  assert.deepEqual(result.state.providers.slice(0, 6).map(p => p.id), ['openai','claude','grok','antigravity','zai','ollama']);
  assert.deepEqual(result.state.providers.slice(0, 6).map(p => p.name), ['OpenAI GPT','Anthropic Claude','xAI Grok','Antigravity','Z.ai','Ollama']);
  assert.deepEqual(result.state.providers.filter(p => p.type === 'api'), before.providers.filter(p => p.type === 'api'));
  for (const p of result.state.providers) {
    const original = before.providers.find(o => o.id === p.id);
    assert.deepEqual({ ...p, name: original.name }, original);
  }
  assert.deepEqual(result.state.history, before.history);
  assert.deepEqual(state, before);
  assert.equal(normalizeProviderPresentation(result.state).changed, false);
});

test('Theme migration keeps explicit light/dark choices and only defaults invalid values', () => {
  const light = createSeed();
  light.settings.theme = 'light';
  const before = structuredClone(light);
  assert.deepEqual(normalizeThemeSettings(light), { changed: false, state: light });
  assert.deepEqual(light, before);

  const dark = createSeed();
  dark.settings.theme = 'dark';
  assert.equal(normalizeThemeSettings(dark).changed, false);

  const legacy = createSeed();
  delete legacy.settings.theme;
  const defaulted = normalizeThemeSettings(legacy);
  assert.equal(defaulted.changed, true);
  assert.equal(defaulted.state.settings.theme, 'system');
  assert.equal(defaulted.state.settings.autoRefresh, legacy.settings.autoRefresh);
  assert.equal(Object.hasOwn(legacy.settings, 'theme'), false);
  assert.equal(normalizeThemeSettings(defaulted.state).changed, false);
});

test('API cooldown migration seeds an empty object and preserves valid entries without secrets', () => {
  const fresh = createSeed();
  delete fresh.apiCooldowns;
  const seeded = addApiCooldowns(fresh);
  assert.equal(seeded.changed, true);
  assert.deepEqual(seeded.state.apiCooldowns, {});
  assert.equal(addApiCooldowns(seeded.state).changed, false);

  const state = createSeed();
  state.apiCooldowns = { 'openrouter:abcdef': 1767225600000, 'deepseek:ghijkl': 1767229200000 };
  const preserved = addApiCooldowns(state);
  assert.equal(preserved.changed, false);
  assert.deepEqual(preserved.state.apiCooldowns, state.apiCooldowns);

  const oversized = Object.fromEntries(Array.from({ length: MAX_API_COOLDOWNS + 20 }, (_v, i) => [`key-${i}:x`, 1_767_225_600_000 + i]));
  const capped = addApiCooldowns({ ...createSeed(), apiCooldowns: oversized });
  assert.equal(capped.changed, true);
  assert.equal(Object.keys(capped.state.apiCooldowns).length, MAX_API_COOLDOWNS);
  assert.equal(Object.hasOwn(capped.state.apiCooldowns, `key-${MAX_API_COOLDOWNS + 19}:x`), true);
  assert.equal(Object.hasOwn(capped.state.apiCooldowns, 'key-0:x'), false);
});

test('0.6.9 : la fiche ne garde que forfait, prix, fréquence et échéance, sans toucher aux sessions ni aux relevés', () => {
  const { simplifySubscriptionFields } = require('../lib/migrations.cjs');
  const state = createSeed();
  const openai = state.providers.find(p => p.id === 'openai');
  Object.assign(openai, { plan: 'Plus', amount: 20, billingCycle: 'monthly', renewalDate: '2026-12-04', notes: 'note', statusMessage: 'msg',
    reviewed: true, nextAmount: 25, priceChangeDate: '2027-01-01', manualResets: { Semaine: { date: '2026-12-01' } },
    accountSession: { kind: 'openai-codex' }, snapshot: { source: 'api', updatedAt: 't', balances: [] } });
  const grok = state.providers.find(p => p.id === 'grok');
  Object.assign(grok, { subscriptionStatus: 'paused', active: true });
  const ollama = state.providers.find(p => p.id === 'ollama');
  Object.assign(ollama, { subscriptionStatus: 'paused' });
  const deepseek = state.providers.find(p => p.id === 'deepseek');
  deepseek.active = false;
  const result = simplifySubscriptionFields(state);
  assert.equal(result.changed, true);
  const migrated = Object.fromEntries(result.state.providers.map(p => [p.id, p]));
  for (const field of ['notes', 'statusMessage', 'reviewed', 'nextAmount', 'priceChangeDate', 'manualResets']) {
    assert.equal(field in migrated.openai, false, field);
  }
  assert.deepEqual([migrated.openai.plan, migrated.openai.amount, migrated.openai.billingCycle, migrated.openai.renewalDate], ['Plus', 20, 'monthly', '2026-12-04']);
  assert.deepEqual(migrated.openai.accountSession, { kind: 'openai-codex' });
  assert.equal(migrated.openai.snapshot.source, 'api');
  assert.deepEqual([migrated.grok.subscriptionStatus, migrated.grok.active], ['expired', false], 'en pause → « je n’ai plus cet abonnement »');
  assert.deepEqual([migrated.ollama.subscriptionStatus, migrated.ollama.active], ['expired', true], 'Ollama reste suivi en Free');
  assert.equal(migrated.deepseek.active, true, 'un accès API revient dans le suivi : sa fiche ne garde que la clé');
  assert.equal(state.providers.find(p => p.id === 'openai').notes, 'note', 'l’état d’origine n’est pas modifié');
  assert.deepEqual(simplifySubscriptionFields(result.state), { changed: false, state: result.state }, 'migration idempotente');
});

test('0.6.8 : une ancienne session Claude Desktop devient la connexion à l’abonnement dès le chargement', () => {
  const { convertClaudeSession } = require('../lib/migrations.cjs');
  const state = createSeed();
  const claude = state.providers.find(p => p.id === 'claude');
  claude.accountSession = { kind: 'claude-desktop-local', resumeLiveAfter: '2026-11-05T12:00:00.000Z' };
  claude.snapshot = { source: 'api', updatedAt: 't', quotaWindows: [] };
  const result = convertClaudeSession(state);
  assert.equal(result.changed, true);
  const migrated = result.state.providers.find(p => p.id === 'claude');
  assert.deepEqual(migrated.accountSession, { kind: 'claude-live-local' });
  assert.equal(migrated.snapshot, claude.snapshot, 'le dernier relevé reste affiché');
  assert.deepEqual(convertClaudeSession(result.state), { changed: false, state: result.state });
  const untouched = createSeed();
  assert.equal(convertClaudeSession(untouched).changed, false, 'Claude non connecté : rien à convertir');
});
