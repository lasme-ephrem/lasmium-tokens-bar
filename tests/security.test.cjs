// Garde-fous de sécurité de la refonte 0.3.0.
//
// Ces tests ne lancent ni Electron ni navigateur et n'ouvrent aucune connexion
// réseau : ils vérifient les invariants de la surface exposée (fenêtres, IPC,
// export, purge, CSP, documentation) pour empêcher une régression silencieuse.
// Ils complètent tests/window-security.test.cjs, tests/privacy-export.test.cjs et
// tests/quality.test.cjs (qui couvrent respectivement le détail, l'export et le dépôt).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { createSeed } = require('../lib/seed.cjs');
const { sanitizeStateForExport, FORBIDDEN_KEYS } = require('../lib/privacy-export.cjs');
const { MAX_API_COOLDOWNS } = require('../lib/migrations.cjs');
const { HISTORY_LIMIT } = require('../lib/data-store.cjs');
const { OLLAMA_ORIGIN } = require('../lib/ollama-account.cjs');
const { readerArguments } = require('../lib/account-browser.cjs');
const { normalizeAllowlist, isAllowedOrigin, secureAccountWindow, applyDataDirAcl, purgeLeftovers } = require('../lib/window-security.cjs');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFile(path.join(root, relative), 'utf8');
const exists = relative => fs.access(path.join(root, relative)).then(() => true, () => false);
const existsAt = absolute => fs.access(absolute).then(() => true, () => false);

async function walk(relativeDir) {
  const files = [];
  for (const entry of await fs.readdir(path.join(root, relativeDir), { withFileTypes: true })) {
    const relative = `${relativeDir.split(path.sep).join('/')}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await walk(relative));
    else files.push(relative);
  }
  return files;
}
async function applicationFiles() {
  const files = ['main.cjs', 'preload.cjs'];
  for (const directory of ['lib', 'renderer']) {
    for (const file of await walk(directory)) {
      if (['.cjs', '.js', '.html'].includes(path.extname(file).toLowerCase())) files.push(file);
    }
  }
  return files;
}
function compareVersions(left, right) {
  const a = String(left).split('.').map(Number), b = String(right).split('.').map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}
function fakeWindow() {
  const contents = new EventEmitter();
  contents.session = new EventEmitter();
  contents.openHandler = null;
  contents.setWindowOpenHandler = handler => { contents.openHandler = handler; };
  contents.closeDevTools = () => { contents.devtoolsClosed = true; };
  contents.session.setPermissionRequestHandler = handler => { contents.permissionRequest = handler; };
  contents.session.setPermissionCheckHandler = handler => { contents.permissionCheck = handler; };
  return { webContents: contents };
}
function navigationEvent() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}
// Extrait et évalue l'allowlist réellement utilisée par main.cjs, sans lancer Electron.
function accountOriginsFromMain() {
  const source = require('node:fs').readFileSync(path.join(root, 'main.cjs'), 'utf8');
  const block = source.match(/const ACCOUNT_ORIGINS = \[[\s\S]*?\];/);
  assert.ok(block, 'ACCOUNT_ORIGINS doit être déclaré dans main.cjs');
  const value = vm.runInNewContext(`${block[0]}\nACCOUNT_ORIGINS;`, { Set, OLLAMA_ORIGIN });
  assert.ok(Array.isArray(value));
  return value;
}

// ---------------------------------------------------------------------------
// Sessions navigateur et port de débogage
// ---------------------------------------------------------------------------

test('aucun navigateur de compte n’ouvre de port CDP TCP', async () => {
  const offenders = [];
  for (const file of await applicationFiles()) {
    const lines = (await read(file)).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!/remote-debugging-(?:port|address)/.test(line)) return;
      // Seule exception admise : main.cjs détecte l'option passée au processus
      // pour conserver DevToolsActivePort. Elle ne lance aucun navigateur.
      const allowed = file === 'main.cjs' && /startsWith\('--remote-debugging-port'\)/.test(line);
      if (!allowed) offenders.push(`${file}:${index + 1} — ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `Port de débogage TCP détecté :\n${offenders.join('\n')}`);

  const browser = await read('lib/account-browser.cjs');
  assert.ok(browser.includes('--remote-debugging-pipe'), 'les lecteurs doivent utiliser le pipe CDP');
  assert.equal(browser.includes('--remote-debugging-port'), false);
  assert.equal(browser.includes('--remote-debugging-address'), false);
  assert.equal(browser.includes('WebSocket'), false, 'plus aucun transport TCP/CDP par socket');
  // DevToolsActivePort ne peut plus être lu : seule sa suppression est permise.
  const references = browser.split(/\r?\n/).filter(line => line.includes('DevToolsActivePort'));
  assert.ok(references.length > 0);
  for (const line of references) assert.match(line, /fs\.rm\(|Artefact/, `DevToolsActivePort ne doit qu’être supprimé : ${line.trim()}`);
});

