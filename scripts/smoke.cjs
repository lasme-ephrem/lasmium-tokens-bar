// Smoke test Electron 0.3.0 — renderer refondu + socle main.cjs durci.
// Couvre : inventaire, stratégie, édition, historique, clés API chiffrées,
// sessions de compte (Orca/Ollama/OpenAI/Grok/Z.ai/Claude/Antigravity), états
// de connexion transitoires/expirés, thème clair/sombre/système, version
// dynamique, export nettoyé, effacement des données, widget, tray, redémarrage.
// Aucune requête réelle vers un fournisseur : les transports sont simulés.
const { _electron: electron } = require(process.env.PROVIDERSBAR_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const packageJson = require('../package.json');
const { createSeed } = require('../lib/seed.cjs');

const root = path.resolve(__dirname, '..');
const results = path.join(root, 'test-results');
const futureDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
const pastDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
let desktop;
// Faux claude.exe en tête du PATH : Lasmium le trouve mais ne l'exécute jamais
// (spawn simulé par fakeClaudeCode), donc jamais le vrai compte Claude.
let claudeBin = null;

async function launch(dataDir, home) {
  const env = { ...process.env, PROVIDERSBAR_DATA_DIR: dataDir };
  if (home) { env.USERPROFILE = home; env.HOME = home; }
  if (claudeBin) { env.PATH = `${claudeBin}${path.delimiter}${process.env.PATH || process.env.Path || ''}`; delete env.Path; }
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({
    executablePath: process.env.PROVIDERSBAR_EXECUTABLE || require('electron'),
    args: [...(process.env.PROVIDERSBAR_EXECUTABLE ? [] : [root]), '--no-sandbox', '--disable-gpu'],
    cwd: root, env, timeout: 30000,
  });
}

// Horloge décalée dans le processus principal uniquement : permet d'exercer le
// backoff d'une panne (60 s) sans attendre réellement une minute. Aucun effet
// sur le renderer, donc les assertions visuelles restent déterministes.
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

// Claude Code simulé dans le processus principal (`auth status`, `auth login`).
async function fakeClaudeCode(loggedIn) {
  await desktop.evaluate((_electron, connected) => {
    const req = process.mainModule.require;
    const childProcess = req('node:child_process');
    const { EventEmitter } = req('node:events');
    globalThis.__realSpawn = globalThis.__realSpawn || childProcess.spawn;
    childProcess.spawn = (file, args, options) => {
      if (!/claude\.exe$/i.test(String(file))) return globalThis.__realSpawn(file, args, options);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        child.stdout.emit('data', JSON.stringify(connected
          ? { loggedIn: true, authMethod: 'claude.ai', email: 'smoke@example.test', subscriptionType: 'max' }
          : { loggedIn: false, authMethod: 'none' }));
        child.emit('close', connected ? 0 : 1);
      });
      return child;
    };
  }, loggedIn);
}

async function openProvider(page, id, tab) {
  await page.locator(`[data-open="${id}"]`).first().click();
  await page.waitForFunction(() => document.querySelector('dialog')?.open);
  if (tab) await page.locator(`[data-dialog-tab="${tab}"]`).click();
}

async function closeDialog(page) {
  await page.locator('[data-action="close-dialog"]').click();
  await page.waitForFunction(() => !document.querySelector('dialog')?.open);
}

