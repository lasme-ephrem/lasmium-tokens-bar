// Lasmium TOKENS-HUB — processus principal Electron (Windows).
// Rôle : cycle de vie (fenêtres, tray, widget, single-instance), surface IPC
// exposée par preload.cjs, orchestration des lectures via les connecteurs de
// lib/, état en mémoire et persistance (lib/data-store.cjs), durcissement des
// fenêtres (lib/window-security.cjs) et export nettoyé (lib/privacy-export.cjs).
// Les parcours d'authentification fournisseur vivent dans lib/provider-flows.cjs
// et l'orchestration des lectures dans lib/connector-sync.cjs ; main.cjs ne garde
// que le cycle de vie, les fenêtres, l'IPC et l'état en mémoire.
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, nativeTheme, screen, safeStorage, dialog, Notification, session, powerMonitor, net } = require('electron');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createSeed } = require('./lib/seed.cjs');
const { MAX_API_COOLDOWNS } = require('./lib/migrations.cjs');
const { createDataStore, HISTORY_LIMIT } = require('./lib/data-store.cjs');
const { createBackupManager } = require('./lib/state-backups.cjs');
const { createLogger } = require('./lib/logger.cjs');
const { secureWindow, secureAccountWindow, applyDataDirAcl, purgeLeftovers } = require('./lib/window-security.cjs');
const { sanitizeStateForExport } = require('./lib/privacy-export.cjs');
const { buildDiagnosticBundle } = require('./lib/diagnostic-bundle.cjs');
const antigravityTransport = require('./lib/antigravity-account.cjs');
const { validatePatch, summary, daysUntil, isTracked, expireSubscriptions, applyOllamaPlan, asOllamaFreeSnapshot } = require('./lib/domain.cjs');
const apiSpending = require('./lib/api-spending.cjs');
const { fetchUsage } = require('./lib/connectors.cjs');
const { createCredentialStore } = require('./lib/credential-store.cjs');
const { connectors, connectionInfo } = require('./lib/provider-catalog.cjs');
const { ORCA_ORIGIN, fetchWallet, validateAccountRef, resetOrcaRateLimit } = require('./lib/orca-account.cjs');
const { OLLAMA_ORIGIN, SETTINGS_URL, fetchOllamaCredits, lastKnownUsageCredits, resetOllamaRateLimit } = require('./lib/ollama-account.cjs');
const { openOllamaBrowser, deleteAccountProfile, deleteOllamaAccountProfile } = require('./lib/account-browser.cjs');
const accountBrowser = require('./lib/account-browser.cjs');
const { createOpenAiAccount } = require('./lib/openai-account.cjs');
const openAiTransport = require('./lib/openai-account.cjs');
const { createSubscriptionController } = require('./lib/subscription-controller.cjs');
const { createConnectorSync, assumeOllamaFree } = require('./lib/connector-sync.cjs');
const { assertSnapshot, healthSuccess, healthFailure, publicHealth, strategyFor, breakerOpen } = require('./lib/connector-contract.cjs');
const { loadPacks, packFor, packSummary } = require('./lib/connector-packs.cjs');
const { createProviderFlows } = require('./lib/provider-flows.cjs');
const { createUpdater } = require('./lib/updater.cjs');
const claudeLive = require('./lib/claude-live-usage.cjs');
const { CREDENTIAL_PATH } = require('./lib/claude-connection.cjs');
const { createClaudeCli } = require('./lib/claude-cli.cjs');
const { createAutostart, autostartCommand, startsHidden } = require('./lib/autostart.cjs');
const { watchFile, unwatchFile } = require('node:fs');

