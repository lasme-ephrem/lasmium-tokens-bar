const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const delay = (ms, signal) => require('node:timers/promises').setTimeout(ms, undefined, { signal });
const ORIGIN = 'https://ollama.com';
// OrcaRouter : le site vit sur www, une redirection canonique peut passer par l'apex.
const ORCA_ORIGIN = 'https://www.orcarouter.ai';
const ORCA_HOSTS = new Set(['www.orcarouter.ai', 'orcarouter.ai']);
const { accountConfig, inspectSubscriptionPage } = require('./subscription-accounts.cjs');

// Aucune session de compte n'ouvre de port TCP de débogage : le protocole CDP
// passe par les descripteurs 3 (écriture navigateur) et 4 (lecture navigateur)
// de `--remote-debugging-pipe`. Chaque message est un JSON terminé par NUL.
const CDP_MESSAGE_END = 0;
const CDP_PIPE_STDIO = ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'];
const COMMAND_TIMEOUT_MS = 10000;
const BROWSER_READY_TIMEOUT_MS = 20000;
const BROWSER_READY_PROBE_TIMEOUT_MS = 1500;
const BROWSER_READY_INTERVAL_MS = 250;
const BROWSER_STOP_TIMEOUTS = Object.freeze({ gracefulMs: 1500, killMs: 3000, treeMs: 4000 });
const TEMPORARY_PROFILES_DIR = 'temporary-account-browsers';

function browserClosedError() {
  return new Error('La fenêtre du navigateur est fermée. Rouvre la connexion au compte.');
}
function browserStoppedError() {
  return new Error('Le navigateur dédié s’est arrêté avant la vérification. Ferme les autres fenêtres de ce compte puis réessaie.');
}

// Transport CDP minimal, indépendant du système de processus : il ne connaît
// que deux flux. Les tests l'exercent avec des flux simulés, sans Chrome.
function createCdpPipeTransport({ toBrowser, fromBrowser, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  if (!toBrowser || typeof toBrowser.write !== 'function' || !fromBrowser || typeof fromBrowser.on !== 'function') {
    throw new TypeError('Flux CDP invalides.');
  }
  let sequence = 0, closed = false, buffer = Buffer.alloc(0);
  const pending = new Map();
  function rejectPending(error) {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  }
  function resolveMessage(message) {
    const request = pending.get(message?.id);
    if (!request) return; // Événement CDP ou réponse dont l'appelant s'est désisté.
    pending.delete(message.id);
    clearTimeout(request.timer);
    // Les détails de l'erreur CDP (page, pile) ne sortent jamais vers l'UI.
    if (message.error) request.reject(new Error('La lecture de la session a échoué.'));
    else request.resolve(message.result);
  }
  function onData(chunk) {
    if (closed) return;
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    let end;
    while ((end = buffer.indexOf(CDP_MESSAGE_END)) >= 0) {
      const payload = buffer.subarray(0, end).toString('utf8');
      buffer = buffer.subarray(end + 1);
      let message;
      try { message = JSON.parse(payload); } catch { continue; }
      resolveMessage(message);
    }
  }
  function onClosed() {
    if (closed) return;
    closed = true;
    rejectPending(new Error('Le navigateur a été fermé.'));
  }
  function onError() { onClosed(); }
  function removeListeners() {
    fromBrowser.removeListener('data', onData);
    fromBrowser.removeListener('close', onClosed);
    fromBrowser.removeListener('end', onClosed);
    fromBrowser.removeListener('error', onError);
    toBrowser.removeListener('error', onError);
    toBrowser.removeListener('close', onClosed);
    // Un flux détruit peut encore émettre un `error` tardif : sans écouteur, il
    // ferait tomber le processus principal. On laisse un écouteur inerte.
    fromBrowser.on('error', () => {});
    toBrowser.on('error', () => {});
  }
  fromBrowser.on('data', onData);
  fromBrowser.once('close', onClosed);
  fromBrowser.once('end', onClosed);
  fromBrowser.once('error', onError);
  toBrowser.once('error', onError);
  toBrowser.once('close', onClosed);
  return {
    isOpen: () => !closed,
    command(method, params = {}, sessionId, { timeoutMs: commandTimeoutMs } = {}) {
      if (closed) return Promise.reject(browserClosedError());
      const id = ++sequence;
      const timeout = Number.isFinite(commandTimeoutMs) && commandTimeoutMs > 0 ? commandTimeoutMs : timeoutMs;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Le navigateur ne répond pas.')); }, timeout);
        pending.set(id, { resolve, reject, timer });
        try {
          toBrowser.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
        } catch {
          pending.delete(id);
          clearTimeout(timer);
          reject(browserClosedError());
        }
      });
    },
    close() {
      if (closed && pending.size === 0) { removeListeners(); return; }
      closed = true;
      rejectPending(new Error('Le navigateur a été fermé.'));
      removeListeners();
    },
  };
}

