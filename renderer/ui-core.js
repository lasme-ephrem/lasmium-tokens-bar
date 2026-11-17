/* Lasmium TOKENS-HUB — noyau d'interface partagé (renderer).
 * Aucun accès réseau, aucun secret : uniquement formatage, thème, focus et composants de base.
 * Chargé avant les fichiers views-*.js et app.js ; expose des bindings globaux utilisés par les autres scripts.
 */
'use strict';

/* ------------------------------------------------------------------ *
 * 1. Icônes (SVG décoratifs, aria-hidden)
 * ------------------------------------------------------------------ */
const UI_ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  wallet: '<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 8V6a2 2 0 0 1 2-2h13M21 11h-6v5h6"/><path d="M17 13.5h.1"/>',
  chart: '<path d="M4 3v17h17M8 15l4-5 4 2 5-7"/>',
  plug: '<path d="m9 3 1 5m5-5-1 5M7 8h10v4a5 5 0 0 1-5 5v4M7 8v4a5 5 0 0 0 5 5"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.2 7a8 8 0 0 1 13.3-2L20 8M4 16l1.5 3A8 8 0 0 0 19 17"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  file: '<path d="M14 3H5v18h14V8Zm0 0v5h5M8 12h8m-8 4h6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5"/>',
  widget: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16M18 8h-1m1 3h-1"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8m-4-4v4"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  warning: '<path d="M12 3 2.5 20h19L12 3Zm0 6v5m0 3h.01"/>',
};

function icon(name, size = 18) {
  const body = UI_ICONS[name] || UI_ICONS.grid;
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/* ------------------------------------------------------------------ *
 * 2. Échappement et formatage
 * ------------------------------------------------------------------ */
const FRESHNESS_MS = 600000; // 10 minutes, seuil de fraîcheur partagé avec le main.

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const money = (value, currency = 'USD') =>
  new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);

const quotaDisplay = (value, providerId) => providerId === 'ollama' ? Math.round(value) : value;

const shortDate = value => value
  ? new Date(value + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })
  : 'À préciser';

const fullDateTime = value => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString('fr-FR') : 'date inconnue';
};

function relativeAge(value, { capital = false } = {}) {
  if (!value) return 'Aucun relevé';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 'Date inconnue';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  const prefix = capital ? 'Il y a' : 'il y a';
  if (minutes < 1) return capital ? 'À l’instant' : 'à l’instant';
  if (minutes < 60) return `${prefix} ${minutes} min`;
  if (minutes < 1440) return `${prefix} ${Math.floor(minutes / 60)} h`;
  return `${prefix} ${Math.floor(minutes / 1440)} j`;
}

const age = value => relativeAge(value, { capital: true });

function freshness(value) {
  const time = Date.parse(value);
  const stale = !Number.isFinite(time) || Date.now() - time > FRESHNESS_MS;
  return { stale, text: relativeAge(value), full: fullDateTime(value) };
}

// Badge textuel de fraîcheur : jamais uniquement une atténuation de couleur.
function freshnessMarkup(value) {
  if (!value) return '';
  const { stale, text, full } = freshness(value);
  const title = `Dernier relevé : ${full}`;
  if (!stale) {
    return `<span class="freshness" title="${escapeHtml(title)}">${escapeHtml(text)}</span>`;
  }
  return `<span class="freshness is-stale" title="${escapeHtml(title)}" aria-label="Relevé à vérifier">`
    + `<span class="freshness-warning">${icon('warning', 12)} Relevé ancien</span>`
    + `<span class="freshness-age">${escapeHtml(text)}</span>`
    + `</span>`;
}