app.setName('Lasmium TOKENS-HUB');
// Identité stable des notifications Windows (toasts), indépendante du raccourci
// que l'utilisateur a éventuellement créé pour l'application.
if (process.platform === 'win32') app.setAppUserModelId('com.lasmium.tokenshub');
// Lancement au démarrage de Windows (Réglages et installeur).
const autostart = createAutostart({ app });
let autostartRequest = null;
try { autostartRequest = autostartCommand(); } catch (error) { console.error(error.message); }
const dataDir = (process.env.LASMIUM_DATA_DIR || process.env.PROVIDERSBAR_DATA_DIR) || (app.isPackaged ? path.join(path.dirname(process.execPath), 'data') : path.join(__dirname, '.local'));
app.setPath('userData', dataDir);
const store = createDataStore({ dataDir });
const logger = createLogger({ dataDir });
const backups = createBackupManager({ dataDir, logger });
// Origines autorisées dans les fenêtres de connexion Electron. Seules les deux
// fenêtres internes (OrcaRouter, Ollama) utilisent cette liste ; Claude, Grok,
// Z.ai et OpenAI s'authentifient dans un Chrome/Edge externe ou via Codex.
// `orcarouter.ai` sans www couvre une éventuelle redirection canonique du site.
const ACCOUNT_ORIGINS = [...new Set([
  OLLAMA_ORIGIN, ORCA_ORIGIN, ORCA_ORIGIN.replace('://www.', '://'), 'https://accounts.google.com',
])];
// Mode diagnostic (`verify:connections`, `update:portable`) : Chromium écrit
// data/DevToolsActivePort et un autre processus peut s'en servir. La purge doit
// donc laisser ce fichier intact tant que ce processus tourne.
const diagnosticMode = process.argv.some(argument => argument.startsWith('--remote-debugging-port'));
let mainWindow, quickWindow, tray, state, quitting = false;
let updateTimer, updateStartupTimer;
const credentials = createCredentialStore({ write: document => store.atomicWrite('credentials.json', document) });
const disconnecting = new Set();
const DEFAULT_UPDATE_MANIFEST_URL = 'https://github.com/lasme-ephrem/lasmium-tokens-bar/releases/latest/download/latest.json';
const UPDATE_MANIFEST_URL = process.env.LASMIUM_UPDATE_MANIFEST_URL || DEFAULT_UPDATE_MANIFEST_URL;
let lastUpdateState = null;
const updater = createUpdater({
  currentVersion: app.getVersion(),
  manifestUrl: UPDATE_MANIFEST_URL,
  publicKey: (() => { try { return fsSync.readFileSync(path.join(__dirname, 'lib', 'updater-public.pem'), 'utf8'); } catch { return ''; } })(),
  dataDir,
  targetRoot: path.dirname(process.execPath),
  enabled: app.isPackaged || Boolean(process.env.LASMIUM_UPDATE_MANIFEST_URL),
  fetchImpl: (url, options) => net.fetch(url, options),
  quit: () => app.quit(),
  onState: snapshot => {
    if (snapshot.state !== lastUpdateState) {
      lastUpdateState = snapshot.state;
      if (snapshot.state === 'available') logger.info(`Mise à jour ${snapshot.available?.version || ''} disponible.`);
      if (snapshot.state === 'error') logger.warn(`Mise à jour : ${snapshot.error}`);
    }
    if (state) broadcast();
  },
});
// Electron uses Windows' network/proxy configuration for API connections too.
const apiFetch = (...args) => session.defaultSession.fetch(...args);
// Cooldowns 429 des clés API : store synchrone exigé par fetchUsage, adossé à
// state.apiCooldowns (persisté, plafonné à 100 entrées) pour survivre au
// redémarrage. Ne duplique pas la logique Ollama/Orca, qui vivent dans leur lib.
const cooldowns = {
  get(fingerprint) {
    const until = state?.apiCooldowns?.[fingerprint];
    return Number.isFinite(until) ? until : undefined;
  },
  set(fingerprint, untilMs) {
    if (!state || typeof fingerprint !== 'string' || !Number.isFinite(untilMs) || untilMs <= 0) return;
    if (!state.apiCooldowns || typeof state.apiCooldowns !== 'object' || Array.isArray(state.apiCooldowns)) state.apiCooldowns = {};
    state.apiCooldowns[fingerprint] = untilMs;
    const entries = Object.entries(state.apiCooldowns);
    if (entries.length > MAX_API_COOLDOWNS) {
      entries.sort((a, b) => b[1] - a[1]);
      state.apiCooldowns = Object.fromEntries(entries.slice(0, MAX_API_COOLDOWNS));
    }
    // Un 429 est rare : écrire tout de suite évite de dépendre du cycle suivant.
    persist().catch(() => {});
  },
  prune(nowMs) {
    const entries = state?.apiCooldowns;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return;
    for (const [fingerprint, until] of Object.entries(entries)) if (!(until > nowMs)) delete entries[fingerprint];
  },
};
// Lecture directe Claude : instance unique du lecteur, transport Windows
// (session.defaultSession.fetch) partagé avec les appels API. Le renouvellement
// OAuth est créé par la même factory, donc sans globalThis.fetch.
// Le jeton expiré est renouvelé par Claude Code lui-même, en arrière-plan.
const claudeReader = claudeLive.createClaudeLiveReader({ fetchImpl: apiFetch,
  renewWithClaudeCode: () => claudeCli.renewConnection({ cwd: path.join(dataDir, 'claude-code') }) });
// Connexion Claude déléguée au Claude Code officiel, toujours sur l'abonnement.
const claudeCli = createClaudeCli();
let quickDesiredHeight = 660;
let connectorPacks = new Map();
let connectorPackErrors = [];
const orcaSession = () => session.fromPartition('persist:orcarouter-account');
const ollamaSession = () => session.fromPartition('persist:ollama-account');
let claudeTimer;
const isConnected = p => connectors[p.id]?.mode === 'account' ? Boolean(p.accountSession) : credentials.has(p.id);
const busy = new Map();
const announced = new Set();
const uiPath = path.join(__dirname, 'renderer', 'index.html');
const uiUrl = pathToFileURL(uiPath).href;
const subscriptionAccounts = createSubscriptionController({
  getPreviousSnapshot: id => state?.providers.find(p => p.id === id)?.snapshot,
  dataDir, openBrowser: (...args) => accountBrowser.openSubscriptionBrowser(...args), deleteProfile: deleteAccountProfile, onChange: () => { if (state) broadcast(); },
  onResult: async (id, snapshot, message) => {
    const p = provider(id);
    p.accountSession = { kind: 'subscription-browser' };
    p.lastAttempt = new Date().toISOString();
    if (snapshot) record(p, snapshot);
    else {
      p.error = message;
      markHealthFailure(p, Object.assign(new Error(message || 'Aucun relevé.'), { code: 'PARSER_EMPTY' }));
    }
    await persist(); broadcast();
  },
  onFailure: async (id, message) => { const p = provider(id); p.error = message; p.lastAttempt = new Date().toISOString(); markHealthFailure(p, new Error(message)); await persist(); broadcast(); },
});
const openAiAccount = createOpenAiAccount({
  rpcFactory: () => openAiTransport.openCodexRpc(),
  onChange: () => { if (state) broadcast(); },
  openExternal: url => require('electron').shell.openExternal(url),
  onResult: async (snapshot, identity) => {
    if (disconnecting.has('openai') || quitting) throw new Error('Connexion annulée.');
    const p = provider('openai');
    p.accountSession = { kind: 'openai-codex', identity };
    p.lastAttempt = new Date().toISOString(); record(p, snapshot);
    await persist(); broadcast();
  },
});