// Attendre que le navigateur réponde sur le pipe borné : au plus 20 s, avec des
// sondes courtes pour détecter immédiatement un processus déjà sorti.
async function waitForBrowserReady({ transport, signal, isFailed = () => false, isExited = () => false, timeoutMs = BROWSER_READY_TIMEOUT_MS, intervalMs = BROWSER_READY_INTERVAL_MS }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (isFailed()) throw new Error('Le navigateur ne peut pas être démarré.');
    if (isExited() || !transport.isOpen()) throw browserStoppedError();
    try {
      await transport.command('Target.getTargets', {}, undefined, { timeoutMs: BROWSER_READY_PROBE_TIMEOUT_MS });
      return;
    } catch (error) { lastError = error; }
    if (isFailed()) throw new Error('Le navigateur ne peut pas être démarré.');
    if (isExited() || !transport.isOpen()) throw browserStoppedError();
    await delay(intervalMs, signal);
  }
  throw new Error(lastError?.message === 'Le navigateur ne répond pas.'
    ? 'Le navigateur dédié ne répond pas. Essaie la connexion par email.'
    : 'Connexion locale au navigateur impossible.');
}

// Vrai arrêt confirmé par `exit`, jamais par un simple écran de délai.
function waitForExit(child, timeoutMs) {
  if (!child) return Promise.resolve(true);
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.removeListener('exit', onExit); resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    child.once('exit', onExit);
  });
}

// Repli Windows : Chrome lance des processus fils (GPU, rendu). `child.kill()`
// n'y met pas fin, `taskkill /T /F` si. Jamais bloquant, jamais fatal.
function killProcessTree(child) {
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  if (process.platform !== 'win32') {
    try { child.kill('SIGKILL'); } catch {}
    return Promise.resolve(true);
  }
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => finish(false), 5000);
    let killer;
    try { killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
    catch { finish(false); return; }
    killer.once('error', () => finish(false));
    killer.once('exit', () => finish(true));
  });
}

async function stopBrowserProcess(child, graceful = false, options = {}) {
  if (!child) return true;
  const { gracefulMs = BROWSER_STOP_TIMEOUTS.gracefulMs, killMs = BROWSER_STOP_TIMEOUTS.killMs, treeMs = BROWSER_STOP_TIMEOUTS.treeMs, killTree = killProcessTree } = options;
  if (child.exitCode != null || child.signalCode != null) return true;
  if (graceful && await waitForExit(child, gracefulMs)) return true;
  if (child.exitCode != null || child.signalCode != null) return true;
  try { child.kill(); } catch {}
  if (await waitForExit(child, killMs)) return true;
  try { await killTree(child); } catch {}
  return waitForExit(child, treeMs);
}

