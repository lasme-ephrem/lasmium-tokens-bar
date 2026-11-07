// Claude Code owns this connection. Renew it in place using its OAuth protocol
// and both of its refresh locks; never copy credentials into Lasmium TOKENS-HUB data.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const lockfile = require('proper-lockfile');

const CREDENTIAL_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const EXPIRY_MARGIN_MS = 5 * 60000;
// Un message dit ce qui se passe et la seule action utile. Deux familles :
// « Reconnexion nécessaire » (bouton Connecter Claude) et « attente » (rien à
// faire, nouvel essai automatique, dernières valeurs affichées).
const RECONNECT = 'Clique sur « Connecter Claude » pour te reconnecter avec ton abonnement.';
const WAIT = 'Dernières valeurs affichées ; nouvel essai automatique.';
const messages = {
  'auth-required': `Connexion Claude expirée. ${RECONNECT}`,
  'auth-unavailable': `Claude n’est pas connecté sur ce PC. ${RECONNECT}`,
  'auth-refused': `Connexion Claude refusée par Anthropic. ${RECONNECT}`,
  'not-subscription': `Claude Code n’est pas connecté à un abonnement Claude (Pro ou Max). ${RECONNECT}`,
  'login-failed': 'La connexion à Claude n’a pas abouti. Clique de nouveau sur « Connecter Claude » et termine la connexion dans ton navigateur.',
  'login-timeout': 'Connexion à Claude non terminée après 5 minutes. Clique de nouveau sur « Connecter Claude ».',
  'cli-missing': 'Claude Code n’est pas installé sur ce PC. Installe-le depuis claude.com/claude-code, puis clique sur « Connecter Claude ».',
  'cli-failed': 'Claude Code ne répond pas. Vérifie son installation, puis clique sur « Connecter Claude ».',
  'auth-busy': `Connexion Claude en cours de renouvellement par Claude Code. ${WAIT}`,
  'auth-save': `Connexion Claude renouvelée mais non enregistrée sur ce PC. ${WAIT}`,
  'auth-network': `Renouvellement de la connexion Claude impossible pour le moment (réseau). ${WAIT}`,
  'auth-rate-limit': `Anthropic limite temporairement le renouvellement de la connexion Claude. ${WAIT}`,
  'network': `Lecture des quotas Claude impossible (réseau). ${WAIT}`,
  'service': `Le service de quotas Claude est indisponible. ${WAIT}`,
  'rate-limit': `Anthropic limite temporairement la lecture des quotas Claude. ${WAIT}`,
  'format': `Réponse de quotas Claude incomplète. ${WAIT}`,
};
// Codes qui demandent une action de l'utilisateur (bouton « Connecter Claude »).
const RECONNECT_CODES = new Set(['auth-required', 'auth-unavailable', 'auth-refused', 'not-subscription', 'login-failed', 'login-timeout', 'cli-missing', 'cli-failed']);
class ClaudeError extends Error {
  constructor(code, retryAt = null) { super(messages[code] || messages.network); this.code = Object.hasOwn(messages, code) ? code : 'network'; this.retryAt = retryAt; }
}
function retryAfter(response, time, minimum = 300000) {
  const value = response.headers?.get('retry-after');
  const duration = value && /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - time;
  const deadline = time + Math.max(minimum, Number.isFinite(duration) ? duration : 0);
  return Number.isFinite(new Date(deadline).getTime()) ? deadline : time + minimum;
}
const validToken = value => typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[\r\n]/.test(value);
const usable = (account, time, margin = 0) => validToken(account?.accessToken) && Number.isFinite(account.expiresAt) && account.expiresAt > time + margin;

async function readCredentials(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 65536) throw new Error();
    const document = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!validToken(document?.claudeAiOauth?.accessToken)) throw new Error();
    return document;
  } catch { throw new ClaudeError('auth-unavailable'); }
}