const providerFlows = createProviderFlows({
  BrowserWindow,
  secureAccountWindow,
  ACCOUNT_ORIGINS,
  ORCA_ORIGIN,
  OLLAMA_ORIGIN,
  SETTINGS_URL,
  dataDir,
  getState: () => state,
  getMainWindow: () => mainWindow,
  provider,
  isTracked,
  isConnected: p => isConnected(p),
  disconnecting,
  busy,
  isQuitting: () => quitting,
  broadcast: () => broadcast(),
  persist: () => persist(),
  publicState: () => publicState(),
  record,
  markHealthSuccess,
  markHealthFailure,
  showMain,
  syncOne: (id, options) => syncOne(id, options),
  claudeReader,
  claudeCli,
  antigravityTransport,
  fetchWallet,
  validateAccountRef,
  orcaSession,
  fetchOllamaCredits,
  ollamaSession,
  openOllamaBrowser,
  assumeOllamaFree,
});
const {
  syncClaudeWhenDue, verifyClaude, connectClaude, verifyAntigravity,
  openOrcaAccount, verifyOrcaAccount,
  openOllamaSystemAccount, openOllamaAccount, verifyOllamaAccount,
} = providerFlows;

const connectorSync = createConnectorSync({
  getState: () => state,
  provider,
  isTracked,
  isConnected: p => isConnected(p),
  disconnecting,
  busy,
  publicState: () => publicState(),
  broadcast: () => broadcast(),
  persist: () => persist(),
  notify: () => notify(),
  record,
  markHealthFailure,
  safeStorage,
  credentials,
  fetchUsage,
  apiFetch,
  cooldowns,
  endpointFor: id => packFor(connectorPacks, id)?.endpoint,
  fetchWallet,
  orcaSession,
  fetchOllamaCredits,
  ollamaSession,
  openAiAccount,
  verifyAntigravity,
  verifyClaude,
  subscriptionAccounts,
  isBrowserAccount: id => Boolean(connectors[id]?.browserAccount),
  breakerOpen,
});
const { syncOne, syncAll } = connectorSync;