test('les arguments du lecteur navigateur ne contiennent que le pipe CDP', () => {
  for (const headless of [true, false]) {
    const args = readerArguments('C:\\data\\profile', 'https://grok.com/dashboard', { headless, minimized: !headless });
    assert.ok(args.includes('--remote-debugging-pipe'));
    assert.equal(args.some(argument => /remote-debugging-(port|address)/.test(argument)), false);
    assert.equal(args.some(argument => /DevToolsActivePort/.test(argument)), false);
    assert.equal(args.filter(argument => argument.startsWith('--user-data-dir=')).length, 1);
    assert.equal(args.at(-1), 'https://grok.com/dashboard');
  }
});

test('le mode diagnostic ne conserve le port que sur demande explicite, jamais par défaut', async () => {
  const main = await read('main.cjs');
  const diagnostic = main.split(/\r?\n/).filter(line => line.includes('--remote-debugging-port'));
  assert.equal(diagnostic.length, 1, 'une seule référence, la détection d’argument');
  assert.match(diagnostic[0], /process\.argv\.some/);
  // La purge reçoit le drapeau aux deux points d'entrée (démarrage et effacement).
  assert.equal((main.match(/preserveDevToolsPort: diagnosticMode/g) || []).length, 2);
  // main.cjs ne lance pas lui-même de navigateur instrumenté.
  assert.equal(/spawn\(|execFile\(/.test(main), false, 'les navigateurs sont lancés par lib/account-browser.cjs');
});

// ---------------------------------------------------------------------------
// Fenêtres de connexion et allowlist
// ---------------------------------------------------------------------------

test('l’allowlist des fenêtres de compte est stricte et limitée aux origines utiles', () => {
  const origins = accountOriginsFromMain();
  const expected = [OLLAMA_ORIGIN, 'https://accounts.google.com'];
  assert.deepEqual([...origins].sort(), [...new Set(expected)].sort());
  for (const origin of origins) assert.match(origin, /^https:\/\//, `origine non HTTPS : ${origin}`);
  for (const forbidden of ['https://claude.ai', 'https://grok.com', 'https://z.ai', 'https://chatgpt.com', 'https://www.orcarouter.ai', 'http://127.0.0.1', 'http://localhost']) {
    assert.equal(origins.includes(forbidden), false, `${forbidden} ne doit jamais entrer dans l’allowlist`);
  }
  const flows = require('node:fs').readFileSync(path.join(root, 'lib', 'provider-flows.cjs'), 'utf8');
  assert.equal((flows.match(/secureAccountWindow\(\w+, ACCOUNT_ORIGINS\)/g) || []).length, 1, 'la fenêtre interne (e-mail Ollama) utilise l’allowlist');
});

test('une fenêtre de compte refuse toute navigation ou popup hors allowlist', () => {
  const origins = [...accountOriginsFromMain()];
  const win = fakeWindow();
  secureAccountWindow(win, origins);
  const navigate = url => { const event = navigationEvent(); win.webContents.emit('will-navigate', event, url); return !event.prevented; };
  const redirect = url => { const event = navigationEvent(); win.webContents.emit('will-redirect', event, url); return !event.prevented; };
  for (const allowed of ['https://accounts.google.com/signin', 'https://ollama.com/settings']) {
    assert.equal(navigate(allowed), true, `${allowed} doit rester autorisé`);
  }
  for (const denied of ['https://claude.ai/settings/usage', 'https://grok.com/', 'https://z.ai/', 'https://www.orcarouter.ai/console', 'https://evil.test/', 'http://ollama.com/', 'data:text/html,x']) {
    assert.equal(navigate(denied), false, `${denied} doit être bloqué`);
    assert.equal(redirect(denied), false, `${denied} ne doit pas passer par redirection`);
  }
  assert.deepEqual(win.webContents.openHandler({ url: 'https://evil.test/' }), { action: 'deny' });
  const popup = win.webContents.openHandler({ url: 'https://accounts.google.com/o/oauth2' });
  assert.equal(popup.action, 'allow');
  assert.equal(popup.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false);
  assert.equal(popup.overrideBrowserWindowOptions.webPreferences.contextIsolation, true);
  assert.equal(popup.overrideBrowserWindowOptions.webPreferences.sandbox, true);
  assert.equal(popup.overrideBrowserWindowOptions.webPreferences.devTools, false);
  assert.equal(popup.overrideBrowserWindowOptions.webPreferences.session, win.webContents.session);
  // La liste normalisée ne contient que des origines HTTPS exactes.
  const normalized = normalizeAllowlist(['https://grok.com/x', 'http://insecure.test', 'javascript:alert(1)']);
  assert.deepEqual([...normalized], ['https://grok.com']);
  assert.equal(isAllowedOrigin('https://grok.com.evil.test/', normalized), false);
});

// ---------------------------------------------------------------------------
// Frontière renderer : CSP, fenêtres UI, IPC
// ---------------------------------------------------------------------------

test('la CSP du renderer interdit eval et les scripts inline', async () => {
  const html = await read('renderer/index.html');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  assert.ok(csp, 'la CSP doit être déclarée dans index.html');
  const directives = Object.fromEntries(csp.split(';').map(part => part.trim()).filter(Boolean)
    .map(part => { const [name, ...values] = part.split(/\s+/); return [name, values]; }));
  assert.deepEqual(directives['default-src'], ["'self'"]);
  assert.deepEqual(directives['script-src'], ["'self'"], 'aucun unsafe-inline/unsafe-eval dans script-src');
  assert.deepEqual(directives['connect-src'], ["'self'"]);
  assert.deepEqual(directives['object-src'], ["'none'"]);
  assert.deepEqual(directives['base-uri'], ["'none'"]);
  assert.deepEqual(directives['form-action'], ["'none'"]);
  assert.equal(csp.includes("'unsafe-eval'"), false);
  assert.equal(csp.includes('http://'), false);
  assert.equal(csp.includes('https://'), false, 'la CSP ne doit autoriser aucune origine distante');

  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map(match => match[0]);
  assert.ok(scripts.length > 0);
  for (const tag of scripts) assert.match(tag, /\bsrc=/, `script inline interdit : ${tag}`);
  assert.equal(/(?:^|\s)on[a-z]+\s*=/i.test(html), false, 'aucun gestionnaire d’événement inline');
  for (const file of await walk('renderer')) {
    if (!file.endsWith('.js')) continue;
    const source = await read(file);
    assert.equal(/\beval\s*\(|\bnew Function\s*\(|\bdocument\.write\s*\(/.test(source), false, `${file} ne doit pas évaluer de code`);
    assert.equal(/\brequire\s*\(|\bprocess\.(?:mainModule|versions)\b/.test(source), false, `${file} ne doit pas accéder à Node`);
  }
});

test('les fenêtres UI sont isolées et la passerelle IPC est filtrée', async () => {
  const main = await read('main.cjs');
  const preload = await read('preload.cjs');
  const prefs = main.match(/const webPreferences = \{([^}]*)\}/)?.[1] || '';
  for (const flag of ['preload: path.join(__dirname, \'preload.cjs\')', 'contextIsolation: true', 'nodeIntegration: false', 'sandbox: true', 'devTools: false', 'spellcheck: false']) {
    assert.ok(prefs.includes(flag), `webPreferences UI doit contenir ${flag}`);
  }
  assert.equal((main.match(/secureWindow\((?:mainWindow|quickWindow)\)/g) || []).length, 2);
  const flowsSource = await read('lib/provider-flows.cjs');
  assert.equal(((main + flowsSource).match(/devTools: false/g) || []).length >= 2, true, 'fenêtres UI et fenêtre e-mail Ollama sans DevTools');

  // Un seul point d'entrée IPC, filtré sur la frame principale et l'URL exacte de l'UI.
  assert.equal((main.match(/ipcMain\.handle\(/g) || []).length, 1, 'tout l’IPC passe par le wrapper filtré');
  assert.match(main, /ipcMain\.handle\(name, async \(event, \.\.\.args\)/);
  assert.match(main, /frame !== event\.sender\.mainFrame/);
  assert.match(main, /frame\.url\.split\('\?'\)\[0\] !== uiUrl/);

  // Preload : surface explicite, aucun ipcRenderer brut ni canal dynamique.
  assert.equal((preload.match(/exposeInMainWorld\(/g) || []).length, 1);
  assert.match(preload, /contextBridge\.exposeInMainWorld\('lasmium'/);
  assert.equal(preload.includes("exposeInMainWorld('ipcRenderer'"), false);
  assert.equal(/ipcRenderer\.invoke\(\s*[a-zA-Z_$]/.test(preload), false, 'les canaux IPC doivent être littéraux');
  assert.match(preload, /getAppInfo: \(\) => ipcRenderer\.invoke\('app:info'\)/);
  assert.match(preload, /eraseData: \(\) => ipcRenderer\.invoke\('data:erase'\)/);
});

// ---------------------------------------------------------------------------
// Données locales : ACL, export, purge, effacement
// ---------------------------------------------------------------------------

test('l’ACL du dossier de données ne bloque jamais le démarrage et complète le mode 0o600', async () => {
  const warnings = [];
  const failed = await applyDataDirAcl('C:\\tmp\\lasmium-data', {
    platform: 'win32', account: 'DESKTOP-TEST\\lasme',
    run: async () => { throw new Error('accès refusé'); },
    logger: { warn: message => warnings.push(message) },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.skipped, undefined);
  assert.match(failed.warning, /accès refusé/);
  assert.equal(warnings.length, 1);

  const granted = [];
  const ok = await applyDataDirAcl('C:\\tmp\\lasmium-data', {
    platform: 'win32', account: 'DESKTOP-TEST\\lasme',
    run: async args => { granted.push(args); return { stdout: 'Success', stderr: '' }; },
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(granted[0].slice(0, 4), ['C:\\tmp\\lasmium-data', '/inheritance:r', '/grant:r', 'DESKTOP-TEST\\lasme:(OI)(CI)F']);

  const main = await read('main.cjs');
  assert.match(main, /applyDataDirAcl\(dataDir\)/);
  assert.ok(main.indexOf('applyDataDirAcl(dataDir)') < main.indexOf('store.load()'), 'l’ACL précède la création des fichiers de données');
  assert.match(main, /if \(acl\.warning\) console\.warn/, 'un échec ACL est un avertissement seulement');
  // mode 0o600 conservé : inopérant seul sous Windows, mais l'ACL fait foi.
  assert.match(await read('lib/data-store.cjs'), /mode: 0o600/);
});

test('l’export IPC ne sérialise jamais l’état brut et reste sans identité ni session', async () => {
  const main = await read('main.cjs');
  const start = main.indexOf("handle('export'");
  const end = main.indexOf("handle('app:info'");
  assert.ok(start > 0 && end > start);
  const exportHandler = main.slice(start, end);
  assert.match(exportHandler, /sanitizeStateForExport\(state, \{ version: app\.getVersion\(\) \}\)/);
  assert.match(exportHandler, /JSON\.stringify\(document/);
  assert.equal(exportHandler.includes('JSON.stringify(state'), false, 'l’export ne doit jamais écrire l’état brut');

  const state = createSeed();
  const openai = state.providers.find(provider => provider.id === 'openai');
  openai.accountSession = { kind: 'openai-codex', identity: 'sha256-identite-test' };
  openai.claudeSync = { nextAttemptAt: '2026-11-03T22:00:00.000Z', errorCode: null };
  openai.snapshot = { source: 'api', updatedAt: '2026-11-03T20:00:00.000Z', balances: [], quotaRemaining: 42, identity: 'identite-nested' };
  const ollama = state.providers.find(provider => provider.id === 'ollama');
  ollama.accountSession = { kind: 'ollama-credits', userId: 102647, workspaceId: 102238 };
  state.apiCooldowns = { 'openrouter:empreinte': 996 };
  state.history = [{ id: 'releve-1', providerId: 'openai', accountSession: { kind: 'openai-codex', identity: 'x' }, quotaRemaining: 42 }];

  const exported = sanitizeStateForExport(state, { version: '0.3.0' });
  const serialized = JSON.stringify(exported);
  for (const forbidden of ['accountSession', 'claudeSync', 'apiCooldowns', 'identity', 'email', 'userId', 'workspaceId']) {
    assert.equal(FORBIDDEN_KEYS.has(forbidden), true, `${forbidden} doit rester dans la liste interdite`);
    assert.equal(serialized.includes(`"${forbidden}"`), false, `l’export ne doit pas contenir ${forbidden}`);
  }
  for (const sentinel of ['sha256-identite-test', 'identite-nested', '102647', '102238', 'empreinte']) {
    assert.equal(serialized.includes(sentinel), false, `l’export ne doit pas contenir ${sentinel}`);
  }
  assert.deepEqual(Object.keys(exported).sort(), ['app', 'exportedAt', 'history', 'inventory', 'manualResets', 'settings', 'version']);
  // L'état source n'est jamais modifié par l'export.
  assert.equal(state.providers.find(provider => provider.id === 'openai').accountSession.identity, 'sha256-identite-test');
});

test('la purge des restes est conditionnée au mode diagnostic et couvre les fichiers interrompus', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lasmium-security-purge-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'DevToolsActivePort'), '9222\n/devtools/browser/abc');
  await fs.writeFile(path.join(directory, 'state.json.tmp'), 'interrompu');

  await purgeLeftovers(directory, { preserveDevToolsPort: true });
  assert.equal(await existsAt(path.join(directory, 'DevToolsActivePort')), true, 'mode diagnostic : port conservé');
  assert.equal(await existsAt(path.join(directory, 'state.json.tmp')), false, 'les .tmp sont toujours purgés');

  await purgeLeftovers(directory);
  assert.equal(await existsAt(path.join(directory, 'DevToolsActivePort')), false, 'hors diagnostic : port purgé');

  const main = await read('main.cjs');
  assert.equal((main.match(/preserveDevToolsPort: diagnosticMode/g) || []).length, 2);
});

test('l’effacement des données supprime clés, sessions et profils puis réinitialise l’inventaire', async () => {
  const main = await read('main.cjs');
  const start = main.indexOf('async function eraseAllData');
  const end = main.indexOf('function registerIpc');
  assert.ok(start > 0 && end > start);
  const block = main.slice(start, end);
  for (const entry of [
    'store.settle()', 'credentials.settled()',
    'subscriptionAccounts.closeAll()', 'clearStorageData()', 'claudeReader.clear()',
    "store.remove('state.json')", "store.remove('credentials.json')",
    "store.remove('account-browsers')", "store.remove('temporary-account-browsers')",
    'state = createSeed()', 'store.persist(state)',
  ]) assert.ok(block.includes(entry), `eraseAllData doit contenir ${entry}`);
  assert.match(block, /if \(disconnecting\.size \|\| busy\.size\)/, 'effacement refusé pendant une opération');
  assert.match(main, /handle\('data:erase', eraseAllData\)/);

  // Côté renderer : double confirmation explicite avant l'appel.
  const app = await read('renderer/app.js');
  assert.match(app, /erasePending/);
  assert.match(app, /setTimeout\([\s\S]{0,200}?,\s*10000\)/, 'la confirmation expire après 10 s');
  assert.match(app, /await api\.eraseData\(\)/);
  const preload = await read('preload.cjs');
  assert.match(preload, /eraseData: \(\) => ipcRenderer\.invoke\('data:erase'\)/);
});

// ---------------------------------------------------------------------------
// Confidentialité : télémétrie, cooldowns, dépendances
// ---------------------------------------------------------------------------

test('aucune télémétrie : dépendances minimales, renderer sans réseau hors aperçu local', async () => {
  const pkg = JSON.parse(await read('package.json'));
  assert.deepEqual(Object.keys(pkg.dependencies || {}), ['proper-lockfile', 'yauzl']);
  const telemetryPackage = /analytics|telemetry|sentry|posthog|mixpanel|amplitude|bugsnag|datadog/i;
  for (const name of [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]) {
    assert.equal(telemetryPackage.test(name), false, `dépendance de télémétrie : ${name}`);
  }
  for (const file of await walk('renderer')) {
    if (!file.endsWith('.js')) continue;
    const source = await read(file);
    assert.equal(/\bXMLHttpRequest\b|new WebSocket|sendBeacon/.test(source), false, `${file} ne doit pas ouvrir de connexion`);
    assert.equal(/https?:\/\//.test(source), false, `${file} ne doit pas cibler d’origine distante`);
    for (const match of source.matchAll(/fetch\(\s*([^)]*)\)/g)) {
      assert.match(match[1].trim(), /^'\/preview-state'$/, `${file} : seul l’aperçu local /preview-state peut être requis (${match[1].trim()})`);
    }
  }
});

test('les cooldowns de clés API sont bornés, chiffrés par empreinte et jamais exportés', async () => {
  assert.equal(MAX_API_COOLDOWNS, 100);
  assert.equal(FORBIDDEN_KEYS.has('apiCooldowns'), true);
  const main = await read('main.cjs');
  assert.match(main, /MAX_API_COOLDOWNS/, 'le plafond est appliqué à l’écriture');
  assert.match(main, /cooldowns\.prune\(Date\.now\(\)\)/);
  const migrations = await read('lib/migrations.cjs');
  assert.match(migrations, /function addApiCooldowns/);
  const connectors = await read('lib/connectors.cjs');
  assert.match(connectors, /createHash\('sha256'\)/, 'seule une empreinte SHA-256 de la clé est conservée');
  assert.equal(connectors.includes('apiCooldowns'), false, 'le connecteur n’écrit jamais les cooldowns ni la clé lui-même');
  assert.equal(connectors.includes('console.'), false, 'aucune clé ni erreur brute ne doit être journalisée');
});

// ---------------------------------------------------------------------------
// Chaîne d'approvisionnement et documentation
// ---------------------------------------------------------------------------

test('Electron est verrouillé au-dessus du correctif d’audit et expédié depuis le lockfile', async t => {
  const pkg = JSON.parse(await read('package.json'));
  const lock = JSON.parse(await read('package-lock.json'));
  const locked = lock.packages?.['node_modules/electron'];
  assert.ok(locked, 'electron doit être verrouillé dans package-lock.json');
  assert.match(locked.version, /^44\.\d+\.\d+$/);
  assert.ok(compareVersions(locked.version, '44.9.1') >= 0, `Electron ${locked.version} doit contenir le correctif d’audit (≥ 44.9.1)`);
  assert.ok(String(locked.integrity || '').startsWith('sha512-'), 'intégrité du paquet electron verrouillée');
  assert.ok(pkg.devDependencies?.electron, 'le runtime Electron est fourni par les dépendances de développement');
  if (/^[\^~]/.test(String(pkg.devDependencies.electron))) {
    t.diagnostic(`Electron déclaré avec une plage (${pkg.devDependencies.electron}) : le lockfile fige la version livrée, le pin exact reste recommandé.`);
  }
  // L'audit CI porte sur les dépendances de production : la dette Electron doit rester explicite.
  const workflow = await read('.github/workflows/ci.yml');
  assert.ok(workflow.includes('npm audit --omit=dev'));
});

test('PRIVACY.md et SECURITY.md sont embarqués, complets et sans données personnelles', async () => {
  const requirements = {
    'PRIVACY.md': ['safeStorage', 'DPAPI', 'télémétrie', 'export', 'effacement', 'session', '.claude'],
    'SECURITY.md': ['périmètre', 'vulnérabilité', 'signalement', 'hors périmètre'],
  };
  for (const [file, terms] of Object.entries(requirements)) {
    assert.equal(await exists(file), true, `${file} est requis pour la release 0.3.0`);
    const content = await read(file);
    assert.ok(content.length > 1500, `${file} doit être substantiel`);
    assert.match(content, /^# /m);
    assert.equal(/[A-Za-z]:\\Users\\/.test(content), false, `${file} ne doit contenir aucun chemin utilisateur`);
    assert.equal(/\bsk-[A-Za-z0-9_-]{20,}\b|-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(content), false, `${file} ne doit contenir aucun secret`);
    for (const term of terms) assert.ok(content.toLowerCase().includes(term.toLowerCase()), `${file} doit mentionner « ${term} »`);
  }
  const privacy = await read('PRIVACY.md');
  assert.match(privacy, /20[\s\u00a0]000/, 'PRIVACY.md doit refléter la limite réelle de l’historique');
  assert.equal(HISTORY_LIMIT, 20000);
  assert.equal(/conformité\s+RGPD\s+certifiée|certifié\s+RGPD/i.test(privacy), false, 'aucune promesse de certification non validée');
  // Les deux documents sont expédiés dans le portable dès qu'ils existent.
  const packaging = await read('scripts/app-resources.cjs');
  for (const file of ['PRIVACY.md', 'SECURITY.md']) assert.ok(packaging.includes(`'${file}'`), `${file} doit être copié dans resources/app`);
});
