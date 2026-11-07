const OLLAMA_ORIGIN = 'https://ollama.com';
const SETTINGS_URL = OLLAMA_ORIGIN + '/settings';
// Depuis novembre 2026, le solde des crédits d'usage et l'usage inclus
// (Free, Pro…) sont affichés sur le tableau de bord, avec des identifiants
// stables ; /settings ne montre plus que les coûts et les requêtes.
const DASHBOARD_URL = OLLAMA_ORIGIN + '/dashboard';
const MIN_RATE_LIMIT_COOLDOWN_MS = 60000;
let rateLimitedUntil = 0;
function signInError() { return Object.assign(new Error('Session Ollama absente ou expirée. Ouvre le compte Ollama et reconnecte-toi.'), { code: 'OLLAMA_SIGNIN' }); }
function rateLimitError(retryAt) {
  return Object.assign(new Error(`Trop de demandes Ollama. Nouvelle lecture possible après ${new Date(retryAt).toLocaleTimeString('fr-FR')}.`), { code: 'OLLAMA_RATE_LIMIT', retryAt });
}
function retryAfterUntil(response, nowMs) {
  const header = response.headers?.get?.('retry-after');
  let parsed = null;
  if (typeof header === 'string' && header.trim()) {
    const value = header.trim();
    parsed = /^\d+(?:\.\d+)?$/.test(value) ? nowMs + Number(value) * 1000 : Date.parse(value);
  }
  return Math.max(nowMs + MIN_RATE_LIMIT_COOLDOWN_MS, Number.isFinite(parsed) ? parsed : 0);
}
function resetOllamaRateLimit() { rateLimitedUntil = 0; }