function persist() {
  // La copie de sécurité est faite avant l'écriture, au plus toutes les 6 h ;
  // une erreur de sauvegarde ne doit jamais empêcher la persistance.
  return backups.maybeBackup().catch(error => { logger.warn(`Sauvegarde d’état : ${error.message}`); })
    .then(() => store.persist(state));
}
function appInfo() {
  return {
    version: app.getVersion(),
    electron: process.versions.electron || null,
    platform: process.platform,
    dataDir,
    packaged: app.isPackaged,
  };
}
// Version minimale exposée dans publicState() : aucun chemin absolu.
function publicAppInfo() {
  return { version: app.getVersion(), electron: process.versions.electron || null, packaged: app.isPackaged, autostart: autostart.info() };
}
// Couleur de la barre du haut (identique à la barre latérale, dans les deux thèmes).
const TITLE_BAR_OVERLAY = { color: '#070b10', symbolColor: '#eaf2f8', height: 40 };
// `system` suit le thème Windows ; ce fond de fenêtre n'a qu'un rôle visuel, le
// thème CSS étant appliqué par le renderer.
function windowBackgroundFor(theme) {
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
  return dark ? '#101112' : '#f2f5f0';
}
function publicState() {
  const { history, ...visibleState } = state;
  // L'ordre de consommation a été retiré : aucun `strategy` n'est exposé.
  delete visibleState.strategy;
  const flows = providerFlows.info();
  // Ollama : les crédits d'usage exposés sont les derniers connus, relus dans
  // l'historique ; les autres relevés sont transmis tels quels.
  function presentSnapshot(p) {
    if (p.id !== 'ollama' || !p.snapshot) return {};
    return { snapshot: { ...p.snapshot, usageCredits: lastKnownUsageCredits(p.snapshot, history) } };
  }
  // Lien de compte exposé selon le fournisseur : parcours dédié (Antigravity,
  // Claude, OpenAI, OrcaRouter, Ollama), lecteur de compte web, sinon rien.
  function presentAccountConnection(p) {
    if (p.id === 'antigravity') return { accountConnection: flows.antigravity };
    if (p.id === 'claude') return { accountConnection: flows.claude };
    if (p.id === 'openai') return { accountConnection: openAiAccount.info() };
    if (p.id === 'orcarouter') return { accountConnection: flows.orcarouter };
    if (p.id === 'ollama') return { accountConnection: flows.ollama };
    if (connectors[p.id]?.browserAccount) return { accountConnection: subscriptionAccounts.info(p.id) };
    return {};
  }
  function presentProvider(p) {
    return {
      ...p,
      ...presentSnapshot(p),
      connector: connectionInfo(p.id),
      connected: isConnected(p),
      syncing: busy.has(p.id),
      health: publicHealth(state.connectorHealth?.[p.id], p.snapshot),
      ...(p.spending ? { spendingTotals: apiSpending.providerSpending(p) } : {}),
      ...presentAccountConnection(p),
    };
  }
  return {
    ...visibleState,
    app: publicAppInfo(),
    update: updater.info(),
    connectorPacks: packSummary(connectorPacks),
    connectorPackErrors: connectorPackErrors.map(({ file, provider, reason }) => ({ file, provider: provider || null, reason })),
    historyCount: history.length,
    historyRevision: history[0]?.id || null,
    providers: state.providers.map(presentProvider),
    summary: summary(state.providers, new Date(), { apiSpending: apiSpending.spendingSummary(state.providers) }),
    desktop: true,
  };
}
async function loadConnectorPacks() {
  try {
    const publicKey = await fs.readFile(path.join(__dirname, 'lib', 'connector-packs-public.pem'), 'utf8');
    const result = await loadPacks({
      dirs: [path.join(__dirname, 'assets', 'connector-packs'), path.join(dataDir, 'connector-packs')],
      publicKey,
      appVersion: app.getVersion(),
      providers: Object.keys(connectors),
      // Un pack local non signé n'est accepté qu'en développement explicite.
      allowUnsigned: !app.isPackaged && process.env.LASMIUM_ALLOW_UNSIGNED_PACKS === '1',
    });
    connectorPacks = result.packs;
    connectorPackErrors = result.errors;
  } catch (error) {
    connectorPacks = new Map();
    connectorPackErrors = [{ file: 'connector-packs', provider: null, reason: error.message }];
  }
}
function broadcast() {
  for (const window of [mainWindow, quickWindow]) if (window && !window.isDestroyed()) window.webContents.send('state:changed', publicState());
  if (tray) tray.setToolTip(`Lasmium TOKENS-HUB · ${state.providers.filter(isTracked).length} services · ${state.providers.filter(isConnected).length} connecté(s)`);
}
function provider(id) {
  const p = state.providers.find(p => p.id === id);
  if (!p) throw new Error('Service inconnu.');
  return p;
}
function record(p, snapshot) {
  // Ollama : le forfait lu (Free ou payant) fixe le statut avant tout affichage.
  applyOllamaPlan(p, snapshot);
  if (p.id === 'ollama' && p.subscriptionStatus === 'expired' && snapshot.source === 'api') snapshot = asOllamaFreeSnapshot(snapshot);
  // Valider AVANT de toucher au dernier relevé : une réponse valide HTTP mais
  // illisible ne doit jamais remplacer un relevé sain ni afficher un faux zéro.
  assertSnapshot(p.id, snapshot);
  p.snapshot = snapshot;
  p.error = null;
  // Suivi des dépenses API : une hausse du solde est une recharge détectée.
  apiSpending.trackBalance(p, snapshot);
  state.connectorHealth = state.connectorHealth || {};
  state.connectorHealth[p.id] = healthSuccess(state.connectorHealth[p.id], {
    providerId: p.id,
    strategy: strategyFor(p, connectors),
    snapshot,
  });
  state.history.unshift({ id: require('node:crypto').randomUUID(), providerId: p.id, ...snapshot });
  state.history = state.history.slice(0, HISTORY_LIMIT);
}
function markHealthSuccess(p, snapshot) {
  state.connectorHealth = state.connectorHealth || {};
  state.connectorHealth[p.id] = healthSuccess(state.connectorHealth[p.id], {
    providerId: p.id,
    strategy: strategyFor(p, connectors),
    snapshot,
  });
}
function markHealthFailure(p, error) {
  state.connectorHealth = state.connectorHealth || {};
  state.connectorHealth[p.id] = healthFailure(state.connectorHealth[p.id], {
    providerId: p.id,
    strategy: strategyFor(p, connectors),
    error,
  });
  const failure = state.connectorHealth[p.id].error;
  if (failure) logger.warn(`Connecteur ${p.id} (${failure.code}) : ${failure.message}`);
}
function notify() {
  if (!state.settings.notifications || !Notification.isSupported()) return;
  const today = new Date().toLocaleDateString('en-CA');
  for (const p of state.providers.filter(isTracked)) {
    const messages = [];
    if (p.reviewed && p.renewalDate && daysUntil(p.renewalDate) >= 0 && daysUntil(p.renewalDate) <= 3) messages.push('Une échéance arrive dans moins de 4 jours.');
    if (p.snapshot && !p.error && Date.now() - Date.parse(p.snapshot.updatedAt) < 600000) {
      if (p.snapshot.quotaRemaining !== null && p.snapshot.quotaRemaining <= 20) messages.push('Il reste au plus 20 % de ton quota.');
      // The threshold is explicitly in USD; never compare CNY to the same threshold.
      if ((p.snapshot.balances ?? []).some(b => b.currency === 'USD' && b.remaining <= state.settings.lowBalance)) messages.push(`Le solde est inférieur ou égal à ${state.settings.lowBalance} USD.`);
    }
    for (const body of messages) {
      const key = `${today}:${p.id}:${body}`;
      if (!announced.has(key)) { announced.add(key); new Notification({ title: p.name, body, icon: path.join(__dirname, 'assets/icon.png') }).show(); }
    }
  }
}
function showMain() {
  if (quickWindow && !quickWindow.isDestroyed()) quickWindow.hide();
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}
function toggleQuick() {
  if (quickWindow.isVisible()) { quickWindow.hide(); return; }
  positionQuick();
  quickWindow.show(); quickWindow.focus();
}
function positionQuick() {
  if (!tray || !quickWindow || quickWindow.isDestroyed()) return;
  const bounds = tray.getBounds();
  const area = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea;
  const size = { width: 360, height: Math.min(quickDesiredHeight, area.height - 16) };
  const x = Math.max(area.x, Math.min(bounds.x - size.width + bounds.width, area.x + area.width - size.width));
  const y = Math.max(area.y, Math.min(bounds.y - size.height - 8, area.y + area.height - size.height));
  quickWindow.setBounds({ x, y, width: size.width, height: size.height });
}
// Caches et sessions Chromium recréés au besoin : effacés avec les données.
const ERASABLE_CACHE_ENTRIES = Object.freeze([
  'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Shared Dictionary',
  'DIPS', 'Local Storage', 'Session Storage', 'Network', 'blob_storage', 'WebStorage',
  'Service Worker', 'Partitions', 'Local State', 'Preferences', 'DevToolsActivePort',
  'declarative_performance_observer.db', 'declarative_performance_observer.db-journal',
]);

