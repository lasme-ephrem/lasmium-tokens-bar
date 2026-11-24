'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUpdater, MAX_MANIFEST_BYTES } = require('../lib/updater.cjs');
const { signManifest } = require('../lib/update-manifest.cjs');
const { buildZip } = require('./helpers/zip-writer.cjs');

// Aucun réseau ni PowerShell : le manifeste et l'archive sont servis par un
// `fetch` simulé, l'archive est bâtie en JavaScript pur, la plate-forme
// Windows est injectée et `spawn` est enregistré au lieu d'être exécuté.

const repositoryRoot = path.resolve(__dirname, '..');
const MANIFEST_URL = 'https://example.test/latest.json';
const CHECK_TIMEOUT_MS = 20000;

function workspace(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Sous Windows, un descripteur peut se refermer juste après le test : on réessaie.
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

function setup() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const manifest = {
    schemaVersion: 1,
    version: '0.6.0',
    minApp: '0.5.0',
    publishedAt: '2026-11-05T10:00:00.000Z',
    notes: 'Nouveautés.',
    asset: {
      name: 'LasmiumTokensHub-0.6.0-win32-x64.zip',
      url: 'https://example.test/LasmiumTokensHub-0.6.0-win32-x64.zip',
      sha256: 'b'.repeat(64),
      size: 100,
    },
  };
  manifest.signature = signManifest(manifest, privateKey);
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  return { manifest, publicPem, privateKey };
}

function fakeFetch(manifest) {
  return async url => ({
    ok: true,
    status: 200,
    url,
    headers: { get: () => null },
    arrayBuffer: async () => Buffer.from(JSON.stringify(manifest)),
  });
}

function updater(t, overrides = {}) {
  const dataDir = workspace(t, 'lasmium-update-');
  return createUpdater({
    currentVersion: '0.5.0',
    manifestUrl: MANIFEST_URL,
    publicKey: overrides.publicKey,
    dataDir,
    targetRoot: dataDir,
    fetchImpl: fakeFetch(overrides.manifest),
    ...overrides,
  });
}

// Archive portable minimale, de même forme que le ZIP de release : une racine
// `LasmiumTokensHub-<version>-win32-x64/` avec l'exécutable et
// resources/app/main.cjs.
function packageBytes(version = '0.6.0', { withData = false } = {}) {
  const base = `LasmiumTokensHub-${version}-win32-x64`;
  const entries = [
    { name: `${base}/` },
    { name: `${base}/LasmiumTokensHub.exe`, data: 'exe' },
    { name: `${base}/resources/` },
    { name: `${base}/resources/app/` },
    { name: `${base}/resources/app/main.cjs`, data: 'main' },
  ];
  if (withData) entries.push({ name: `${base}/data/` }, { name: `${base}/data/state.json`, data: '{}' });
  return buildZip(entries);
}

// Manifeste signé cohérent avec l'archive ; `mutate` altère le manifeste
// avant signature (taille ou hash faux, par exemple).
function signedRelease(bytes, mutate = () => {}) {
  const { manifest, publicPem, privateKey } = setup();
  manifest.asset.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  manifest.asset.size = bytes.length;
  mutate(manifest);
  manifest.signature = signManifest(manifest, privateKey);
  return { manifest, publicPem, privateKey };
}

// Réponse brute contrôlable (URL finale, en-tête content-length, corps) : la
// classe Response ne permet pas de fixer `url`.
function rawResponse(bytes, { url = '', contentLength, status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: name => (name === 'content-length' && contentLength !== undefined ? String(contentLength) : null) },
    body: bytes === null ? null : new Response(bytes).body,
    arrayBuffer: async () => Buffer.from(bytes || ''),
  };
}