// Page de connexion, en anglais comme en français (le site suit la langue).
const SIGN_IN_PATTERN = /\b(?:sign in|log in|continue with (?:google|email|github)|verify your email|se connecter|continuer avec (?:google|github|l['’]e-mail))\b/i;

const plainText = html => String(html).replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
  .replace(/&#36;|&#x24;/gi, '$').replace(/&#x27;|&#39;/gi, "'").replace(/\s+/g, ' ').trim();
function byId(html, id) {
  const match = String(html).match(new RegExp(`<([a-z0-9]+)\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)</\\1>`, 'i'));
  return match ? plainText(match[2]) : null;
}

// Tableau de bord Ollama (2026-11) : `#extra-usage-balance` (crédits d'usage),
// `#dashboard-plan` (« Pay as you go », « Pro »…), `#dashboard-included`
// (« 100% left » sous « Free usage », « Pro usage »…). Renvoie null si ces
// repères sont absents (ancienne page) ; jamais un montant deviné.
const PLAN_TIERS = { free: 'free', pro: 'pro', max: 'max', team: 'team' };
function parseOllamaDashboard(html, now = new Date()) {
  if (typeof html !== 'string') return null;
  const safe = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const balanceText = byId(safe, 'extra-usage-balance');
  const includedText = byId(safe, 'dashboard-included');
  if (balanceText === null && includedText === null) {
    if (SIGN_IN_PATTERN.test(plainText(safe))) throw signInError();
    return null;
  }
  let usageCredits = null;
  if (balanceText !== null) {
    const amount = balanceText.match(/^\$\s*((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?)$/);
    if (!amount) throw new Error('Solde des crédits d’usage Ollama illisible.');
    usageCredits = { currency: 'USD', remaining: Number(amount[1].replaceAll(',', '')) };
  }
  let quotaRemaining = null;
  let planTier = null;
  if (includedText !== null) {
    const meter = includedText.match(/^(\d{1,3}(?:\.\d+)?)\s*%\s*(left|used|remaining)$/i);
    if (!meter || Number(meter[1]) > 100) throw new Error('Usage inclus Ollama illisible.');
    const value = Number(meter[1]);
    quotaRemaining = meter[2].toLowerCase() === 'used' ? Math.round((100 - value) * 100) / 100 : value;
    // Libellé juste avant la jauge : « Free usage », « Pro usage »…
    const before = plainText(safe.slice(0, safe.search(/\bid=["']dashboard-included["']/i)));
    const label = before.match(/\b(Free|Pro|Max|Team)\s+usage$/i);
    if (label) planTier = PLAN_TIERS[label[1].toLowerCase()];
  }
  const badge = (byId(safe, 'dashboard-plan') || '').toLowerCase();
  // Forfait inconnu si la page n'affiche ni jauge nommée ni badge (rien deviné).
  if (!planTier && badge) planTier = PLAN_TIERS[badge] || (badge === 'pay as you go' ? 'free' : 'paid');
  const free = planTier === 'free';
  return { source: 'api', connectorVersion: 'ollama-monthly-credits-v1', updatedAt: now.toISOString(), planTier,
    balanceLabel: free ? 'Usage Free restant' : 'Usage inclus restant', balances: [], usageCredits,
    quotaRemaining, resetAt: null, details: [] };
}

function usageCredits(safe) {
  const start = safe.search(/Usage credits/i);
  if (start < 0) return null;
  const tail = safe.slice(start, start + 6000);
  const boundary = tail.slice('Usage credits'.length).search(/Billing history|Payment methods|Invoices|Subscription settings/i);
  const section = boundary < 0 ? tail : tail.slice(0, 'Usage credits'.length + boundary);
  const plain = section.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;|&#xA0;/gi, ' ').replace(/&#36;|&#x24;/gi, '$').replace(/\s+/g, ' ');
  const amount = '((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\.[0-9]+)?)';
  const matches = [
    ...plain.matchAll(new RegExp('\\$' + amount + '\\s+Current balance\\b', 'gi')),
    ...plain.matchAll(new RegExp('\\bCurrent balance\\s+\\$' + amount, 'gi')),
  ];
  // The current settings header displays the purchased balance immediately
  // after its plan badge, without the former "Current balance" caption. Keep
  // the match before the add-funds controls; model spend and top-up presets
  // further down the screen are unrelated to the remaining balance. The new
  // portal uses a "Pay as you go" badge instead of Free/Pro/Max/Team.
  if (!matches.length) {
    const header = plain.match(new RegExp('^\\s*Usage credits\\s+(?:Free|Pro|Max|Team|Pay as you go)\\s+\\$' + amount + '\\s+(?:Add usage credits to pay as you go|Add funds|Auto-reload)\\b', 'i'));
    if (header) matches.push(header);
  }
  if (matches.length !== 1) return null;
  const remaining = Number(matches[0][1].replaceAll(',', ''));
  return Number.isFinite(remaining) && remaining >= 0 ? { currency: 'USD', remaining } : null;
}
// New portal layout: the Free plan is shown as "Free usage <N>% used" under
// "Usage breakdown". Take the last occurrence (the actual meter), never a
// model list sentence that happens to contain "free usage".
function freeUsageQuota(plainPage) {
  const occurrences = [...plainPage.matchAll(/\bFree usage\b/gi)];
  for (let index = occurrences.length - 1; index >= 0; index--) {
    const segment = plainPage.slice(occurrences[index].index, occurrences[index].index + 160);
    const match = segment.match(/^Free usage\b[^%]{0,80}?(\d{1,3}(?:\.\d+)?)\s*%\s*(used|remaining)\b/i);
    if (!match) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < 0 || value > 100) continue;
    return { remaining: match[2].toLowerCase() === 'used' ? Math.round((100 - value) * 100) / 100 : value };
  }
  return null;
}
function lastKnownUsageCredits(snapshot, history = []) {
  const valid = value => value?.currency === 'USD' && typeof value.remaining === 'number' && Number.isFinite(value.remaining) && value.remaining >= 0;
  if (valid(snapshot?.usageCredits)) {
    return { ...snapshot.usageCredits, observedAt: snapshot.usageCredits.observedAt || snapshot.usageCredits.updatedAt || snapshot.updatedAt || null, stale: Boolean(snapshot.usageCredits.stale) };
  }
  const previous = history.find(entry => entry?.providerId === 'ollama' && valid(entry.usageCredits));
  if (!previous) return null;
  return { ...previous.usageCredits, observedAt: previous.usageCredits.observedAt || previous.usageCredits.updatedAt || previous.updatedAt || null, stale: true };
}
function parseOllamaCredits(html, now = new Date(), { assumeFree = false } = {}) {
  if (typeof html !== 'string') throw new Error('Réponse Ollama illisible.');
  const safe = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const plainPage = safe.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;|&#xA0;/gi, ' ').replace(/&#36;|&#x24;/gi, '$').replace(/\s+/g, ' ');
  const start = safe.search(/Monthly usage|Included usage|Usage included|Cloud usage/i);
  if (/\b(?:sign in|log in|continue with (?:google|email)|verify your email)\b/i.test(plainPage)) throw signInError();
  const heading = (start < 0 ? plainPage : safe.slice(Math.max(0, start - 250), start + 600)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const explicitFree = /\b(?:Included usage|Usage included|Cloud usage|Usage credits)\s*Free\b|\bFree plan\b/i.test(heading);
  // New portal: no monthly section at all, a Free plan meter provides the quota.
  const newFreeQuota = start < 0 ? freeUsageQuota(plainPage) : null;
  const free = explicitFree || assumeFree || Boolean(newFreeQuota);
  if (start < 0) {
    // A Free fallback still needs recognizable account usage content.
    const reserve = usageCredits(safe);
    if (free && (explicitFree || newFreeQuota || reserve)) {
      return { source: 'api', connectorVersion: 'ollama-monthly-credits-v1', updatedAt: now.toISOString(), planTier: 'free',
        balanceLabel: newFreeQuota ? 'Usage Free restant' : 'Limite Free à vérifier', balances: [], usageCredits: reserve,
        quotaRemaining: newFreeQuota ? newFreeQuota.remaining : null, resetAt: null, details: [] };
    }
    throw new Error('Crédits mensuels Ollama non reconnus. Aucun montant ne sera déduit du tarif ou d’une jauge.');
  }
  // Restrict extraction to the monthly usage section; additional credits and
  // subscription prices must not be mistaken for included usage.
  const tail = safe.slice(start, start + 6000);
  const boundary = tail.search(/Usage credits|Extra usage|Additional credits|Session usage|Weekly usage|Billing history/i);
  const section = boundary >= 0 ? tail.slice(0, boundary) : tail;
  const plain = section.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;|&#xA0;/gi, ' ').replace(/&#36;|&#x24;/gi, '$').replace(/\s+/g, ' ');
  const amount = '((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\.[0-9]+)?)';
  const planTier = heading.match(/(?:Included usage|Usage included|Cloud usage)\s*(Free|Pro|Max|Team)\b/i)?.[1]?.toLowerCase() || (free ? 'free' : 'paid');
  const matches = [...plain.matchAll(new RegExp('\\$' + amount + '\\s+of\\s+\\$' + amount + '\\s+used', 'gi'))];
  let usedMatch = matches[0]?.[1], totalMatch = matches[0]?.[2];
  if (matches.length === 0 && !free) {
    const usedAmounts = [...plain.matchAll(new RegExp('\\$' + amount + '\\s+used\\b', 'gi'))];
    const includedAmounts = [...plain.matchAll(new RegExp('\\b(?:includes?|included)\\s+\\$' + amount + '\\s+(?:of\\s+)?(?:monthly\\s+)?usage(?:\\s+credits)?\\b', 'gi'))];
    if (usedAmounts.length === 1 && includedAmounts.length === 1) {
      usedMatch = usedAmounts[0][1];
      totalMatch = includedAmounts[0][1];
    } else if (usedAmounts.length === 1 && ['pro','max','team'].includes(planTier)) {
      const tierAllowance = plain.match(new RegExp('\\b' + planTier + '\\s*[—–:-]\\s*\\$' + amount, 'i'));
      if (tierAllowance) { usedMatch = usedAmounts[0][1]; totalMatch = tierAllowance[1]; }
    }
  }
  if ((matches.length !== 1 && !(usedMatch && totalMatch)) && !free) throw new Error('Montants des crédits mensuels Ollama absents ou ambigus. Aucun solde estimé ne sera affiché.');
  if (matches.length > 1) throw new Error('Montants des crédits mensuels Ollama ambigus.');
  const used = usedMatch ? Number(usedMatch.replaceAll(',', '')) : null, total = totalMatch ? Number(totalMatch.replaceAll(',', '')) : null;
  if (usedMatch && totalMatch && (!Number.isFinite(used) || !Number.isFinite(total) || total < 0 || used < 0 || (total === 0 && !free))) throw new Error('Crédits mensuels Ollama invalides.');
  const hasAmount = total !== null && total > 0 && (!assumeFree || explicitFree);
  const remaining = hasAmount ? Math.max(0, total - used) : null;
  const freePercent = !hasAmount && free ? [...plain.matchAll(/\b(\d{1,3}(?:\.\d+)?)\s*%\s*(used|remaining)\b/gi)] : [];
  const freeQuota = freePercent.length === 1 && Number(freePercent[0][1]) <= 100
    ? Math.round((freePercent[0][2].toLowerCase() === 'used' ? 100 - Number(freePercent[0][1]) : Number(freePercent[0][1])) * 100) / 100 : null;
  const date = section.match(/data-time=["']([^"']+)["']/i)?.[1];
  let resetAt = null;
  if (date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(date) || !Number.isFinite(Date.parse(date))) throw new Error('Date de remise à zéro Ollama non reconnue.');
    resetAt = new Date(date).toISOString();
  }
  return { source: 'api', connectorVersion: 'ollama-monthly-credits-v1', updatedAt: now.toISOString(),
    planTier, balanceLabel: free ? 'Usage Free restant' : 'Crédits mensuels restants', balances: hasAmount ? [{ currency: 'USD', remaining, total, used }] : [],
    usageCredits: usageCredits(safe),
    quotaRemaining: hasAmount ? Math.round(remaining / total * 10000) / 100 : freeQuota, resetAt,
    details: hasAmount ? [{ label: 'Crédits inclus dans la période', amount: total, currency: 'USD' }, { label: 'Crédits consommés dans la période', amount: used, currency: 'USD' }] : [],
  };
}
// Une page Ollama : redirection (connexion) → session expirée. Electron lève
// « Redirect was cancelled » en mode manuel au lieu de renvoyer le 3xx.
async function fetchOllamaPage(fetcher, url, now) {
  let response;
  try { response = await fetcher(url, { method: 'GET', credentials: 'include', redirect: 'manual', cache: 'no-store', headers: { Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(15000) }); }
  catch (error) {
    if (/redirect/i.test(String(error?.message))) throw signInError();
    throw Object.assign(new Error('Connexion aux usages Ollama impossible ou délai dépassé.'), { code: 'OLLAMA_TRANSIENT' });
  }
  if ([301,302,303,307,308,401,403].includes(response.status) || response.type === 'opaqueredirect') throw signInError();
  if (response.status === 429) {
    rateLimitedUntil = retryAfterUntil(response, now.getTime());
    throw rateLimitError(rateLimitedUntil);
  }
  if (!response.ok) throw Object.assign(new Error(`Usages Ollama indisponibles (HTTP ${response.status}).`), { code: 'OLLAMA_TRANSIENT', status: response.status });
  if (response.url) {
    const finalUrl = new URL(response.url);
    if (finalUrl.origin !== OLLAMA_ORIGIN || finalUrl.pathname.startsWith('/auth/')) throw signInError();
  }
  return response.text();
}

async function fetchOllamaCredits(fetcher, now = new Date(), options = {}) {
  if (rateLimitedUntil > now.getTime()) throw rateLimitError(rateLimitedUntil);
  try {
    // Tableau de bord d'abord ; l'ancienne page /settings reste un recours.
    const html = await fetchOllamaPage(fetcher, DASHBOARD_URL, now).catch(error => {
      if (error.status === 404) return null;
      throw error;
    });
    const dashboard = html === null ? null : parseOllamaDashboard(html, now);
    if (dashboard) return dashboard;
    return parseOllamaCredits(await fetchOllamaPage(fetcher, SETTINGS_URL, now), now, options);
  } catch (error) {
    // A format change is not an authentication failure: the session must be kept
    // so the next automatic cycle can retry instead of asking for a new login.
    if (!error.code) error.code = 'OLLAMA_TRANSIENT';
    throw error;
  }
}
module.exports = { OLLAMA_ORIGIN, SETTINGS_URL, DASHBOARD_URL, parseOllamaCredits, parseOllamaDashboard, fetchOllamaCredits, lastKnownUsageCredits, resetOllamaRateLimit };