// Effacement complet demandé par l'utilisateur (après double confirmation côté
// UI) : sessions, identifiants, profils, caches puis inventaire initial.
async function eraseAllData() {
  if (quitting) throw new Error('Arrêt en cours.');
  if (disconnecting.size || busy.size) throw new Error('Attends la fin des synchronisations avant d’effacer les données.');
  // Aucune écriture en attente ne doit pouvoir recréer un fichier effacé.
  await Promise.allSettled([store.settle(), credentials.settled()]);
  await providerFlows.closeAll({ reset: true });
  await Promise.allSettled([subscriptionAccounts.closeAll(), openAiAccount.close()]);
  // Les parcours fermés peuvent avoir persisté leur état final : on revide
  // avant de supprimer les fichiers.
  await Promise.allSettled([store.settle(), credentials.settled()]);
  await Promise.allSettled([orcaSession().clearStorageData(), ollamaSession().clearStorageData()]);
  await credentials.load({});
  claudeReader.clear();
  // Cooldowns mémoire Ollama/Orca : un effacement complet ne doit pas laisser
  // l'utilisateur bloqué 60 s sur des compteurs qu'il vient de réinitialiser.
  resetOllamaRateLimit();
  resetOrcaRateLimit();
  announced.clear();
  await Promise.allSettled([
    store.remove('state.json'),
    store.remove('credentials.json'),
    store.remove('account-browsers'),
    store.remove('temporary-account-browsers'),
    store.remove('state.before-subscription-removal.json'),
    store.remove('state.before-orca-balance-fix.json'),
    ...ERASABLE_CACHE_ENTRIES.map(name => store.remove(name)),
  ]);
  await purgeLeftovers(dataDir, {
    preserveDevToolsPort: diagnosticMode,
    sweepTemporaryProfiles: typeof accountBrowser.sweepTemporaryProfiles === 'function' ? accountBrowser.sweepTemporaryProfiles : null,
  });
  state = createSeed();
  await store.persist(state);
  broadcast();
  return true;
}