function releaseFetch({ manifest, archive, manifestResponse }) {
  return async (url, options) => {
    if (String(url) === MANIFEST_URL) {
      if (manifestResponse) return manifestResponse(url, options, manifest);
      return new Response(JSON.stringify(manifest), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (typeof archive === 'function') return archive(url, options);
    return new Response(archive, { status: 200, headers: { 'content-length': String(archive.length) } });
  };
}

// Portable simulé : `data/` et `target/` séparés sous un dossier temporaire,
// plate-forme Windows injectée, `spawn` enregistré (avec `spawnBehaviour`
// pour simuler le script) et états collectés.
function portable(t, { bytes = packageBytes(), mutate, archive, manifestResponse, spawnBehaviour, ...overrides } = {}) {
  const dir = workspace(t, 'lasmium-update-zip-');
  const { manifest, publicPem, privateKey } = signedRelease(bytes, mutate);
  const spawned = [];
  const states = [];
  const controller = createUpdater({
    currentVersion: '0.5.0',
    manifestUrl: MANIFEST_URL,
    publicKey: publicPem,
    dataDir: path.join(dir, 'data'),
    targetRoot: path.join(dir, 'target'),
    platform: 'win32',
    fetchImpl: releaseFetch({ manifest, archive: archive || bytes, manifestResponse }),
    spawnImpl: (command, args, options) => {
      const call = { command, args, options, killed: false, unrefed: false };
      spawned.push(call);
      if (spawnBehaviour) spawnBehaviour(call);
      return { unref() { call.unrefed = true; }, kill() { call.killed = true; } };
    },
    onState: snapshot => states.push(snapshot.state),
    ...overrides,
  });
  const versionDir = path.join(dir, 'data', 'updates', '0.6.0');
  return {
    controller, dir, bytes, manifest, publicPem, privateKey, spawned, states, versionDir,
    installScript: path.join(versionDir, 'install-0.6.0.ps1'),
  };
}

const flushIo = () => new Promise(resolve => setImmediate(resolve));

// Contenu du dossier de version (vide ou inexistant après un échec).
const leftovers = directory => (fs.existsSync(directory) ? fs.readdirSync(directory) : []);

test('une mise à jour plus récente et signée devient disponible', async t => {
  const { manifest, publicPem } = setup();
  const controller = updater(t, { manifest, publicKey: publicPem });
  const result = await controller.check();
  assert.equal(result.state, 'available');
  assert.equal(result.available.version, '0.6.0');
  assert.equal(result.available.notes, 'Nouveautés.');
});

test('une version identique est signalée à jour', async t => {
  const { manifest, publicPem, privateKey } = setup();
  manifest.version = '0.5.0';
  manifest.asset.name = 'LasmiumTokensHub-0.5.0-win32-x64.zip';
  manifest.signature = signManifest(manifest, privateKey);
  const controller = updater(t, { manifest, publicKey: publicPem });
  const result = await controller.check();
  assert.equal(result.state, 'up-to-date');
});

test('une signature altérée bloque la mise à jour', async t => {
  const { manifest, publicPem } = setup();
  manifest.notes = 'altéré';
  const controller = updater(t, { manifest, publicKey: publicPem });
  const result = await controller.check();
  assert.equal(result.state, 'error');
  assert.match(result.error, /signature|refusée/i);
});

test('une source HTTP est refusée avant toute requête', async t => {
  const { manifest, publicPem } = setup();
  let called = false;
  const controller = updater(t, {
    manifest, publicKey: publicPem,
    manifestUrl: 'http://example.test/latest.json',
    fetchImpl: async () => { called = true; return fakeFetch(manifest)(); },
  });
  const result = await controller.check();
  assert.equal(result.state, 'error');
  assert.match(result.error, /HTTPS/);
  assert.equal(called, false);
});

test('une configuration incomplète est signalée sans requête', async t => {
  const { manifest, publicPem } = setup();
  const cases = [
    [{ manifestUrl: '' }, /Aucune source/],
    [{ manifestUrl: 'pas une adresse' }, /Adresse de mise à jour invalide/],
    [{ publicKey: '' }, /Clé publique de mise à jour absente/],
    [{ dataDir: '' }, /Dossier de données absent/],
  ];
  for (const [override, expected] of cases) {
    let called = false;
    const controller = updater(t, {
      manifest, publicKey: publicPem, ...override,
      fetchImpl: async () => { called = true; return fakeFetch(manifest)(); },
    });
    const result = await controller.check();
    assert.equal(result.state, 'error');
    assert.match(result.error, expected);
    assert.equal(result.available, null);
    assert.equal(called, false);
  }
});

test('enabled: false place le contrôleur en état disabled et neutralise check() et install()', async t => {
  const { manifest, publicPem } = setup();
  let called = false;
  const controller = updater(t, {
    manifest, publicKey: publicPem, enabled: false,
    fetchImpl: async () => { called = true; return fakeFetch(manifest)(); },
    spawnImpl: () => { throw new Error('spawn interdit'); },
  });
  assert.equal(controller.info().state, 'disabled');
  assert.equal(controller.info().enabled, false);
  const checked = await controller.check();
  assert.equal(checked.state, 'disabled');
  assert.equal(checked.error, 'Mises à jour désactivées.');
  const installed = await controller.install();
  assert.equal(installed.state, 'disabled');
  assert.equal(called, false);
});

test('les réponses de manifeste anormales sont refusées', async t => {
  const { manifest, publicPem } = setup();
  const response = extra => async url => ({ ok: true, status: 200, url, headers: { get: () => null }, ...extra });
  const cases = [
    [response({ arrayBuffer: async () => Buffer.alloc(MAX_MANIFEST_BYTES + 1) }), /trop volumineux/],
    [response({ arrayBuffer: async () => Buffer.from('{ pas du JSON') }), /illisible/],
    [async () => ({ ok: false, status: 503 }), /indisponible \(503\)/],
    [async () => null, /indisponible \(réseau\)/],
    [async () => { throw new Error('ECONNRESET'); }, /ECONNRESET/],
    [async () => ({ ok: true, status: 200, url: 'http://example.test/latest.json', headers: { get: () => null }, arrayBuffer: async () => Buffer.from(JSON.stringify(manifest)) }), /Redirection de mise à jour non HTTPS/],
  ];
  for (const [fetchImpl, expected] of cases) {
    const controller = updater(t, { manifest, publicKey: publicPem, fetchImpl });
    const result = await controller.check();
    assert.equal(result.state, 'error');
    assert.match(result.error, expected);
    assert.equal(result.available, null);
    assert.ok(result.checkedAt);
  }
  // Un manifeste exactement à la limite reste accepté.
  const padded = { ...manifest, notes: manifest.notes };
  const controller = updater(t, {
    manifest, publicKey: publicPem,
    fetchImpl: response({ arrayBuffer: async () => Buffer.from(JSON.stringify(padded)) }),
  });
  assert.equal((await controller.check()).state, 'available');
});

test('le dépassement du délai de vérification est signalé', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manifest, publicPem } = setup();
  let aborted = false;
  const controller = updater(t, {
    manifest, publicKey: publicPem,
    // fetch n'aboutit jamais : seul le signal d'abandon le libère.
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); });
    }),
    now: () => new Date('2026-11-05T12:00:00.000Z'),
  });
  const pending = controller.check();
  await flushIo();
  assert.equal(controller.info().state, 'checking');
  t.mock.timers.tick(CHECK_TIMEOUT_MS - 1);
  await flushIo();
  assert.equal(aborted, false);
  assert.equal(controller.info().state, 'checking');
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(aborted, true);
  assert.equal(result.state, 'error');
  assert.equal(result.error, 'Délai de vérification dépassé.');
  assert.equal(result.checkedAt, '2026-11-05T12:00:00.000Z');
});

