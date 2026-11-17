'use strict';

// Contrat commun des connecteurs : validation des relevés, classification des
// erreurs et santé. Module pur (aucune dépendance Electron) pour être testé
// sous `node --test` et partagé par main.cjs, les scripts et le renderer.

const ERROR_CODES = Object.freeze({
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  AUTH_RATE_LIMITED: 'AUTH_RATE_LIMITED',
  RATE_LIMITED: 'RATE_LIMITED',
  NETWORK: 'NETWORK',
  TIMEOUT: 'TIMEOUT',
  UPSTREAM: 'UPSTREAM',
  SCHEMA_DRIFT: 'SCHEMA_DRIFT',
  PARSER_EMPTY: 'PARSER_EMPTY',
  CONFLICT: 'CONFLICT',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  UNKNOWN: 'UNKNOWN',
});

const STATE_BY_CODE = Object.freeze({
  [ERROR_CODES.AUTH_REQUIRED]: 'auth',
  [ERROR_CODES.AUTH_EXPIRED]: 'auth',
  [ERROR_CODES.AUTH_RATE_LIMITED]: 'auth',
  [ERROR_CODES.RATE_LIMITED]: 'rate',
  [ERROR_CODES.NETWORK]: 'down',
  [ERROR_CODES.TIMEOUT]: 'down',
  [ERROR_CODES.UPSTREAM]: 'down',
  [ERROR_CODES.SCHEMA_DRIFT]: 'drift',
  [ERROR_CODES.PARSER_EMPTY]: 'drift',
  [ERROR_CODES.CONFLICT]: 'drift',
  [ERROR_CODES.NOT_CONFIGURED]: 'idle',
  [ERROR_CODES.UNKNOWN]: 'error',
});

const MAX_ERROR_MESSAGE = 240;
const STALE_AFTER_MS = 10 * 60 * 1000;