function registerIpc() {
  function handle(name, fn) {
    ipcMain.handle(name, async (event, ...args) => {
      const frame = event.senderFrame;
      if (!frame || frame !== event.sender.mainFrame || frame.url.split('?')[0] !== uiUrl) throw new Error('Accès refusé.');
      return fn(...args);
    });
  }
  handle('state:get', async () => {
    if (expireSubscriptions(state.providers)) { await persist(); broadcast(); }
    return publicState();
  });
  handle('history:get', () => state.history);
  handle('window:quick-size', height => {
    if (!Number.isFinite(height) || height < 100 || height > 4000 || !quickWindow || quickWindow.isDestroyed()) return;
    const area = tray ? screen.getDisplayNearestPoint(tray.getBounds()).workArea : screen.getPrimaryDisplay().workArea;
    const target = Math.round(Math.min(Math.max(240, height), 900, area.height - 16));
    if (quickDesiredHeight === target) return;
    quickDesiredHeight = target;
    if (tray) positionQuick();
    else quickWindow.setSize(360, target);
  });
  // Suivi des dépenses API : montant de départ, arrêt, recharge offerte.
  handle('api:spending-start', async (id, amount) => {
    apiSpending.startSpending(provider(id), amount);
    await persist(); broadcast(); return publicState();
  });
  handle('api:spending-stop', async id => {
    apiSpending.stopSpending(provider(id));
    await persist(); broadcast(); return publicState();
  });
  handle('api:top-up', async (id, topUpId, offered) => {
    apiSpending.markTopUp(provider(id), topUpId, offered);
    await persist(); broadcast(); return publicState();
  });
  handle('orca:open-account', openOrcaAccount);
  handle('orca:verify-account', verifyOrcaAccount);
  handle('ollama:open-account', openOllamaSystemAccount);
  handle('ollama:open-email', providerFlows.openOllamaEmailAccount);
  handle('ollama:verify-account', () => verifyOllamaAccount());
  handle('account:open', async id => {
    provider(id);
    if (disconnecting.has(id) || quitting) throw new Error('Déconnexion en cours.');
    if (id === 'antigravity') return verifyAntigravity();
    if (id === 'claude') return connectClaude();
    if (id === 'openai') return openAiAccount.open();
    if (id === 'orcarouter') return openOrcaAccount();
    if (id === 'ollama') return openOllamaAccount();
    return subscriptionAccounts.open(id);
  });
  handle('account:verify', async id => {
    provider(id);
    if (disconnecting.has(id) || quitting) throw new Error('Déconnexion en cours.');
    try {
      if (id === 'openai') await openAiAccount.read(provider(id).accountSession?.identity);
      else if (id === 'antigravity') await verifyAntigravity();
      else if (id === 'claude') await verifyClaude({ manual: true });
      else if (id === 'orcarouter') await verifyOrcaAccount();
      else if (id === 'ollama') await verifyOllamaAccount();
      else await subscriptionAccounts.read(id, { background: true, interactive: true });
    } catch (error) {
      // Les connecteurs dédiés enregistrent déjà leur santé ; ce filet couvre
      // OpenAI/Codex et toute erreur remontée avant leur propre catch.
      markHealthFailure(provider(id), error);
      await persist(); broadcast();
      throw error;
    }
    return publicState();
  });
  // « Connecter Claude » : connexion officielle de Claude Code (abonnement).
  handle('claude:enable-live', async () => {
    await connectClaude();
    return publicState();
  });
  handle('provider:update', async (id, patch) => {
    const p = provider(id), changes = validatePatch(patch);
    if (p.type !== 'subscription' && 'subscriptionStatus' in changes) throw new Error('Statut réservé aux abonnements.');
    if (changes.confirmRenewal && p.type !== 'subscription') throw new Error('Confirmation réservée aux abonnements.');
    if (changes.subscriptionStatus === 'active' && changes.renewalDate && daysUntil(changes.renewalDate) < 0) throw new Error('Indique une prochaine échéance future pour activer le forfait.');
    if (p.subscriptionStatus === 'expired' && changes.subscriptionStatus === 'active') {
      if (!changes.confirmRenewal || !changes.renewalDate || daysUntil(changes.renewalDate) <= 0) throw new Error('Confirme le renouvellement et indique une prochaine échéance future.');
      delete p.expiredAt;
      if (p.id === 'ollama' && p.snapshot) p.snapshot = { ...p.snapshot, balances: [], quotaRemaining: null, resetAt: null, details: [], balanceLabel: 'Crédits mensuels à vérifier' };
    }
    delete changes.confirmRenewal;
    if ('subscriptionStatus' in changes) changes.active = changes.subscriptionStatus === 'active' || (p.id === 'ollama' && changes.subscriptionStatus === 'expired');
    else if (p.type === 'subscription' && 'active' in changes) changes.subscriptionStatus = changes.active ? 'active' : 'paused';
    // Ollama : un arrêt choisi prime sur le forfait payant encore affiché par
    // le site jusqu'à la fin de la période réglée ; une réactivation le lève.
    if (p.id === 'ollama' && changes.subscriptionStatus === 'expired') p.endedByUser = true;
    if (p.id === 'ollama' && changes.subscriptionStatus === 'active') delete p.endedByUser;
    Object.assign(p, changes);
    if (p.id === 'ollama' && p.subscriptionStatus === 'expired') p.snapshot = asOllamaFreeSnapshot(p.snapshot);
    expireSubscriptions(state.providers);
    await persist(); broadcast(); return publicState();
  });
  handle('provider:connect', async (id, key) => {
    provider(id);
    if (!Object.hasOwn(connectors, id)) throw new Error('Connecteur non disponible.');
    if (connectors[id].mode === 'account') throw new Error('Utilise la connexion au compte pour lire ses usages.');
    if (busy.has(id) || disconnecting.has(id)) throw new Error('Une opération de connexion est déjà en cours.');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Le chiffrement Windows est indisponible. La clé ne sera pas enregistrée.');
    // Validate access before replacing an existing, working credential.
    const work = (async () => {
      const snapshot = await fetchUsage(id, key, apiFetch, { cooldowns, endpoint: packFor(connectorPacks, id)?.endpoint });
      const encrypted = safeStorage.encryptString(key.trim()).toString('base64');
      await credentials.set(id, encrypted);
      record(provider(id), snapshot); provider(id).lastAttempt = snapshot.updatedAt;
      await persist();
    })();
    busy.set(id, work); broadcast();
    try { await work; } finally { busy.delete(id); broadcast(); }
    return publicState();
  });
  handle('provider:disconnect', async id => {
    provider(id);
    if (disconnecting.has(id)) throw new Error('Déconnexion en cours.');
    disconnecting.add(id);
    try {
      if (id === 'ollama') await providerFlows.cancelOllama();
      if (busy.has(id)) await busy.get(id).catch(() => {});
      if (id === 'antigravity') {
        await providerFlows.cancelAntigravity();
        delete provider(id).accountSession;
      }
      if (id === 'claude') {
        await providerFlows.cancelClaude();
        claudeReader.clear();
        delete provider(id).accountSession;
        delete provider(id).claudeSync;
        await deleteAccountProfile(dataDir, id);
      }
      if (id === 'openai') { await openAiAccount.disconnect(); await subscriptionAccounts.disconnect(id); delete provider(id).accountSession; }
      if (connectors[id]?.browserAccount) {
        await subscriptionAccounts.disconnect(id);
        delete provider(id).accountSession;
      }
      if (id === 'orcarouter') {
        await providerFlows.cancelOrca();
        await orcaSession().clearStorageData();
        delete provider(id).accountSession;
      }
      if (id === 'ollama') {
        await ollamaSession().clearStorageData();
        await deleteOllamaAccountProfile(dataDir);
        delete provider(id).accountSession;
      }
      await credentials.delete(id);
      provider(id).error = null; await persist(); broadcast(); return publicState();
    } finally { disconnecting.delete(id); }
  });
  handle('sync:all', () => syncAll({ force: true }));
  handle('sync:one', (id, options = {}) => syncOne(id, { force: options?.force !== false }));
  handle('settings:update', async patch => {
    if (typeof patch.autoRefresh !== 'boolean' || typeof patch.notifications !== 'boolean' || !Number.isFinite(patch.lowBalance) || patch.lowBalance < 0 || patch.lowBalance > 10000 || !['light', 'dark', 'system'].includes(patch.theme)) throw new Error('Réglages invalides.');
    if ('autostart' in patch && typeof patch.autostart !== 'boolean') throw new Error('Réglages invalides.');
    // Lancement au démarrage : état tenu par Windows, pas par state.json.
    if ('autostart' in patch && autostart.supported && patch.autostart !== autostart.info().enabled) autostart.set(patch.autostart);
    const resumeClaude = patch.autoRefresh && !state.settings.autoRefresh;
    state.settings = { ...state.settings, autoRefresh: patch.autoRefresh, notifications: patch.notifications, lowBalance: patch.lowBalance, theme: patch.theme };
    const backgroundColor = windowBackgroundFor(patch.theme);
    for (const window of [mainWindow, quickWindow]) if (window && !window.isDestroyed()) window.setBackgroundColor(backgroundColor);
    await persist(); broadcast();
    if (resumeClaude) { claudeReader.wake(); syncClaudeWhenDue(); }
    return publicState();
  });
  handle('export', async () => {
    const result = await dialog.showSaveDialog(mainWindow, { title: 'Exporter mes données', defaultPath: `Lasmium TOKENS-HUB-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'Données JSON', extensions: ['json'] }] });
    if (result.canceled) return false;
    // Export nettoyé : ni session, ni identité, ni empreinte de clé (contrat §3.5).
    const document = sanitizeStateForExport(state, { version: app.getVersion() });
    await fs.writeFile(result.filePath, JSON.stringify(document, null, 2)); return true;
  });
  handle('diagnostic', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Exporter un diagnostic',
      defaultPath: `Lasmium-diagnostic-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'Diagnostic JSON', extensions: ['json'] }],
    });
    if (result.canceled) return false;
    const bundle = buildDiagnosticBundle({
      app: { name: app.getName(), version: app.getVersion(), electron: process.versions.electron, packaged: app.isPackaged },
      state: { ...state, providers: publicState().providers },
      packs: packSummary(connectorPacks),
      packErrors: connectorPackErrors,
      backups: await backups.list(),
      versions: { node: process.version },
      platform: process.platform,
    });
    await fs.writeFile(result.filePath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
    return true;
  });
  handle('app:info', async () => appInfo());
  handle('update:check', () => updater.check());
  handle('update:state', () => updater.info());
  handle('update:install', async () => {
    if (!app.isPackaged && process.env.LASMIUM_ALLOW_DEV_UPDATES !== '1') throw new Error('L’installation d’une mise à jour est désactivée en développement.');
    return updater.install();
  });
  handle('data:erase', eraseAllData);
  handle('window:main', showMain);
  handle('window:toggle-quick', toggleQuick);
}