test('les abonnés sont notifiés à chaque changement d’état et isolés des exceptions', async t => {
  const { manifest, publicPem } = setup();
  const controller = updater(t, {
    manifest, publicKey: publicPem,
    onState: () => { throw new Error('UI cassée'); },
  });
  const received = [];
  const unsubscribe = controller.subscribe(snapshot => received.push(snapshot.state));
  controller.subscribe(() => { throw new Error('abonné cassé'); });
  await controller.check();
  assert.deepEqual(received, ['checking', 'available']);
  unsubscribe();
  unsubscribe();
  await controller.check();
  assert.deepEqual(received, ['checking', 'available']);
});

test('une archive signée est téléchargée, vérifiée et préparée sans toucher à data/', async t => {
  const { controller, dir, bytes, manifest, states, versionDir } = portable(t);
  // check() passe par le manifeste simulé, puis prepare() télécharge l'archive.
  const checked = await controller.check();
  assert.equal(checked.state, 'available', checked.error);
  const prepared = await controller.prepare();
  assert.equal(prepared.size, bytes.length);
  assert.equal(prepared.sha256, manifest.asset.sha256);
  assert.equal(prepared.archive, path.join(versionDir, manifest.asset.name));
  assert.ok(fs.readFileSync(prepared.archive).equals(bytes));
  assert.equal(fs.existsSync(`${prepared.archive}.part`), false);
  assert.equal(prepared.staging, path.join(versionDir, 'staging'));
  assert.equal(prepared.staged, path.join(prepared.staging, 'LasmiumTokensHub-0.6.0-win32-x64'));
  assert.equal(fs.readFileSync(path.join(prepared.staged, 'resources', 'app', 'main.cjs'), 'utf8'), 'main');
  assert.equal(fs.existsSync(path.join(dir, 'target', 'data')), false);
  assert.equal(fs.existsSync(path.join(dir, 'target')), false);
  const info = controller.info();
  assert.equal(info.state, 'ready');
  assert.equal(info.stagedVersion, '0.6.0');
  assert.equal(info.progress, 100);
  assert.equal(info.error, null);
  assert.deepEqual(states, ['checking', 'available', 'downloading', 'extracting', 'ready']);
});

