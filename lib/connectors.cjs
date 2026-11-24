const { connectors } = require('./provider-catalog.cjs');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const MAX_COOLDOWNS = 100;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
// Retry delays (before jitter) for the single read-only retry: ~350 ms then ~800 ms.
const RETRY_DELAYS_MS = [350, 800];
// A server-provided Retry-After is honored but never freezes a sync cycle for long.
const MAX_RETRY_WAIT_MS = 5000;
const MIN_RATE_LIMIT_COOLDOWN_MS = 60000;
const REQUEST_TIMEOUT_MS = 20000;

function createCooldownStore() {
  const entries = new Map();
  return {
    get(fingerprint) {
      const until = entries.get(fingerprint);
      return Number.isFinite(until) ? until : undefined;
    },
    set(fingerprint, untilMs) {
      if (typeof fingerprint !== 'string' || !Number.isFinite(untilMs) || untilMs <= 0) return;
      // Keep insertion order usable as a bounded LRU-ish eviction order.
      entries.delete(fingerprint);
      entries.set(fingerprint, untilMs);
      while (entries.size > MAX_COOLDOWNS) entries.delete(entries.keys().next().value);
    },
    prune(nowMs) {
      for (const [fingerprint, until] of entries) if (!(until > nowMs)) entries.delete(fingerprint);
    },
  };
}
const memoryCooldowns = createCooldownStore();

function rateLimitError(retryAt) {
  return Object.assign(new Error(`Trop de demandes. Nouvelle lecture possible après ${new Date(retryAt).toLocaleTimeString('fr-FR')}.`), { code: 'API_RATE_LIMIT', retryAt });
}
function parseRetryAfter(header, nowMs) {
  if (typeof header !== 'string' || !header.trim()) return null;
  const value = header.trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) return nowMs + Number(value) * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function retryDelay(attempt, random) {
  const base = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
  const jitter = 0.8 + random() * 0.4; // ±20 %
  return Math.min(MAX_RETRY_WAIT_MS, Math.round(base * jitter));
}
function finite(value) {
  if (!['string', 'number'].includes(typeof value) || (typeof value === 'string' && !/^-?\d+(?:\.\d+)?$/.test(value)) || !Number.isFinite(Number(value))) throw new Error('Réponse du fournisseur incomplète ou invalide.');
  return Number(value);
}
function hasTimezone(value) {
  return typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}
