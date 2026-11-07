// Opt-in quota reads. OAuth renewal stays in Claude Code's credential store.
const { createClaudeConnection, readCredentials, CREDENTIAL_PATH, ClaudeError, retryAfter } = require('./claude-connection.cjs');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// Toutes les 5 minutes : une lecture par minute déclenchait des refus (HTTP 429)
// prolongés du service de quotas. Les échecs espacent jusqu'à 25 minutes.
const REFRESH_MS = 5 * 60000;

function parseClaudeLiveUsage(body, now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error('Date du relevé Claude invalide.');
  const window = (data, label) => {
    if (!data || typeof data.utilization !== 'number' || !Number.isFinite(data.utilization) || data.utilization < 0 || data.utilization > 100) {
      throw new Error('Quota Claude incomplet ou invalide. Le dernier relevé est conservé.');
    }
    const reset = data.resets_at;
    if (reset != null && (typeof reset !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(reset) || !Number.isFinite(Date.parse(reset)))) {
      throw new Error('Date de remise à zéro Claude invalide.');
    }
    return { label, remaining: Math.round((100 - data.utilization) * 100) / 100, resetAt: reset ? new Date(reset).toISOString() : null };
  };
  const shared = [window(body?.five_hour, '5 heures'), window(body?.seven_day, 'Semaine')];
  const windows = [...shared];
  // Model-specific limits are additional constraints, not the shared weekly quota.
  for (const [key, name] of [['seven_day_sonnet', 'Sonnet'], ['seven_day_opus', 'Opus']]) {
    if (body[key] != null) windows.push(window(body[key], `${name} · Semaine`));
  }
  if (body.limits != null && !Array.isArray(body.limits)) throw new Error('Limites Claude illisibles.');
  for (const limit of body.limits || []) {
    // Current responses repeat the shared limits and nest model names in scope.
    // is_active marks the currently constraining limit, not whether it exists.
    if (['session', 'weekly_all'].includes(limit?.kind)) {
      const base = shared[limit.kind === 'session' ? 0 : 1];
      const repeated = window({ utilization: limit.percent, resets_at: limit.resets_at }, base.label);
      if (repeated.remaining !== base.remaining || repeated.resetAt !== base.resetAt) throw new Error('Limites Claude contradictoires.');
      continue;
    }
    if (limit?.kind != null && (limit.kind !== 'weekly_scoped' || limit.group !== 'weekly')) throw new Error('Limites Claude illisibles.');
    const name = limit?.display_name ?? limit?.scope?.model?.display_name;
    if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\r\n]/.test(name)) throw new Error('Nom de limite Claude invalide.');
    const label = `${name.trim()} · Semaine`;
    if (windows.some(w => w.label === label)) throw new Error('Limites Claude contradictoires.');
    windows.push(window({ utilization: limit.percent, resets_at: limit.resets_at }, label));
  }
  const tightest = shared.reduce((a, b) => a.remaining <= b.remaining ? a : b);
  return { source: 'api', connectorVersion: 'claude-live-usage-v1', updatedAt: now.toISOString(), balances: [],
    quotaRemaining: tightest.remaining, resetAt: tightest.resetAt, quotaWindows: windows,
    quotaLabel: `Claude · ${tightest.label} · Lecture directe` };
}

async function readLocalConnection(now, credentialPath = CREDENTIAL_PATH) {
  const account = (await readCredentials(credentialPath)).claudeAiOauth;
  if (!Number.isFinite(account.expiresAt) || account.expiresAt <= now.getTime()) throw new ClaudeError('auth-required');
  return account.accessToken;
}

