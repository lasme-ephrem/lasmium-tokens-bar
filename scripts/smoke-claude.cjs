// Smoke Claude 0.6.8 — connexion simplifiée à l'abonnement via Claude Code,
// dans Electron, sans identifiants réels : USERPROFILE pointe vers un profil
// isolé, Claude Code est simulé dans le processus principal (connexion et
// statut) et le transport HTTP (session.defaultSession.fetch) est simulé.
// Couvre : « Connecter Claude » en un clic (statut, refus, connexion officielle,
// lecture), environnement « abonnement seulement » (clé API ignorée), migration
// d'une ancienne session Claude Desktop, redémarrage, panne puis reprise,
// renouvellement limité (auth-rate-limit) sans bouton de reconnexion, échec de
// connexion, aucun jeton dans les données Lasmium TOKENS-HUB.
const { _electron: electron } = require(process.env.PROVIDERSBAR_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createSeed } = require('../lib/seed.cjs');

const root = path.resolve(__dirname, '..');
const results = path.join(root, 'test-results');
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const MINUTE = 60000;
let desktop;

// Un faux claude.exe dans un dossier placé en tête du PATH : Lasmium le trouve,
// mais ne l'exécute jamais (spawn est simulé).
async function fakeClaudeBin() {
  const bin = await fs.mkdtemp(path.join(results, 'claude-bin-'));
  await fs.writeFile(path.join(bin, 'claude.exe'), '');
  return bin;
}