function parseResponse(id, body, now = new Date()) {
  const snapshot = { source: 'api', connectorVersion: `${id}-api-v1`, updatedAt: now.toISOString(), quotaRemaining: null, resetAt: null, balances: [] };
  if (id === 'openrouter') {
    const total = finite(body?.data?.total_credits), used = finite(body?.data?.total_usage);
    if (total < 0 || used < 0) throw new Error('Réponse du fournisseur invalide.');
    // A real account can be slightly overdrawn: usage may exceed purchased
    // credits (observed 45 / 45.08283509, i.e. -0.08283509 USD). Keep that
    // exact negative remaining (the UI displays it as "Épuisé"). Only an
    // implausible overdraft is treated as an inconsistent response: more than
    // the purchased amount (minimum 1 USD for tiny/zero accounts) in excess.
    if (used - total > Math.max(total, 1)) throw new Error('Solde OpenRouter incohérent : consommation très supérieure aux crédits disponibles.');
    snapshot.balances = [{ currency: 'USD', remaining: total - used, total, used }];
  } else if (id === 'deepseek') {
    if (!Array.isArray(body?.balance_infos) || !body.balance_infos.length) throw new Error('Aucun solde retourné par DeepSeek.');
    const currencies = new Set();
    snapshot.balances = body.balance_infos.map(b => {
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('Réponse du fournisseur incomplète ou invalide.');
      if (!['USD', 'CNY'].includes(b.currency)) throw new Error('Devise DeepSeek inconnue.');
      if (currencies.has(b.currency)) throw new Error('Soldes DeepSeek ambigus.');
      currencies.add(b.currency);
      const remaining = finite(b.total_balance);
      if (remaining < 0) throw new Error('Solde DeepSeek négatif inattendu.');
      return { currency: b.currency, remaining };
    });
  } else if (id === 'runinfra') {
    const cents = value => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Montant RightNow invalide : un nombre entier de centimes positif est attendu.');
      return value / 100;
    };
    if (body?.object !== 'credits' || body.currency !== 'usd') throw new Error('Format ou devise RightNow inconnu.');
    const balance = cents(body.balance_cents), available = cents(body.available_cents), held = cents(body.held_cents);
    if (available !== Math.max(0, balance)) throw new Error('Soldes RightNow incohérents.');
    // Holds are already accounted for in balance_cents: never subtract them again.
    snapshot.balances = [{ currency: 'USD', remaining: balance }];
    snapshot.details = [
      { label: 'Disponible pour de nouveaux appels', amount: available, currency: 'USD' },
      { label: 'Réservé par les appels en cours (déjà déduit)', amount: held, currency: 'USD' },
    ];
    if (body.period?.spent_cents !== undefined) {
      const spent = cents(body.period.spent_cents);
      snapshot.details.push({ label: 'Dépenses de la période', amount: spent, currency: 'USD' });
    }
    if (body.as_of !== undefined) {
      if (!hasTimezone(body.as_of)) throw new Error('Horodatage RightNow invalide : un fuseau horaire est requis.');
      snapshot.updatedAt = new Date(body.as_of).toISOString();
    }
  } else throw new Error('Connecteur non disponible.');
  return snapshot;
}
async function fetchUsage(id, key, fetcher = fetch, { sleep = delay, now = Date.now, cooldowns = memoryCooldowns, random = Math.random, endpoint } = {}) {
  if (!Object.hasOwn(connectors, id)) throw new Error('Connecteur non disponible.');
  if (connectors[id].mode === 'account') throw new Error('Ce fournisseur nécessite une connexion au compte, pas une clé API.');
  // La plage de caractères de contrôle est volontaire : une clé n'en contient jamais.
  // eslint-disable-next-line no-control-regex
  if (typeof key !== 'string' || !key.trim() || key.length > 4096 || /[\r\n]/.test(key) || /[\x00-\x20\x7f]/.test(key.trim())) throw new Error('Clé invalide.');
  let target = connectors[id].endpoint;
  if (endpoint !== undefined) {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Endpoint de pack invalide.');
      target = url.href;
    } catch { throw new Error('Endpoint de pack invalide : HTTPS sans identifiants requis.'); }
  }
  const fingerprint = `${id}:${createHash('sha256').update(key.trim()).digest('hex')}`;
  const store = cooldowns || memoryCooldowns;
  try { if (typeof store.prune === 'function') store.prune(now()); } catch { /* a persistence hiccup must not break the read */ }
  const blockedUntil = Number(typeof store.get === 'function' ? store.get(fingerprint) : undefined);
  if (Number.isFinite(blockedUntil) && blockedUntil > now()) throw rateLimitError(blockedUntil);
  let response;
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  // Only read-only GETs are retried, twice, within a shared request deadline.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetcher(target, { method: 'GET', headers: { Authorization: `Bearer ${key.trim()}`, Accept: 'application/json' }, redirect: 'error', cache: 'no-store', signal });
    } catch {
      if (attempt < 2 && !signal.aborted) { await sleep(retryDelay(attempt, random)); continue; }
      throw new Error('Connexion impossible ou délai dépassé. Vérifie ton accès Internet et ton proxy Windows.');
    }
    if (attempt < 2 && RETRYABLE_STATUSES.has(response.status)) {
      try { await response.body?.cancel?.(); } catch { /* the body is discarded anyway */ }
      const serverUntil = parseRetryAfter(response.headers?.get?.('retry-after'), now());
      // Honor Retry-After on the retried gateway errors, with a bounded wait.
      const waitMs = serverUntil === null ? retryDelay(attempt, random) : Math.min(MAX_RETRY_WAIT_MS, Math.max(retryDelay(attempt, random), serverUntil - now()));
      await sleep(waitMs);
      continue;
    }
    break;
  }
  if (!response.ok) {
    if (response.status === 401) throw new Error('Clé refusée ou expirée.');
    if (response.status === 403) {
      if (id === 'openrouter') throw new Error('Une clé de gestion OpenRouter (Management key) est nécessaire pour lire le solde du compte.');
      if (id === 'runinfra') throw new Error('Utilise une clé d’espace de travail RightNow : les clés limitées à un déploiement ou endpoint ne peuvent pas lire les crédits.');
      throw new Error('Cette clé ne permet pas de lire le solde.');
    }
    if (response.status === 429) {
      const parsed = parseRetryAfter(response.headers?.get?.('retry-after'), now());
      const until = Math.max(now() + MIN_RATE_LIMIT_COOLDOWN_MS, parsed ?? 0);
      try {
        store.set(fingerprint, until);
        if (typeof store.prune === 'function') store.prune(now());
      } catch { /* keep the actionable rate-limit error even if persistence fails */ }
      throw rateLimitError(until);
    }
    if (response.status === 404) throw new Error('La route de consultation du solde est indisponible chez ce fournisseur. La clé n’a pas été enregistrée ou remplacée.');
    throw new Error(`Fournisseur indisponible (HTTP ${response.status}).`);
  }
  let body;
  try { body = await response.json(); } catch { throw new Error('Réponse illisible du fournisseur.'); }
  return parseResponse(id, body);
}
module.exports = { fetchUsage, parseResponse, createCooldownStore, parseRetryAfter };