test('prepare() exige un manifeste vérifié, Windows et un dossier cible', async t => {
  await assert.rejects(portable(t).controller.prepare(), /Aucune mise à jour vérifiée/);
  const linux = portable(t, { platform: 'linux' });
  await linux.controller.check();
  await assert.rejects(linux.controller.prepare(), /uniquement sous Windows x64/);
  const noTarget = portable(t, { targetRoot: '' });
  await noTarget.controller.check();
  await assert.rejects(noTarget.controller.prepare(), /Dossier d’installation inconnu/);
  assert.equal(fs.existsSync(path.join(noTarget.dir, 'data')), false);
});

test('une taille reçue différente de la taille annoncée est refusée et le téléchargement partiel supprimé', async t => {
  const cases = [
    // En-tête content-length supérieur à la taille signée : refus avant lecture.
    [{ archive: (url, options, bytes) => rawResponse(bytes, { contentLength: bytes.length + 1 }) }, /Taille annoncée supérieure/],
    // Corps plus long que la taille signée : refus pendant la lecture.
    [{ mutate: manifest => { manifest.asset.size -= 1; }, archive: (url, options, bytes) => rawResponse(bytes) }, /plus volumineuse que prévu/],
    // Corps plus court que la taille signée : refus après lecture complète.
    [{ mutate: manifest => { manifest.asset.size += 1; } }, /Taille reçue incorrecte \(\d+ au lieu de \d+\)/],
  ];
  for (const [options, expected] of cases) {
    const bytes = packageBytes();
    const { controller, spawned, versionDir } = portable(t, {
      bytes,
      mutate: options.mutate,
      archive: options.archive && ((url, fetchOptions) => options.archive(url, fetchOptions, bytes)),
    });
    const result = await controller.install();
    assert.equal(result.state, 'error');
    assert.match(result.error, expected);
    assert.deepEqual(leftovers(versionDir), [], 'ni archive ni fichier .part ne doivent subsister');
    assert.equal(spawned.length, 0);
  }
});

test('un SHA-256 différent de celui du manifeste est refusé', async t => {
  const { controller, spawned, versionDir } = portable(t, { mutate: manifest => { manifest.asset.sha256 = 'c'.repeat(64); } });
  const result = await controller.install();
  assert.equal(result.state, 'error');
  assert.match(result.error, /SHA-256/);
  assert.deepEqual(leftovers(versionDir), []);
  assert.equal(spawned.length, 0);
});

test('le téléchargement refuse une redirection HTTP et une réponse en erreur', async t => {
  const redirected = portable(t, { archive: () => rawResponse(redirected.bytes, { url: 'http://example.test/update.zip' }) });
  const result = await redirected.controller.install();
  assert.equal(result.state, 'error');
  assert.match(result.error, /Redirection de téléchargement non HTTPS/);
  assert.deepEqual(leftovers(redirected.versionDir), []);
  assert.equal(redirected.spawned.length, 0);

  const missing = portable(t, { archive: () => rawResponse(null, { status: 404 }) });
  const notFound = await missing.controller.install();
  assert.equal(notFound.state, 'error');
  assert.match(notFound.error, /Téléchargement impossible \(404\)/);
  assert.equal(missing.spawned.length, 0);
});