async function main() {
  await fs.mkdir(results, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(results, 'smoke-data-'));
  const home = await fs.mkdtemp(path.join(results, 'smoke-home-'));
  claudeBin = await fs.mkdtemp(path.join(results, 'smoke-claude-bin-'));
  await fs.writeFile(path.join(claudeBin, 'claude.exe'), '');
  // Claude Code lit USERPROFILE/.claude/.credentials.json : le smoke utilise un
  // faux profil isolé, jamais le fichier réel de l'utilisateur.
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude', '.credentials.json'), JSON.stringify({
    otherAccount: { preserve: true },
    claudeAiOauth: {
      accessToken: 'smoke-claude-access', refreshToken: 'smoke-claude-refresh',
      expiresAt: Date.now() + 8 * 3600000, scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max', rateLimitTier: 'default',
    },
  }));
  // État initial déterministe : thème clair forcé (le seed par défaut est « system »).
  const initial = createSeed();
  initial.settings.theme = 'light';
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify(initial));

  desktop = await launch(dataDir, home);
  let page = await desktop.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('.cards .card');
  // Barre du haut façon VS Code (0.6.11) : boutons Windows natifs à droite,
  // recherche au centre, actions utiles ; plus de second bouton Réglages.
  assert.equal(await page.evaluate(() => Boolean(navigator.windowControlsOverlay?.visible)), true, 'boutons Windows natifs');
  assert.deepEqual(await page.locator('.titlebar-actions [data-action]').evaluateAll(items => items.map(item => item.dataset.action)),
    ['sync', 'toggle-widget', 'toggle-theme', 'open-settings']);
  assert.equal(await page.locator('.titlebar #search').count(), 1);
  await page.locator('[data-action="open-settings"]').click();
  await page.waitForSelector('#settings-form');
  // Lancement au démarrage : disponible dans l'exécutable construit, pas en développement.
  const packagedApp = await page.evaluate(() => Boolean(state.app?.packaged));
  assert.equal(await page.locator('[name="autostart"]').isDisabled(), !packagedApp, 'lancement au démarrage réservé à l’application installée');
  await page.locator('#search').fill('claude');
  await page.waitForFunction(() => page === 'overview' && document.activeElement?.id === 'search');
  await page.locator('#search').fill('');

  // ------------------------------------------------------------------ *
  // Démarrage : marque neutre, thème forcé, version dynamique, IPC app:info
  // ------------------------------------------------------------------ *
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.themePreference), 'light');
  const workspaceText = await page.locator('.workspace').innerText();
  assert.match(workspaceText, /Espace local/);
  assert.doesNotMatch(workspaceText, /Lasme/);
  assert.equal(await page.locator('.sidebar').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  const sidebarBackground = await page.locator('.sidebar').evaluate(el => getComputedStyle(el).backgroundImage);
  assert.match(sidebarBackground, /linear-gradient/, 'le rail doit porter la signature obsidian');
  assert.equal(await page.locator('.brand-name').innerText(), 'Lasmium');
  assert.equal(await page.locator('.brand-sub').innerText(), 'TOKENS-HUB');
  const brandLogo = await page.locator('.brand-logo img').evaluate(img => ({ loaded: img.complete && img.naturalWidth > 0, width: img.getBoundingClientRect().width }));
  assert.equal(brandLogo.loaded, true, 'le logo Lasmium doit être chargé');
  assert.ok(brandLogo.width >= 32, `logo Lasmium trop petit : ${brandLogo.width}px`);
  assert.equal(await page.title(), 'Lasmium TOKENS-HUB');
  assert.equal(await page.locator('.cards .card').count(), 10);
  // Recommandations/ordre de consommation retirés (T16) : aucun panneau, action ni
  // texte de stratégie dans le tableau de bord.
  assert.equal(await page.locator('.strategy-panel, .strategy-current, .strategy-next, .strategy-api, .strategy-details, #strategy-form, [data-action="strategy-settings"]').count(), 0);
  const overviewText = await page.locator('#main-content').innerText();
  for (const forbidden of ['Utilise maintenant', 'Abonnements à vérifier', 'API disponibles à utiliser', 'Régler l’ordre', 'Ton ordre d’usage', 'Ordre de consommation']) {
    assert.equal(overviewText.includes(forbidden), false, `texte de recommandation encore affiché : ${forbidden}`);
  }
  assert.equal(await page.evaluate(() => typeof strategyResult), 'undefined');
  assert.equal(await page.evaluate(() => typeof UsageStrategy), 'undefined');
  assert.equal(await page.evaluate(async () => 'strategy' in (await window.lasmium.getState())), false);
  const appInfo = await page.evaluate(() => window.lasmium.getAppInfo());
  assert.equal(appInfo.version, packageJson.version);
  assert.match(String(appInfo.electron), /^44\./);
  assert.equal(appInfo.platform, 'win32');
  assert.equal(appInfo.packaged, Boolean(process.env.PROVIDERSBAR_EXECUTABLE));
  assert.equal(appInfo.dataDir, dataDir);
  const publicApp = await page.evaluate(async () => (await window.lasmium.getState()).app);
  assert.equal(publicApp.version, packageJson.version);
  assert.equal(publicApp.dataDir, undefined, 'publicState ne doit pas exposer de chemin absolu');
  await page.screenshot({ path: path.join(results, 'dashboard.png'), fullPage: true });
  await page.screenshot({ path: path.join(results, 'dashboard-window.png') });

  // ------------------------------------------------------------------ *
  // Réglages : version dynamique, télémétrie, effacement (confirmation puis annulation)
  // ------------------------------------------------------------------ *
  await page.locator('[data-nav="settings"]').click();
  assert.equal(await page.locator('#app-version').innerText(), `Version ${packageJson.version}`);
  assert.equal(await page.locator('.update-panel').count(), 1);
  assert.match(await page.locator('.update-panel').innerText(), /Mises à jour/);
  assert.equal(await page.locator('[data-action="update-check"]').count(), 1);
  assert.match(await page.locator('.privacy-note').innerText(), /Aucune télémétrie/);
  // Chips de statut de la légende des Réglages (T19) : texte toujours visible.
  assert.deepEqual(await page.locator('.resource-legend .level-pill').allTextContents(), [
    'Épuisé · 0', 'Critique · ≤ 2 USD ou ≤ 10 %', 'Bas · ≤ 5 USD ou ≤ 25 %',
    'Suffisant · au-dessus', 'Indisponible · aucune donnée',
  ]);
  assert.equal(await page.locator('[data-action="erase-data"]').count(), 1);
  await page.locator('[data-action="erase-data"]').click();
  await page.waitForSelector('.danger-zone');
  assert.match(await page.locator('.danger-zone').innerText(), /irréversible/);
  assert.equal(await page.locator('[data-action="erase-cancel"]').count(), 1);
  await page.locator('[data-action="erase-cancel"]').click();
  await page.waitForFunction(() => !document.querySelector('.danger-zone'));
  await page.locator('[data-nav="overview"]').click();

  // ------------------------------------------------------------------ *
  // Recommandations retirées : aucun formulaire ni texte dans les Réglages
  // ------------------------------------------------------------------ *
  await page.locator('[data-nav="settings"]').click();
  assert.equal(await page.locator('#strategy-form, [data-action="strategy-settings"], .strategy-panel, .strategy-settings').count(), 0);
  const settingsText = await page.locator('#main-content').innerText();
  for (const forbidden of ['Ordre de consommation', 'Utilise maintenant', 'Régler l’ordre', 'API disponibles à utiliser', 'Modèles accessibles']) {
    assert.equal(settingsText.includes(forbidden), false, `texte de recommandation encore affiché dans Réglages : ${forbidden}`);
  }
  await page.locator('[data-nav="overview"]').click();

  // ------------------------------------------------------------------ *
  // Navigation, recherche, filtres
  // ------------------------------------------------------------------ *
  await page.locator('[data-nav="subscriptions"]').first().click();
  assert.equal(await page.locator('.data-table tbody tr').count(), 6);
  await page.screenshot({ path: path.join(results, 'subscriptions.png'), fullPage: true });
  await page.locator('[data-nav="connections"]').click();
  assert.equal(await page.locator('.connection-card').count(), 10);
  assert.equal(await page.locator('.health-panel').count(), 1);
  assert.equal(await page.locator('.health-row').count(), 10);
  assert.match(await page.locator('.health-panel').innerText(), /Santé des connexions/);
  assert.match(await page.locator('.health-packs').innerText(), /Packs signés actifs/);
  const packState = await page.evaluate(() => window.lasmium.getState());
  assert.equal(packState.connectorPacks.length, 3);
  assert.ok(packState.connectorPacks.every(pack => pack.version && pack.parserVersion));
  assert.equal(packState.connectorPackErrors.length, 0);
  await page.screenshot({ path: path.join(results, 'connections.png'), fullPage: true });
  await page.locator('[data-nav="overview"]').click();
  await page.locator('#search').fill('deepseek');
  assert.equal(await page.locator('.cards .card').count(), 1);
  await page.locator('#search').fill('');
  await page.locator('[data-filter="api"]').click();
  assert.equal(await page.locator('.cards .card').count(), 4);
  await page.locator('[data-filter="all"]').click();

  // ------------------------------------------------------------------ *
  // Fiche abonnement (0.6.9) : forfait, prix, fréquence, échéance ; fin et
  // réactivation ; aucun onglet « Relevé manuel » ni « Réinitialisations ».
  // ------------------------------------------------------------------ *
  await openProvider(page, 'openai');
  assert.deepEqual(await page.locator('[role="tab"]').allTextContents(), ['Informations', 'Connexion']);
  for (const removed of ['#notes', '#statusMessage', '#nextAmount', '#priceChangeDate', '[name="reviewed"]', '#subscriptionStatus']) {
    assert.equal(await page.locator(removed).count(), 0, `${removed} ne doit plus exister`);
  }
  await page.screenshot({ path: path.join(results, 'provider-details.png') });
  await page.locator('#plan').fill('Offre de test');
  await page.locator('#amount').fill('103');
  await page.locator('#billingCycle').selectOption('yearly');
  assert.match(await page.locator('#cost-line').innerText(), /8,58.*par mois/);
  await page.locator('#billingCycle').selectOption('one-time');
  assert.equal(await page.locator('#renewalDate-label').innerText(), 'Fin de la période payée');
  await page.locator('#billingCycle').selectOption('monthly');
  assert.equal(await page.locator('#renewalDate-label').innerText(), 'Prochain paiement');
  await page.locator('#renewalDate').fill(futureDate);
  await page.locator('#provider-form button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('dialog').open);
  assert.ok((await page.locator('.stats').innerText()).includes('103'));
  await openProvider(page, 'openai');
  await page.locator('[data-action="subscription-end"]').click();
  await page.waitForFunction(() => !document.querySelector('dialog').open);
  const expiredState = await page.evaluate(() => window.lasmium.getState());
  assert.equal(expiredState.providers.find(p => p.id === 'openai').active, false);
  assert.equal(expiredState.providers.find(p => p.id === 'openai').subscriptionStatus, 'expired');
  assert.deepEqual(expiredState.summary.monthly, {});
  assert.match(await page.locator('.expired-card').innerText(), /Tu n’as plus cet abonnement/);
  await page.screenshot({ path: path.join(results, 'expired-subscription.png'), fullPage: true });
  await assert.rejects(page.evaluate(() => window.lasmium.syncOne('openai')), /expiré/);
  await page.locator('[data-nav="subscriptions"]').click();
  assert.match(await page.locator('.expired-row').innerText(), /Abonnement terminé/);
  await page.locator('[data-nav="overview"]').click();
  await openProvider(page, 'openai');
  assert.equal(await page.locator('#provider-form button[type="submit"]').innerText(), 'Réactiver');
  await page.locator('#renewalDate').fill(pastDate);
  await page.locator('#provider-form button[type="submit"]').click();
  assert.match(await page.locator('#provider-form .form-error').innerText(), /échéance future/);
  await page.locator('#renewalDate').fill(futureDate);
  await page.locator('#provider-form button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('dialog').open);
  assert.ok((await page.locator('.stats').innerText()).includes('103'));
  // Un mensuel dont l'échéance est passée reste compté et passe « à vérifier ».
  const overdueState = await page.evaluate(renewalDate => window.lasmium.updateProvider('openai', { renewalDate }), pastDate);
  assert.equal(overdueState.providers.find(p => p.id === 'openai').subscriptionStatus, 'active');
  assert.equal(overdueState.summary.monthly.USD, 103);
  assert.equal(overdueState.summary.overdue, 1);
  await page.waitForFunction(() => document.querySelector('.stats')?.innerText.includes('échéance à vérifier'));
  await page.evaluate(renewalDate => window.lasmium.updateProvider('openai', { renewalDate }), futureDate);
  // Paiement unique : compté à part, jamais dans le coût mensuel.
  const oneTimeState = await page.evaluate(renewalDate => window.lasmium.updateProvider('grok', { amount: 199, billingCycle: 'one-time', renewalDate }), futureDate);
  assert.deepEqual(oneTimeState.summary.oneTime, { USD: 199 });
  assert.equal(oneTimeState.summary.monthly.USD, 103);
  await page.evaluate(() => window.lasmium.updateProvider('grok', { amount: null, billingCycle: 'unknown', renewalDate: null }));

  // ------------------------------------------------------------------ *
  // Connecteurs API : validation, chiffrement, course connect/disconnect,
  // panne transitoire puis reprise, cooldown 429 persistant.
  // ------------------------------------------------------------------ *
  await desktop.evaluate(() => {
    process.mainModule.require('electron').session.defaultSession.fetch = async (_url, options) => {
      if (options.headers.Authorization === 'Bearer test-rejected') return { ok: false, status: 403 };
      return { ok: true, json: async () => ({ data: { total_credits: 100, total_usage: 25.5 } }) };
    };
  });
  await page.locator('[data-nav="connections"]').first().click();
  await openProvider(page, 'openrouter', 'connection');
  await page.locator('#api-key').fill('test-rejected');
  await page.locator('#connection-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#connection-form .form-error').textContent.includes('clé de gestion'));
  await page.locator('#api-key').fill('test-secret-never-export');
  await page.locator('#connection-form button[type="submit"]').click();
  await page.waitForSelector('.connection-success');
  assert.equal(await page.locator('#api-key').inputValue(), '');
  const secretText = await fs.readFile(path.join(dataDir, 'credentials.json'), 'utf8');
  assert.ok(!secretText.includes('test-secret-never-export'));
  // Déconnexion pendant la validation d'une clé de remplacement.
  await desktop.evaluate(({ session }) => {
    const gate = new Promise(resolve => { globalThis.releaseApiConnection = resolve; });
    session.defaultSession.fetch = async (_url, options) => {
      if (options.headers.Authorization === 'Bearer test-pending-replacement') await gate;
      return { ok: true, json: async () => ({ data: { total_credits: 100, total_usage: 25.5 } }) };
    };
  });
  await page.evaluate(() => { globalThis.pendingReplacement = window.lasmium.connect('openrouter', 'test-pending-replacement'); });
  await page.waitForFunction(() => state.providers.find(p => p.id === 'openrouter').syncing);
  await page.evaluate(() => { globalThis.pendingDisconnect = window.lasmium.disconnect('openrouter'); });
  await assert.rejects(page.evaluate(() => window.lasmium.connect('openrouter', 'test-overlapping')), /opération.*en cours/);
  await desktop.evaluate(() => globalThis.releaseApiConnection());
  await page.evaluate(async () => { await Promise.all([globalThis.pendingReplacement, globalThis.pendingDisconnect]); });
  const disconnectedDuringConnect = await page.evaluate(() => window.lasmium.getState());
  assert.equal(disconnectedDuringConnect.providers.find(p => p.id === 'openrouter').connected, false);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'credentials.json'), 'utf8')).openrouter, undefined);
  await page.evaluate(() => window.lasmium.connect('openrouter', 'test-secret-never-export'));
  // Panne transitoire : la clé reste connectée, le dernier relevé est conservé,
  // puis une synchronisation réussie efface l'erreur sans ressaisie.
  await desktop.evaluate(({ session }) => {
    session.defaultSession.fetch = async url => {
      if (String(url).includes('openrouter.ai')) throw new Error('smoke network down');
      return { ok: true, json: async () => ({ data: { total_credits: 100, total_usage: 25.5 } }) };
    };
  });
  let transient = await page.evaluate(() => window.lasmium.syncOne('openrouter'));
  assert.match(transient.providers.find(p => p.id === 'openrouter').error, /Connexion impossible/);
  assert.equal(transient.providers.find(p => p.id === 'openrouter').connected, true);
  assert.equal(transient.providers.find(p => p.id === 'openrouter').snapshot.balances[0].remaining, 74.5);
  await desktop.evaluate(({ session }) => {
    session.defaultSession.fetch = async () => ({ ok: true, json: async () => ({ data: { total_credits: 100, total_usage: 25.5 } }) });
  });
  const recovered = await page.evaluate(() => window.lasmium.syncOne('openrouter'));
  assert.equal(recovered.providers.find(p => p.id === 'openrouter').error, null);
  assert.equal(recovered.providers.find(p => p.id === 'openrouter').connected, true);
  // Fiche API (0.6.9) : la clé seulement, puis le suivi des dépenses.
  assert.deepEqual(await page.locator('[role="tab"]').allTextContents(), ['Connexion', 'Dépenses']);
  assert.equal(await page.locator('#plan').count(), 0);
  await page.locator('[data-dialog-tab="spending"]').click();
  await page.locator('#startAmount').fill('10');
  await page.locator('#spending-form button[type="submit"]').click();
  await page.waitForFunction(() => state.providers.find(p => p.id === 'openrouter').spending?.startAmount === 10);
  // Le solde passe de 74,50 à 94,50 : une recharge de 20 $ est détectée et comptée.
  await desktop.evaluate(({ session }) => {
    session.defaultSession.fetch = async () => ({ ok: true, json: async () => ({ data: { total_credits: 120, total_usage: 25.5 } }) });
  });
  const toppedUp = (await page.evaluate(() => window.lasmium.syncOne('openrouter'))).providers.find(p => p.id === 'openrouter');
  assert.equal(toppedUp.spending.topUps.length, 1);
  assert.equal(toppedUp.spending.topUps[0].amount, 20);
  assert.deepEqual(toppedUp.spendingTotals, { currency: 'USD', thisMonth: 30, total: 30, topUps: 1 });
  await page.waitForFunction(() => document.querySelector('.top-up'));
  await page.locator('[data-action="topup-toggle"]').click();
  await page.waitForFunction(() => state.providers.find(p => p.id === 'openrouter').spending.topUps[0].offered === true);
  const offeredState = await page.evaluate(() => window.lasmium.getState());
  assert.equal(offeredState.providers.find(p => p.id === 'openrouter').spendingTotals.thisMonth, 10, 'un crédit offert sort des dépenses');
  assert.deepEqual(offeredState.summary.api.month, { USD: 10 });
  await page.screenshot({ path: path.join(results, 'api-spending.png') });
  await desktop.evaluate(({ session }) => {
    session.defaultSession.fetch = async () => ({ ok: true, json: async () => ({ data: { total_credits: 100, total_usage: 25.5 } }) });
  });
  await page.locator('[data-action="spending-stop"]').click();
  await page.waitForFunction(() => !state.providers.find(p => p.id === 'openrouter').spending);
  // Solde d'origine rétabli pour la suite du scénario (74,50 $).
  await page.evaluate(() => window.lasmium.syncOne('openrouter'));
  await closeDialog(page);
  // ------------------------------------------------------------------ *
  // Historique (chargement paresseux par IPC) : relevés OpenRouter réels.
  // ------------------------------------------------------------------ *
  await page.locator('[data-nav="history"]').click();
  await page.waitForSelector('#history-provider');
  await page.locator('#history-provider').selectOption('openrouter');
  assert.equal(await page.locator('.chart-panel').count(), 1);
  assert.ok((await page.locator('.data-table').innerText()).includes('94,50'));
  await page.screenshot({ path: path.join(results, 'history.png'), fullPage: true });
  await page.locator('[data-nav="connections"]').first().click();
  // Second connecteur API : RunInfra (clé d'espace de travail).
  await desktop.evaluate(() => {
    process.mainModule.require('electron').session.defaultSession.fetch = async url => {
      if (url === 'https://api.runinfra.ai/v1/credits') return { ok: true, json: async () => ({ object: 'credits', currency: 'usd', balance_cents: 5476, available_cents: 5476, held_cents: 34, period: { spent_cents: 1500 } }) };
      throw new Error('Unexpected endpoint');
    };
  });
  await openProvider(page, 'runinfra', 'connection');
  await page.locator('#api-key').fill('test-secret-runinfra');
  await page.locator('#connection-form button[type="submit"]').click();
  await page.waitForSelector('.connection-success');
  const connectedRuninfra = await page.evaluate(() => window.lasmium.getState());
  assert.equal(connectedRuninfra.providers.find(p => p.id === 'runinfra').snapshot.balances[0].remaining, 54.76);
  assert.equal(connectedRuninfra.providers.find(p => p.id === 'runinfra').connected, true);
  assert.ok(!(await fs.readFile(path.join(dataDir, 'credentials.json'), 'utf8')).includes('test-secret'));
  await page.locator('[data-action="disconnect"]').click();
  await page.waitForFunction(() => !document.querySelector('.connection-success'));
  await closeDialog(page);

  // ------------------------------------------------------------------ *
  // OrcaRouter : session conservée sur erreur transitoire, perdue sur auth
  // invalide, puis reconnexion. Couvre P0-5/P0-6 de l'analyse.
  // ------------------------------------------------------------------ *
  await desktop.evaluate(({ session }) => {
    const isolated = session.fromPartition('persist:orcarouter-account');
    isolated.protocol.handle('https', () => new Response('<!doctype html><title>Orca account test</title><p>Simulated login page</p>', { headers: { 'content-type': 'text/html' } }));
    isolated.fetch = async (url, options) => {
      if (options.headers['New-API-User'] !== '12' || options.headers['X-Workspace-Id'] !== '34') throw new Error('Wrong workspace');
      if (url === 'https://www.orcarouter.ai/api/user/self') return { ok: true, json: async () => ({ success: true, data: { id: 12, active_workspace: { id: 34, wallet_quota: 26600000 } } }) };
      if (url === 'https://www.orcarouter.ai/api/status') return { ok: true, json: async () => ({ success: true, data: { quota_per_unit: 500000 } }) };
      throw new Error('Unexpected wallet endpoint');
    };
  });
  // Connexion dans Chrome ou Edge (navigateur système simulé) : aucune fenêtre
  // intégrée ; la session est lue après la fermeture du navigateur.
  await desktop.evaluate(() => {
    const fake = globalThis.__orcaBrowser = { phase: 'login', opened: 0, closed: 0 };
    process.mainModule.require('./lib/account-browser.cjs').openOrcaBrowser = async () => {
      fake.opened++; fake.phase = 'login';
      return {
        isOpen: () => fake.phase !== 'closed',
        phase: () => fake.phase,
        async readOrcaSession() {
          if (fake.phase === 'login') throw Object.assign(new Error('Termine la connexion OrcaRouter dans Chrome ou Edge.'), { code: 'ORCA_LOGIN_PENDING' });
          fake.phase = 'closed';
          return { ref: { userId: 12, workspaceId: 34 }, cookies: [{ url: 'https://www.orcarouter.ai/', name: 'smoke-orca', value: 'fixture', path: '/', secure: true }] };
        },
        async close() { fake.closed++; fake.phase = 'closed'; },
      };
    };
  });
  await openProvider(page, 'orcarouter', 'connection');
  assert.equal(await page.locator('#api-key').count(), 0);
  const windowsBefore = desktop.windows().length;
  await page.locator('[data-action="orca-open"]').click();
  await page.waitForFunction(() => document.querySelector('#orca-connection-progress')?.textContent.includes('Chrome ou Edge'));
  assert.ok((await page.locator('#orca-connection-progress').innerText()).includes('automatiquement'));
  assert.equal(desktop.windows().length, windowsBefore, 'aucune fenêtre intégrée pour OrcaRouter');
  assert.equal(await page.locator('.connection-success').count(), 0);
  await desktop.evaluate(() => { globalThis.__orcaBrowser.phase = 'verifying'; });
  await page.waitForSelector('.connection-success');
  assert.deepEqual(await desktop.evaluate(async ({ session }) => ({
    cookies: (await session.fromPartition('persist:orcarouter-account').cookies.get({ name: 'smoke-orca' })).length,
    opened: globalThis.__orcaBrowser.opened, closed: globalThis.__orcaBrowser.closed,
  })), { cookies: 1, opened: 1, closed: 1 });
  assert.ok((await page.locator('.dialog-body').innerText()).includes('53,20'));
  await page.screenshot({ path: path.join(results, 'orca-account.png') });
  let orcaState = await page.evaluate(() => window.lasmium.getState());
  assert.equal(orcaState.providers.find(p => p.id === 'orcarouter').snapshot.balances[0].remaining, 53.2);
  assert.equal(orcaState.providers.find(p => p.id === 'orcarouter').connected, true);
  // Erreur transitoire (5xx) : session et relevé conservés, reprise possible
  // sans reconnexion (P0-5) — la session est écrite avant le premier fetch.
  const patchOrcaSuccess = () => desktop.evaluate(({ session }) => {
    session.fromPartition('persist:orcarouter-account').fetch = async url => {
      if (url === 'https://www.orcarouter.ai/api/user/self') return { ok: true, json: async () => ({ success: true, data: { id: 12, active_workspace: { id: 34, wallet_quota: 26600000 } } }) };
      return { ok: true, json: async () => ({ success: true, data: { quota_per_unit: 500000 } }) };
    };
  });
  await desktop.evaluate(({ session }) => { session.fromPartition('persist:orcarouter-account').fetch = async () => ({ ok: false, status: 500 }); });
  orcaState = await page.evaluate(() => window.lasmium.syncOne('orcarouter'));
  const orcaTransient = orcaState.providers.find(p => p.id === 'orcarouter');
  assert.match(orcaTransient.error, /indisponible \(HTTP 500\)/);
  assert.equal(orcaTransient.connected, true);
  assert.equal(orcaTransient.accountSession.userId, 12);
  assert.equal(orcaTransient.snapshot.balances[0].remaining, 53.2);
  await patchOrcaSuccess();
  orcaState = await page.evaluate(() => window.lasmium.syncOne('orcarouter'));
  assert.equal(orcaState.providers.find(p => p.id === 'orcarouter').error, null);
  assert.equal(orcaState.providers.find(p => p.id === 'orcarouter').connected, true);
  // 429 : cooldown serveur honoré (persisté en mémoire) et relevé conservé ;
  // la reprise n'a lieu qu'après le délai, pas immédiatement.
  await desktop.evaluate(({ session }) => { session.fromPartition('persist:orcarouter-account').fetch = async () => ({ ok: false, status: 429 }); });
  orcaState = await page.evaluate(() => window.lasmium.syncOne('orcarouter'));
  assert.match(orcaState.providers.find(p => p.id === 'orcarouter').error, /Trop de demandes/);
  orcaState = await page.evaluate(() => window.lasmium.syncOne('orcarouter'));
  assert.match(orcaState.providers.find(p => p.id === 'orcarouter').error, /Trop de demandes/);
  assert.equal(orcaState.providers.find(p => p.id === 'orcarouter').connected, true);
  // Délai écoulé : le store de cooldown est réinitialisé par l'application
  // (équivalent d'une nouvelle tentative après 60 s) ; la lecture réussit.
  await desktop.evaluate(() => process.mainModule.require('./lib/orca-account.cjs').resetOrcaRateLimit());
  await patchOrcaSuccess();
  orcaState = await page.evaluate(() => window.lasmium.syncOne('orcarouter'));
  assert.equal(orcaState.providers.find(p => p.id === 'orcarouter').error, null);
  // Session expirée : la connexion repasse « non connectée », le relevé reste.
  await desktop.evaluate(({ session }) => { session.fromPartition('persist:orcarouter-account').fetch = async () => ({ ok: false, status: 401 }); });
  orcaState = await page.evaluate(() => window.lasmium.syncOne('orcarouter'));
  const orcaExpired = orcaState.providers.find(p => p.id === 'orcarouter');
  assert.match(orcaExpired.error, /expirée/);
  assert.equal(orcaExpired.connected, false);
  assert.equal(orcaExpired.accountSession, undefined);
  assert.equal(orcaExpired.snapshot.balances[0].remaining, 53.2);
  // Reconnexion via la fenêtre de compte : la session est rétablie avant le relevé.
  await desktop.evaluate(({ session }) => {
    session.fromPartition('persist:orcarouter-account').fetch = async url => {
      if (url === 'https://www.orcarouter.ai/api/user/self') return { ok: true, json: async () => ({ success: true, data: { id: 12, active_workspace: { id: 34, wallet_quota: 26600000 } } }) };
      return { ok: true, json: async () => ({ success: true, data: { quota_per_unit: 500000 } }) };
    };
  });
  // Sans Chrome ni Edge, la fenêtre intégrée isolée reste un recours.
  await desktop.evaluate(() => {
    process.mainModule.require('./lib/account-browser.cjs').openOrcaBrowser = async () => { throw new Error('Chrome ou Edge est nécessaire.'); };
  });
  await closeDialog(page);
  await openProvider(page, 'orcarouter', 'connection');
  const reconnected = desktop.waitForEvent('window');
  await page.locator('[data-action="orca-open"]').click();
  const reconnectWindow = await reconnected;
  await reconnectWindow.waitForURL('https://www.orcarouter.ai/console');
  assert.equal(await reconnectWindow.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await reconnectWindow.evaluate(() => typeof window.lasmium), 'undefined');
  await reconnectWindow.evaluate(() => { localStorage.setItem('user', JSON.stringify({ id: 12 })); localStorage.setItem('active_workspace_id', '34'); });
  await page.waitForSelector('.connection-success');
  orcaState = await page.evaluate(() => window.lasmium.getState());
  assert.equal(orcaState.providers.find(p => p.id === 'orcarouter').connected, true);
  await closeDialog(page);
  await page.locator('[data-nav="overview"]').click();
  const router = page.locator('.card').filter({ has: page.locator('[data-open="openrouter"]') });

  // ------------------------------------------------------------------ *
  // Ollama : session isolée, lecture des crédits, session invalide, reprise
  // ------------------------------------------------------------------ *
  await desktop.evaluate(({ session }) => {
    const isolated = session.fromPartition('persist:ollama-account');
    isolated.protocol.handle('https', () => new Response('<!doctype html><title>Ollama account test</title><p>Signed-in settings</p>', { headers: { 'content-type': 'text/html' } }));
    isolated.fetch = async url => {
      // Tableau de bord absent (404) : repli sur l'ancienne page /settings.
      if (url === 'https://ollama.com/dashboard') return { ok: false, status: 404 };
      if (url !== 'https://ollama.com/settings') throw new Error('Unexpected settings URL');
      return { ok: true, status: 200, url, text: async () => '<h2>Included usage Pro</h2><h3>Monthly usage</h3><span>$12.50 of $60.00 used</span><span data-time="2026-10-07T12:00:00Z">Resets</span><h3>Usage credits</h3><span>$2.98</span><small>Current balance</small>' };
    };
  });
  await openProvider(page, 'ollama', 'connection');
  assert.equal(await page.locator('#api-key').count(), 0);
  assert.equal(await page.locator('[data-action="ollama-open"]').count(), 1);
  // Le parcours email/IPC conservé par main.cjs est exercé directement : le
  // renderer 0.3.0 propose le navigateur système (ollama-open) en priorité.
  const ollamaOpened = desktop.waitForEvent('window');
  await page.evaluate(() => window.lasmium.openOllamaEmail());
  const ollamaWindow = await ollamaOpened;
  await ollamaWindow.waitForURL('https://ollama.com/settings');
  assert.equal(await ollamaWindow.evaluate(() => typeof window.lasmium), 'undefined');
  assert.equal(await desktop.evaluate(({ BrowserWindow, session }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('https://ollama.com')).webContents.session === session.fromPartition('persist:orcarouter-account')), false);
  await page.waitForSelector('.connection-success');
  await page.screenshot({ path: path.join(results, 'ollama-account.png') });
  let ollamaState = await page.evaluate(() => window.lasmium.getState());
  assert.equal(ollamaState.providers.find(p => p.id === 'ollama').snapshot.balances[0].remaining, 47.5);
  assert.equal(ollamaState.providers.find(p => p.id === 'ollama').snapshot.usageCredits.remaining, 2.98);
  assert.match(await page.locator('.dialog-body').innerText(), /Réserve supplémentaire/);
  assert.equal(ollamaState.providers.find(p => p.id === 'ollama').amount, null);
  assert.equal(ollamaState.providers.find(p => p.id === 'ollama').connected, true);
  // Session invalide : la connexion est retirée mais le dernier relevé reste.
  await desktop.evaluate(({ session }) => { session.fromPartition('persist:ollama-account').fetch = async () => ({ ok: false, status: 302 }); });
  ollamaState = await page.evaluate(() => window.lasmium.syncOne('ollama'));
  const ollamaExpired = ollamaState.providers.find(p => p.id === 'ollama');
  assert.match(ollamaExpired.error, /expirée/);
  assert.equal(ollamaExpired.connected, false);
  assert.equal(ollamaExpired.snapshot.balances[0].remaining, 47.5);
  await closeDialog(page);
  // Reprise : une vérification réussie rétablit la session avant le premier fetch.
  await desktop.evaluate(({ session }) => {
    session.fromPartition('persist:ollama-account').fetch = async url => ({ ok: true, status: 200, url, text: async () => '<h2>Included usage Pro</h2><h3>Monthly usage</h3><span>$12.50 of $60.00 used</span><h3>Usage credits</h3><span>$2.98</span><small>Current balance</small>' });
  });
  ollamaState = await page.evaluate(() => window.lasmium.verifyOllamaAccount());
  assert.equal(ollamaState.providers.find(p => p.id === 'ollama').connected, true);
  assert.ok((await router.innerText()).includes('74,50'));
  // Un échec de rafraîchissement (429) conserve le dernier relevé valide.
  await desktop.evaluate(() => { process.mainModule.require('electron').session.defaultSession.fetch = async () => ({ ok: false, status: 429 }); });
  await page.locator('[data-action="sync"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.card-error')].some(el => el.textContent.includes('Trop de demandes')));
  assert.ok((await router.innerText()).includes('74,50'));
  const afterCooldown = await page.evaluate(() => window.lasmium.getState());
  assert.ok(Object.keys(afterCooldown.apiCooldowns || {}).length >= 1, 'le cooldown 429 doit être persisté dans apiCooldowns');
  const persistedCooldown = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  assert.ok(Object.keys(persistedCooldown.apiCooldowns || {}).length >= 1, 'apiCooldowns doit être écrit sur disque');
  await openProvider(page, 'openrouter', 'connection');
  await page.locator('[data-action="disconnect"]').click();
  await page.waitForFunction(() => !document.querySelector('.connection-success'));
  await closeDialog(page);
  await page.locator('[data-favorite="grok"]').click();

  // ------------------------------------------------------------------ *
  // Réglages : thème sombre/clair/système, préférences persistées
  // ------------------------------------------------------------------ *
  await page.locator('[data-nav="settings"]').click();
  await page.locator('[name="autoRefresh"]').uncheck();
  await page.locator('[name="theme"]').selectOption('dark');
  await page.locator('#settings-form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Préférences enregistrées.');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.match(await page.locator('.sidebar').evaluate(el => getComputedStyle(el).backgroundImage), /linear-gradient/);
  assert.equal(await page.locator('.brand-name').evaluate(el => getComputedStyle(el).color), 'rgb(234, 242, 248)');
  await page.screenshot({ path: path.join(results, 'settings-dark.png') });
  await page.locator('[name="theme"]').selectOption('system');
  await page.locator('#settings-form button[type="submit"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.themePreference === 'system');
  const systemTheme = await page.evaluate(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, systemTheme);
  const quickForTheme = desktop.windows().find(w => w.url().includes('mode=quick'));
  await quickForTheme.waitForFunction(expected => document.documentElement.dataset.theme === expected, systemTheme);
  await assert.rejects(page.evaluate(() => window.lasmium.updateSettings({ ...state.settings, theme: 'bogus' })), /invalides/);
  await page.locator('[name="theme"]').selectOption('light');
  await page.locator('#settings-form button[type="submit"]').click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await quickForTheme.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.screenshot({ path: path.join(results, 'settings-light.png') });

  // ------------------------------------------------------------------ *
  // Export nettoyé (sans session, identité, clé ni cooldown)
  // ------------------------------------------------------------------ *
  const exportPath = path.join(results, 'export-test.json');
  const historyCountBeforeExport = await page.evaluate(async () => (await window.lasmium.getHistory()).length);
  await desktop.evaluate(({ dialog }, exportPath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: exportPath }); }, exportPath);
  await page.locator('[data-action="export"]').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Données exportées, sans les clés.');
  const exported = await fs.readFile(exportPath, 'utf8');
  assert.ok(!exported.includes('test-secret'));
  for (const forbidden of ['accountSession', 'identity', 'claudeSync', 'apiCooldowns', 'workspaceId', 'userId']) {
    assert.ok(!exported.includes(forbidden), `l’export ne doit pas contenir ${forbidden}`);
  }
  const exportedDocument = JSON.parse(exported);
  assert.equal(exportedDocument.version, packageJson.version);
  assert.equal(exportedDocument.inventory.length, 10);
  assert.equal(exportedDocument.history.length, historyCountBeforeExport);
  // L'ordre de consommation a été retiré : l'export ne contient plus `strategy`.
  assert.equal('strategy' in exportedDocument, false);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');

  // ------------------------------------------------------------------ *
  // Widget compact 360×520 : liste abonnements puis API, sans recommandation
  // ------------------------------------------------------------------ *
  const quick = desktop.windows().find(w => w.url().includes('mode=quick'));
  assert.ok(quick);
  await quick.waitForSelector('.quick-row');
  // Police Inter Variable autohébergée (T19) : fichiers présents, licence OFL,
  // chargement réel et chiffres tabulaires dans la fenêtre principale ET le widget.
  const fontDirectory = path.join(root, 'assets', 'fonts');
  const fontFile = path.join(fontDirectory, 'InterVariable.woff2');
  const licenseFile = path.join(fontDirectory, 'LICENSE-Inter.txt');
  const soraFile = path.join(fontDirectory, 'SoraVariable.woff2');