if (autostartRequest !== null) {
  // Commande de l'installeur (--autostart=on|off) : appliquer puis quitter, sans fenêtre.
  app.whenReady().then(() => {
    try { autostart.set(autostartRequest); } catch (error) { console.error(error.message); }
    app.exit(0);
  });
} else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) showMain(); });
  let browsersClosed = false;
  app.on('before-quit', event => {
    quitting = true;
    clearInterval(claudeTimer);
    clearInterval(updateTimer);
    clearTimeout(updateStartupTimer);
    unwatchFile(CREDENTIAL_PATH);
    if (browsersClosed) return;
    event.preventDefault();
    Promise.allSettled([providerFlows.closeAll(), subscriptionAccounts.closeAll(), openAiAccount.close(), ...busy.values()])
      .then(() => credentials.settled()).then(() => store.settle()).finally(() => { browsersClosed = true; app.quit(); });
  });
  app.whenReady().then(async () => {
    try {
      await store.ensureDir();
      const acl = await applyDataDirAcl(dataDir);
      if (acl.warning) console.warn(acl.warning);
      const loaded = await store.load();
      state = loaded.state;
      await loadConnectorPacks();
      await backups.maybeBackup({ force: true, reason: 'startup' }).catch(error => {
        logger.warn(`Sauvegarde de démarrage : ${error.message}`);
      });
      logger.info(`Démarrage ${app.getVersion()} · ${connectorPacks.size} pack(s) · ${state.providers.length} fournisseurs`);
      // Cooldowns 429 expirés : purgés dès le chargement, avant toute lecture.
      cooldowns.prune(Date.now());
      // Restes d'une exécution interrompue : `.tmp`, port de diagnostic obsolète,
      // sauvegardes en surnombre (2 conservées) et profils temporaires orphelins.
      await purgeLeftovers(dataDir, {
        preserveDevToolsPort: diagnosticMode,
        sweepTemporaryProfiles: typeof accountBrowser.sweepTemporaryProfiles === 'function' ? accountBrowser.sweepTemporaryProfiles : null,
      });
      if (loaded.legacyGeminiProfile) await deleteAccountProfile(dataDir, 'gemini').catch(() => console.warn('Ancien profil Gemini web verrouillé ; son suivi est désactivé.'));
      const keyDocument = await store.readJSON('credentials.json');
      if (keyDocument) credentials.load(keyDocument);
      registerIpc();
      const webPreferences = { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, devTools: false };
      const windowBackground = windowBackgroundFor(state.settings.theme);
      // Barre de titre intégrée (comme VS Code) : les boutons Windows restent
      // natifs (accrochage, info-bulles), dessinés sur la couleur de la barre.
      mainWindow = new BrowserWindow({ width: 1360, height: 940, minWidth: 900, minHeight: 680, show: false, title: 'Lasmium TOKENS-HUB', icon: path.join(__dirname, 'assets/icon.png'), backgroundColor: windowBackground, autoHideMenuBar: true, titleBarStyle: 'hidden', titleBarOverlay: TITLE_BAR_OVERLAY, webPreferences });
      secureWindow(mainWindow);
      mainWindow.on('close', event => { if (!quitting) { event.preventDefault(); mainWindow.hide(); } });
      // Démarrage de Windows (--hidden) : seule l'icône de notification apparaît.
      // Icône de la barre des tâches donnée explicitement (fichier .ico livré avec
      // l'application) : Windows ne réutilise pas une ancienne icône gardée en
      // cache pour le chemin de l'exécutable ou d'un raccourci.
      if (process.platform === 'win32') {
        mainWindow.setAppDetails({ appId: 'com.lasmium.tokenshub', appIconPath: path.join(__dirname, 'assets', 'icon.ico'), appIconIndex: 0,
          ...(app.isPackaged ? { relaunchCommand: `"${process.execPath}"`, relaunchDisplayName: 'Lasmium TOKENS-HUB' } : {}) });
      }
      mainWindow.once('ready-to-show', () => { if (!startsHidden()) mainWindow.show(); });
      await mainWindow.loadFile(uiPath);
      quickWindow = new BrowserWindow({ width: 360, height: Math.min(660, screen.getPrimaryDisplay().workAreaSize.height - 16), show: false, frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true, icon: path.join(__dirname, 'assets/icon.png'), backgroundColor: windowBackground, webPreferences });
      secureWindow(quickWindow);
      quickWindow.on('blur', () => quickWindow.hide());
      await quickWindow.loadFile(uiPath, { query: { mode: 'quick' } });
      tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets/icon.png')));
      tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Ouvrir Lasmium TOKENS-HUB', click: showMain }, { label: 'Synchroniser', click: () => syncAll({ force: true }).catch(error => console.error('Synchronisation manuelle :', error)) }, { type: 'separator' }, { label: 'Quitter', click: () => app.quit() }]));
      tray.on('click', toggleQuick); tray.on('double-click', showMain);
      broadcast();
      if (updater.info().enabled) {
        updateStartupTimer = setTimeout(() => { if (!quitting) updater.check().catch(() => {}); }, 60000);
        updateStartupTimer.unref?.();
        updateTimer = setInterval(() => { if (!quitting) updater.check().catch(() => {}); }, 6 * 60 * 60 * 1000);
        updateTimer.unref?.();
      }
      const claude = state.providers.find(p => p.id === 'claude');
      // Ancienne session Claude Desktop : convertie au chargement (data-store).
      // Restaurer le cooldown d'échec persisté (Retry-After), jamais un succès.
      if (claude?.accountSession?.kind === 'claude-live-local') claudeReader.restore(claude.claudeSync);
      // Claude Code réécrit ce fichier à chaque connexion ou renouvellement :
      // un cooldown d'authentification est levé et la lecture retentée.
      watchFile(CREDENTIAL_PATH, { interval: 2000, persistent: false }, (current, previous) => {
        if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
        syncClaudeWhenDue({ credentialsChanged: true });
      });
      // Check the deadline rather than two independent 60-second timers, which
      // could otherwise skip a cycle because of network latency.
      claudeTimer = setInterval(syncClaudeWhenDue, 2000);
      claudeTimer.unref();
      const resumeClaude = () => { claudeReader.wake(); syncClaudeWhenDue(); };
      powerMonitor.on('resume', resumeClaude);
      powerMonitor.on('unlock-screen', resumeClaude);
      setInterval(() => {
        try { if (expireSubscriptions(state.providers)) persist().then(broadcast).catch(console.error); }
        catch (error) { console.error('Expiration des abonnements :', error); }
      }, 60 * 1000).unref();
      setInterval(() => {
        try {
          if (state.settings.autoRefresh) syncAll().catch(error => console.error('Actualisation automatique :', error));
          notify();
        } catch (error) { console.error('Actualisation automatique :', error); }
      }, 5 * 60 * 1000).unref();
      if (state.settings.autoRefresh) syncAll().catch(error => console.error('Synchronisation initiale :', error));
    } catch (error) { dialog.showErrorBox('Lasmium TOKENS-HUB ne peut pas démarrer', error.message + '\nLes fichiers existants ont été conservés.'); app.quit(); }
  });
}