class ConnectorError extends Error {
  constructor(code, message, { cause, retryAt = null, details = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ConnectorError';
    this.code = code;
    this.retryAt = retryAt;
    this.details = details;
  }
}

function isoDate(value) {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isCurrency(value) {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
}

function normalizeCode(error) {
  const raw = typeof error?.code === 'string' ? error.code.trim() : '';
  const lower = raw.toLowerCase();
  if (lower === 'schema_drift' || lower === 'parser_error' || lower === 'conflict') {
    return lower === 'conflict' ? ERROR_CODES.CONFLICT : ERROR_CODES.SCHEMA_DRIFT;
  }
  if (lower === 'auth-rate-limit' || lower === 'auth_rate_limit') return ERROR_CODES.AUTH_RATE_LIMITED;
  if (lower === 'api_rate_limit' || lower === 'rate-limit' || lower === 'rate_limited'
    || lower === 'ollama_rate_limit') return ERROR_CODES.RATE_LIMITED;
  if (lower === 'ollama_signin' || lower === 'account_login_pending'
    || lower === 'auth-required' || lower === 'auth-invalid' || lower === 'auth-expired'
    || lower === 'auth_required' || lower === 'auth_invalid') return ERROR_CODES.AUTH_REQUIRED;
  if (lower === 'ollama_transient') return ERROR_CODES.UPSTREAM;
  if (lower === 'timeout' || lower === 'etimedout' || lower === 'account_timeout') return ERROR_CODES.TIMEOUT;
  if (lower === 'network' || lower === 'enotfound' || lower === 'econnreset' || lower === 'econnrefused') return ERROR_CODES.NETWORK;
  if (lower.includes('rate') && lower.includes('limit')) return ERROR_CODES.RATE_LIMITED;
  if (lower.startsWith('auth')) return ERROR_CODES.AUTH_REQUIRED;
  if (lower.includes('drift') || lower.includes('schema') || lower.includes('parser')) return ERROR_CODES.SCHEMA_DRIFT;

  const message = String(error?.message || '');
  if (/aucun .*retourn|aucun quota|page .*introuvable|relevé .*vide|aucune donnée|interface .*modifi/i.test(message)) {
    return ERROR_CODES.PARSER_EMPTY;
  }
  if (/trop de demandes|rate.?limit|\b429\b/i.test(message)) return ERROR_CODES.RATE_LIMITED;
  if (/format|schéma|schema|incomplète|invalide|incohérent|ambigu|contradictoire|illisible/i.test(message)) {
    return ERROR_CODES.SCHEMA_DRIFT;
  }
  if (/fetch failed|network|internet|réseau|ENOTFOUND|ECONN|ETIMEDOUT|socket/i.test(message)) return ERROR_CODES.NETWORK;
  if (/\b401\b|\b403\b|session|jeton|token|clé enregistrée|reconnect/i.test(message)) return ERROR_CODES.AUTH_REQUIRED;
  return ERROR_CODES.UNKNOWN;
}

function stateForCode(code) {
  return STATE_BY_CODE[code] || 'error';
}

function validateSnapshot(providerId, snapshot, now = Date.now()) {
  const issues = [];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return { ok: false, issues: ['relevé absent'] };
  }
  const observed = Date.parse(snapshot.updatedAt);
  if (!Number.isFinite(observed)) issues.push('date de relevé absente');
  else if (observed > now + 5 * 60 * 1000) issues.push('date de relevé dans le futur');

  const balances = snapshot.balances;
  if (balances !== undefined && balances !== null) {
    if (!Array.isArray(balances)) issues.push('soldes non tabulaires');
    else {
      const currencies = new Set();
      for (const balance of balances) {
        if (!balance || typeof balance !== 'object' || Array.isArray(balance)) {
          issues.push('solde mal formé');
          continue;
        }
        if (!isFiniteNumber(balance.remaining)) issues.push('montant de solde invalide');
        if (!isCurrency(balance.currency)) issues.push('devise de solde invalide');
        else if (currencies.has(balance.currency)) issues.push(`devise ${balance.currency} en double`);
        else currencies.add(balance.currency);
        if (balance.total !== undefined && !isFiniteNumber(balance.total)) issues.push('total de solde invalide');
        if (balance.used !== undefined && !isFiniteNumber(balance.used)) issues.push('consommation de solde invalide');
      }
    }
  }

  if (snapshot.quotaRemaining !== undefined && snapshot.quotaRemaining !== null
    && (!isFiniteNumber(snapshot.quotaRemaining) || snapshot.quotaRemaining < 0 || snapshot.quotaRemaining > 100)) {
    issues.push('quota restant hors de 0–100');
  }

  if (snapshot.quotaWindows !== undefined && snapshot.quotaWindows !== null) {
    if (!Array.isArray(snapshot.quotaWindows)) issues.push('fenêtres de quota non tabulaires');
    else {
      for (const window of snapshot.quotaWindows) {
        if (!window || typeof window !== 'object' || Array.isArray(window)) {
          issues.push('fenêtre de quota mal formée');
          continue;
        }
        if (typeof window.label !== 'string' || !window.label.trim()) issues.push('libellé de quota absent');
        if (!isFiniteNumber(window.remaining) || window.remaining < 0 || window.remaining > 100) {
          issues.push('quota de fenêtre hors de 0–100');
        }
        if (window.resetAt !== undefined && window.resetAt !== null && !isoDate(window.resetAt)) {
          issues.push('date de remise à zéro invalide');
        }
      }
    }
  }

  if (snapshot.usageCredits !== undefined && snapshot.usageCredits !== null) {
    if (typeof snapshot.usageCredits !== 'object' || Array.isArray(snapshot.usageCredits)
      || !isFiniteNumber(snapshot.usageCredits.remaining) || !isCurrency(snapshot.usageCredits.currency)) {
      issues.push('réserve de crédits invalide');
    }
  }

  if (snapshot.details !== undefined && snapshot.details !== null) {
    if (!Array.isArray(snapshot.details)) issues.push('détails non tabulaires');
    else {
      for (const detail of snapshot.details) {
        if (!detail || typeof detail !== 'object' || typeof detail.label !== 'string'
          || !isFiniteNumber(detail.amount) || !isCurrency(detail.currency)) {
          issues.push('détail de solde invalide');
        }
      }
    }
  }

  if (snapshot.resetAt !== undefined && snapshot.resetAt !== null && !isoDate(snapshot.resetAt)) {
    issues.push('date de remise à zéro invalide');
  }

  const hasBalances = Array.isArray(balances) && balances.length > 0;
  const hasWindows = Array.isArray(snapshot.quotaWindows) && snapshot.quotaWindows.length > 0;
  const hasQuota = isFiniteNumber(snapshot.quotaRemaining);
  const hasCredits = snapshot.usageCredits && isFiniteNumber(snapshot.usageCredits.remaining);
  const hasDetails = Array.isArray(snapshot.details) && snapshot.details.length > 0;
  // Une session Ollama Free peut être valide sans montant détaillé : le site ne
  // publie pas toujours la limite. On ne la traite donc pas comme vide.
  const freeTier = snapshot.planTier === 'free';
  if (!hasBalances && !hasWindows && !hasQuota && !hasCredits && !hasDetails && !freeTier) {
    issues.push('relevé sans donnée exploitable');
  }

  return { ok: issues.length === 0, issues: [...new Set(issues)] };
}

function assertSnapshot(providerId, snapshot, now = Date.now()) {
  const result = validateSnapshot(providerId, snapshot, now);
  if (result.ok) return snapshot;
  throw new ConnectorError(
    ERROR_CODES.SCHEMA_DRIFT,
    `Lecture incohérente (${result.issues.slice(0, 3).join(' ; ')}). Le dernier relevé est conservé.`,
    { details: { providerId, issues: result.issues } },
  );
}

function strategyFor(provider, catalog = {}) {
  const id = provider?.id;
  if (id === 'claude') {
    return provider?.accountSession?.kind === 'claude-live-local' ? 'claude-direct' : 'claude-desktop';
  }
  if (id === 'openai') return 'openai-codex';
  if (id === 'antigravity') return 'antigravity-local';
  if (id === 'ollama') return 'ollama-browser';
  const descriptor = catalog[id] || {};
  if (descriptor.browserAccount) return 'browser-session';
  if (descriptor.mode === 'account') return 'account-session';
  return 'api-key';
}

function errorToHealth(error) {
  const code = normalizeCode(error);
  const retryAt = error?.retryAt === undefined || error?.retryAt === null ? null : isoDate(error.retryAt);
  return {
    code,
    state: stateForCode(code),
    message: String(error?.message || 'Erreur inconnue.').slice(0, MAX_ERROR_MESSAGE),
    retryAt,
    sourceCode: typeof error?.code === 'string' ? error.code.slice(0, 80) : null,
  };
}

function healthSuccess(previous, { providerId, strategy, snapshot, now = Date.now() } = {}) {
  const timestamp = new Date(now).toISOString();
  return {
    providerId,
    strategy: strategy || previous?.strategy || 'unknown',
    state: 'ok',
    lastSuccessAt: timestamp,
    lastAttemptAt: timestamp,
    lastFailureAt: previous?.lastFailureAt || null,
    observedAt: isoDate(snapshot?.updatedAt),
    parserVersion: typeof snapshot?.connectorVersion === 'string' ? snapshot.connectorVersion : null,
    warnings: Array.isArray(snapshot?.warnings) ? snapshot.warnings.slice(0, 5) : [],
    failures: 0,
    error: null,
  };
}

const RETRY_BASE_MS = 30 * 1000;
const MAX_RETRY_MS = 30 * 60 * 1000;
function retryDelayFor(code, failures, now) {
  if (code === ERROR_CODES.AUTH_REQUIRED || code === ERROR_CODES.AUTH_EXPIRED || code === ERROR_CODES.AUTH_RATE_LIMITED) {
    return null;
  }
  if (code === ERROR_CODES.SCHEMA_DRIFT || code === ERROR_CODES.PARSER_EMPTY || code === ERROR_CODES.CONFLICT) {
    return now + 15 * 60 * 1000;
  }
  if (code === ERROR_CODES.RATE_LIMITED) {
    return now + Math.min(MAX_RETRY_MS, 60 * 1000 * 2 ** Math.max(0, failures - 1));
  }
  if (code === ERROR_CODES.UNKNOWN) return now + 5 * 60 * 1000;
  return now + Math.min(MAX_RETRY_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
}

function healthFailure(previous, { providerId, strategy, error, now = Date.now() } = {}) {
  const timestamp = new Date(now).toISOString();
  const failure = errorToHealth(error);
  const failures = Math.max(0, Number(previous?.failures) || 0) + 1;
  const retryAt = failure.retryAt
    ? failure.retryAt
    : (() => {
      const until = retryDelayFor(failure.code, failures, now);
      return until === null ? null : new Date(until).toISOString();
    })();
  return {
    providerId,
    strategy: previous?.strategy || strategy || 'unknown',
    state: failure.state,
    lastSuccessAt: previous?.lastSuccessAt || null,
    lastAttemptAt: timestamp,
    lastFailureAt: timestamp,
    observedAt: previous?.observedAt || null,
    parserVersion: previous?.parserVersion || null,
    warnings: previous?.warnings || [],
    failures,
    error: {
      code: failure.code,
      message: failure.message,
      retryAt,
      sourceCode: failure.sourceCode,
    },
  };
}

// Un disjoncteur simple, dérivé de la santé persistée : les erreurs
// transitoires espacent les tentatives (30 s → 30 min) au lieu de marteler le
// fournisseur. Les erreurs d'authentification restent immédiatement
// actionnables et ne sont jamais bloquées par ce mécanisme.
function breakerOpen(health, now = Date.now()) {
  if (!health || !health.error) return false;
  if (!['rate', 'down', 'drift', 'error'].includes(health.state)) return false;
  const until = Date.parse(health.error.retryAt);
  return Number.isFinite(until) && until > now;
}

function retryAtFor(health) {
  const until = Date.parse(health?.error?.retryAt);
  return Number.isFinite(until) ? new Date(until).toISOString() : null;
}

const STRATEGY_CHAINS = Object.freeze({
  claude: ['claude-direct', 'claude-desktop'],
  openai: ['openai-codex'],
  antigravity: ['antigravity-local'],
  ollama: ['ollama-browser'],
  browser: ['browser-session'],
  api: ['api-key'],
});

function strategyChainFor(provider, catalog = {}) {
  const id = provider?.id;
  if (STRATEGY_CHAINS[id]) return STRATEGY_CHAINS[id];
  const descriptor = catalog[id] || {};
  if (descriptor.browserAccount) return STRATEGY_CHAINS.browser;
  if (descriptor.mode === 'account') return ['account-session'];
  return STRATEGY_CHAINS.api;
}

function fallbackStrategyFor(provider, failedStrategy, catalog = {}) {
  const chain = strategyChainFor(provider, catalog);
  const index = chain.indexOf(failedStrategy);
  return index >= 0 ? chain[index + 1] || null : chain[0] || null;
}

function isStale(health, snapshot, now = Date.now()) {
  const observed = Date.parse(snapshot?.updatedAt);
  if (Number.isFinite(observed)) return now - observed > STALE_AFTER_MS;
  const lastSuccess = Date.parse(health?.lastSuccessAt);
  return !Number.isFinite(lastSuccess) || now - lastSuccess > STALE_AFTER_MS;
}

function publicHealth(health, snapshot, now = Date.now()) {
  if (!health || typeof health !== 'object') return null;
  const stale = isStale(health, snapshot, now);
  return {
    ...health,
    stale,
    state: health.state === 'ok' && stale ? 'stale' : health.state,
    error: health.error ? { ...health.error } : null,
  };
}

module.exports = {
  ERROR_CODES,
  STATE_BY_CODE,
  STALE_AFTER_MS,
  ConnectorError,
  normalizeCode,
  stateForCode,
  validateSnapshot,
  assertSnapshot,
  strategyFor,
  strategyChainFor,
  fallbackStrategyFor,
  healthSuccess,
  healthFailure,
  breakerOpen,
  retryAtFor,
  isStale,
  publicHealth,
};
