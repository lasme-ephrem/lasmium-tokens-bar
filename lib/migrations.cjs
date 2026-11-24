// Services explicitly removed by the owner; other records are preserved.
// OrcaRouter retiré en 0.6.17 (fiche, historique, santé et cooldowns).
const removedProviderIds = new Set(['tokenrouter', 'opencode-zen', 'qwen', 'opencode-go', 'gemini', 'orcarouter']);

function removeUnusedProviders(state) {
  const providers = state.providers.filter(p => !removedProviderIds.has(p.id));
  const history = state.history.filter(entry => !removedProviderIds.has(entry.providerId));
  // Santé et cooldowns 429 indexés par fournisseur (`<id>` / `<id>:<empreinte>`).
  const keep = key => !removedProviderIds.has(String(key).split(':')[0]);
  const prune = map => (map && typeof map === 'object' && !Array.isArray(map) ? Object.fromEntries(Object.entries(map).filter(([key]) => keep(key))) : map);
  const connectorHealth = prune(state.connectorHealth), apiCooldowns = prune(state.apiCooldowns);
  const pruned = (state.connectorHealth && Object.keys(connectorHealth).length !== Object.keys(state.connectorHealth).length)
    || (state.apiCooldowns && Object.keys(apiCooldowns).length !== Object.keys(state.apiCooldowns).length);
  // L'ordre de consommation (moteur de recommandation) a été retiré du produit :
  // le champ `strategy` n'est plus utilisé. Migration non destructive — il est
  // supprimé des inventaires existants, les autres données sont conservées.
  const hadStrategy = Object.hasOwn(state, 'strategy');
  const { strategy: _obsoleteStrategy, ...rest } = state;
  const changed = providers.length !== state.providers.length || history.length !== state.history.length || hadStrategy || pruned;
  const next = { ...rest, providers, history };
  if (state.connectorHealth !== undefined) next.connectorHealth = connectorHealth;
  if (state.apiCooldowns !== undefined) next.apiCooldowns = apiCooldowns;
  return { changed, state: changed ? next : state };
}

function removeImportMetadata(state) {
  const legacyNotes = new Set([
    'Offre exacte à préciser. Échéance importée à vérifier.',
    'Passage à 219,99 $ indiqué ; date du changement et périodicité à préciser.',
    'Échéance contradictoire : 28/09/2026 dans le tableau de droite, absente à gauche.',
    'Tarif, offre et échéance non renseignés.',
    'Montant importé : 10 $. Nature à préciser (recharge, budget ou solde).',
    'Montant importé : 20 $. Nature à préciser (recharge, budget ou solde).',
  ]);
  let changed = Object.hasOwn(state, 'importedFrom');
  const providers = state.providers.map(p => {
    if (!Object.hasOwn(p, 'importedCost')) return p;
    changed = true;
    const { importedCost, ...clean } = p;
    if (legacyNotes.has(clean.notes)) clean.notes = '';
    return clean;
  });
  if (!changed) return { changed: false, state };
  const { importedFrom, ...clean } = state;
  return { changed: true, state: { ...clean, providers } };
}