function createClaudeLiveReader({ fetchImpl = globalThis.fetch, readToken, now = () => new Date(), renewWithClaudeCode = null } = {}) {
  const connection = readToken ? null : createClaudeConnection({ fetchImpl, now, renewWithClaudeCode });
  readToken ||= connection.read;
  let work, snapshot, retryAt = 0, lastError, failures = 0;
  async function request(token) {
    try {
      return await fetchImpl(USAGE_URL, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12000),
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Cache-Control': 'no-cache' } });
    } catch { throw new ClaudeError('network'); }
  }
  async function read() {
    if (work) return work;
    if (now().getTime() < retryAt) {
      if (lastError) throw lastError;
      return snapshot;
    }
    work = (async () => {
      try {
        let token = await readToken(now());
        let response = await request(token);
        if (response.status === 401) {
          // An access token can be revoked before its recorded expiry. Renew
          // once, adopting a sibling's newer token instead of rotating it again.
          const replacement = await readToken(now(), { forceRefresh: true, rejectedToken: token });
          if (replacement !== token) response = await request(replacement);
        }
        if (response.status === 429) throw new ClaudeError('rate-limit', retryAfter(response, now().getTime()));
        if ([401, 403].includes(response.status)) throw new ClaudeError('auth-refused');
        if (!response.ok) throw new ClaudeError('service');
        try { snapshot = parseClaudeLiveUsage(await response.json(), now()); }
        catch { throw new ClaudeError('format'); }
        lastError = null; failures = 0;
        retryAt = now().getTime() + REFRESH_MS;
        return snapshot;
      } catch (error) {
        // No transport exception, body or credential value reaches the renderer.
        lastError = error instanceof ClaudeError ? error : new ClaudeError('network');
        failures++;
        const delay = lastError.code.startsWith('auth-') && lastError.code !== 'auth-network' && lastError.code !== 'auth-save' && lastError.code !== 'auth-busy'
          ? 5 * REFRESH_MS : Math.min(5 * REFRESH_MS, REFRESH_MS * 2 ** Math.min(failures - 1, 3));
        retryAt = Math.max(now().getTime() + delay, lastError.retryAt || 0);
        lastError.retryAt = retryAt;
        throw lastError;
      }
    })();
    try { return await work; } finally { work = null; }
  }
  function info() { return { nextAttemptAt: retryAt ? new Date(retryAt).toISOString() : null, errorCode: lastError?.code || null }; }
  function restore(value) {
    // Persist only failure cooldowns. Cached successes have no in-memory
    // snapshot after restart and must be measured again.
    if (value?.errorCode && Number.isFinite(Date.parse(value.nextAttemptAt)) && Date.parse(value.nextAttemptAt) > now().getTime()) {
      retryAt = Date.parse(value.nextAttemptAt);
      lastError = new ClaudeError(value.errorCode, retryAt);
    }
  }
  function credentialsChanged() {
    if (lastError?.code.startsWith('auth-') && !work) { lastError = null; retryAt = 0; failures = 0; }
  }
  function wake() {
    // Un 429 d'usage comme un 429 de renouvellement porte un Retry-After :
    // le réveil de veille ne doit pas le contourner.
    const coolingDown = lastError?.code === 'rate-limit' || lastError?.code === 'auth-rate-limit';
    if (!coolingDown && !work && (!snapshot || now().getTime() - Date.parse(snapshot.updatedAt) >= REFRESH_MS)) retryAt = 0;
  }
  function clear() { snapshot = null; retryAt = 0; lastError = null; failures = 0; connection?.clear(); }
  return { read, clear, info, restore, credentialsChanged, wake };
}

const defaultReader = createClaudeLiveReader();
module.exports = { USAGE_URL, REFRESH_MS, parseClaudeLiveUsage, readLocalConnection, createClaudeLiveReader,
  readClaudeLiveUsage: defaultReader.read, clearClaudeLiveUsage: defaultReader.clear,
  claudeLiveStatus: defaultReader.info, restoreClaudeLiveStatus: defaultReader.restore,
  claudeCredentialsChanged: defaultReader.credentialsChanged, wakeClaudeLiveUsage: defaultReader.wake };
