const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createDataStore, HISTORY_LIMIT, STATE_FILE, trimHistory } = require('../lib/data-store.cjs');
const { createSeed } = require('../lib/seed.cjs');
const { normalizeThemeSettings, addApiCooldowns, addConnectorHealth } = require('../lib/migrations.cjs');

async function withTestDir(prefix, run) {
  const projectRoot = await fs.realpath(path.resolve(__dirname, '..'));
  const results = path.join(projectRoot, 'test-results');
  await fs.mkdir(results, { recursive: true });
  const realResults = await fs.realpath(results);
  const dir = await fs.mkdtemp(path.join(realResults, prefix));
  assert.equal(path.dirname(dir), realResults);
  try { return await run(dir); }
  finally {
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), realResults);
    assert.ok(path.basename(target).startsWith(prefix));
    await fs.rm(target, { recursive: true, force: true });
  }
}

async function readState(dataDir) {
  return JSON.parse(await fs.readFile(path.join(dataDir, STATE_FILE), 'utf8'));
}

async function writeState(dataDir, state) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, STATE_FILE), JSON.stringify(state));
}

function legacyState() {
  const state = createSeed();
  state.providers = state.providers.filter(provider => provider.id !== 'claude');
  state.providers.push({ id: 'gemini', name: 'Gemini', type: 'subscription', active: true, subscriptionStatus: 'active', snapshot: null });
  state.providers.find(provider => provider.id === 'openai').importedCost = '103$';
  state.providers[0].notes = 'Tarif, offre et échéance non renseignés.';
  // OrcaRouter (retiré en 0.6.17) tel qu'enregistré par la 0.6.16.
  state.providers.push({ id: 'orcarouter', name: 'OrcaRouter', type: 'api', active: true, accountSession: { userId: 7, workspaceId: 8 }, snapshot: { source: 'api', connectorVersion: 'orca-wallet-v1', balances: [{ currency: 'USD', remaining: 20 }] } });
  state.connectorHealth = { orcarouter: { state: 'ok' } };
  state.importedFrom = 'legacy.xlsx';
  state.settings.theme = 'light';
  delete state.apiCooldowns;
  state.history = [
    { id: 'gemini-old', providerId: 'gemini', quotaRemaining: 100 },
    { id: 'orca-old', providerId: 'orcarouter', source: 'api', connectorVersion: 'orca-wallet-v1', balances: [{ currency: 'USD', remaining: 20 }] },
    { id: 'zai-kept', providerId: 'zai', quotaRemaining: 40 },
  ];
  return state;
}

test('a first launch creates, persists and reloads the seeded inventory', async () => {
  await withTestDir('data-store-', async dir => {
    const store = createDataStore({ dataDir: dir });
    const loaded = await store.load();
    assert.equal(loaded.created, true);
    assert.equal(loaded.legacyGeminiProfile, false);
    assert.equal(loaded.legacyOrcaRouter, false);
    assert.equal(loaded.state.providers.length, 9);
    assert.equal(loaded.state.settings.theme, 'system');
    assert.deepEqual(loaded.state.apiCooldowns, {});

    const persisted = await readState(dir);
    assert.equal(persisted.providers.length, 9);
    assert.equal(persisted.version, 1);

    const again = await createDataStore({ dataDir: dir }).load();
    assert.equal(again.created, false);
    assert.deepEqual(again.state.providers.map(provider => provider.id), persisted.providers.map(provider => provider.id));
  });
});

test('atomic writes are serialized, leave no temporary file and settle before shutdown', async () => {
  await withTestDir('data-store-', async dir => {
    const store = createDataStore({ dataDir: dir });
    const first = { value: 1 };
    await store.persist(first);
    first.value = 2;
    await store.persist(first);
    await store.settle();
    assert.deepEqual(await readState(dir), { value: 2 });
    assert.deepEqual((await fs.readdir(dir)).filter(name => name.endsWith('.tmp')), []);

    await store.atomicWrite('credentials.json', { openrouter: 'base64-value' });
    assert.deepEqual(await store.readJSON('credentials.json'), { openrouter: 'base64-value' });
    assert.equal(await store.readJSON('absent.json'), null);
    await store.settle();
    assert.equal(await store.readJSON('absent.json'), null);

    await store.remove('credentials.json');
    assert.equal(await store.readJSON('credentials.json'), null);
  });
});