function addAntigravity(state) {
  let changed = false;
  const providers = state.providers.map(p => {
    if (p.id === 'gemini' && p.name === 'Gemini') { changed = true; return { ...p, name: 'Gemini web' }; }
    return p;
  });
  if (!providers.some(p => p.id === 'antigravity')) {
    const item = require('./seed.cjs').createSeed().providers.find(p => p.id === 'antigravity');
    providers.splice(providers.findIndex(p => p.id === 'gemini') + 1, 0, item);
    changed = true;
  }
  return { changed, state: changed ? { ...state, providers } : state };
}
function addClaude(state) {
  if (state.providers.some(p => p.id === 'claude')) return { changed: false, state };
  const providers = [...state.providers];
  const item = require('./seed.cjs').createSeed().providers.find(p => p.id === 'claude');
  const openaiIndex = providers.findIndex(p => p.id === 'openai');
  providers.splice(openaiIndex < 0 ? 0 : openaiIndex + 1, 0, item);
  return { changed: true, state: { ...state, providers } };
}
function normalizeProviderPresentation(state) {
  // 0.6.19 : RunInfra devient RightNow (même service, même clé, même historique).
  const names = { openai: 'OpenAI GPT', claude: 'Anthropic Claude', grok: 'xAI Grok', zai: 'Z.ai', runinfra: 'RightNow' };
  const looks = { runinfra: { monogram: 'RN', color: '#76b900' } };
  const order = ['openai', 'claude', 'grok', 'antigravity', 'zai', 'ollama'];
  const providers = state.providers.map(p => {
    let next = names[p.id] && p.name !== names[p.id] ? { ...p, name: names[p.id] } : p;
    const look = looks[p.id];
    if (look && Object.entries(look).some(([key, value]) => next[key] !== value)) next = { ...next, ...look };
    return next;
  });
  providers.sort((a, b) => {
    const rank = id => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
    return rank(a.id) - rank(b.id);
  });
  const changed = providers.some((p, i) => p !== state.providers[i]);
  return { changed, state: changed ? { ...state, providers } : state };
}
// Thème : les anciens inventaires gardent leur choix explicite (`light` ou
// `dark`) ; `system` n'est appliqué qu'en l'absence de valeur valide.
const THEMES = Object.freeze(['light', 'dark', 'system']);
function normalizeThemeSettings(state) {
  const settings = state?.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { changed: false, state };
  if (THEMES.includes(settings.theme)) return { changed: false, state };
  return { changed: true, state: { ...state, settings: { ...settings, theme: 'system' } } };
}
// Cooldowns 429 des clés API : initialisation non destructive. Les entrées
// valides sont conservées, les invalides écartées et le total plafonné aux 100
// échéances les plus récentes (contrat §3.2).
const MAX_API_COOLDOWNS = 100;
function addApiCooldowns(state) {
  const source = state?.apiCooldowns;
  const valid = Boolean(source) && typeof source === 'object' && !Array.isArray(source);
  if (!valid) return { changed: true, state: { ...state, apiCooldowns: {} } };
  const entries = Object.entries(source).filter(([key, until]) => typeof key === 'string' && key.length > 0 && Number.isFinite(until) && until > 0);
  const pristine = entries.length === Object.keys(source).length && entries.length <= MAX_API_COOLDOWNS;
  if (pristine) return { changed: false, state };
  entries.sort((a, b) => b[1] - a[1]);
  return { changed: true, state: { ...state, apiCooldowns: Object.fromEntries(entries.slice(0, MAX_API_COOLDOWNS)) } };
}
// Santé des connecteurs : initialisation non destructive. Les entrées mal
// formées sont écartées ; le dernier relevé et les erreurs restent locaux.
const HEALTH_STATES = Object.freeze(['ok', 'stale', 'auth', 'rate', 'drift', 'down', 'idle', 'error']);
// 0.6.9 : fiche réduite à forfait, prix, fréquence et échéance. Les champs
// saisis à la main (notes, message d'expiration, prochain tarif, case
// « vérifié », dates de réinitialisation manuelles) n'ont plus d'interface :
// ils sont retirés. Un abonnement « en pause » devient « je n'ai plus cet
// abonnement » (expiré) ; un accès API exclu du suivi y revient (la fiche API
// ne garde que la clé). Une sauvegarde d'état précède toujours la migration.
const OBSOLETE_FIELDS = ['notes', 'statusMessage', 'reviewed', 'nextAmount', 'priceChangeDate', 'manualResets'];
function simplifySubscriptionFields(state) {
  let changed = false;
  const providers = state.providers.map(p => {
    const next = { ...p };
    for (const field of OBSOLETE_FIELDS) if (Object.hasOwn(next, field)) { delete next[field]; changed = true; }
    if (next.type === 'subscription' && next.subscriptionStatus === 'paused') {
      next.subscriptionStatus = 'expired'; next.active = next.id === 'ollama'; changed = true;
    }
    if (next.type === 'api' && next.active === false) { next.active = true; changed = true; }
    return next;
  });
  return { changed, state: changed ? { ...state, providers } : state };
}

// 0.6.8 : une seule connexion Claude (abonnement via Claude Code). Une
// ancienne session Claude Desktop devient cette connexion au chargement de
// l'état, avant l'ouverture des fenêtres ; le dernier relevé reste affiché.
function convertClaudeSession(state) {
  let changed = false;
  const providers = state.providers.map(p => {
    if (p.id !== 'claude' || !p.accountSession || p.accountSession.kind === 'claude-live-local') return p;
    changed = true;
    return { ...p, accountSession: { kind: 'claude-live-local' } };
  });
  return { changed, state: changed ? { ...state, providers } : state };
}

function addConnectorHealth(state) {
  const source = state?.connectorHealth;
  const valid = Boolean(source) && typeof source === 'object' && !Array.isArray(source);
  if (!valid) return { changed: true, state: { ...state, connectorHealth: {} } };
  const entries = Object.entries(source).filter(([id, health]) =>
    typeof id === 'string' && id.length > 0 && health && typeof health === 'object'
    && !Array.isArray(health) && HEALTH_STATES.includes(health.state));
  if (entries.length === Object.keys(source).length) return { changed: false, state };
  return { changed: true, state: { ...state, connectorHealth: Object.fromEntries(entries) } };
}
module.exports = { convertClaudeSession, simplifySubscriptionFields, removeUnusedProviders, removeImportMetadata, removedProviderIds, addAntigravity, addClaude, normalizeProviderPresentation, normalizeThemeSettings, addApiCooldowns, addConnectorHealth, THEMES, MAX_API_COOLDOWNS, HEALTH_STATES };