function days(value) {
  const now = new Date();
  return Math.round((Date.parse(value + 'T00:00:00Z')
    - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
}

function resetLabel(value) {
  const minutes = Math.ceil((Date.parse(value) - Date.now()) / 60000);
  if (minutes <= 0) return 'Réinitialisation passée · nouveau relevé nécessaire';
  if (minutes < 60) return `Réinitialisation dans ${minutes} min`;
  if (minutes < 1440) return `Réinitialisation dans ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `Réinitialisation dans ${Math.floor(minutes / 1440)} j ${Math.floor((minutes % 1440) / 60)} h`;
}

/* ------------------------------------------------------------------ *
 * 3. Identité des fournisseurs et logos
 * ------------------------------------------------------------------ */
const PROVIDER_LOGOS = {
  openai: 'openai.svg',
  claude: 'claude.ico',
  antigravity: 'antigravity.ico',
  zai: 'zai.svg',
  ollama: 'ollama.png',
  grok: 'grok.svg',
  openrouter: 'openrouter.png',
  deepseek: 'deepseek.ico',
  runinfra: 'runinfra.svg',
};

const hasConnector = provider => Boolean(provider.connector);
const isTracked = provider => Boolean(
  provider.active
  && provider.subscriptionStatus !== 'paused'
  && (provider.subscriptionStatus !== 'expired' || provider.id === 'ollama')
);
const ollamaFree = provider => provider.id === 'ollama' && provider.subscriptionStatus === 'expired';
const subscriptionStatus = provider =>
  provider.subscriptionStatus || (provider.active ? 'active' : 'paused');
const providerById = id => state.providers.find(provider => provider.id === id);

// Logo décoratif si le nom du fournisseur est déjà affiché en texte à côté.
function logo(provider, small = false) {
  if (!provider) return '';
  const file = PROVIDER_LOGOS[provider.id];
  const fallback = escapeHtml(provider.monogram || '?');
  const content = file
    ? `<img src="../assets/providers/${file}" alt="" draggable="false" width="24" height="24">`
    : fallback;
  return `<span class="logo ${small ? 'logo-small' : ''} provider-${escapeHtml(provider.id)}"`
    + ` style="--provider-color:${escapeHtml(provider.color || '#888')}">${content}</span>`;
}

/* ------------------------------------------------------------------ *
 * 4. Niveaux de ressource : couleur + texte + aria
 * ------------------------------------------------------------------ */
function resourceClass(value, unit) {
  if (typeof value !== 'number') return 'resource-unknown';
  return 'resource-' + ResourceLevels.level(value, unit);
}

// Chip de niveau : texte toujours visible (jamais couleur seule), point décoratif
// et title explicitant le seuil. Le texte « Indisponible » est rendu comme les autres.
function levelPill(levelName, unit, extraClass = '') {
  const safeLevel = ['empty', 'critical', 'low', 'healthy', 'unknown'].includes(levelName)
    ? levelName : 'unknown';
  const explicit = {
    empty: 'Ressource épuisée',
    healthy: 'Ressource suffisante',
    unknown: 'Donnée indisponible',
  }[safeLevel];
  const description = explicit || ResourceLevels.describe(safeLevel, unit);
  const classes = ['level-pill', `resource-${safeLevel}`, extraClass].filter(Boolean).join(' ');
  return `<span class="${classes}" title="${escapeHtml(description)}">`
    + `${escapeHtml(ResourceLevels.shortLabel(safeLevel))}</span>`;
}

// Jauge accessible : rendue uniquement pour un pourcentage fiable.
// Élément en ligne (phrasing content) pour rester valide dans un bouton de widget.
function meterMarkup(value, label, { compact = false } = {}) {
  const known = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
  // Une valeur inconnue n'affiche aucune barre : le texte « — » / « Indisponible »
  // reste la seule information, évite les barres fantômes et garde la ligne compacte.
  if (!known) return '';
  const size = compact ? 'meter meter-compact' : 'meter';
  const levelName = ResourceLevels.level(value, '%');
  const description = `${value} % restants · ${ResourceLevels.describe(levelName, '%')}`;
  return `<span class="${size} resource-${levelName}" role="meter"`
    + ` aria-label="${escapeHtml(label)}" aria-valuenow="${value}" aria-valuemin="0" aria-valuemax="100"`
    + ` aria-valuetext="${escapeHtml(description)}"><span style="width:${value}%"></span></span>`;
}

/* ------------------------------------------------------------------ *
 * 5. Thème clair / sombre / système
 * ------------------------------------------------------------------ */
const THEME_STORAGE_KEY = 'lasmium-theme';
const THEME_PREFERENCES = ['light', 'dark', 'system'];
let themePreference = 'light';
let systemThemeQuery = null;

function normalizeThemePreference(value) {
  return THEME_PREFERENCES.includes(value) ? value : 'light';
}

function systemPrefersDark() {
  return Boolean(systemThemeQuery && systemThemeQuery.matches);
}

function resolveTheme(preference) {
  const pref = normalizeThemePreference(preference);
  return pref === 'dark' || (pref === 'system' && systemPrefersDark()) ? 'dark' : 'light';
}

function applyTheme(preference, { persist = true } = {}) {
  themePreference = normalizeThemePreference(preference);
  const resolved = resolveTheme(themePreference);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = themePreference;
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, themePreference); } catch {}
  }
  return resolved;
}

// Le thème « système » doit suivre les changements de Windows en direct.
function watchSystemTheme(callback) {
  if (!window.matchMedia) return;
  systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  systemThemeQuery.addEventListener?.('change', () => {
    if (themePreference !== 'system') return;
    applyTheme('system', { persist: false });
    if (typeof callback === 'function') callback(resolveTheme('system'));
  });
}

/* ------------------------------------------------------------------ *
 * 6. Focus : signature et restauration après rendu
 * ------------------------------------------------------------------ */
const FOCUS_ATTRIBUTES = [
  'data-nav', 'data-filter', 'data-favorite', 'data-open',
  'data-action', 'data-dialog-tab', 'data-provider', 'data-api-provider',
];

function focusSelector(element) {
  if (!element || element === document.body || element === document.documentElement) return null;
  for (const attribute of FOCUS_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value) return `[${attribute}="${CSS.escape(value)}"]`;
  }
  if (element.id) return `#${CSS.escape(element.id)}`;
  const name = element.getAttribute('name');
  if (name) return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
  return null;
}

function captureFocus() {
  const element = document.activeElement;
  const selector = focusSelector(element);
  if (!selector) return null;
  const selection = typeof element.selectionStart === 'number'
    && !['checkbox', 'radio', 'file'].includes(element.type)
    ? { start: element.selectionStart, end: element.selectionEnd }
    : null;
  return { selector, selection };
}

function restoreFocus(token) {
  if (!token) return false;
  const element = document.querySelector(token.selector);
  if (!element || typeof element.focus !== 'function') return false;
  element.focus();
  if (token.selection && typeof element.setSelectionRange === 'function') {
    try { element.setSelectionRange(token.selection.start, token.selection.end); } catch {}
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * 7. Toasts, annonces live et divulgations
 * ------------------------------------------------------------------ */
let toastTimer = null;

function toast(message) {
  const element = document.getElementById('toast');
  if (!element) return;
  element.textContent = message;
  element.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('visible'), 4500);
}

function announce(message) {
  const region = document.getElementById('live-region');
  if (!region) return;
  region.textContent = '';
  requestAnimationFrame(() => { region.textContent = String(message || ''); });
}

const disclosureState = new Map();
document.addEventListener('toggle', event => {
  const panel = event.target;
  if (panel.isConnected && panel.matches('details[data-disclosure]')) {
    disclosureState.set(panel.dataset.disclosure, panel.open);
  }
}, true);