test('migrations run once, keep explicit light theme and write minimal backups with `wx`', async () => {
  await withTestDir('data-store-', async dir => {
    await writeState(dir, legacyState());
    const store = createDataStore({ dataDir: dir });
    const loaded = await store.load();

    assert.equal(loaded.legacyGeminiProfile, true);
    assert.equal(loaded.legacyOrcaRouter, true, 'main.cjs efface alors la session et le profil OrcaRouter');
    assert.equal(loaded.state.providers.some(provider => provider.id === 'orcarouter'), false);
    assert.deepEqual(Object.keys(loaded.state.connectorHealth), []);
    assert.equal(loaded.state.providers.some(provider => provider.id === 'gemini'), false);
    assert.equal(loaded.state.providers.some(provider => provider.id === 'claude'), true);
    assert.equal(loaded.state.providers.length, 9);
    assert.equal(Object.hasOwn(loaded.state, 'importedFrom'), false);
    assert.equal(loaded.state.providers.some(provider => Object.hasOwn(provider, 'importedCost')), false);
    // Choix explicite conservé, cooldowns initialisés sans perte.
    assert.equal(loaded.state.settings.theme, 'light');
    assert.deepEqual(loaded.state.apiCooldowns, {});
    assert.deepEqual(loaded.state.history.map(entry => entry.id), ['zai-kept']);

    const backupNames = ['state.before-subscription-removal.json'];
    assert.equal((await store.readJSON('state.before-subscription-removal.json')).providers.some(provider => provider.id === 'orcarouter'), true, 'copie intégrale avant retrait');
    for (const name of backupNames) assert.equal(await store.readJSON(name) !== null, true, name);
    const backupsBefore = new Map();
    for (const name of backupNames) backupsBefore.set(name, { contents: await fs.readFile(path.join(dir, name), 'utf8'), time: (await fs.stat(path.join(dir, name))).mtimeMs });

    const reloaded = await createDataStore({ dataDir: dir }).load();
    assert.equal(reloaded.legacyGeminiProfile, false);
    assert.equal(reloaded.legacyOrcaRouter, false);
    assert.equal(reloaded.state.settings.theme, 'light');
    assert.deepEqual(reloaded.state.providers.map(provider => provider.id), loaded.state.providers.map(provider => provider.id));
    for (const name of backupNames) {
      const after = { contents: await fs.readFile(path.join(dir, name), 'utf8'), time: (await fs.stat(path.join(dir, name))).mtimeMs };
      assert.equal(after.contents, backupsBefore.get(name).contents, `${name} ne doit jamais être écrasé`);
      assert.equal(after.time, backupsBefore.get(name).time);
    }
  });
});

test('an unknown or corrupt state file refuses to load instead of being reset', async () => {
  await withTestDir('data-store-', async dir => {
    await fs.writeFile(path.join(dir, 'state.json'), '{ pas du json');
    await assert.rejects(createDataStore({ dataDir: dir }).load());
    assert.equal(await fs.readFile(path.join(dir, 'state.json'), 'utf8'), '{ pas du json');

    const future = { ...createSeed(), version: 2 };
    await writeState(dir, future);
    await assert.rejects(createDataStore({ dataDir: dir }).load(), /Format de données non reconnu/);
    assert.equal((await readState(dir)).version, 2);
  });
});

test('history is capped and trimmed from the oldest entries', async () => {
  await withTestDir('data-store-', async dir => {
    assert.equal(HISTORY_LIMIT, 20000);
    assert.deepEqual(trimHistory([1, 2, 3], 2), [1, 2]);
    assert.deepEqual(trimHistory(undefined, 2), undefined);

    const state = createSeed();
    state.history = Array.from({ length: HISTORY_LIMIT + 5 }, (_value, index) => ({ id: `entry-${index}`, providerId: 'openai' }));
    await writeState(dir, state);
    const loaded = await createDataStore({ dataDir: dir }).load();
    assert.equal(loaded.state.history.length, HISTORY_LIMIT);
    assert.equal(loaded.state.history[0].id, 'entry-0');
    assert.equal(loaded.state.history.at(-1).id, `entry-${HISTORY_LIMIT - 1}`);
    assert.equal((await readState(dir)).history.length, HISTORY_LIMIT);
  });
});