const soraLicense = path.join(fontDirectory, 'LICENSE-Sora.txt');
const soraBytes = await fs.readFile(soraFile);
assert.equal(soraBytes.subarray(0, 4).toString('latin1'), 'wOF2', 'SoraVariable.woff2 doit être une police WOFF2 valide');
assert.ok(soraBytes.length > 20000, `police Sora trop petite : ${soraBytes.length} octets`);
assert.match(await fs.readFile(soraLicense, 'utf8'), /SIL OPEN FONT LICENSE|SIL Open Font License/i, 'licence Sora (OFL) manquante');
const fontBytes = await fs.readFile(fontFile);
  assert.equal(fontBytes.subarray(0, 4).toString('latin1'), 'wOF2', 'InterVariable.woff2 doit être une police WOFF2 valide');
  assert.ok(fontBytes.length > 100000, `police Inter trop petite : ${fontBytes.length} octets`);
  assert.match(await fs.readFile(licenseFile, 'utf8'), /SIL OPEN FONT LICENSE|SIL Open Font License/i, 'licence Inter (OFL) manquante');
  for (const surface of [page, quick]) {
    const fontState = await surface.evaluate(async () => {
      try { await document.fonts.load('400 13px "Inter Variable"'); } catch { /* repli mesuré ci-dessous */ }
      try { await document.fonts.load('600 16px "Sora Variable"'); } catch { /* repli mesuré ci-dessous */ }
      await document.fonts.ready;
      const body = getComputedStyle(document.body);
      const heading = document.querySelector('h1, .brand-name');
      return { check: document.fonts.check('400 13px "Inter Variable"'), sora: document.fonts.check('600 16px "Sora Variable"'), family: body.fontFamily, headingFamily: heading ? getComputedStyle(heading).fontFamily : '', numeric: body.fontVariantNumeric };
    });
    assert.equal(fontState.check, true, 'Inter Variable doit être chargée dans la surface');
    assert.equal(fontState.sora, true, 'Sora Variable doit être chargée dans la surface');
    assert.match(fontState.headingFamily, /Sora Variable/, 'les titres et la marque doivent utiliser Sora Variable');
    assert.match(fontState.family, /Inter Variable/, 'la famille calculée doit commencer par Inter Variable');
    assert.match(fontState.numeric, /tabular-nums/, 'les chiffres doivent être tabulaires');
  }
  // Embarquement dans un portable existant : vérifié seulement si ce portable a
  // déjà été reconstruit avec la nouvelle feuille de style (sinon build antérieur).
  try {
    const distEntries = await fs.readdir(path.join(root, 'dist'), { withFileTypes: true });
    for (const entry of distEntries.filter(item => item.isDirectory() && item.name.startsWith('Lasmium TOKENS-HUB'))) {
      const app = path.join(root, 'dist', entry.name, 'resources', 'app');
      const appStyles = path.join(app, 'renderer', 'styles.css');
      if (!fss.existsSync(appStyles)) continue;
      if (!(await fs.readFile(appStyles, 'utf8')).includes('Inter Variable')) continue;
      assert.ok(fss.existsSync(path.join(app, 'assets', 'fonts', 'InterVariable.woff2')), `${entry.name} doit embarquer InterVariable.woff2`);
      assert.ok(fss.existsSync(path.join(app, 'assets', 'fonts', 'LICENSE-Inter.txt')), `${entry.name} doit embarquer LICENSE-Inter.txt`);
    }
  } catch { /* dist absent : validation limitée au dépôt */ }
  // Taille par défaut fixée par main.cjs (aucun auto-dimensionnement du renderer).
  // Le widget vertical complet est plus haut (660 px) mais reste plus compact que
  // l'ancien 400×700 et affiche toutes les fenêtres sans défilement.
  const quickSize = await quick.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(Math.abs(quickSize.width - 360) <= 4, `largeur de contenu inattendue : ${quickSize.width}`);
  assert.ok(Math.abs(quickSize.height - 660) <= 4, `hauteur de contenu inattendue : ${quickSize.height}`);
  const quickBounds = await desktop.evaluate(({ BrowserWindow }) => {
    const quickWindow = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('mode=quick'));
    return quickWindow.getBounds();
  });
  assert.ok(Math.abs(quickBounds.width - 360) <= 4 && Math.abs(quickBounds.height - 660) <= 4, `taille de fenêtre inattendue : ${JSON.stringify(quickBounds)}`);
  assert.equal(await quick.locator('.quick-row').count(), 10);
  // Ordre de l'inventaire : abonnements en tête, puis API (aucun classement).
  assert.deepEqual(await quick.locator('.quick-row').evaluateAll(rows => rows.map(row => row.dataset.provider)), ['openai', 'claude', 'grok', 'antigravity', 'zai', 'ollama', 'openrouter', 'deepseek', 'runinfra', 'orcarouter']);
  assert.deepEqual(await quick.locator('.quick-group-title').allTextContents(), ['Abonnements', 'API']);
  assert.match(await quick.locator('.quick-count').innerText(), /10 comptes · 6 abonnements · 4 API/);
  assert.match(await quick.locator('.quick-refresh-status').innerText(), /Actualisation désactivée/);
  // Aucune recommandation/ordre de consommation ni ancien classement dans le widget.
  assert.equal(await quick.locator('.quick-strategy, .quick-api, .quick-api-providers, [data-api-provider], .quick-columns').count(), 0);
  const quickText = await quick.locator('.quick-list').innerText();
  for (const forbidden of ['À utiliser maintenant', 'Utilise maintenant', 'Abonnements à vérifier', 'API disponibles à utiliser', 'Régler l’ordre']) {
    assert.equal(quickText.includes(forbidden), false, `texte de recommandation encore affiché dans le widget : ${forbidden}`);
  }
  // Plus d'âge affiché en permanence : le relevé n'est visible que dans le title,
  // et l'icône « Relevé à vérifier » n'apparaît que si nécessaire.
  assert.doesNotMatch(quickText, /il y a|à l’instant|Dernier relevé/);
  // Aucun ancien hook de segments plafonnés : le widget vertical affiche tout.
  assert.equal(await quick.locator('.quick-value, .quick-segments, .quick-segment, .quick-extra, .quick-value-main, .quick-period-status, .quick-resource-status, .quick-quota, .meter').count(), 0);
  // Lignes verticales de hauteur variable : entête + une ligne par information.
  const quickRows = await quick.locator('.quick-row').evaluateAll(rows => rows.map(row => {
    const box = row.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, height: box.height };
  }));
  for (const rowBox of quickRows) assert.ok(rowBox.height >= 24 && rowBox.height <= 130, `hauteur de ligne inattendue : ${rowBox.height}px`);
  for (let index = 1; index < quickRows.length; index++) {
    assert.ok(quickRows[index].top >= quickRows[index - 1].bottom - 0.5, 'les lignes du widget ne doivent pas se chevaucher');
  }
  const quickIcons = await quick.locator('.quick-provider .logo img').evaluateAll(images => images
    .filter(image => image.offsetParent !== null)
    .map(image => ({ width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height, loaded: image.complete && image.naturalWidth > 0 })));
  assert.equal(quickIcons.length, 10);
  for (const providerIcon of quickIcons) {
    assert.ok(providerIcon.loaded, 'icône de fournisseur non chargée');
    assert.ok(providerIcon.width >= 14 && providerIcon.width <= 22, `icône non rendue à ~18 px : ${providerIcon.width}`);
    assert.ok(providerIcon.height >= 14 && providerIcon.height <= 22, `icône non rendue à ~18 px : ${providerIcon.height}`);
  }
  // 10 lignes et toutes les informations visibles sans défilement à 360×660.
  const quickFit = await quick.locator('.quick-list').evaluate(el => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  assert.ok(quickFit.scroll <= quickFit.client + 1, `le widget défile à 360×660 : ${JSON.stringify(quickFit)}`);
  assert.ok(await quick.locator('.quick-footer').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight), 'le pied du widget doit rester visible');
  // La fenêtre du widget est masquée par défaut : la rendre visible pour les
  // captures (sans voler le focus ni déclencher la fermeture sur blur).
  await desktop.evaluate(({ BrowserWindow }) => {
    const quickWindow = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('mode=quick'));
    quickWindow.webContents.setBackgroundThrottling(false);
    quickWindow.removeAllListeners('blur');
    quickWindow.showInactive();
  });
  await quick.waitForTimeout(200);
  await quick.screenshot({ path: path.join(results, 'quick.png') });
  // Niveau toujours textuel, une information par fenêtre, aucun « +N ».
  const quickLevels = await quick.locator('.quick-level').allTextContents();
  assert.equal(quickLevels.length, 10);
  for (const quickLevel of quickLevels) assert.match(quickLevel, /Épuisé|Critique|Bas|Suffisant|Indisponible/);
  // Chips T19 : classe .level-pill + .quick-level, texte visible et title explicite.
  const quickChips = await quick.locator('.quick-level').evaluateAll(chips => chips.map(chip => ({
    classes: chip.className, text: chip.innerText, title: chip.getAttribute('title'),
  })));
  for (const chip of quickChips) {
    assert.match(chip.classes, /level-pill/);
    assert.match(chip.classes, /resource-(?:empty|critical|low|healthy|unknown)/);
    assert.match(chip.title, /Ressource suffisante|Bas · ≤|Critique · ≤|Ressource épuisée|Donnée indisponible/);
  }
  assert.ok(await quick.locator('[data-provider="ollama"] .quick-fact').count() >= 1, 'Ollama doit afficher ses informations dans le widget');
  // ------------------------------------------------------------------ *
  // T19/T21 : libellés segmentés (Hebdo/Horaire/Hebdo Fable/Hebdo Argon),
  // toutes les fenêtres visibles, Ollama et API complets.
  // ------------------------------------------------------------------ *
  for (const surface of [page, quick]) await surface.evaluate(() => {
    globalThis.t19OriginalState = state;
    state = structuredClone(state);
    const stamp = new Date().toISOString();
    Object.assign(state.providers.find(p => p.id === 'claude'), {
      active: true, connected: true, error: null,
      snapshot: { source: 'api', updatedAt: stamp, balances: [], quotaWindows: [
        { label: 'Semaine', remaining: 40 }, { label: '5 heures', remaining: 80 },
        { label: 'Fable · Semaine', remaining: 30 },
      ] },
    });
    Object.assign(state.providers.find(p => p.id === 'antigravity'), {
      active: true, connected: true, error: null,
      snapshot: { source: 'api', updatedAt: stamp, balances: [], quotaWindows: [
        { label: 'Gemini · Semaine', remaining: 88 }, { label: 'Gemini · 5 heures', remaining: 95 },
        { label: 'Claude et GPT · Semaine', remaining: 70 }, { label: 'Claude et GPT · 5 heures', remaining: 90 },
        { label: 'Gemini 4 Argon · Semaine', remaining: 60 },
      ] },
    });
    Object.assign(state.providers.find(p => p.id === 'zai'), {
      active: true, connected: true, error: null,
      snapshot: { source: 'api', updatedAt: stamp, balances: [], quotaWindows: [
        { label: '5 heures', remaining: 50 },
      ] },
    });
    Object.assign(state.providers.find(p => p.id === 'ollama'), {
      active: true, connected: true, error: null, subscriptionStatus: 'active',
      snapshot: { source: 'api', updatedAt: stamp, connectorVersion: 'ollama-monthly-credits-v1', planTier: 'free',
        balances: [], quotaRemaining: 100, resetAt: null, usageCredits: { currency: 'USD', remaining: 1.05 } },
    });
    Object.assign(state.providers.find(p => p.id === 'deepseek'), {
      active: true, connected: true, error: null,
      snapshot: { source: 'api', updatedAt: stamp, balances: [
        { currency: 'USD', remaining: 10 }, { currency: 'CNY', remaining: 42.5 },
      ] },
    });
    page = 'overview'; filter = 'all'; query = '';
    render();
  });
  // Cartes : libellés exacts, aucune occurrence de « 5 h ».
  assert.deepEqual(await page.locator('.card:has([data-open="claude"]) .quota-period-label').allTextContents(), ['Hebdo', 'Horaire', 'Hebdo Fable']);
  assert.deepEqual(await page.locator('.card:has([data-open="antigravity"]) .quota-period-label').allTextContents(), ['Hebdo', 'Horaire', 'Hebdo', 'Horaire', 'Hebdo Argon']);
  assert.deepEqual(await page.locator('.card:has([data-open="zai"]) .quota-period-label').allTextContents(), ['Horaire']);
  assert.equal(await page.locator('.card:has([data-open="zai"]) .quota-period').count(), 1, 'aucune ligne « — » pour une fenêtre absente');
  assert.doesNotMatch(await page.locator('.card:has([data-open="zai"])').innerText(), /—/);
  const cardsText = await page.locator('#provider-cards').innerText();
  assert.doesNotMatch(cardsText, /\b5 h\b/, 'plus aucun libellé « 5 h » dans les cartes');
  assert.match(cardsText, /Horaire/);
  // Chips des cartes : classe, texte visible, title explicite.
  const cardChips = await page.locator('.card .level-pill').evaluateAll(chips => chips.map(chip => ({
    classes: chip.className, text: chip.innerText, title: chip.getAttribute('title'),
  })));
  assert.ok(cardChips.length > 0);
  for (const chip of cardChips) {
    assert.match(chip.classes, /level-pill/);
    assert.match(chip.text, /Épuisé|Critique|Bas|Suffisant|Indisponible/);
    assert.match(chip.title, /Ressource suffisante|Bas · ≤|Critique · ≤|Ressource épuisée|Donnée indisponible/);
  }
  // Widget vertical : toutes les fenêtres, aucun « +N », Ollama et API complets.
  const widgetFacts = async id => quick.locator(`[data-provider="${id}"] .quick-fact`).evaluateAll(items => items.map(item => ({
    label: item.querySelector('.quick-fact-label')?.textContent || '',
    value: item.querySelector('.quick-fact-value')?.textContent || '',
  })));
  assert.deepEqual((await widgetFacts('claude')).map(fact => fact.label), ['Hebdo', 'Horaire', 'Hebdo Fable']);
  assert.deepEqual((await widgetFacts('claude')).map(fact => fact.value.replace(/\s/g, '')), ['40%', '80%', '30%']);
  assert.deepEqual((await widgetFacts('antigravity')).map(fact => fact.label),
    ['Gemini · Hebdo', 'Gemini · Horaire', 'Claude / GPT · Hebdo', 'Claude / GPT · Horaire', 'Hebdo Argon']);
  assert.deepEqual((await widgetFacts('zai')).map(fact => fact.label), ['Horaire']);
  assert.deepEqual((await widgetFacts('ollama')).map(fact => fact.label), ['Limite Free', 'Crédits achetés']);
  assert.match((await widgetFacts('ollama'))[0].value, /100\s*%/);
  assert.match((await widgetFacts('ollama'))[1].value, /1,05/);
  assert.deepEqual((await widgetFacts('deepseek')).map(fact => fact.label), ['USD', 'CNY']);
  assert.equal(await quick.locator('.quick-extra').count(), 0, 'aucun compteur de segments masqués : tout est affiché');
  assert.doesNotMatch(await quick.locator('.quick-list').innerText(), /\b5 h\b/);
  // Restauration de l'état réel avant les fixtures de niveaux.
  for (const surface of [page, quick]) await surface.evaluate(() => {
    state = globalThis.t19OriginalState;
    delete globalThis.t19OriginalState;
    render();
  });

  // Fournisseurs non suivis absents du widget (expiré non-Ollama), puis restauration.
  await quick.evaluate(() => {
    globalThis.widgetOriginalState = state;
    state = structuredClone(state);
    state.providers.find(provider => provider.id === 'zai').subscriptionStatus = 'expired';
    renderQuick();
  });
  assert.equal(await quick.locator('[data-provider="zai"]').count(), 0);
  assert.equal(await quick.locator('.quick-row').count(), 9);
  await quick.evaluate(() => { state = globalThis.widgetOriginalState; delete globalThis.widgetOriginalState; renderQuick(); });
  assert.equal(await quick.locator('.quick-row').count(), 10);
  // Défilement fin uniquement en cas de dépassement : hauteur réduite 360×320.
  await desktop.evaluate(({ BrowserWindow }) => {
    const quickWindow = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('mode=quick'));
    quickWindow.webContents.setBackgroundThrottling(false); quickWindow.removeAllListeners('blur'); quickWindow.showInactive();
    // resizable=false bloque setSize : rendre temporairement la fenêtre
    // redimensionnable pour simuler un contenu qui dépasse la hauteur.
    quickWindow.setResizable(true);
    quickWindow.setSize(360, 320);
  });
  await quick.waitForFunction(() => {
    const list = document.querySelector('.quick-list');
    return list && list.scrollHeight > list.clientHeight + 1;
  }, null, { timeout: 10000 });
  const overflowFit = await quick.locator('.quick-list').evaluate(el => ({ scroll: el.scrollHeight, client: el.clientHeight, overflow: getComputedStyle(el).overflowY }));
  assert.ok(overflowFit.scroll > overflowFit.client, `la liste devrait défiler à 360×320 : ${JSON.stringify(overflowFit)}`);
  assert.match(overflowFit.overflow, /auto|scroll/);
  await quick.screenshot({ path: path.join(results, 'widget-scroll-360x320.png') });
  await desktop.evaluate(({ BrowserWindow }) => {
    const quickWindow = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('mode=quick'));
    quickWindow.setSize(360, 660);
    quickWindow.setResizable(false);
  });
  await quick.waitForFunction(() => {
    const list = document.querySelector('.quick-list');
    return list && list.scrollHeight <= list.clientHeight + 1;
  }, null, { timeout: 10000 });

  // ------------------------------------------------------------------ *
  // Niveaux de ressources : épuisement et seuils dans les deux surfaces
  // ------------------------------------------------------------------ *
  for (const surface of [page, quick]) await surface.evaluate(() => {
    globalThis.resourceOriginalState = state;
    globalThis.resourceOriginalView = { page, filter, query };
    page = 'overview'; filter = 'all'; query = '';
    state = structuredClone(state);
    const stamp = new Date().toISOString();
    for (const [id, remaining] of [['openrouter', 0], ['deepseek', 2], ['runinfra', 5], ['orcarouter', 10]]) {
      const p = state.providers.find(p => p.id === id);
      Object.assign(p, { active: true, connected: true, error: null, snapshot: { source: 'api', updatedAt: stamp, balances: [{ currency: 'USD', remaining }], quotaRemaining: null } });
    }
    const ollama = state.providers.find(p => p.id === 'ollama');
    Object.assign(ollama, { active: true, connected: true, error: null, snapshot: { source: 'api', connectorVersion: 'ollama-monthly-credits-v1', updatedAt: stamp, balances: [{ currency: 'USD', remaining: 0, total: 60, used: 60 }], usageCredits: { currency: 'USD', remaining: 2.98 }, quotaRemaining: 0 } });
    const p = state.providers.find(p => p.id === 'antigravity');
    Object.assign(p, { active: true, connected: true, error: null, snapshot: { source: 'api', updatedAt: stamp, balances: [], quotaWindows: [
      { label: 'Gemini · Semaine', remaining: 0 }, { label: 'Gemini · 5 heures', remaining: 10 },
      { label: 'Claude et GPT · Semaine', remaining: 25 }, { label: 'Claude et GPT · 5 heures', remaining: 90 },
      { label: 'Gemini 4 Argon · Semaine', remaining: 88 },
    ] } });
    render();
  });
  // Cartes du tableau de bord : inchangées (statuts par fenêtre).
  assert.match(await page.locator('.card:has([data-open="openrouter"])').innerText(), /Solde épuisé/);
  assert.match(await page.locator('.card:has([data-open="ollama"])').innerText(), /Crédits inclus épuisés · réserve disponible/);
  assert.match(await page.locator('.card:has([data-open="ollama"])').innerText(), /Réserve supplémentaire[\s\S]*2,98/);
  assert.equal(await page.locator('.card:has([data-open="antigravity"]) .quota-period-status').count(), 1);
  assert.match(await page.locator('.card:has([data-open="antigravity"]) .quota-period-status').innerText(), /Limite Gemini · hebdo atteinte/);
  // Widget vertical : une ligne par information, chip de niveau agrégé.
  assert.match(await quick.locator('[data-provider="openrouter"]').getAttribute('class'), /resource-empty/);
  assert.match(await quick.locator('[data-provider="openrouter"] .quick-level').innerText(), /Épuisé/);
  assert.match(await quick.locator('[data-provider="deepseek"] .quick-level').innerText(), /Critique/);
  assert.match(await quick.locator('[data-provider="runinfra"] .quick-level').innerText(), /Bas/);
  assert.match(await quick.locator('[data-provider="orcarouter"] .quick-level').innerText(), /Suffisant/);
  assert.match(await quick.locator('[data-provider="ollama"] .quick-level').innerText(), /Épuisé/);
  const ollamaFacts = await quick.locator('[data-provider="ollama"] .quick-fact').evaluateAll(items => items.map(item => ({
    label: item.querySelector('.quick-fact-label')?.textContent || '',
    value: item.querySelector('.quick-fact-value')?.textContent || '',
  })));
  assert.deepEqual(ollamaFacts.map(fact => fact.label), ['Limite Free', 'Crédits achetés']);
  assert.match(ollamaFacts[0].value, /0\s*%/);
  assert.match(ollamaFacts[1].value, /2,98/);
  // Antigravity : le chip de ligne est le niveau agrégé (Critique), mais chaque
  // fenêtre épuisée reste lisible dans sa propre ligne (Gemini · Hebdo 0 %).
  assert.match(await quick.locator('[data-provider="antigravity"] .quick-level').innerText(), /Critique/);
  const antigravityFacts = await quick.locator('[data-provider="antigravity"] .quick-fact').evaluateAll(items => items.map(item => ({
    label: item.querySelector('.quick-fact-label')?.textContent || '',
    value: item.querySelector('.quick-fact-value')?.textContent || '',
    classes: item.querySelector('.quick-fact-value')?.className || '',
  })));
  assert.deepEqual(antigravityFacts.map(fact => fact.label), ['Gemini · Hebdo', 'Gemini · Horaire', 'Claude / GPT · Hebdo', 'Claude / GPT · Horaire', 'Hebdo Argon']);
  assert.match(antigravityFacts[0].classes, /resource-empty/);
  assert.match(antigravityFacts[0].value, /0\s*%/);
  assert.match(antigravityFacts[1].value, /10\s*%/);
  // Libellés exacts de la carte Antigravity (Horaire, Hebdo Argon, jamais « 5 h »).
  assert.deepEqual(await page.locator('.card:has([data-open="antigravity"]) .quota-period-label').allTextContents(), ['Hebdo', 'Horaire', 'Hebdo', 'Horaire', 'Hebdo Argon']);
  assert.doesNotMatch(await page.locator('.card:has([data-open="antigravity"])').innerText(), /\b5 h\b/);
  // Le solde négatif reste rouge dans le widget, comme dans la carte.
  const openrouterNegativeColor = await quick.locator('[data-provider="openrouter"] .quick-fact-value').evaluate(el => getComputedStyle(el).color);
  const openrouterCardColor = await page.locator('.card:has([data-open="openrouter"]) .resource-value').evaluate(el => getComputedStyle(el).color);
  assert.equal(openrouterNegativeColor, openrouterCardColor);
  // Aucun ancien hook de widget ni barre de jauge.
  assert.equal(await quick.locator('.quick-quota, .quick-period, .quick-period-status, .quick-resource-status, .quick-freshness, .meter').count(), 0);
  for (const [id, level] of [['openrouter', 'empty'], ['deepseek', 'critical'], ['runinfra', 'low'], ['orcarouter', 'healthy']]) {
    assert.equal(await quick.locator(`[data-provider="${id}"].resource-${level}`).count(), 1);
    assert.equal(await page.locator(`.card.resource-${level}:has([data-open="${id}"])`).count(), 1);
  }
  // Les niveaux sont écrits en toutes lettres, jamais portés par la couleur seule.
  for (const pill of await page.locator('.level-pill').allTextContents()) {
    assert.match(pill, /Épuisé|Critique|Bas|Suffisant|Disponible|Indisponible/);
  }
  const resourceQuickFit = await quick.locator('.quick-list').evaluate(el => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  assert.ok(resourceQuickFit.scroll <= resourceQuickFit.client + 1, `le widget défile avec les niveaux affichés : ${JSON.stringify(resourceQuickFit)}`);
  assert.ok(await quick.locator('.quick-footer').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight));
  await quick.screenshot({ path: path.join(results, 'resource-levels-widget.png') });
  await page.screenshot({ path: path.join(results, 'resource-levels-dashboard.png'), fullPage: true });
  for (const surface of [page, quick]) await surface.evaluate(() => { state = globalThis.resourceOriginalState; ({ page, filter, query } = globalThis.resourceOriginalView); delete globalThis.resourceOriginalState; delete globalThis.resourceOriginalView; render(); });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('mode=quick')).close());
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('mode=quick')).isVisible()), false);
  assert.deepEqual(errors, []);

  // ------------------------------------------------------------------ *
  // Redémarrage : persistance, version dynamique, cooldowns, historique
  // ------------------------------------------------------------------ *
  await desktop.close(); desktop = null;
  desktop = await launch(dataDir, home); page = await desktop.firstWindow();
  await page.waitForSelector('.cards .card');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('mode=quick')).setSize(960, 760));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(results, 'compact-window.png') });
  const loaded = await page.evaluate(() => window.lasmium.getState());
  assert.equal(loaded.providers.find(p => p.id === 'openai').plan, 'Offre de test');
  assert.deepEqual(['amount', 'billingCycle'].map(key => loaded.providers.find(p => p.id === 'openai')[key]), [103, 'monthly']);
  assert.equal(loaded.providers.find(p => p.id === 'grok').favorite, true);
  assert.equal(loaded.providers.find(p => p.id === 'openrouter').connected, false);
  assert.equal(loaded.settings.autoRefresh, false);
  assert.equal(loaded.settings.theme, 'light');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  assert.equal(loaded.strategy, undefined);
  const persistedState = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(Object.hasOwn(persistedState, 'strategy'), false);
  assert.equal(loaded.historyCount, historyCountBeforeExport);
  assert.equal((await page.evaluate(() => window.lasmium.getHistory())).length, historyCountBeforeExport);
  assert.ok(Object.keys(loaded.apiCooldowns || {}).length >= 0, 'apiCooldowns doit être un objet persistant');
  assert.equal(typeof loaded.apiCooldowns, 'object');
  assert.equal(loaded.providers.find(p => p.id === 'ollama').connected, true);
  assert.equal(loaded.providers.find(p => p.id === 'ollama').snapshot.balances[0].remaining, 47.5);
  assert.equal(loaded.providers.find(p => p.id === 'ollama').snapshot.usageCredits.remaining, 2.98);
  assert.equal(loaded.providers.find(p => p.id === 'orcarouter').connected, true);
  assert.equal(loaded.providers.find(p => p.id === 'orcarouter').snapshot.balances[0].remaining, 53.2);
  await page.locator('[data-nav="settings"]').click();
  assert.equal(await page.locator('#app-version').innerText(), `Version ${packageJson.version}`);
  await page.locator('[data-nav="overview"]').click();

  // ------------------------------------------------------------------ *
  // Ollama Free : conservation des crédits achetés et de la réserve
  // ------------------------------------------------------------------ *
  // 0.6.10 : le forfait lu sur Ollama décide. Un forfait payant dont
  // l'échéance est passée reste compté (« à vérifier ») ; le passage en Free
  // vient de la page Ollama, jamais de la date.
  let freeState = await page.evaluate(renewalDate => window.lasmium.updateProvider('ollama', { amount: 18, billingCycle: 'monthly', renewalDate }), pastDate);
  let free = freeState.providers.find(p => p.id === 'ollama');
  assert.equal(free.subscriptionStatus, 'active');
  assert.equal(freeState.summary.monthly.USD, 121);
  await desktop.evaluate(({ session }) => { session.fromPartition('persist:ollama-account').fetch = async url => ({ ok: true, status: 200, url, text: async () => '<h2>Included usage Free</h2><h3>Monthly usage</h3><p>25% used</p><h3>Usage credits</h3><span>$2.98</span><small>Current balance</small>' }); });
  freeState = await page.evaluate(() => window.lasmium.syncOne('ollama'));
  free = freeState.providers.find(p => p.id === 'ollama');
  assert.equal(free.subscriptionStatus, 'expired');
  assert.equal(free.active, true);
  assert.equal(freeState.summary.monthly.USD, 103, 'Ollama Free est compté 0 $');
  assert.equal(freeState.summary.unpriced, 4);
  assert.deepEqual(free.snapshot.balances, []);
  assert.equal(free.snapshot.quotaRemaining, 75);
  assert.equal(free.snapshot.usageCredits.remaining, 2.98);
  await page.waitForFunction(() => document.querySelector('.card:has([data-open="ollama"])')?.innerText.includes('Free · 0 $/mo'));
  await page.screenshot({ path: path.join(results, 'ollama-free.png'), fullPage: true });
  // Page officielle actuelle : ni section mensuelle ni légende « Current balance ».
  await desktop.evaluate(({ session }) => { session.fromPartition('persist:ollama-account').fetch = async url => ({ ok: true, status: 200, url, text: async () => '<main><h1>Usage credits <span>Free</span></h1><p>$1.05</p><p>Add usage credits to pay as you go on any cloud model.</p><button>Add funds</button><h2>Usage credits used this month</h2><p>model A $1.03</p><p>model B $0.90</p><h2>Usage breakdown</h2><p>62.8%</p></main>' }); });
  freeState = await page.evaluate(() => window.lasmium.syncOne('ollama'));
  free = freeState.providers.find(p => p.id === 'ollama');
  assert.equal(free.error, null); assert.equal(free.connected, true);
  assert.equal(free.snapshot.usageCredits.remaining, 1.05);
  assert.equal(free.snapshot.usageCredits.stale, false);
  assert.equal(free.snapshot.quotaRemaining, null);
  const latestReserveAt = free.snapshot.usageCredits.observedAt;
  const currentWidget = desktop.windows().find(w => w.url().includes('mode=quick'));
  const currentReserveCard = page.locator('.card:has([data-open="ollama"])');
  const currentReserveRow = currentWidget.locator('[data-provider="ollama"]');
  await currentWidget.evaluate(() => { state.providers.find(p => p.id === 'zai').subscriptionStatus = 'expired'; renderQuick(); });
  assert.equal(await currentWidget.locator('[data-provider="zai"]').count(), 0);
  assert.equal(await currentReserveRow.count(), 1);
  await currentWidget.evaluate(data => receiveState(data), freeState);
  assert.match(await page.evaluate(() => statusBadge({ ...state.providers.find(p => p.id === 'ollama'), error: 'Session absente ou expirée.' })), /Connexion à vérifier/);
  for (const surface of [page, currentWidget]) await surface.waitForFunction(() => state.providers.find(p => p.id === 'ollama').snapshot.usageCredits.remaining === 1.05);
  assert.match(await currentReserveCard.innerText(), /Réserve supplémentaire[\s\S]*1,05/);
  assert.equal(await currentReserveCard.locator('.ollama-reserve.stale').count(), 0);
  // Widget vertical : pas d'âge permanent ; la réserve Ollama est une ligne d'information.
  const reserveFacts = await currentReserveRow.locator('.quick-fact').evaluateAll(items => items.map(item => ({
    label: item.querySelector('.quick-fact-label')?.textContent || '',
    value: item.querySelector('.quick-fact-value')?.textContent || '',
  })));
  assert.deepEqual(reserveFacts.map(fact => fact.label), ['Limite Free', 'Crédits achetés']);
  assert.match(reserveFacts[1].value, /1,05/);
  assert.match(await currentReserveRow.locator('.quick-level').innerText(), /Indisponible/);
  assert.equal(await currentReserveRow.locator('[aria-label="Relevé à vérifier"]').count(), 0);
  await currentReserveCard.screenshot({ path: path.join(results, 'ollama-current-card.png') });
  await desktop.evaluate(({ BrowserWindow }) => {
    const quickWindow = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('mode=quick'));
    quickWindow.webContents.setBackgroundThrottling(false); quickWindow.removeAllListeners('blur'); quickWindow.showInactive();
  });
  await currentReserveRow.screenshot({ path: path.join(results, 'ollama-current-row.png') });
  await desktop.evaluate(({ session }) => { session.fromPartition('persist:ollama-account').fetch = async url => ({ ok: true, status: 200, url, text: async () => '<main><h1>Usage credits Free</h1><h2>Usage breakdown</h2></main>' }); });
  freeState = await page.evaluate(() => window.lasmium.syncOne('ollama'));
  free = freeState.providers.find(p => p.id === 'ollama');
  assert.equal(free.snapshot.usageCredits.remaining, 1.05);
  assert.equal(free.snapshot.usageCredits.stale, true);
  assert.equal(free.snapshot.usageCredits.observedAt, latestReserveAt);
  for (const surface of [page, currentWidget]) await surface.waitForFunction(() => state.providers.find(p => p.id === 'ollama').snapshot.usageCredits.stale);
  assert.match(await currentReserveCard.innerText(), /Dernière valeur connue[\s\S]*1,05/);
  assert.match((await currentReserveRow.locator('.quick-fact').nth(1).innerText()), /1,05/);
  assert.equal(await currentReserveRow.locator('.quick-stale').count(), 0);
  await assert.rejects(page.evaluate(renewalDate => window.lasmium.updateProvider('ollama', { subscriptionStatus: 'active', renewalDate }), futureDate), /Confirme le renouvellement/);

  // ------------------------------------------------------------------ *
  // Comptes à navigateur : OpenAI (Codex), Grok, Z.ai, Claude, Antigravity
  // ------------------------------------------------------------------ *
  await desktop.evaluate(() => {
    const openai = process.mainModule.require('./lib/openai-account.cjs');
    openai.openCodexRpc = async () => ({ close() {}, request: async method => method === 'account/read' ? { account: { type: 'chatgpt', email: 'smoke@example.test' } } : { rateLimitsByLimitId: { codex: { primary: { usedPercent: 38, windowDurationMins: 10080, resetsAt: 1900000000 }, secondary: { usedPercent: 13, windowDurationMins: 300, resetsAt: 1900000600 } } } } });
    const transport = process.mainModule.require('./lib/account-browser.cjs');
    transport.openSubscriptionBrowser = async (_dataDir, id) => {
      let open = true;
      return { isOpen: () => open, close: async () => { open = false; }, readSubscriptionPage: async () => ({ authenticated: true, windows: [{ label: '5 heures', remaining: 80, resetAt: null }, { label: 'Semaine', remaining: id === 'openai' ? 62 : 45, resetAt: null }] }) };
    };
  });
  await page.locator('[data-nav="connections"]').click();
  for (const id of ['openai', 'grok', 'zai']) {
    await openProvider(page, id);
    assert.equal(await page.locator('#api-key').count(), 0);
    assert.equal(await page.locator('[data-action="ollama-open"]').count(), 0);
    await page.locator('[data-action="account-open"]').click();
    await page.waitForSelector('#account-connection-progress');
    if (id !== 'openai') await page.locator('[data-action="account-verify"]').click();
    await page.waitForSelector('.connection-success');
    const connected = await page.evaluate(() => window.lasmium.getState());
    assert.ok(connected.providers.find(p => p.id === id).snapshot.quotaWindows.some(w => w.label.includes('Semaine')), `${id} doit exposer une fenêtre hebdomadaire`);
    assert.equal(connected.providers.find(p => p.id === id).connected, true);
    assert.equal(connected.providers.find(p => p.id === id).health?.state, 'ok', `${id} doit exposer une santé à jour`);
    assert.ok(connected.providers.find(p => p.id === id).health?.lastSuccessAt, `${id} doit dater son dernier succès`);
    assert.equal(connected.providers.find(p => p.id === id).snapshot.balances.length, 0);
    if (id === 'grok') {
      const before = connected.providers.find(p => p.id === 'grok').snapshot;
      await desktop.evaluate(() => {
        const transport = process.mainModule.require('./lib/account-browser.cjs');
        transport.openSubscriptionBrowser = async () => ({
          isOpen: () => false,
          close: async () => {},
          readSubscriptionPage: async () => ({ authenticated: true, windows: [{ label: 'Semaine', remaining: 150, resetAt: null }] }),
        });
      });
      const drifted = await page.evaluate(() => window.lasmium.syncOne('grok'));
      const grok = drifted.providers.find(p => p.id === 'grok');
      assert.equal(grok.snapshot.updatedAt, before.updatedAt, 'une dérive ne doit pas remplacer le dernier relevé');
      assert.equal(grok.health?.state, 'drift');
      assert.equal(grok.health?.error?.code, 'SCHEMA_DRIFT');
      assert.ok(grok.health?.error?.retryAt, 'une dérive doit programmer une nouvelle tentative espacée');
      assert.match(grok.health?.error?.message || '', /invalide|conservé/i);
      await desktop.evaluate(() => {
        const transport = process.mainModule.require('./lib/account-browser.cjs');
        transport.openSubscriptionBrowser = async (_dataDir, id) => ({
          isOpen: () => false,
          close: async () => {},
          readSubscriptionPage: async () => ({ authenticated: true, windows: [{ label: '5 heures', remaining: 80, resetAt: null }, { label: 'Semaine', remaining: id === 'openai' ? 62 : 45, resetAt: null }] }),
        });
      });
    }
    if (id === 'openai') assert.equal(connected.providers.find(p => p.id === id).amount, 103);
    if (id !== 'zai') {
      await page.locator('[data-action="disconnect"]').click();
      await page.waitForFunction(() => !document.querySelector('.connection-success'));
    }
    await closeDialog(page);
  }
  // Claude : connexion à l'abonnement via Claude Code (simulé), en un clic,
  // avec un faux profil Claude Code (USERPROFILE temporaire) et un transport
  // HTTP simulé, jamais le vrai compte.
  await openProvider(page, 'claude', 'connection');
  assert.equal(await page.locator('[data-action="account-open"]').count(), 0);
  assert.equal(await page.locator('[data-action="claude-enable-live"]').innerText(), 'Connecter Claude');
  await fakeClaudeCode(true);
  await desktop.evaluate(({ session }, urls) => {
    session.defaultSession.fetch = async (url, _options) => {
      if (String(url) === urls.token) return { ok: false, status: 400, headers: new Headers(), json: async () => ({}) };
      if (String(url) === urls.usage) return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 9, resets_at: '2099-09-30T11:00:00Z' }, seven_day: { utilization: 42, resets_at: '2099-10-07T08:00:00Z' }, limits: [{ display_name: 'Fable', percent: 31, resets_at: '2099-10-07T08:00:00Z' }] }) };
      throw new Error('Unexpected Claude endpoint');
    };
  }, { token: CLAUDE_TOKEN_URL, usage: CLAUDE_USAGE_URL });
  await page.locator('[data-action="claude-enable-live"]').click();
  await page.waitForFunction(() => state.providers.find(p => p.id === 'claude').snapshot?.quotaWindows?.length === 3);
  assert.equal(await page.locator('[data-action="claude-enable-live"]').count(), 0);
  assert.match(await page.locator('.connection-success').innerText(), /Claude Max .* toutes les 5 minutes/);
  assert.match(await page.locator('.dialog-body').innerText(), /Hebdo Fable : 69 % restants/);
  const directClaude = await page.evaluate(() => window.lasmium.getState());
  assert.deepEqual(directClaude.providers.find(p => p.id === 'claude').accountSession, { kind: 'claude-live-local', plan: 'Max', email: 'smoke@example.test' });
  assert.deepEqual(directClaude.providers.find(p => p.id === 'claude').snapshot.quotaWindows.map(w => w.remaining), [91, 58, 69]);
  await page.locator('[data-action="account-verify"]').click();
  assert.equal((await page.evaluate(() => window.lasmium.getState())).providers.find(p => p.id === 'claude').error, null);
  await page.screenshot({ path: path.join(results, 'claude-live-connection.png') });
  // Panne du service : dernier relevé conservé, puis reprise après le délai de 5 minutes.
  await setMainClockOffset(6 * 60000);
  await desktop.evaluate(({ session }, usageUrl) => {
    session.defaultSession.fetch = async url => { if (String(url) === usageUrl) throw new Error('Claude smoke offline'); throw new Error('Unexpected Claude endpoint'); };
  }, CLAUDE_USAGE_URL);
  await page.evaluate(() => window.lasmium.verifyAccount('claude')).catch(() => {});
  const failedClaude = (await page.evaluate(() => window.lasmium.getState())).providers.find(p => p.id === 'claude');
  assert.equal(failedClaude.snapshot.updatedAt, directClaude.providers.find(p => p.id === 'claude').snapshot.updatedAt);
  assert.deepEqual(failedClaude.snapshot.quotaWindows.map(w => w.remaining), [91, 58, 69]);
  assert.ok(failedClaude.error);
  await setMainClockOffset(12 * 60000);
  await desktop.evaluate(({ session }, usageUrl) => {
    session.defaultSession.fetch = async url => {
      if (String(url) === usageUrl) return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 9, resets_at: '2099-09-30T11:00:00Z' }, seven_day: { utilization: 42, resets_at: '2099-10-07T08:00:00Z' }, limits: [{ display_name: 'Fable', percent: 31, resets_at: '2099-10-07T08:00:00Z' }] }) };
      throw new Error('Unexpected Claude endpoint');
    };
  }, CLAUDE_USAGE_URL);
  await page.evaluate(() => window.lasmium.verifyAccount('claude'));
  const recoveredClaude = (await page.evaluate(() => window.lasmium.getState())).providers.find(p => p.id === 'claude');
  assert.equal(recoveredClaude.error, null);
  assert.notEqual(recoveredClaude.snapshot.updatedAt, directClaude.providers.find(p => p.id === 'claude').snapshot.updatedAt);
  await resetMainClock();
  const claudePersisted = await fs.readFile(path.join(dataDir, 'state.json'), 'utf8');
  assert.ok(!claudePersisted.includes('smoke-claude-access'));
  await page.locator('[data-action="disconnect"]').click();
  await closeDialog(page);
  await page.screenshot({ path: path.join(results, 'connections-updated.png'), fullPage: true });

  // ------------------------------------------------------------------ *
  // Lecteur DOM réel des comptes (document Chromium sandboxé)
  // ------------------------------------------------------------------ *
  const readings = await desktop.evaluate(async ({ BrowserWindow, session }) => {
    const { accounts, inspectSubscriptionPage } = process.mainModule.require('./lib/subscription-accounts.cjs');
    const isolated = session.fromPartition('subscription-dom-test');
    isolated.protocol.handle('https', () => new Response('<main><section role="dialog"><h2>Usage</h2><h3>5 hour usage limit</h3><p>80% remaining</p><h3>Weekly usage limit</h3><p>35% used</p></section></main>', { headers: { 'content-type': 'text/html' } }));
    const w = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      const output = [];
      for (const [id, config] of Object.entries(accounts).filter(([id]) => !['openai', 'claude'].includes(id))) {
        await w.loadURL(config.url);
        output.push(await w.webContents.executeJavaScript('(' + inspectSubscriptionPage.toString() + ')(' + JSON.stringify(id) + ',' + JSON.stringify(config.origin) + ')'));
      }
      return output;
    } finally { w.destroy(); }
  });
  for (const result of readings) { assert.equal(result.authenticated, true); assert.equal(result.windows.length, 2); assert.equal(result.windows[1].remaining, 65); }
  const claudeReading = await desktop.evaluate(async ({ BrowserWindow, session }) => {
    const { inspectSubscriptionPage } = process.mainModule.require('./lib/subscription-accounts.cjs');
    const isolated = session.fromPartition('claude-usage-dom-test');
    isolated.protocol.handle('https', () => new Response('<main><h1>Votre utilisation</h1><p>Pro</p><h2>Session actuelle</h2><p>Réinitialisation à 4:40</p><p>12 % utilisés</p><h2>Cette semaine</h2><p>Réinitialisation le mercredi 10:00</p><p>9 % utilisés</p><h2>Crédits d’utilisation</h2><p>4,71 €</p></main>', { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const w = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try { await w.loadURL('https://claude.ai/settings/usage'); return await w.webContents.executeJavaScript('(' + inspectSubscriptionPage.toString() + ')("claude","https://claude.ai")'); } finally { w.destroy(); }
  });
  assert.equal(claudeReading.authenticated, true);
  assert.deepEqual(claudeReading.windows.map(w => [w.label, w.remaining]), [['5 heures', 88], ['Semaine', 91]]);
  const grokReading = await desktop.evaluate(async ({ BrowserWindow, session }) => {
    const { inspectSubscriptionPage } = process.mainModule.require('./lib/subscription-accounts.cjs');
    const isolated = session.fromPartition('grok-number-dom-test');
    isolated.protocol.handle('https', () => new Response('<section role="dialog"><h2>Paramètres</h2><h2>Utilisation</h2><h3>Limite hebdomadaire SuperGrok</h3><span><number-flow-react aria-label="12%" role="img" style="display:inline-block;width:30px;height:20px"></number-flow-react><span>utilisés</span></span><p>Grok Build 8%</p></section>', { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const w = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try { await w.loadURL('https://grok.com/'); return await w.webContents.executeJavaScript('(' + inspectSubscriptionPage.toString() + ')("grok","https://grok.com")'); } finally { w.destroy(); }
  });
  assert.equal(grokReading.authenticated, true);
  assert.deepEqual(grokReading.windows, [{ label: 'Semaine', remaining: 88, resetAt: null }]);
  const grokBotReading = await desktop.evaluate(async ({ BrowserWindow, session }) => {
    const { inspectSubscriptionPage } = process.mainModule.require('./lib/subscription-accounts.cjs');
    const isolated = session.fromPartition('grok-bot-dom-test');
    isolated.protocol.handle('https', () => new Response('<section role="dialog"><h2>Paramètres</h2><h2>Utilisation</h2><p>Grok Bot a une limite hebdomadaire distincte.</p><h3>Limite hebdomadaire SuperGrok</h3><div><span><number-flow-react aria-label="8%" role="img" style="display:inline-block;width:30px;height:20px"></number-flow-react><span>utilisés</span></span><p>Réinitialisation le<br>21 octobre 2026 à 20:14</p><p>Grok Build 8%</p></div><h3>Weekly Grok Bot Limit</h3><div><span><number-flow-react aria-label="0%" role="img" style="display:inline-block;width:30px;height:20px"></number-flow-react><span>utilisés</span></span><p>Réinitialisation le<br>24 octobre 2026 à 16:12</p></div><h3>Crédits d’utilisation supplémentaires</h3><span>0,00 $US</span></section>', { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const w = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try { await w.loadURL('https://grok.com/?_s=usage'); return await w.webContents.executeJavaScript('(' + inspectSubscriptionPage.toString() + ')("grok","https://grok.com")'); } finally { w.destroy(); }
  });
  assert.equal(grokBotReading.usageKind, 'supergrok-legacy');
  assert.deepEqual(grokBotReading.windows, [{ label: 'Semaine', remaining: 92, resetAt: new Date(2026, 9, 21, 20, 14).toISOString() }, { label: 'Grok Bot · Semaine', remaining: 100, resetAt: new Date(2026, 9, 24, 16, 12).toISOString() }]);

  // ------------------------------------------------------------------ *
  // Antigravity : lecture locale simulée, erreur conservant le dernier relevé
  // ------------------------------------------------------------------ *
  await page.evaluate(() => window.lasmium.disconnect('ollama'));
  await page.evaluate(() => window.lasmium.disconnect('zai'));
  // Plus de dates de réinitialisation manuelles (0.6.9) : l'API n'existe plus.
  assert.equal(await page.evaluate(() => typeof window.lasmium.saveResets), 'undefined');
  await desktop.evaluate(() => {
    const transport = process.mainModule.require('./lib/antigravity-account.cjs');
    process.mainModule.require('./lib/account-browser.cjs').openSubscriptionBrowser = async () => ({ isOpen: () => true, close: async () => {}, readSubscriptionPage: async () => ({ authenticated: true, windows: [{ label: 'Semaine', remaining: 45, resetAt: null }] }) });
    transport.fetchAntigravityQuota = async () => transport.parseAntigravityQuota({ response: { groups: [{ buckets: [
      { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: .98 },
      { bucketId: 'gemini-5h', window: '5h', remainingFraction: .94 },
      { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1 },
      { bucketId: '3p-5h', window: '5h', remainingFraction: 1 },
    ] }] } });
  });
  await assert.rejects(page.evaluate(() => window.lasmium.verifyAccount('gemini')), /introuvable|inconnu/i);
  await page.locator('[data-nav="connections"]').click();
  await openProvider(page, 'antigravity');
  await page.locator('[data-action="account-open"]').click();
  await page.waitForFunction(() => document.querySelector('dialog').innerText.includes('Claude et GPT · Semaine : 100 %'));
  let local = await page.evaluate(() => window.lasmium.getState());
  assert.equal(local.providers.find(p => p.id === 'antigravity').snapshot.quotaRemaining, 94);
  assert.equal(local.providers.some(p => p.id === 'gemini'), false);
  await desktop.evaluate(() => { process.mainModule.require('./lib/antigravity-account.cjs').fetchAntigravityQuota = async () => { throw new Error('Antigravity fermé'); }; });
  await assert.rejects(page.evaluate(() => window.lasmium.verifyAccount('antigravity')), /Antigravity fermé/);
  local = await page.evaluate(() => window.lasmium.getState());
  assert.equal(local.providers.find(p => p.id === 'antigravity').snapshot.quotaRemaining, 94);
  assert.match(local.providers.find(p => p.id === 'antigravity').error, /Antigravity fermé/);
  await page.evaluate(() => window.lasmium.disconnect('antigravity'));
  local = await page.evaluate(() => window.lasmium.getState());
  assert.equal(local.providers.find(p => p.id === 'antigravity').connected, false);
  assert.equal(local.providers.some(p => p.id === 'gemini'), false);
  await closeDialog(page);

  // ------------------------------------------------------------------ *
  // Effacement complet (data:erase) : inventaire, sessions et fichiers
  // ------------------------------------------------------------------ *
  await page.locator('[data-nav="settings"]').click();
  await page.locator('[data-action="erase-data"]').click();
  await page.waitForSelector('.danger-zone');
  await page.locator('[data-action="erase-data"]').click();
  await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Données effacées'));
  const erased = await page.evaluate(() => window.lasmium.getState());
  assert.equal(erased.providers.length, 10);
  assert.equal(erased.historyCount, 0);
  assert.equal(erased.providers.every(p => !p.connected), true);
  assert.equal(await page.evaluate(async () => (await window.lasmium.getHistory()).length), 0);
  assert.equal(await page.locator('#app-version').innerText(), `Version ${packageJson.version}`);
  await page.screenshot({ path: path.join(results, 'erase-data.png'), fullPage: true });
  for (const name of ['credentials.json', 'account-browsers', 'temporary-account-browsers', 'state.before-subscription-removal.json', 'state.before-orca-balance-fix.json']) {
    await assert.rejects(fs.access(path.join(dataDir, name)), { code: 'ENOENT' }, `${name} doit être supprimé`);
  }
  const erasedState = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(Array.isArray(erasedState.providers) && erasedState.providers.length, 10);
  assert.deepEqual(erasedState.history, []);
  await desktop.close(); desktop = null;
  console.log('PASS: marque Lasmium TOKENS-HUB, logo, thèmes clair/sombre/système, version dynamique, app:info, erase-data, recommandations retirées, inventaire 10 fournisseurs, recherche/filtres, fiche abonnement à quatre champs (mensuel/annuel/paiement unique, échéance à vérifier, fin et réactivation), suivi des dépenses API (recharge détectée, crédit offert), historique, clés chiffrées, course connect/disconnect, reprise transitoire, cooldown persistant, Orca/Ollama (session conservée puis auth invalide), Claude via Claude Code, lecteurs DOM réels, santé des connexions (10 lignes, états typés, dérive SCHEMA_DRIFT sans écraser le dernier relevé), packs signés (3) et sauvegarde d’état, polices Inter + Sora (fichiers+OFL+chargement dashboard/widget, tabular-nums), libellés Hebdo/Horaire/Hebdo Fable/Hebdo Argon et chips, widget vertical Lasmium 360×660 (10 lignes, une information par fenêtre, Ollama Free + crédits, soldes multi-devises, sans défilement ; scroll fin à 320), niveaux textuels, tray, redémarrage, Ollama Free, Antigravity, export nettoyé.');
}

// Un smoke en échec se termine toujours : fermeture d'Electron bornée à 15 s,
// puis sortie explicite (sinon un Electron bloqué occupe la CI jusqu'au délai).
async function finish(failed) {
  if (desktop) await Promise.race([desktop.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 15000))]);
  if (failed) process.exit(1);
}

main().then(() => finish(false), async error => { console.error(error); await finish(true); });