// Same mkdir locks, heartbeat and stale threshold as Claude Code 2.1.285.
// Taking the legacy lock also coordinates older installed CLI processes.
async function acquireRefreshLock(dir) {
  const controller = new AbortController();
  const options = { realpath: false, stale: 60000, update: 5000,
    retries: { retries: 4, minTimeout: 500, maxTimeout: 1000 }, onCompromised: () => controller.abort() };
  const releases = [];
  try {
    releases.push(await lockfile.lock(dir, { ...options, lockfilePath: path.join(dir, '.oauth_refresh.lock') }));
    const legacy = dir + '.lock';
    releases.push(await lockfile.lock(legacy, { ...options, lockfilePath: legacy }));
  } catch {
    for (const release of releases.reverse()) await release().catch(() => {});
    throw new ClaudeError('auth-busy');
  }
  return { signal: controller.signal, release: async () => {
    for (const release of releases.reverse()) await release().catch(() => {});
  } };
}

async function atomicCredentials(file, document) {
  const temp = file + '.lasmium-' + randomUUID() + '.tmp';
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(document)); await handle.sync(); }
    finally { await handle.close(); }
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, file); break; }
      catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 2) throw error;
        await delay(100 * (attempt + 1));
      }
    }
  } catch { throw new ClaudeError('auth-save'); }
  finally { await fs.unlink(temp).catch(() => {}); }
}

// Renouvellement délégué à Claude Code : Anthropic refuse durablement (HTTP 429)
// le renouvellement fait par une autre application, alors que Claude Code
// renouvelle sa propre connexion à son démarrage. Au plus un lancement par
// quart d'heure ; le renouvellement direct reste le recours.
const DELEGATE_RETRY_MS = 15 * 60000;