test('theme and cooldown migrations are non-destructive and idempotent', () => {
  const state = createSeed();
  assert.deepEqual(normalizeThemeSettings(state), { changed: false, state });

  const legacy = { ...createSeed(), settings: { ...createSeed().settings, theme: 'light' } };
  assert.deepEqual(normalizeThemeSettings(legacy), { changed: false, state: legacy });

  const invalid = { ...createSeed(), settings: { ...createSeed().settings, theme: 'neon' } };
  const normalized = normalizeThemeSettings(invalid);
  assert.equal(normalized.changed, true);
  assert.equal(normalized.state.settings.theme, 'system');
  assert.equal(invalid.settings.theme, 'neon');

  const withCooldowns = { ...createSeed(), apiCooldowns: { 'openrouter:fingerprint': 1000, 'deepseek:other': 2000 } };
  const kept = addApiCooldowns(withCooldowns);
  assert.equal(kept.changed, false);
  assert.deepEqual(kept.state.apiCooldowns, { 'openrouter:fingerprint': 1000, 'deepseek:other': 2000 });

  const polluted = { ...createSeed(), apiCooldowns: { 'openrouter:fingerprint': 1000, broken: 'soon', negative: -5 } };
  const cleaned = addApiCooldowns(polluted);
  assert.equal(cleaned.changed, true);
  assert.deepEqual(cleaned.state.apiCooldowns, { 'openrouter:fingerprint': 1000 });
  assert.equal(addApiCooldowns(cleaned.state).changed, false);

  const bounded = { ...createSeed(), apiCooldowns: Object.fromEntries(Array.from({ length: 150 }, (_value, index) => [`key-${index}:x`, index + 1])) };
  const capped = addApiCooldowns(bounded);
  assert.equal(capped.changed, true);
  assert.equal(Object.keys(capped.state.apiCooldowns).length, 100);
  assert.equal(Object.hasOwn(capped.state.apiCooldowns, 'key-149:x'), true);
  assert.equal(Object.hasOwn(capped.state.apiCooldowns, 'key-0:x'), false);

  const health = { providerId: 'claude', state: 'ok', lastSuccessAt: '2026-11-04T00:00:00.000Z' };
  assert.equal(addConnectorHealth(createSeed()).changed, false);
  const withoutHealth = { ...createSeed() };
  delete withoutHealth.connectorHealth;
  assert.deepEqual(addConnectorHealth(withoutHealth), { changed: true, state: { ...withoutHealth, connectorHealth: {} } });
  const pollutedHealth = { ...createSeed(), connectorHealth: { claude: health, broken: { state: 'nope' }, empty: null } };
  const cleanedHealth = addConnectorHealth(pollutedHealth);
  assert.equal(cleanedHealth.changed, true);
  assert.deepEqual(cleanedHealth.state.connectorHealth, { claude: health });
  assert.equal(addConnectorHealth(cleanedHealth.state).changed, false);
});

test('0.6.9 : une copie intégrale précède le retrait des champs saisis à la main', async () => {
  await withTestDir('data-store-', async dir => {
    const state = createSeed();
    Object.assign(state.providers.find(provider => provider.id === 'openai'), { notes: 'à garder en copie', reviewed: true, nextAmount: 25 });
    await writeState(dir, state);
    const loaded = await createDataStore({ dataDir: dir }).load();
    const openai = loaded.state.providers.find(provider => provider.id === 'openai');
    assert.equal('notes' in openai, false);
    assert.equal('nextAmount' in openai, false);
    const copy = await createDataStore({ dataDir: dir }).readJSON('state.before-0.6.9-simplification.json');
    assert.equal(copy.providers.find(provider => provider.id === 'openai').notes, 'à garder en copie');
    // Un état déjà simplifié ne produit aucune nouvelle copie.
    const again = await createDataStore({ dataDir: dir }).load();
    assert.equal('notes' in again.state.providers.find(provider => provider.id === 'openai'), false);
  });
});