test('une archive contenant data/ est refusée après extraction', async t => {
  const { controller, spawned, versionDir } = portable(t, { bytes: packageBytes('0.6.0', { withData: true }) });
  const result = await controller.install();
  assert.equal(result.state, 'error');
  assert.match(result.error, /dossier data interdit/);
  assert.equal(spawned.length, 0);
  assert.ok(fs.existsSync(path.join(versionDir, 'staging')));
});

test('install() sans préparation préalable passe par check() et prepare(), et refuse hors Windows sans lancer de script', async t => {
  const linux = portable(t, { platform: 'linux' });
  const refused = await linux.controller.install();
  assert.equal(refused.state, 'error');
  assert.match(refused.error, /uniquement sous Windows x64/);
  assert.equal(linux.spawned.length, 0);
  // La garde de plate-forme précède tout téléchargement.
  assert.deepEqual(linux.states, ['checking', 'available', 'error']);
  assert.equal(fs.existsSync(path.join(linux.dir, 'data')), false);

  // Version identique : install() s'arrête sur up-to-date.
  const same = portable(t, { mutate: manifest => { manifest.version = '0.5.0'; manifest.asset.name = 'LasmiumTokensHub-0.5.0-win32-x64.zip'; } });
  assert.equal((await same.controller.install()).state, 'up-to-date');
  assert.equal(same.spawned.length, 0);

  // Manifeste refusé : install() rapporte l'erreur de check() sans rien préparer.
  const tampered = portable(t, { manifestResponse: (url, options, manifest) => new Response(JSON.stringify({ ...manifest, notes: 'altéré' }), { status: 200 }) });
  const result = await tampered.controller.install();
  assert.equal(result.state, 'error');
  assert.match(result.error, /signature|refusée/i);
  assert.equal(tampered.spawned.length, 0);
  assert.equal(fs.existsSync(path.join(tampered.dir, 'data')), false);
});

test('install() ne relance rien pendant un téléchargement en cours', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { controller, bytes, spawned } = portable(t, {
    archive: async () => { await gate; return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } }); },
  });
  await controller.check();
  const preparing = controller.prepare();
  assert.equal(controller.info().state, 'downloading');
  const during = await controller.install();
  assert.equal(during.state, 'downloading');
  assert.equal(spawned.length, 0);
  release();
  const prepared = await preparing;
  assert.equal(controller.info().state, 'ready');
  assert.equal(prepared.size, bytes.length);
});