async function launch(dataDir, home, bin) {
  const env = { ...process.env, PROVIDERSBAR_DATA_DIR: dataDir, USERPROFILE: home, HOME: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH || process.env.Path || ''}`,
    // Leurre : une clé API dans l'environnement ne doit jamais atteindre Claude Code.
    ANTHROPIC_API_KEY: 'smoke-api-key-never-used', CLAUDE_CODE_OAUTH_TOKEN: 'smoke-setup-token-never-used' };
  delete env.Path;
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({
    executablePath: process.env.PROVIDERSBAR_EXECUTABLE || require('electron'),
    args: [...(process.env.PROVIDERSBAR_EXECUTABLE ? [] : [root]), '--no-sandbox', '--disable-gpu'],
    cwd: root, env, timeout: 30000,
  });
}

function credentialDocument(overrides = {}) {
  return {
    otherAccount: { preserve: true },
    claudeAiOauth: {
      accessToken: 'fixture-live-access',
      refreshToken: 'fixture-refresh',
      expiresAt: Date.now() + 8 * 3600000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max', rateLimitTier: 'default',
      ...overrides,
    },
  };
}

async function writeCredentials(home, document) {
  const directory = path.join(home, '.claude');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, '.credentials.json'), JSON.stringify(document));
}

// Claude Code simulé : `auth status --json` et `auth login --claudeai`. La
// connexion réussie écrit un fichier de connexion valide, comme le vrai logiciel.
async function fakeClaudeCode(options) {
  await desktop.evaluate((_electron, opts) => {
    const req = process.mainModule.require;
    const childProcess = req('node:child_process');
    const { EventEmitter } = req('node:events');
    const fsSync = req('node:fs');
    const { CREDENTIAL_PATH } = req('./lib/claude-connection.cjs');
    globalThis.__realSpawn = globalThis.__realSpawn || childProcess.spawn;
    globalThis.__claudeCode = { ...opts, calls: [] };
    childProcess.spawn = (file, args, spawnOptions) => {
      if (!/claude\.exe$/i.test(String(file))) return globalThis.__realSpawn(file, args, spawnOptions);
      const fake = globalThis.__claudeCode;
      const env = spawnOptions?.env || {};
      fake.calls.push({ args, apiKey: 'ANTHROPIC_API_KEY' in env, setupToken: 'CLAUDE_CODE_OAUTH_TOKEN' in env, hidden: spawnOptions?.windowsHide === true });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        // Renouvellement en arrière-plan (claude -p …) : comme le vrai Claude Code,
        // il réécrit sa connexion seulement s'il en a une neuve à écrire.
        if (args[0] === '-p') {
          if (fake.renewCredentials) fsSync.writeFileSync(CREDENTIAL_PATH, JSON.stringify(fake.renewCredentials));
          child.stdout.emit('data', 'OK');
          child.emit('close', 0);
          return;
        }
        if (args[1] === 'login') {
          if (!fake.loginSucceeds) { child.stderr.emit('data', 'OAuth error'); child.emit('close', 1); return; }
          fsSync.writeFileSync(CREDENTIAL_PATH, JSON.stringify(fake.loginCredentials));
          fake.loggedIn = true;
          child.stdout.emit('data', 'Opening browser to sign in…\nLogin successful.\n');
          child.emit('close', 0);
          return;
        }
        child.stdout.emit('data', JSON.stringify(fake.loggedIn
          ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'smoke@example.test', subscriptionType: 'max' }
          : { loggedIn: false, authMethod: 'none' }));
        child.emit('close', fake.loggedIn ? 0 : 1);
      });
      return child;
    };
  }, options);
}

async function patchFetch(mode) {
  await desktop.evaluate(({ session }, data) => {
    globalThis.__claudeRequests = globalThis.__claudeRequests || { token: 0, usage: 0 };
    session.defaultSession.fetch = async (url, _options) => {
      const target = String(url);
      if (target === data.tokenUrl) {
        globalThis.__claudeRequests.token++;
        if (data.mode === 'deny-token') return { ok: false, status: 400, headers: new Headers(), json: async () => { throw new Error('hidden'); } };
        if (data.mode === 'rate-limit-token') return { ok: false, status: 429, headers: new Headers({ 'retry-after': '7200' }), json: async () => { throw new Error('hidden'); } };
        return {
          ok: true, status: 200,
          json: async () => ({ access_token: 'fixture-live-access', refresh_token: 'fixture-rotated-refresh', expires_in: 28800, scope: 'user:profile user:inference' }),
        };
      }
      if (target === data.usageUrl) {
        globalThis.__claudeRequests.usage++;
        if (data.mode === 'offline') throw new Error('Claude smoke offline');
        return {
          ok: true, status: 200,
          json: async () => ({
            five_hour: { utilization: 9, resets_at: '2099-09-30T11:00:00Z' },
            seven_day: { utilization: 42, resets_at: '2099-10-07T08:00:00Z' },
            limits: [{ display_name: 'Fable', percent: 31, resets_at: '2099-10-07T08:00:00Z' }],
          }),
        };
      }
      throw new Error(`Unexpected Claude endpoint: ${target}`);
    };
  }, { mode, tokenUrl: TOKEN_URL, usageUrl: USAGE_URL });
}

// Horloge décalée dans le processus principal pour franchir la cadence de
// 5 minutes et les délais d'attente sans attente réelle.
async function setMainClockOffset(offsetMs) {
  await desktop.evaluate((_electron, offset) => {
    const RealDate = globalThis.__lasmiumRealDate || Date;
    globalThis.__lasmiumRealDate = RealDate;
    globalThis.Date = class extends RealDate {
      constructor(...args) { if (args.length === 0) super(RealDate.now() + offset); else super(...args); }
      static now() { return RealDate.now() + offset; }
    };
  }, offsetMs);
}

async function resetMainClock() {
  await desktop.evaluate(() => {
    if (globalThis.__lasmiumRealDate) {
      globalThis.Date = globalThis.__lasmiumRealDate;
      delete globalThis.__lasmiumRealDate;
    }
  });
}

const claudeOf = state => state.providers.find(p => p.id === 'claude');

async function openClaude(page) {
  await page.evaluate(() => openDetail('claude', 'connection'));
  await page.waitForFunction(() => document.querySelector('dialog')?.open);
}

async function main() {
  await fs.mkdir(results, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(results, 'claude-smoke-'));
  const home = await fs.mkdtemp(path.join(results, 'claude-home-'));
  const bin = await fakeClaudeBin();
  const initial = createSeed();
  initial.settings.autoRefresh = false;
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify(initial));
  // Connexion Claude Code expirée dont le renouvellement est refusé : seule une
  // nouvelle connexion officielle peut la rétablir.
  await writeCredentials(home, credentialDocument({ accessToken: 'fixture-old-access', refreshToken: 'fixture-old-refresh', expiresAt: Date.now() - MINUTE }));

  // ------------------------------------------------------------------ *
  // 1. « Connecter Claude » en un clic : statut, refus du jeton, connexion
  //    officielle (navigateur), lecture. Aucune clé API transmise.
  // ------------------------------------------------------------------ *
  desktop = await launch(dataDir, home, bin);
  let page = await desktop.firstWindow();
  await page.waitForSelector('.cards .card');
  await patchFetch('deny-token');
  await fakeClaudeCode({ loggedIn: true, loginSucceeds: true, loginCredentials: credentialDocument() });
  await openClaude(page);
  assert.equal(await page.locator('[data-action="claude-enable-live"]').innerText(), 'Connecter Claude');
  assert.equal(await page.locator('[data-action="account-verify"]').count(), 0);
  assert.doesNotMatch(await page.locator('.dialog-body').innerText(), /Desktop/);
  await page.locator('[data-action="claude-enable-live"]').click();
  await page.waitForFunction(() => state.providers.find(p => p.id === 'claude').snapshot?.quotaWindows?.length === 3);
  const connected = claudeOf(await page.evaluate(() => window.lasmium.getState()));
  assert.deepEqual(connected.accountSession, { kind: 'claude-live-local', plan: 'Max', email: 'smoke@example.test' });
  assert.equal(connected.plan, 'Max', 'le forfait est renseigné depuis Claude Code');
  assert.equal(connected.error, null);
  assert.deepEqual(connected.snapshot.quotaWindows.map(w => [w.label, w.remaining]), [['5 heures', 91], ['Semaine', 58], ['Fable · Semaine', 69]]);
  const cliCalls = await desktop.evaluate(() => globalThis.__claudeCode.calls);
  // Claude Code est d'abord lancé en arrière-plan pour renouveler (sans effet
  // ici : connexion révoquée), puis la connexion officielle prend le relais.
  assert.deepEqual(cliCalls.map(call => call.args.join(' ')),
    ['auth status --json', '-p Réponds uniquement : OK --model haiku --no-session-persistence --tools ', 'auth login --claudeai', 'auth status --json']);
  assert.ok(cliCalls.every(call => !call.apiKey && !call.setupToken && call.hidden), 'Claude Code est toujours lancé sur l’abonnement, sans fenêtre');
  assert.match(await page.locator('.connection-success').innerText(), /ton abonnement Claude Max \(smoke@example\.test\) · lecture toutes les 5 minutes/);
  assert.match(await page.locator('.dialog-body').innerText(), /Hebdo Fable : 69 % restants/);
  assert.equal(await page.locator('[data-action="account-verify"]').innerText(), 'Vérifier maintenant');
  assert.equal(await page.locator('[data-action="claude-enable-live"]').count(), 0);
  assert.match(await page.locator('#toast').innerText(), /Claude connecté à ton abonnement/);
  await page.screenshot({ path: path.join(results, 'claude-connected.png') });
  await page.locator('[data-action="close-dialog"]').click();
  assert.deepEqual(await page.locator('.card:has([data-open="claude"]) .quota-period-label').allTextContents(), ['Hebdo', 'Horaire', 'Hebdo Fable']);
  await desktop.close(); desktop = null;

  // ------------------------------------------------------------------ *
  // 2. Redémarrage et migration : une ancienne session Claude Desktop devient
  //    la connexion à l'abonnement.
  // ------------------------------------------------------------------ *
  const savedState = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  claudeOf(savedState).accountSession = { kind: 'claude-desktop-local', resumeLiveAfter: new Date().toISOString() };
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify(savedState));
  desktop = await launch(dataDir, home, bin);
  page = await desktop.firstWindow();
  await page.waitForSelector('.cards .card');
  await patchFetch('success');
  await fakeClaudeCode({ loggedIn: true, loginSucceeds: true, loginCredentials: credentialDocument() });
  assert.deepEqual(claudeOf(await page.evaluate(() => window.lasmium.getState())).accountSession, { kind: 'claude-live-local' });
  const verified = claudeOf(await page.evaluate(() => window.lasmium.verifyAccount('claude')));
  assert.equal(verified.error, null);
  assert.equal(verified.snapshot.quotaWindows.length, 3);

  // ------------------------------------------------------------------ *
  // 3. Panne : dernières valeurs conservées, un seul message, prochain essai
  //    automatique ; reprise après le délai de 5 minutes.
  // ------------------------------------------------------------------ *
  await patchFetch('offline');
  await setMainClockOffset(6 * MINUTE);
  await page.evaluate(() => window.lasmium.verifyAccount('claude')).catch(() => {});
  const offline = claudeOf(await page.evaluate(() => window.lasmium.getState()));
  assert.equal(offline.snapshot.updatedAt, verified.snapshot.updatedAt, 'une panne n’efface pas les valeurs');
  assert.match(offline.error, /Lecture des quotas Claude impossible \(réseau\)/);
  await page.evaluate(() => { state = null; });
  await page.evaluate(async () => { state = await window.lasmium.getState(); render(); });
  await openClaude(page);
  const offlineText = await page.locator('.dialog-body').innerText();
  assert.match(offlineText, /dernières valeurs affichées/);
  assert.match(offlineText, /Prochain essai automatique/);
  assert.equal(offlineText.split('Lecture des quotas Claude impossible').length - 1, 1, 'le message d’erreur apparaît une seule fois');
  assert.equal(await page.locator('[data-action="claude-enable-live"]').count(), 0, 'une panne ne demande pas de reconnexion');
  assert.match(await page.evaluate(() => statusBadge(state.providers.find(p => p.id === 'claude'))), /Dernières valeurs/);
  await setMainClockOffset(12 * MINUTE);
  await patchFetch('success');
  const recovered = claudeOf(await page.evaluate(() => window.lasmium.verifyAccount('claude')));
  assert.equal(recovered.error, null);
  assert.notEqual(recovered.snapshot.updatedAt, verified.snapshot.updatedAt);

  // ------------------------------------------------------------------ *
  // 4. Renouvellement limité par Anthropic (auth-rate-limit) : attente
  //    automatique, aucune mention de Claude Desktop, pas de reconnexion.
  // ------------------------------------------------------------------ *
  await setMainClockOffset(18 * MINUTE);
  await patchFetch('rate-limit-token');
  await writeCredentials(home, credentialDocument({ expiresAt: Date.now() - MINUTE }));
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.lasmium.verifyAccount('claude')).catch(() => {});
  const limited = claudeOf(await page.evaluate(() => window.lasmium.getState()));
  assert.equal(limited.claudeSync.errorCode, 'auth-rate-limit');
  assert.equal(limited.snapshot.updatedAt, recovered.snapshot.updatedAt);
  await page.evaluate(async () => { state = await window.lasmium.getState(); render(); });
  await openClaude(page);
  const limitedText = await page.locator('.dialog-body').innerText();
  assert.match(limitedText, /Anthropic limite temporairement le renouvellement/);
  assert.match(limitedText, /Prochain essai automatique/);
  assert.doesNotMatch(limitedText, /Desktop|Déconnecter/);
  assert.equal(await page.locator('[data-action="account-verify"]').count(), 1);
  await page.screenshot({ path: path.join(results, 'claude-waiting.png') });
  await resetMainClock();

  // ------------------------------------------------------------------ *
  // 4 bis. Jeton expiré : Claude Code le renouvelle en arrière-plan, sans
  //        aucune action ; la lecture reprend sans message d'erreur.
  // ------------------------------------------------------------------ *
  await setMainClockOffset(40 * MINUTE);
  await patchFetch('rate-limit-token');
  await fakeClaudeCode({ loggedIn: true, loginSucceeds: true, renewCredentials: credentialDocument({ accessToken: 'fixture-renewed-by-claude-code' }) });
  await writeCredentials(home, credentialDocument({ expiresAt: Date.now() - MINUTE }));
  await page.waitForTimeout(2500);
  await patchFetch('success');
  const renewed = claudeOf(await page.evaluate(() => window.lasmium.verifyAccount('claude')));
  assert.equal(renewed.error, null, 'aucune bannière : Claude Code a renouvelé la connexion');
  const renewCalls = await desktop.evaluate(() => globalThis.__claudeCode.calls.filter(call => call.args[0] === '-p'));
  assert.equal(renewCalls.length, 1);
  assert.ok(renewCalls.every(call => !call.apiKey && !call.setupToken && call.hidden));
  const renewedFile = JSON.parse(await fs.readFile(path.join(home, '.claude', '.credentials.json'), 'utf8'));
  assert.equal(renewedFile.claudeAiOauth.accessToken, 'fixture-renewed-by-claude-code');
  await resetMainClock();

  // ------------------------------------------------------------------ *
  // 5. Arrêt du suivi puis connexion qui n'aboutit pas : message clair et
  //    bouton « Connecter Claude », dernières valeurs effacées de la fiche.
  // ------------------------------------------------------------------ *
  await page.locator('[data-action="disconnect"]').click();
  await page.waitForFunction(() => !state.providers.find(p => p.id === 'claude').accountSession);
  await fakeClaudeCode({ loggedIn: false, loginSucceeds: false });
  await openClaude(page);
  await page.locator('[data-action="claude-enable-live"]').click();
  await page.waitForFunction(() => document.querySelector('.dialog-body')?.innerText.includes('n’a pas abouti'));
  assert.equal(await page.locator('[data-action="claude-enable-live"]').innerText(), 'Connecter Claude');
  await page.screenshot({ path: path.join(results, 'claude-login-failed.png') });

  // Aucun jeton ni contenu privé dans les données Lasmium TOKENS-HUB.
  const persisted = await fs.readFile(path.join(dataDir, 'state.json'), 'utf8');
  for (const forbidden of ['fixture-live-access', 'fixture-rotated-refresh', 'fixture-old-access', 'fixture-old-refresh', 'fixture-renewed-by-claude-code', 'smoke-api-key-never-used', 'smoke-setup-token-never-used']) {
    assert.ok(!persisted.includes(forbidden), `state.json ne doit pas contenir ${forbidden}`);
  }
  assert.equal(await page.evaluate(() => JSON.stringify(state).includes('fixture-live-access')), false);
  const requests = await desktop.evaluate(() => globalThis.__claudeRequests);
  assert.ok(requests.usage >= 3, 'lectures initiales, panne et reprise doivent avoir appelé le service');
  await desktop.close(); desktop = null;
  console.log('PASS: Connecter Claude en un clic (statut, jeton refusé, connexion officielle, renouvellement en arrière-plan par Claude Code sans bannière, lecture Horaire/Hebdo/Hebdo Fable, forfait Max), Claude Code lancé sans clé API ni jeton longue durée, migration claude-desktop-local, redémarrage, panne + prochain essai automatique + reprise (message unique), auth-rate-limit sans mention Desktop ni reconnexion, connexion non aboutie avec message clair, aucun jeton persisté dans Lasmium TOKENS-HUB.');
}

// Un smoke en échec se termine toujours : fermeture d'Electron bornée à 15 s,
// puis sortie explicite (sinon un Electron bloqué occupe la CI jusqu'au délai).
async function finish(failed) {
  if (desktop) await Promise.race([desktop.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 15000))]);
  if (failed) process.exit(1);
}

main().then(() => finish(false), async error => { console.error(error); await finish(true); });