// Cookie CDP → cookie Electron, uniquement pour les hôtes du fournisseur.
function providerCookie(cookie, hosts) {
  const host = cookie?.domain?.replace(/^\./, '');
  if (!hosts.has(host) || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') return null;
  const cookiePath = cookie.path?.startsWith('/') ? cookie.path : '/';
  return { url: `https://${host}${cookiePath}`, name: cookie.name, value: cookie.value, path: cookiePath,
    ...(cookie.domain.startsWith('.') ? { domain: cookie.domain } : {}), secure: Boolean(cookie.secure), httpOnly: Boolean(cookie.httpOnly),
    ...(cookie.expires > 0 ? { expirationDate: cookie.expires } : {}),
    ...(cookie.sameSite ? { sameSite: { Strict: 'strict', Lax: 'lax', None: 'no_restriction' }[cookie.sameSite] } : {}) };
}
const ollamaCookie = cookie => providerCookie(cookie, new Set(['ollama.com']));
const orcaCookie = cookie => providerCookie(cookie, ORCA_HOSTS);
// Identifiants publics du compte OrcaRouter (utilisateur, espace de travail),
// lus dans le stockage local du site ; aucun jeton n'est lu.
const ORCA_ACCOUNT_REF_SCRIPT = `(() => {
  try { const user = JSON.parse(localStorage.getItem('user') || 'null');
    return { userId: Number(user?.id), workspaceId: Number(localStorage.getItem('active_workspace_id') || user?.active_workspace_id) };
  } catch { return null; }
})()`;
async function findBrowser() {
  const candidates = [
    path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe'),
  ];
  for (const candidate of candidates) { try { await fs.access(candidate); return candidate; } catch {} }
  throw new Error('Chrome ou Edge est nécessaire pour la connexion Google. Tu peux aussi utiliser la connexion par email.');
}

// Arguments du navigateur lecteur. Aucun port TCP : uniquement le pipe CDP.
function readerArguments(profile, url, { headless = false, minimized = false } = {}) {
  return [`--user-data-dir=${profile}`, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
    ...(headless ? ['--headless=new'] : ['--new-window', ...(minimized ? ['--start-minimized'] : [])]), url];
}

async function openAccountBrowser(dataDir, accountId = null, headless = false, options = {}, dependencies = {}) {
  const { signal, minimized = false, profileOverride, originOverride, urlOverride, preserveProfile = false } = options;
  signal?.throwIfAborted();
  const config = accountId ? accountConfig(accountId) : null;
  const origin = originOverride || config?.origin || ORIGIN;
  const url = urlOverride || (headless && config?.usageUrl) || config?.url || ORIGIN + '/settings';
  const executable = await (dependencies.findBrowser || findBrowser)();
  signal?.throwIfAborted();
  const profilesRoot = path.resolve(dataDir, accountId || profileOverride ? 'account-browsers' : TEMPORARY_PROFILES_DIR);
  await fs.mkdir(profilesRoot, { recursive: true });
  const profile = profileOverride ? path.resolve(profileOverride) : accountId ? path.join(profilesRoot, accountId) : await fs.mkdtemp(path.join(profilesRoot, 'ollama-'));
  if (accountId || profileOverride) {
    await fs.mkdir(profile, { recursive: true });
    // Artefact d'anciennes versions (port TCP) : supprimé et plus jamais lu.
    await fs.rm(path.join(profile, 'DevToolsActivePort'), { force: true });
  }
  // Ce lecteur ne s'ouvre qu'après la connexion Google ordinaire. Il utilise un
  // profil dédié, sans profil navigateur partagé ni usurpation d'identité.
  const child = (dependencies.spawn || spawn)(executable, readerArguments(profile, url, { headless, minimized }), { windowsHide: true, stdio: CDP_PIPE_STDIO });
  let launchFailed = false, launchExited = false;
  child.on('error', () => { launchFailed = true; });
  child.once('exit', () => { launchExited = true; });
  let transport = null;
  const cancel = () => {
    try { transport?.close(); } catch {}
    try { child.kill(); } catch {}
  };
  signal?.addEventListener('abort', cancel, { once: true });
  async function cleanup() {
    if (accountId || profileOverride || preserveProfile) return; // Dedicated sessions are retained until disconnect.
    const resolved = await fs.realpath(profile).catch(() => null);
    const root = await fs.realpath(profilesRoot).catch(() => null);
    // Recursive removal is restricted to the exact temporary profile we created.
    if (!resolved || !root || path.dirname(resolved) !== root || !path.basename(resolved).startsWith('ollama-')) return;
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
  }
  const toBrowser = child.stdio?.[3], fromBrowser = child.stdio?.[4];
  try {
    if (!toBrowser || !fromBrowser) throw new Error('Le navigateur dédié ne répond pas. Essaie la connexion par email.');
    transport = createCdpPipeTransport({ toBrowser, fromBrowser });
    await waitForBrowserReady({ transport, signal, isFailed: () => launchFailed, isExited: () => launchExited });
  } catch (error) {
    signal?.removeEventListener('abort', cancel);
    try { transport?.close(); } catch {}
    await stopBrowserProcess(child).catch(() => {});
    await cleanup();
    throw error;
  }
  const command = (method, params, sessionId, commandOptions) => transport.command(method, params, sessionId, commandOptions);
  let closed = false, emptyUsageReads = 0, fallbackNavigated = false;
  return {
    isOpen: () => !closed && transport.isOpen(),
    async readSubscriptionPage() {
      if (!config) throw new Error('Compte non disponible.');
      const { targetInfos } = await command('Target.getTargets');
      const candidates = targetInfos.filter(t => { try { return t.type === 'page' && new URL(t.url).origin === origin; } catch { return false; } });
      // Prefer the actual usage page when sign-in has opened a second tab.
      const target = candidates.find(t => /analytics|usage|subscription/.test(new URL(t.url).pathname + new URL(t.url).hash)) || candidates.find(t => t.url.split(/[?#]/)[0] === (config.usageUrl || config.url)) || candidates[0];
      if (!target) {
        // /dashboard can redirect legacy accounts to Cursor sign-in. Never
        // inspect that foreign page; probe Grok's own usage route once instead.
        if (config.fallbackUsageUrl && !fallbackNavigated && ++emptyUsageReads >= 5) {
          const fallback = new URL(config.fallbackUsageUrl);
          if (fallback.origin === origin) {
            fallbackNavigated = true;
            await command('Target.createTarget', { url: fallback.href, background: true });
          }
        }
        return { authenticated: false, windows: [] };
      }
      const { sessionId } = await command('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      try {
        const result = await command('Runtime.evaluate', { expression: `(${inspectSubscriptionPage.toString()})(${JSON.stringify(accountId)}, ${JSON.stringify(origin)})`, returnByValue: true }, sessionId);
        if (result.exceptionDetails || !result.result?.value) throw new Error('Les réglages d’utilisation ne sont pas encore lisibles.');
        const reading = result.result.value;
        // Older SuperGrok accounts may not expose the new dashboard. After
        // client rendering has settled, try the official legacy usage route.
        // Never leave the provider origin or navigate away from a human check.
        if (!reading.windows?.length && !reading.blocked && config.fallbackUsageUrl && !fallbackNavigated && ++emptyUsageReads >= 5 && new URL(target.url).href !== new URL(config.fallbackUsageUrl).href) {
          const fallback = new URL(config.fallbackUsageUrl);
          if (fallback.origin === origin) {
            fallbackNavigated = true;
            await command('Page.navigate', { url: fallback.href }, sessionId);
            return { authenticated: false, windows: [] };
          }
        }
        return result.result.value;
      } finally { await command('Target.detachFromTarget', { sessionId }).catch(() => {}); }
    },
    async readOllamaCookies() {
      const { targetInfos } = await command('Target.getTargets');
      const target = targetInfos.find(t => { try { return t.type === 'page' && new URL(t.url).origin === ORIGIN && !new URL(t.url).pathname.startsWith('/auth/'); } catch { return false; } });
      if (!target) return [];
      const { sessionId } = await command('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      try {
        // Only cookies applicable to Ollama are requested. Google credentials,
        // Google cookies and page contents are never read.
        const { cookies } = await command('Network.getCookies', { urls: [ORIGIN + '/settings'] }, sessionId);
        return cookies.map(ollamaCookie).filter(Boolean);
      } finally { await command('Target.detachFromTarget', { sessionId }).catch(() => {}); }
    },
    // OrcaRouter : identifiants du compte et cookies de ses seuls hôtes.
    async readOrcaSession() {
      const { targetInfos } = await command('Target.getTargets');
      const target = targetInfos.find(t => { try { const url = new URL(t.url); return t.type === 'page' && url.protocol === 'https:' && ORCA_HOSTS.has(url.hostname); } catch { return false; } });
      if (!target) return null;
      const { sessionId } = await command('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      try {
        const result = await command('Runtime.evaluate', { expression: ORCA_ACCOUNT_REF_SCRIPT, returnByValue: true }, sessionId);
        const ref = result.exceptionDetails ? null : result.result?.value || null;
        const { cookies } = await command('Network.getCookies', { urls: [...ORCA_HOSTS].map(host => `https://${host}/`) }, sessionId);
        return { ref, cookies: cookies.map(orcaCookie).filter(Boolean) };
      } finally { await command('Target.detachFromTarget', { sessionId }).catch(() => {}); }
    },
    async close() {
      if (closed) return;
      closed = true;
      signal?.removeEventListener('abort', cancel);
      await command('Browser.close').catch(() => {});
      try { transport.close(); } catch {}
      await stopBrowserProcess(child, true);
      await cleanup();
    },
  };
}

// Purge des profils temporaires orphelins (arrêt brutal, mise à jour). Appelée
// par main.cjs au démarrage, avant tout lancement de navigateur. Ne supprime
// jamais autre chose que le contenu direct du dossier temporaire.
async function sweepTemporaryProfiles(dataDir) {
  const rootPath = path.resolve(dataDir, TEMPORARY_PROFILES_DIR);
  const root = await fs.realpath(rootPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!root) return { removed: 0, failed: 0 };
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch { return { removed: 0, failed: 0 }; }
  let removed = 0, failed = 0;
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    try {
      const stats = await fs.lstat(target);
      if (stats.isSymbolicLink()) {
        // Un lien (ou une jonction Windows) est supprimé lui-même, jamais sa cible.
        await fs.unlink(target);
        removed++;
        continue;
      }
      const resolved = await fs.realpath(target);
      if (path.dirname(resolved) !== root || path.basename(resolved) !== entry.name) { failed++; continue; }
      await fs.rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      removed++;
    } catch (error) {
      if (error.code !== 'ENOENT') failed++;
    }
  }
  return { removed, failed };
}

async function deleteAccountProfile(dataDir, id) {
  if (id !== 'gemini') accountConfig(id); // Historical Gemini web migration only.
  const root = await fs.realpath(path.resolve(dataDir, 'account-browsers')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!root) return;
  const profile = await fs.realpath(path.join(root, id)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!profile) return;
  if (path.dirname(profile) !== root || path.basename(profile) !== id) throw new Error('Dossier de session hors du répertoire autorisé.');
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
// Profils dédiés hors fiches d'abonnement (Ollama, OrcaRouter).
async function deleteNamedProfile(dataDir, name, label) {
  const root = await fs.realpath(path.resolve(dataDir, 'account-browsers')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!root) return;
  const profile = await fs.realpath(path.join(root, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!profile) return;
  if (path.dirname(profile) !== root || path.basename(profile) !== name) throw new Error(`Dossier de session ${label} hors du répertoire autorisé.`);
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
const deleteOllamaAccountProfile = dataDir => deleteNamedProfile(dataDir, 'ollama', 'Ollama');
const deleteOrcaAccountProfile = dataDir => deleteNamedProfile(dataDir, 'orcarouter', 'OrcaRouter');
// Fenêtre de connexion ordinaire : elle est « fermée » quand le processus lancé
// est sorti ET que le profil n'est plus utilisé (fichier `lockfile` de
// Chrome/Edge, supprimé à la fermeture). Chrome rend en effet la main en
// quelques millisecondes quand le profil est déjà ouvert dans une autre
// fenêtre : sans ce contrôle, la session serait lue pendant la connexion.
function watchLoginBrowser(child, profile, dependencies = {}) {
  const startedAt = Date.now();
  const launchFailureMs = dependencies.launchFailureMs ?? 3000;
  const inUse = dependencies.profileInUse || (() => fsSync.existsSync(path.join(profile, 'lockfile')));
  let exitedAt = null, sawProfileInUse = false;
  child.once('exit', () => { exitedAt = Date.now(); });
  const profileOpen = () => { const open = inUse(); if (open) sawProfileInUse = true; return open; };
  return {
    done: () => exitedAt !== null && !profileOpen(),
    // Sorti aussitôt sans jamais ouvrir le profil : le navigateur n'a pas démarré.
    failedAtLaunch: () => exitedAt !== null && !sawProfileInUse && exitedAt - startedAt < launchFailureMs,
  };
}
const browserFailedError = () => Object.assign(new Error('Chrome ou Edge s’est fermé dès son ouverture. Réessaie ; si cela se reproduit, ferme les fenêtres Chrome ou Edge ouvertes pour cette connexion.'), { code: 'BROWSER_FAILED' });

// Google authentication runs in an ordinary browser process. A separate
// headless process reads only Ollama cookies after the user closes the window.
async function openNativeOllamaLogin(dataDir, dependencies = {}) {
  const executable = await (dependencies.findBrowser || findBrowser)();
  const profile = path.resolve(dataDir, 'account-browsers', 'ollama');
  await fs.mkdir(profile, { recursive: true });
  await fs.rm(path.join(profile, 'DevToolsActivePort'), { force: true });
  const launch = dependencies.spawn || spawn;
  const child = launch(executable, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--new-window', ORIGIN + '/settings'], { windowsHide: true, stdio: 'ignore' });
  let exited = false, closed = false, reader = null;
  const ready = new Set();
  const watch = watchLoginBrowser(child, profile, dependencies);
  child.once('exit', () => { exited = true; for (const listener of ready) listener(); });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () => reject(new Error('Chrome ou Edge ne peut pas être démarré.')));
  });
  return {
    isOpen: () => !closed,
    phase: () => closed ? 'closed' : watch.done() ? 'verifying' : 'login',
    onReady: listener => { ready.add(listener); if (exited) queueMicrotask(listener); },
    async readOllamaCookies({ signal } = {}) {
      if (!watch.done()) throw Object.assign(new Error('Termine la connexion Ollama dans Chrome ou Edge, puis ferme cette fenêtre. La vérification démarrera ensuite automatiquement.'), { code: 'OLLAMA_LOGIN_PENDING' });
      if (closed) throw new Error('La connexion a été fermée. Rouvre le compte.');
      if (watch.failedAtLaunch()) { closed = true; throw browserFailedError(); }
      try {
        if (!reader) reader = await (dependencies.openReader || openAccountBrowser)(dataDir, null, true, { signal, profileOverride: profile, originOverride: ORIGIN, urlOverride: ORIGIN + '/settings', preserveProfile: true });
        let cookies = [];
        for (let attempt = 0; attempt < 10; attempt++) {
          signal?.throwIfAborted();
          cookies = await reader.readOllamaCookies();
          if (cookies.length) break;
          if (attempt < 9) await delay(500, signal);
        }
        return cookies;
      } finally {
        closed = true;
        if (reader) { await reader.close(); reader = null; }
      }
    },
    async close() {
      closed = true;
      ready.clear();
      if (reader) { await reader.close(); reader = null; }
      if (!exited) await stopBrowserProcess(child);
    },
  };
}
// OrcaRouter : connexion (GitHub, Google, Microsoft, e-mail, clé d'accès) dans
// un Chrome/Edge ordinaire, sans pipe de débogage. Après sa fermeture, un
// lecteur sans fenêtre lit les identifiants du compte et les cookies OrcaRouter.
async function openNativeOrcaLogin(dataDir, dependencies = {}) {
  const executable = await (dependencies.findBrowser || findBrowser)();
  const profile = path.resolve(dataDir, 'account-browsers', 'orcarouter');
  await fs.mkdir(profile, { recursive: true });
  await fs.rm(path.join(profile, 'DevToolsActivePort'), { force: true });
  const launch = dependencies.spawn || spawn;
  const child = launch(executable, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--new-window', ORCA_ORIGIN + '/console'], { windowsHide: true, stdio: 'ignore' });
  let exited = false, closed = false, reader = null;
  const watch = watchLoginBrowser(child, profile, dependencies);
  child.once('exit', () => { exited = true; });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () => reject(new Error('Chrome ou Edge ne peut pas être démarré.')));
  });
  return {
    isOpen: () => !closed,
    phase: () => closed ? 'closed' : watch.done() ? 'verifying' : 'login',
    async readOrcaSession({ signal } = {}) {
      if (!watch.done()) throw Object.assign(new Error('Termine la connexion OrcaRouter dans Chrome ou Edge, puis ferme cette fenêtre. Le portefeuille sera récupéré automatiquement.'), { code: 'ORCA_LOGIN_PENDING' });
      if (closed) throw new Error('La connexion a été fermée. Rouvre le compte.');
      if (watch.failedAtLaunch()) { closed = true; throw browserFailedError(); }
      try {
        if (!reader) reader = await (dependencies.openReader || openAccountBrowser)(dataDir, null, true, { signal, profileOverride: profile, originOverride: ORCA_ORIGIN, urlOverride: ORCA_ORIGIN + '/console', preserveProfile: true }, dependencies);
        // La console est une application client : attendre que le compte soit chargé.
        let session = null;
        for (let attempt = 0; attempt < 20; attempt++) {
          signal?.throwIfAborted();
          session = await reader.readOrcaSession();
          if (session?.ref?.userId > 0 && session.ref.workspaceId > 0 && session.cookies.length) break;
          if (attempt < 19) await delay(500, signal);
        }
        return session || { ref: null, cookies: [] };
      } finally {
        closed = true;
        if (reader) { await reader.close(); reader = null; }
      }
    },
    async close() {
      closed = true;
      if (reader) { await reader.close(); reader = null; }
      if (!exited) await stopBrowserProcess(child);
    },
  };
}
// Google authentication takes place in an ordinary browser process, with no
// debugging pipe and no page/cookie inspection. Only after the user closes it
// may a separate read-only process use this provider's dedicated profile.
async function openNativeLogin(dataDir, id, dependencies = {}) {
  const config = accountConfig(id);
  const executable = await (dependencies.findBrowser || findBrowser)();
  const profile = path.resolve(dataDir, 'account-browsers', id);
  await fs.mkdir(profile, { recursive: true });
  const launch = dependencies.spawn || spawn;
  const child = launch(executable, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--new-window', config.url], { windowsHide: true, stdio: 'ignore' });
  let exited = false, closed = false, reader = null;
  const ready = new Set();
  child.once('exit', () => { exited = true; for (const listener of ready) listener(); });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () => reject(new Error('Chrome ou Edge ne peut pas être démarré.')));
  });
  return {
    // The connection attempt remains active while waiting for the browser to
    // close and then while reading the saved session.
    isOpen: () => !closed,
    phase: () => exited ? 'verifying' : 'login',
    onReady: listener => { ready.add(listener); if (exited) queueMicrotask(listener); },
    async readSubscriptionPage({ signal, interactive = false } = {}) {
      if (!exited) throw Object.assign(new Error(`Termine ta connexion sur ${config.name}, puis ferme cette fenêtre Chrome ou Edge. La vérification démarrera ensuite automatiquement.`), { code: 'ACCOUNT_LOGIN_PENDING' });
      if (closed) throw new Error('La connexion a été fermée. Rouvre le compte.');
      if (!reader) reader = await (dependencies.openReader || openAccountBrowser)(dataDir, id, !interactive, { signal }, dependencies);
      signal?.throwIfAborted();
      // The controller owns settling/retry and closes this reader on every
      // completed verification, including errors and unavailable quotas.
      return { ...await reader.readSubscriptionPage(), loginCompleted: true };
    },
    async close() {
      closed = true;
      ready.clear();
      if (reader) { await reader.close(); reader = null; }
      // Only the process started for this isolated provider can be stopped.
      if (!exited) await stopBrowserProcess(child);
    },
  };
}
function openSubscriptionBrowser(dataDir, id, background = false, options = {}, dependencies = {}) {
  const openLogin = dependencies.openLogin || openNativeLogin;
  const openReader = dependencies.openReader || openAccountBrowser;
  if (accountConfig(id).nativeLogin && !background) return openLogin(dataDir, id, dependencies);
  // Grok automatic refreshes must never create a visible or minimized window.
  // Only explicit login/manual verification may open its browser window.
  const windowRequired = id === 'claude';
  return openReader(dataDir, id, background && !windowRequired && !options.interactive,
    { ...options, minimized: background && windowRequired && !options.interactive }, dependencies);
}
module.exports = {
  openOllamaBrowser: (dataDir, dependencies) => openNativeOllamaLogin(dataDir, dependencies),
  openOrcaBrowser: (dataDir, dependencies) => openNativeOrcaLogin(dataDir, dependencies),
  openSubscriptionBrowser, openNativeLogin, openAccountBrowser,
  deleteAccountProfile, deleteOllamaAccountProfile, deleteOrcaAccountProfile, ollamaCookie, orcaCookie,
  createCdpPipeTransport, waitForBrowserReady, readerArguments, stopBrowserProcess, killProcessTree,
  sweepTemporaryProfiles,
};
