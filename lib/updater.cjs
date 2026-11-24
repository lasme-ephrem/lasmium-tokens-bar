'use strict';

// Contrôleur de mise à jour du portable. Il ne remplace jamais l'application
// en cours : il télécharge, vérifie la signature et le SHA-256, prépare le
// dossier, puis délègue le remplacement à un script Windows séparé.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { finished } = require('node:stream/promises');
const { verifyManifest, isNewer } = require('./update-manifest.cjs');
const { extractZip } = require('./zip-extract.cjs');
const { findPackageRoot, buildWindowsInstallScript } = require('./update-install.cjs');

const MAX_MANIFEST_BYTES = 512 * 1024;
const CHECK_TIMEOUT_MS = 20000;

function publicManifest(manifest) {
  if (!manifest) return null;
  return {
    version: manifest.version,
    minApp: manifest.minApp,
    publishedAt: manifest.publishedAt,
    notes: manifest.notes || '',
    size: manifest.asset.size,
    name: manifest.asset.name,
  };
}

function createUpdater({
  currentVersion,
  manifestUrl = '',
  publicKey,
  dataDir,
  targetRoot,
  executableName = 'LasmiumTokensHub.exe',
  enabled = true,
  fetchImpl = globalThis.fetch,
  spawnImpl = require('node:child_process').spawn,
  quit = () => {},
  onState = () => {},
  appPid = process.pid,
  platform = process.platform,
  now = () => new Date(),
} = {}) {
  let manifest = null;
  let staged = null;
  let installScript = null;
  let state = {
    state: enabled ? 'idle' : 'disabled',
    enabled,
    currentVersion,
    checkedAt: null,
    available: null,
    progress: 0,
    error: null,
  };
  const listeners = [];

  function info() {
    return {
      ...state,
      available: publicManifest(manifest),
    };
  }
  function setState(patch) {
    state = { ...state, ...patch };
    const snapshot = info();
    try { onState(snapshot); } catch { /* l'UI ne doit pas bloquer le téléchargement */ }
    for (const listener of listeners) {
      try { listener(snapshot); } catch { /* isolé */ }
    }
    return snapshot;
  }
  function subscribe(listener) {
    listeners.push(listener);
    return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); };
  }
  function validateConfiguration() {
    if (!enabled) return 'Mises à jour désactivées.';
    if (!manifestUrl) return 'Aucune source de mise à jour configurée.';
    try {
      const url = new URL(manifestUrl);
      if (url.protocol !== 'https:') return 'La source de mise à jour doit utiliser HTTPS.';
    } catch { return 'Adresse de mise à jour invalide.'; }
    if (!publicKey) return 'Clé publique de mise à jour absente.';
    if (!dataDir) return 'Dossier de données absent.';
    return null;
  }

  async function check() {
    const configurationError = validateConfiguration();
    if (configurationError) {
      setState({ state: enabled ? 'error' : 'disabled', error: configurationError, available: null });
      return info();
    }
    setState({ state: 'checking', error: null, progress: 0 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
      const response = await fetchImpl(manifestUrl, {
        signal: controller.signal,
        headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      });
      if (!response || !response.ok) throw new Error(`Serveur de mise à jour indisponible (${response?.status || 'réseau'}).`);
      const finalUrl = new URL(response.url || manifestUrl);
      if (finalUrl.protocol !== 'https:') throw new Error('Redirection de mise à jour non HTTPS.');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('Manifeste de mise à jour trop volumineux.');
      let document;
      try { document = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Manifeste de mise à jour illisible.'); }
      const verification = verifyManifest(document, publicKey, { appVersion: currentVersion });
      if (!verification.valid) throw new Error(`Mise à jour refusée : ${verification.issues.join(' ; ')}.`);
      if (!isNewer(document.version, currentVersion)) {
        manifest = null; staged = null;
        return setState({ state: 'up-to-date', checkedAt: now().toISOString(), available: null, error: null, progress: 0 });
      }
      manifest = document;
      staged = null;
      return setState({
        state: 'available',
        checkedAt: now().toISOString(),
        available: publicManifest(manifest),
        error: null,
        progress: 0,
      });
    } catch (error) {
      const message = error?.name === 'AbortError' ? 'Délai de vérification dépassé.' : error.message;
      manifest = null;
      return setState({ state: 'error', checkedAt: now().toISOString(), available: null, error: message, progress: 0 });
    } finally {
      clearTimeout(timer);
    }
  }

  async function downloadToFile(url, destination, expectedSize, expectedHash) {
    const response = await fetchImpl(url, { headers: { accept: 'application/zip' } });
    if (!response || !response.ok) throw new Error(`Téléchargement impossible (${response?.status || 'réseau'}).`);
    if (new URL(response.url || url).protocol !== 'https:') throw new Error('Redirection de téléchargement non HTTPS.');
    const contentLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(contentLength) && contentLength > expectedSize) throw new Error('Taille annoncée supérieure à celle du manifeste.');
    const temporary = `${destination}.part`;
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    const file = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
    const hash = crypto.createHash('sha256');
    let received = 0;
    try {
      const body = response.body ? Readable.fromWeb(response.body) : Readable.from([]);
      for await (const chunk of body) {
        received += chunk.length;
        if (received > expectedSize) throw new Error('Archive plus volumineuse que prévu.');
        hash.update(chunk);
        if (!file.write(chunk)) await new Promise(resolve => file.once('drain', resolve));
      }
      file.end();
      await finished(file);
      if (received !== expectedSize) throw new Error(`Taille reçue incorrecte (${received} au lieu de ${expectedSize}).`);
      const digest = hash.digest('hex');
      if (digest !== expectedHash.toLowerCase()) throw new Error('SHA-256 de l’archive incorrect.');
      await fsp.rename(temporary, destination);
      return { size: received, sha256: digest };
    } catch (error) {
      file.destroy();
      await fsp.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function prepare() {
    if (!manifest) throw new Error('Aucune mise à jour vérifiée.');
    if (platform !== 'win32') throw new Error('Mise à jour automatique disponible uniquement sous Windows x64.');
    if (!targetRoot) throw new Error('Dossier d’installation inconnu.');
    const versionDir = path.join(dataDir, 'updates', manifest.version);
    const archive = path.join(versionDir, manifest.asset.name);
    const staging = path.join(versionDir, 'staging');
    setState({ state: 'downloading', error: null, progress: 0 });
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.rm(archive, { force: true });
    const result = await downloadToFile(manifest.asset.url, archive, manifest.asset.size, manifest.asset.sha256);
    setState({ state: 'extracting', progress: 100 });
    await extractZip(archive, staging);
    staged = await findPackageRoot(staging);
    installScript = path.join(versionDir, `install-${manifest.version}.ps1`);
    setState({ state: 'ready', error: null, progress: 100, stagedVersion: manifest.version });
    return { archive, staging, staged, size: result.size, sha256: result.sha256 };
  }

  async function install() {
    if (['installing', 'downloading', 'extracting'].includes(state.state)) return info();
    if (state.state === 'up-to-date') return info();
    if (state.state !== 'available' && state.state !== 'ready' && !manifest) {
      const checked = await check();
      if (checked.state !== 'available') return checked;
    }
    try {
      if (!staged) await prepare();
      if (!installScript) throw new Error('Script d’installation absent.');
      const started = `${installScript}.started`;
      await fsp.rm(started, { force: true });
      const script = buildWindowsInstallScript({
        stagedRoot: staged,
        targetRoot,
        executableName,
        appPid,
        logPath: path.join(dataDir, 'updates', 'update.log'),
        startedPath: started,
      });
      await fsp.writeFile(installScript, script, { mode: 0o600 });
      // Lancement sans console : PowerShell démarré directement et détaché
      // (DETACHED_PROCESS) n'ouvre aucune fenêtre, même quand Windows Terminal
      // est le terminal par défaut, et l'application relancée n'a aucune
      // console à laquelle se rattacher. Si l'environnement bloque ce lancement
      // (pas d'accusé), le shell natif reste un recours, fenêtre masquée.
      const powershellArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', installScript];
      const launches = [
        () => spawnImpl('powershell.exe', powershellArgs, { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(installScript) }),
        () => spawnImpl(`powershell.exe ${powershellArgs.slice(0, -1).join(' ')} "${installScript}"`, [], {
          shell: true, detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(installScript),
        }),
      ];
      // Le script écrit un accusé avant d'attendre la fermeture. Sans cet
      // accusé, quitter l'application tuerait un enfant jamais exécuté.
      let acknowledged = false;
      for (const [index, launch] of launches.entries()) {
        const child = launch();
        child.unref?.();
        const attempts = index === 0 ? 50 : 100;
        for (let attempt = 0; attempt < attempts; attempt++) {
          if (await fsp.stat(started).then(() => true).catch(() => false)) { acknowledged = true; break; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (acknowledged) break;
        try { child.kill(); } catch { /* déjà terminé */ }
      }
      if (!acknowledged) throw new Error('Le script d’installation n’a pas démarré.');
      setState({ state: 'installing', progress: 100, error: null });
      setTimeout(() => quit(), 250);
      return info();
    } catch (error) {
      setState({ state: 'error', error: error.message, progress: 0 });
      return info();
    }
  }

  return {
    info,
    subscribe,
    check,
    prepare,
    install,
    // Exposé pour les tests et le diagnostic, sans exposer la clé privée.
    _state: () => state,
  };
}

module.exports = { createUpdater, MAX_MANIFEST_BYTES };
