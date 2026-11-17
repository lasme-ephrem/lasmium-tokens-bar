// Stockage local de Lasmium TOKENS-HUB : dossier de données, écriture atomique
// sérialisée, chargement et migrations. Aucune dépendance à Electron afin que
// le module reste testable sous `node --test` et utilisable par les scripts.
const fsDefault = require('node:fs/promises');
const pathDefault = require('node:path');
const { createSeed } = require('./seed.cjs');
const migrations = require('./migrations.cjs');
const { expireSubscriptions } = require('./domain.cjs');

const STATE_VERSION = 1;
const STATE_FILE = 'state.json';
// ≈ 7 jours d'historique à 10 fournisseurs et 5 minutes de rafraîchissement.
const HISTORY_LIMIT = 20000;

function trimHistory(history, limit = HISTORY_LIMIT) {
  if (!Array.isArray(history) || history.length <= limit) return history;
  return history.slice(0, limit);
}

function createDataStore({ dataDir, fs = fsDefault, path = pathDefault } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('Dossier de données invalide.');
  let writeQueue = Promise.resolve();

  async function ensureDir() {
    await fs.mkdir(dataDir, { recursive: true });
  }

  // Écriture atomique : fichier temporaire puis renommage. La sérialisation des
  // appels est assurée par persist() ; atomicWrite reste utilisable seul
  // (identifiants) grâce à un nom de temporaire distinct par fichier.
  async function atomicWrite(name, document) {
    await ensureDir();
    const dest = path.join(dataDir, name);
    await fs.writeFile(dest + '.tmp', JSON.stringify(document, null, 2), { mode: 0o600 });
    await fs.rename(dest + '.tmp', dest);
  }

  async function readJSON(name) {
    try { return JSON.parse(await fs.readFile(path.join(dataDir, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  function persist(state) {
    const snapshot = JSON.parse(JSON.stringify(state));
    writeQueue = writeQueue.catch(() => {}).then(() => atomicWrite(STATE_FILE, snapshot));
    return writeQueue;
  }

  function settle() {
    return writeQueue.catch(() => {});
  }

  async function remove(name) {
    await fs.rm(path.join(dataDir, name), { recursive: true, force: true });
  }

  async function backup(name, value) {
    await ensureDir();
    const body = JSON.stringify(value, null, 2);
    // `wx` : une sauvegarde existante n'est jamais écrasée par un redémarrage.
    await fs.writeFile(path.join(dataDir, name), body, { flag: 'wx', mode: 0o600 })
      .catch(error => { if (error.code !== 'EEXIST') throw error; });
  }

  // Charge l'état (ou le crée), applique toutes les migrations dans l'ordre
  // historique de main.cjs puis renvoie `{ state, created, legacyGeminiProfile, legacyOrcaRouter }`.
  // Un fichier illisible lève : l'appelant décide (dialogue + arrêt), jamais de
  // réinitialisation silencieuse.
  async function load({ onApply } = {}) {
    await ensureDir();
    let created = false;
    let state;
    try {
      state = JSON.parse(await fs.readFile(path.join(dataDir, STATE_FILE), 'utf8'));
      if (state.version !== STATE_VERSION || !Array.isArray(state.providers) || !Array.isArray(state.history) || !state.settings) {
        throw new Error('Format de données non reconnu.');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = createSeed();
      created = true;
      await persist(state);
    }

    const apply = async (migration, name) => {
      const result = migration(state);
      if (!result.changed) return;
      state = result.state;
      onApply?.(name, state);
      await persist(state);
    };

    await apply(migrations.removeImportMetadata, 'removeImportMetadata');
    await apply(migrations.addAntigravity, 'addAntigravity');

    // Détecté avant le retrait : le profil navigateur historique Gemini web doit
    // être supprimé par l'appelant (dépendance à account-browser.cjs).
    const legacyGeminiProfile = state.providers.some(p => p.id === 'gemini');
    // OrcaRouter (retiré en 0.6.17) : session Electron et profil Chrome à effacer.
    const legacyOrcaRouter = state.providers.some(p => p.id === 'orcarouter');
    const removal = migrations.removeUnusedProviders(state);
    if (removal.changed) {
      await backup('state.before-subscription-removal.json', state);
      state = removal.state;
      onApply?.('removeUnusedProviders', state);
      await persist(state);
    }

    await apply(migrations.addClaude, 'addClaude');
    await apply(migrations.normalizeProviderPresentation, 'normalizeProviderPresentation');
    await apply(migrations.normalizeThemeSettings, 'normalizeThemeSettings');
    await apply(migrations.addApiCooldowns, 'addApiCooldowns');
    await apply(migrations.addConnectorHealth, 'addConnectorHealth');
    await apply(migrations.convertClaudeSession, 'convertClaudeSession');
    // Champs manuels retirés en 0.6.9 : copie intégrale préalable, jamais écrasée.
    const simplified = migrations.simplifySubscriptionFields(state);
    if (simplified.changed) {
      await backup('state.before-0.6.9-simplification.json', state);
      state = simplified.state;
      onApply?.('simplifySubscriptionFields', state);
      await persist(state);
    }

    if (expireSubscriptions(state.providers)) await persist(state);

    if (Array.isArray(state.history) && state.history.length > HISTORY_LIMIT) {
      state.history = trimHistory(state.history);
      onApply?.('trimHistory', state);
      await persist(state);
    }

    return { state, created, legacyGeminiProfile, legacyOrcaRouter };
  }

  return {
    dataDir, ensureDir, atomicWrite, readJSON, persist, settle, remove, load,
    stateFile: path.join(dataDir, STATE_FILE),
  };
}

module.exports = { createDataStore, trimHistory, STATE_VERSION, HISTORY_LIMIT, STATE_FILE };