test('install() écrit le script, attend l’accusé de démarrage puis quitte l’application', async t => {
  let quitCalls = 0;
  let quitResolve;
  const quitted = new Promise(resolve => { quitResolve = resolve; });
  const { controller, dir, spawned, states, installScript } = portable(t, {
    appPid: 4242,
    quit: () => { quitCalls++; quitResolve(); },
    // Le script réel écrit `<script>.started` dès son démarrage : on simule
    // cet accusé, après avoir vérifié qu'un accusé périmé a été purgé.
    spawnBehaviour: call => {
      const script = call.args.at(-1);
      call.staleAcknowledgement = fs.existsSync(`${script}.started`);
      fs.writeFileSync(`${script}.started`, '2026-11-05T12:00:00.000Z');
    },
  });
  await controller.check();
  const prepared = await controller.prepare();
  fs.writeFileSync(`${installScript}.started`, 'périmé');
  const result = await controller.install();
  assert.equal(result.state, 'installing', result.error);
  assert.equal(result.progress, 100);
  assert.equal(result.error, null);
  assert.equal(spawned.length, 1);
  const [call] = spawned;
  assert.equal(call.staleAcknowledgement, false);
  // Lancement direct et détaché : aucune console, donc aucune fenêtre.
  assert.equal(call.command, 'powershell.exe');
  assert.deepEqual(call.args, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', installScript]);
  assert.deepEqual(call.options, { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(installScript) });
  assert.equal(call.unrefed, true);
  assert.equal(call.killed, false);
  const script = fs.readFileSync(installScript, 'utf8');
  assert.match(script, /\$appPid = 4242\n/);
  assert.ok(script.includes(`$target = '${path.join(dir, 'target')}'`));
  assert.ok(script.includes(`$staged = '${prepared.staged}'`));
  assert.ok(script.includes(`$started = '${installScript}.started'`));
  assert.ok(script.includes(`$log = '${path.join(dir, 'data', 'updates', 'update.log')}'`));
  if (process.platform !== 'win32') assert.equal(fs.statSync(installScript).mode & 0o777, 0o600);
  await quitted;
  assert.equal(quitCalls, 1);
  // Un second appel pendant l'installation est sans effet.
  assert.equal((await controller.install()).state, 'installing');
  assert.equal(spawned.length, 1);
  assert.equal(fs.existsSync(path.join(dir, 'target')), false);
  assert.deepEqual(states, ['checking', 'available', 'downloading', 'extracting', 'ready', 'installing']);
});

test('install() se rabat sur le shell natif, fenêtre masquée, si le lancement direct ne démarre pas', async t => {
  let quitCalls = 0;
  const { controller, spawned, installScript } = portable(t, {
    quit: () => { quitCalls++; },
    // Seul le recours par le shell écrit l'accusé.
    spawnBehaviour: call => { if (call.options.shell) fs.writeFileSync(`${installScript}.started`, 'ok'); },
  });
  await controller.check();
  await controller.prepare();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = controller.install();
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  while (!settled) { await flushIo(); t.mock.timers.tick(100); }
  const result = await pending;
  assert.equal(result.state, 'installing', result.error);
  assert.equal(spawned.length, 2);
  assert.equal(spawned[0].killed, true, 'le lancement direct sans accusé est arrêté');
  assert.equal(spawned[1].command, `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${installScript}"`);
  assert.deepEqual(spawned[1].options, { shell: true, detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(installScript) });
  assert.equal(spawned[1].killed, false);
  t.mock.timers.runAll();
  assert.equal(quitCalls, 1);
});

test('install() signale un script qui ne démarre pas et tue le processus lancé', async t => {
  let quitCalls = 0;
  const { controller, spawned, installScript } = portable(t, { quit: () => { quitCalls++; } });
  await controller.check();
  await controller.prepare();
  // Les 100 tentatives espacées de 100 ms sont déroulées avec des minuteurs
  // simulés : chaque tour laisse l'E/S (stat) aboutir puis avance l'horloge.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = controller.install();
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  while (!settled) {
    await flushIo();
    t.mock.timers.tick(100);
  }
  const result = await pending;
  assert.equal(result.state, 'error');
  assert.match(result.error, /n’a pas démarré/);
  assert.equal(spawned.length, 2, 'lancement direct puis recours par le shell');
  assert.ok(spawned.every(call => call.killed), 'aucun processus sans accusé ne reste lancé');
  assert.equal(fs.existsSync(`${installScript}.started`), false);
  assert.ok(fs.existsSync(installScript));
  t.mock.timers.runAll();
  assert.equal(quitCalls, 0);
});

test('main.cjs refuse install() en développement sans LASMIUM_ALLOW_DEV_UPDATES=1', () => {
  // La garde vit dans le gestionnaire IPC de main.cjs, hors de lib/updater.cjs :
  // elle est vérifiée textuellement, sans charger Electron.
  const source = fs.readFileSync(path.join(repositoryRoot, 'main.cjs'), 'utf8');
  const handler = /handle\('update:install',\s*async \(\) => \{([\s\S]*?)\n\s*\}\);/.exec(source);
  assert.ok(handler, 'main.cjs doit exposer le canal IPC update:install');
  const body = handler[1];
  assert.match(body, /if \(!app\.isPackaged && process\.env\.LASMIUM_ALLOW_DEV_UPDATES !== '1'\) throw new Error\(/);
  assert.match(body, /return updater\.install\(\)/);
  assert.ok(body.indexOf('LASMIUM_ALLOW_DEV_UPDATES') < body.indexOf('updater.install()'), 'la garde doit précéder l’installation');
});