function createClaudeConnection({ credentialPath = CREDENTIAL_PATH, fetchImpl = globalThis.fetch,
  now = () => new Date(), acquireLock = acquireRefreshLock, writeCredentials = atomicCredentials,
  renewWithClaudeCode = null } = {}) {
  let work, pending, deadRefreshToken, delegateRetryAt = 0;
  // Lance Claude Code (hors verrou : il prend lui-même le verrou de
  // renouvellement) puis relit sa connexion. Renvoie le jeton s'il est neuf.
  async function delegate(time, rejectedToken) {
    if (!renewWithClaudeCode || pending || time.getTime() < delegateRetryAt) return null;
    delegateRetryAt = time.getTime() + DELEGATE_RETRY_MS;
    try { await renewWithClaudeCode(); } catch { return null; }
    const account = await readCredentials(credentialPath).then(document => document.claudeAiOauth).catch(() => null);
    if (!account || !usable(account, now().getTime()) || (rejectedToken && account.accessToken === rejectedToken)) return null;
    delegateRetryAt = 0;
    return account.accessToken;
  }
  async function savePending(file, signal) {
    const document = await readCredentials(file);
    const account = document.claudeAiOauth;
    // A login, logout or sibling refresh wins over our older request.
    if (account.accessToken !== pending.oldAccess || account.refreshToken !== pending.oldRefresh) {
      pending = null;
      if (!usable(account, now().getTime())) throw new ClaudeError('auth-unavailable');
      return account.accessToken;
    }
    if (signal.aborted) throw new ClaudeError('auth-busy');
    try { await writeCredentials(file, { ...document, claudeAiOauth: { ...account, ...pending.tokens } }); }
    catch { throw new ClaudeError('auth-save'); }
    const token = pending.tokens.accessToken;
    pending = null;
    return token;
  }
  async function renew(expectedToken, force) {
    const dir = await fs.realpath(path.dirname(credentialPath)).catch(() => { throw new ClaudeError('auth-unavailable'); });
    const file = path.join(dir, path.basename(credentialPath));
    const lock = await acquireLock(dir);
    try {
      if (pending) return await savePending(file, lock.signal);
      const account = (await readCredentials(file)).claudeAiOauth;
      const time = now().getTime();
      if (usable(account, time) && ((expectedToken && account.accessToken !== expectedToken) || (!force && usable(account, time, EXPIRY_MARGIN_MS)))) return account.accessToken;
      if (!validToken(account.refreshToken) || account.refreshToken === deadRefreshToken) throw new ClaudeError('auth-required');
      if (account.clientId != null && (typeof account.clientId !== 'string' || !/^[a-f0-9-]{36}$/i.test(account.clientId))) throw new ClaudeError('auth-required');
      if (!Array.isArray(account.scopes) || !account.scopes.length || account.scopes.some(s => typeof s !== 'string' || !/^[a-zA-Z0-9:_-]{1,120}$/.test(s))) throw new ClaudeError('auth-required');
      if (lock.signal.aborted) throw new ClaudeError('auth-busy');
      let response;
      try {
        response = await fetchImpl(TOKEN_URL, { method: 'POST', redirect: 'error',
          signal: AbortSignal.any([lock.signal, AbortSignal.timeout(20000)]),
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token',
            refresh_token: account.refreshToken, client_id: account.clientId || CLIENT_ID, scope: account.scopes.join(' ') }) });
      } catch { throw new ClaudeError('auth-network'); }
      // A 429 here throttles the OAuth refresh endpoint, not the usage read:
      // keep a distinct code (and its Retry-After) instead of a misleading
      // usage rate limit.
      if (response.status === 429) throw new ClaudeError('auth-rate-limit', retryAfter(response, now().getTime()));
      if ([400, 401].includes(response.status)) {
        deadRefreshToken = account.refreshToken;
        throw new ClaudeError('auth-required');
      }
      if (!response.ok) throw new ClaudeError('auth-network');
      let body;
      try { body = await response.json(); } catch { throw new ClaudeError('auth-network'); }
      if (!validToken(body?.access_token) || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || body.expires_in > 366 * 86400 ||
        (body.refresh_token != null && !validToken(body.refresh_token)) || (body.scope != null && typeof body.scope !== 'string')) throw new ClaudeError('auth-network');
      const tokens = { accessToken: body.access_token, refreshToken: body.refresh_token ?? account.refreshToken,
        expiresAt: now().getTime() + body.expires_in * 1000 };
      if (body.scope != null) tokens.scopes = body.scope.trim().split(/\s+/);
      if (Number.isFinite(body.refresh_token_expires_in) && body.refresh_token_expires_in > 0) tokens.refreshTokenExpiresAt = now().getTime() + body.refresh_token_expires_in * 1000;
      // Keep a rotated response in memory if Windows temporarily denies the save.
      // The next attempt saves it under the lock before posting another refresh.
      pending = { oldAccess: account.accessToken, oldRefresh: account.refreshToken, tokens };
      return await savePending(file, lock.signal);
    } finally { await lock.release(); }
  }
  async function read(time = now(), { forceRefresh = false, rejectedToken } = {}) {
    if (work) return work;
    const account = (await readCredentials(credentialPath)).claudeAiOauth;
    if (!pending && !forceRefresh && usable(account, time.getTime(), EXPIRY_MARGIN_MS)) return account.accessToken;
    // A connection without renewal rights may still be used until its expiry.
    if (!pending && !forceRefresh && !validToken(account.refreshToken) && usable(account, time.getTime())) return account.accessToken;
    if (work) return work;
    work = (async () => (await delegate(time, forceRefresh ? (rejectedToken || account.accessToken) : null))
      ?? renew(rejectedToken || account.accessToken, forceRefresh))();
    try { return await work; }
    catch (error) { throw error instanceof ClaudeError ? error : new ClaudeError('auth-network'); }
    finally { work = null; }
  }
  function clear() { pending = null; deadRefreshToken = null; }
  return { read, clear };
}

module.exports = { CREDENTIAL_PATH, TOKEN_URL, CLIENT_ID, EXPIRY_MARGIN_MS, DELEGATE_RETRY_MS, ClaudeError, RECONNECT_CODES, retryAfter,
  readCredentials, acquireRefreshLock, createClaudeConnection };
