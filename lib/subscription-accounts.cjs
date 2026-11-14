// Only official subscription portals. No API keys or inference requests.
const accounts = Object.freeze({
  openai: { name: 'OpenAI', url: 'https://chatgpt.com/', origin: 'https://chatgpt.com', nativeLogin: false, scope: 'Limites OpenAI · compte ChatGPT de Codex', hint: 'Connecte le compte ChatGPT déjà utilisé dans Codex. Si nécessaire, la connexion officielle s’ouvre dans ton navigateur et se confirme automatiquement.' },
  claude: { name: 'Claude', url: 'https://claude.ai/settings/usage', usageUrl: 'https://claude.ai/settings/usage', origin: 'https://claude.ai', nativeLogin: true, scope: 'Claude · 5 heures et semaine', hint: 'Pour la première connexion, connecte-toi dans Chrome ou Edge sur Claude, puis ferme la fenêtre. Si un contrôle humain apparaît pendant « Vérifier maintenant », termine-le et laisse la fenêtre ouverte jusqu’à la lecture des quotas. La session est propre à Lasmium TOKENS-HUB ; Claude Desktop reste connecté séparément.' },
  grok: { name: 'Grok', url: 'https://grok.com/', usageUrl: 'https://grok.com/dashboard', fallbackUsageUrl: 'https://grok.com/?_s=usage', origin: 'https://grok.com', nativeLogin: true, scope: 'Grok et Grok Bot · quotas du compte', hint: 'Connecte-toi dans Chrome ou Edge, puis ferme cette fenêtre. X Subscription présente un pool partagé Grok, Grok Bot et Cursor dans Dashboard → Usage. Les comptes SuperGrok peuvent afficher deux limites distinctes dans Settings → Usage ; certains comptes historiques utilisent encore le dashboard Cursor. La connexion xAI ne fusionne pas de comptes et ne change aucun forfait.' },
  zai: { name: 'Z.ai', url: 'https://z.ai/manage-apikey/coding-plan/personal/usage', origin: 'https://z.ai', nativeLogin: true, scope: 'Quotas du plan Z.ai', hint: 'Connecte-toi dans Chrome ou Edge sur le portail Z.ai, puis ferme cette fenêtre. Lasmium TOKENS-HUB pourra alors lire les quotas de ton abonnement.' },
});
function accountConfig(id) {
  if (!Object.hasOwn(accounts, id)) throw new Error('Connexion au compte non disponible.');
  return accounts[id];
}

// Executed only in the dedicated browser. Never return page text, credentials,
// account identity, chat contents or storage. Read usage settings sections only.
function inspectSubscriptionPage(id, expectedOrigin) {
  if (location.origin !== expectedOrigin) return { authenticated: false, windows: [] };
  if (/^(just a moment|un instant|checking your browser|vérification du navigateur)/i.test(document.title || '')) return { authenticated: false, windows: [], blocked: 'challenge' };
  const visible = el => Boolean(el.getClientRects().length);
  const controls = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"]')].filter(visible);
  const label = el => (el.getAttribute('aria-label') || el.innerText || '').trim();
  const login = controls.some(el => /^(sign in|log in|se connecter|connexion)$/i.test(label(el)));
  const explicitAccount = controls.some(el => /^(sign out|log out|se déconnecter|déconnexion)$|^(google account|compte google)\b|^(open profile menu|ouvrir le menu du profil)$/i.test(label(el)));
  if (login) window.__lasmiumAuthenticated = false;
  else if (explicitAccount) window.__lasmiumAuthenticated = true;
  const authenticated = !login && Boolean(window.__lasmiumAuthenticated);
  if (id === 'claude') {
    // Only the account's usage settings are read, never a conversation or
    // another page containing an incidental percentage.
    const onUsagePage = /^\/settings\/usage\/?$/.test(location.pathname) || /^#settings\/usage\/?$/.test(location.hash || '');
    if (!onUsagePage || login) return { authenticated: false, windows: [] };
    const scopes = [...document.querySelectorAll('main, [role="main"], [role="dialog"], dialog')].filter(visible);
    const scope = scopes.find(el => /(?:votre utilisation|your usage)/i.test(el.innerText.slice(0, 300)));
    if (!scope) return { authenticated: explicitAccount, windows: [] };
    const lines = scope.innerText.slice(0, 12000).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const findLine = expression => lines.findIndex(line => expression.test(line));
    const sessionIndex = findLine(/^(?:session actuelle|current session)$/i);
    const weekIndex = findLine(/^(?:cette semaine|this week|weekly limits?)$/i);
    const windows = [];
    function resetAt(fragment, period) {
      const reset = fragment.match(/(?:r[ée]initialisation|resets?)\s+(?:le\s+|at\s+|on\s+|à\s+)?([^\n]+)/i);
      if (!reset) return null;
      const clock = reset[1].match(/\b(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i);
      if (!clock) return null;
      let hour = Number(clock[1]), minute = Number(clock[2]);
      if (hour > 23 || minute > 59) return null;
      if (clock[3]) hour = hour % 12 + (clock[3].toUpperCase() === 'PM' ? 12 : 0);
      const now = new Date(), candidate = new Date(now);
      candidate.setHours(hour, minute, 0, 0);
      if (period === '5 heures') {
        if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
        return candidate - now <= 5.5 * 3600000 ? candidate.toISOString() : null;
      }
      const weekdays = ['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'];
      const normalized = reset[1].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const english = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
      const day = weekdays.findIndex((name, i) => normalized.includes(name) || normalized.includes(english[i]));
      if (day < 0) return null;
      candidate.setDate(candidate.getDate() + (day - now.getDay() + 7) % 7);
      if (candidate <= now) candidate.setDate(candidate.getDate() + 7);
      return candidate.toISOString();
    }
    for (const [index, label] of [[sessionIndex, '5 heures'], [weekIndex, 'Semaine']]) {
      if (index < 0) continue;
      const end = [sessionIndex, weekIndex].filter(other => other > index).sort((a, b) => a - b)[0] ?? Math.min(lines.length, index + 8);
      const fragment = lines.slice(index + 1, end).join('\n');
      const used = fragment.match(/\b(\d{1,3}(?:[.,]\d+)?)\s*%\s*(?:utilis(?:é|ée|és|ées|e|es)?|used)\b/i);
      if (!used) continue;
      const percentage = Number(used[1].replace(',', '.'));
      if (percentage < 0 || percentage > 100) continue;
      windows.push({ label, remaining: Math.round((100 - percentage) * 100) / 100, resetAt: resetAt(fragment, label) });
    }
    return { authenticated: true, windows };
  }
  const grokDashboard = id === 'grok' && /^\/dashboard\/?$/.test(location.pathname);
  let scopes = [];
  if ((id === 'openai' && /^\/codex\/(?:cloud\/settings\/analytics|settings\/usage)\/?$/.test(location.pathname)) ||
      (id === 'zai' && /^\/manage-apikey\/(subscription|usage|coding-plan\/personal\/usage)\/?$/.test(location.pathname))) {
    scopes = [...document.querySelectorAll('main, [role="main"]')].filter(visible);
  }
  let grokDashboardScope = null;
  if (grokDashboard) {
    // The X Subscription quota is shown in Dashboard → Usage. Restrict the
    // read to the smallest visible Usage section with a weekly allowance; the
    // rest of the dashboard can include unrelated activity and credit data.
    const candidates = [...document.querySelectorAll('main, [role="main"], [role="tabpanel"], section, article')].filter(visible);
    const weeklyUsage = /(?:weekly|hebdomadaire|semaine).*(?:usage|limit|pool|allowance|utilisation|quota|cr[eé]dit)|(?:usage|utilisation).*(?:weekly|hebdomadaire|semaine)/i;
    const usageScopes = candidates.filter(el => {
      const text = (el.innerText || '').slice(0, 12000);
      const headings = [...el.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(visible).map(title => title.innerText.trim());
      return (/\busage\b|utilisation/i.test(headings.join(' ')) || /^(?:usage|utilisation)$/im.test(text)) && weeklyUsage.test(text);
    });
    grokDashboardScope = usageScopes.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0] || null;
    if (grokDashboardScope) scopes = [grokDashboardScope];
  }
  // Grok's older quota remains available in a usage settings panel. Never scan chats.
  for (const el of document.querySelectorAll('[role="dialog"], dialog, [role="tabpanel"]')) {
    if (!visible(el)) continue;
    // Grok nests "Utilisation" under the dialog's first heading "Paramètres".
    // Inspect all headings, still strictly inside settings panels, never chats.
    const titles = [...el.querySelectorAll('h1,h2,h3,[role="heading"]')];
    if (titles.some(title => visible(title) && /^(usage(?: limits)?|limits|utilisation|limites(?: d[’\x27]utilisation)?|consommation)$/i.test(title.innerText.trim()))) scopes.push(el);
  }
  if (grokDashboardScope) {
    // Some legacy SuperGrok accounts still expose both the Grok and Bot
    // allowances from a dashboard shell. A distinct Bot limit takes priority
    // over the dashboard route when identifying the quota model.
    const legacyScopes = scopes.filter(scope => {
      const headings = [...scope.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(visible).map(heading => heading.innerText.trim());
      return headings.some(heading => /supergrok/i.test(heading) || (/grok\s*bot/i.test(heading) && /(?:weekly|week|limit|hebdomadaire|semaine)/i.test(heading))) ||
        /grok\s*bot.{0,80}(?:distinct|separate|limite hebdomadaire|weekly limit)/i.test(scope.innerText || '');
    });
    if (legacyScopes.length) {
      grokDashboardScope = null;
      scopes = legacyScopes;
    }
  }
  if (!scopes.length && !login) {
    // Open only the documented settings/usage controls, never a purchase,
    // conversation or model action. The user can also navigate there manually.
    const usage = controls.find(el => /^(usage(?: limits)?|utilisation|limites d[’\x27]utilisation|consommation)$/i.test(label(el).split('\n')[0].trim()));
    if (usage) usage.click();
      else if (!window.__lasmiumSettingsOpened && id === 'grok') {
      const settings = controls.find(el => /^(settings(?: (?:and|&) help)?|paramètres(?: et aide)?|réglages)$/i.test(label(el)));
      if (settings) { settings.click(); window.__lasmiumSettingsOpened = true; }
      else if (id === 'grok' && !window.__lasmiumProfileOpened) {
        // Grok's account menu is an avatar button, with or without an accessible label. Opening this menu
        // is not authentication evidence: require its explicit logout control.
        const profile = controls.filter(el => el.tagName === 'BUTTON' && el.getAttribute('aria-haspopup') === 'menu' && el.querySelector('img'));
        if (profile.length === 1) {
          // The menu opens on pointerdown rather than the synthetic click event.
          profile[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
          profile[0].dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
          window.__lasmiumProfileOpened = true;
        }
      }
    }
  }
  const texts = scopes.map(el => el.innerText.slice(0, 20000));
  if (id === 'grok' && grokDashboardScope) {
    const text = (grokDashboardScope.innerText || '').slice(0, 12000);
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const title = /^(?:weekly (?:usage(?: limit)?|limit|pool|allowance)(?: supergrok)?|limite hebdomadaire(?: supergrok)?|usage hebdomadaire|semaine)(?::?\s+\d{1,3}(?:[.,]\d+)?\s*%\s*(?:used|remaining|left|utilis[ée]s?|consomm[ée]s?|restant(?:e|s|es)?|disponible(?:s)?))?$/i;
    const titles = lines.map((line, index) => title.test(line) ? index : -1).filter(index => index >= 0);
    const flow = [...grokDashboardScope.querySelectorAll('number-flow-react[aria-label]')].find(number => {
      const value = number.getAttribute('aria-label') || '';
      const direction = number.parentElement?.innerText.trim() || '';
      return visible(number) && /^\d{1,3}(?:[.,]\d+)?\s*%$/.test(value) && /^(used|utilis[ée]s?|remaining|left|restant(?:e|s|es)?|disponible(?:s)?)$/i.test(direction);
    });
    const windows = [];
    for (const [position, start] of titles.entries()) {
      let end = titles[position + 1] ?? Math.min(lines.length, start + 9);
      for (let index = start + 1; index < end; index++) {
        if (/^(?:by (?:product|model|surface)|breakdown|cr[eé]dits?(?: suppl[eé]mentaires)?|additional usage credits?)\b/i.test(lines[index])) { end = index; break; }
      }
      const fragment = lines.slice(start, end).join('\n');
      let amount, direction;
      if (titles.length === 1 && flow) {
        amount = Number((flow.getAttribute('aria-label') || '').match(/[\d]+(?:[.,]\d+)?/)[0].replace(',', '.'));
        direction = flow.parentElement.innerText.trim();
      } else {
        const match = fragment.match(/\b(\d{1,3}(?:[.,]\d+)?)\s*%\s*(remaining|left|restants?|disponibles?|used|utilis[ée]s?|consomm[ée]s?)/i) ||
          fragment.match(/(remaining|left|restants?|disponibles?|used|utilis[ée]s?|consomm[ée]s?)\s*:?\s*(\d{1,3}(?:[.,]\d+)?)\s*%/i);
        if (match) {
          amount = Number((match[1].match(/^\d/) ? match[1] : match[2]).replace(',', '.'));
          direction = match[1].match(/^\d/) ? match[2] : match[1];
        }
      }
      if (!Number.isFinite(amount) || amount < 0 || amount > 100) continue;
      const remaining = /^(remaining|left|restant|disponible)/i.test(direction) ? amount : 100 - amount;
      const reset = fragment.match(/(?:resets?|remise à zéro|réinitialisation)[^\n\d]{0,20}(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/i);
      windows.push({ label: 'Semaine', remaining: Math.round(remaining * 100) / 100, resetAt: reset?.[1] || null });
    }
    const unique = windows.filter((window, index) => windows.findIndex(other => other.label === window.label && other.remaining === window.remaining && other.resetAt === window.resetAt) === index);
    const conflict = unique.some((window, index) => unique.findIndex(other => other.label === window.label) !== index);
    return { authenticated: !login && (authenticated || unique.length > 0), windows: conflict ? [] : unique,
      ...(unique.length && !conflict ? { usageKind: 'x-subscription-shared' } : {}), ...(conflict ? { blocked: 'conflicting-quotas' } : {}) };
  }
  if (id === 'grok') {
    const parseResetAt = text => {
      const iso = text.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/i);
      if (iso && Number.isFinite(Date.parse(iso[0]))) return new Date(iso[0]).toISOString();
      const localized = text.match(/\b(\d{1,2})\s+([\p{L}.]+)\s+(\d{4})\s+(?:à|at)\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\b/iu);
      if (!localized) return null;
      const monthName = localized[2].replace(/\.$/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const monthNames = ['janvier','fevrier','mars','avril','mai','juin','juillet','aout','septembre','octobre','novembre','decembre','january','february','march','april','may','june','july','august','september','october','november','december'];
      const month = monthNames.indexOf(monthName) % 12;
      const day = Number(localized[1]), year = Number(localized[3]), hour = Number(localized[4]), minute = Number(localized[5]), second = Number(localized[6] || 0);
      if (!monthNames.includes(monthName) || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
      const candidate = new Date(year, month, day, hour, minute, second, 0);
      if (candidate.getFullYear() !== year || candidate.getMonth() !== month || candidate.getDate() !== day) return null;
      return candidate.toISOString();
    };
    const readFlow = flow => {
      const accessible = (flow.getAttribute('aria-label') || '').trim();
      const parentText = flow.parentElement?.innerText?.trim() || '';
      const value = accessible.match(/^(\d{1,3}(?:[.,]\d+)?)\s*%/i);
      const amount = value ? Number(value[1].replace(',', '.')) : NaN;
      const directionText = `${accessible} ${parentText}`;
      const used = /\b(?:used|utilis(?:é|ée|és|ées|e|es)?|consomm(?:é|ée|és|ées|e|es)?)\b/i.test(directionText);
      const remaining = /\b(?:remaining|left|restant(?:e|s|es)?|disponible(?:s)?)\b/i.test(directionText);
      if (!value || !Number.isFinite(amount) || amount < 0 || amount > 100 || (!used && !remaining)) return null;
      return Math.round((remaining ? amount : 100 - amount) * 100) / 100;
    };
    const quotaWindows = [];
    let foundQuotaHeading = false, readFromText = false;
    for (const scope of scopes) {
      const quotaHeadings = [...scope.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(visible).filter(heading =>
        /(?:weekly|hebdomadaire|semaine)/i.test(heading.innerText.trim()));
      if (!quotaHeadings.length) continue;
      foundQuotaHeading = true;
      // Older pages animate totals with number-flow; since November 2026 the
      // percentage is plain text right under each quota heading.
      const flows = [...scope.querySelectorAll('number-flow-react[aria-label]')].filter(visible);
      const lines = (scope.innerText || '').slice(0, 12000).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const readText = text => {
        const value = text.match(/(?:^|\n)\s*(\d{1,3}(?:[.,]\d+)?)\s*%\s*(used|utilis(?:é|ée|és|ées|e|es)?|consomm(?:é|ée|és|ées|e|es)?|remaining|left|restant(?:e|s|es)?|disponible(?:s)?)\b/i);
        if (!value) return null;
        const amount = Number(value[1].replace(',', '.'));
        if (!Number.isFinite(amount) || amount < 0 || amount > 100) return null;
        return Math.round((/^(remaining|left|restant|disponible)/i.test(value[2]) ? amount : 100 - amount) * 100) / 100;
      };
      let lineCursor = 0;
      for (const [headingIndex, heading] of quotaHeadings.entries()) {
        let container = null, flow = null, ancestor = heading;
        for (let depth = 0; depth < 10; depth++) {
          const parent = ancestor.parentElement;
          if (!parent) break;
          const contained = [...parent.querySelectorAll('number-flow-react[aria-label]')].filter(visible);
          if (contained.length === 1) { container = parent; flow = contained[0]; }
          else if (contained.length > 1) break;
          ancestor = parent;
          if (ancestor === scope) break;
        }
        if (!flow && flows.length && flows.length === quotaHeadings.length) { flow = flows[headingIndex]; container = scope; }
        const headingText = heading.innerText.trim();
        let lineIndex = lines.findIndex((line, index) => index >= lineCursor && line.localeCompare(headingText, undefined, { sensitivity: 'accent' }) === 0);
        if (lineIndex < 0) lineIndex = lines.findIndex((line, index) => index >= lineCursor && line.toLowerCase() === headingText.toLowerCase());
        if (lineIndex < 0) lineIndex = lineCursor;
        const nextHeading = quotaHeadings[headingIndex + 1]?.innerText.trim();
        let end = lines.length;
        if (nextHeading) {
          const nextIndex = lines.findIndex((line, index) => index > lineIndex && line.toLowerCase() === nextHeading.toLowerCase());
          if (nextIndex >= 0) end = nextIndex;
        }
        const fragment = lines.slice(lineIndex, end).join('\n');
        lineCursor = Math.max(lineCursor, lineIndex + 1);
        // Text value: only the two lines right under the heading ("24 %",
        // "utilisés"), never the per-product breakdown below it.
        const remaining = flow ? readFlow(flow) : readText(lines.slice(lineIndex + 1, Math.min(end, lineIndex + 3)).join('\n'));
        if (remaining === null || remaining === undefined) continue;
        if (!flow) readFromText = true;
        const resetAt = parseResetAt(fragment) || (container && [...container.querySelectorAll('number-flow-react[aria-label]')].filter(visible).length === 1 ? parseResetAt(container.innerText || '') : null);
        const label = /grok\s*bot/i.test(headingText) ? 'Grok Bot · Semaine' : 'Semaine';
        quotaWindows.push({ label, remaining, resetAt });
      }
    }
    // Plain-text values are taken per heading only for the two distinct
    // SuperGrok/Grok Bot limits, which the generic reader would mislabel as
    // two conflicting weekly quotas; other pages keep the generic reader
    // (e.g. a 5-hour window shown beside a weekly one).
    if (foundQuotaHeading && quotaWindows.length && (!readFromText || quotaWindows.some(quota => quota.label === 'Grok Bot · Semaine'))) {
      const uniqueQuotaWindows = quotaWindows.filter((quota, index) => quotaWindows.findIndex(other => other.label === quota.label && other.remaining === quota.remaining && other.resetAt === quota.resetAt) === index);
      const conflict = uniqueQuotaWindows.some((quota, index) => uniqueQuotaWindows.findIndex(other => other.label === quota.label) !== index);
      return { authenticated: !login && (authenticated || uniqueQuotaWindows.length > 0), windows: conflict ? [] : uniqueQuotaWindows,
        ...(uniqueQuotaWindows.length && !conflict ? { usageKind: /supergrok/i.test(texts.join('\n')) ? 'supergrok-legacy' : 'grok-legacy' } : {}),
        ...(conflict ? { blocked: 'conflicting-quotas' } : {}) };
    }
  }
  if (id === 'grok') {
    for (const scope of scopes) {
      if (!/(weekly (?:usage|limit|pool|allowance)|limite hebdomadaire|usage hebdomadaire)/i.test(scope.innerText)) continue;
      // Grok renders quota totals in number-flow's shadow DOM. Read its
      // accessible value and usage direction, never a bar width or credits.
      // On Dashboard → Usage, the first accessible total is the weekly pool;
      // subsequent values belong to product/model breakdowns.
      for (const number of scope.querySelectorAll('number-flow-react[aria-label]')) {
        const value = number.getAttribute('aria-label') || '';
        const direction = number.parentElement?.innerText.trim() || '';
        if (visible(number) && /^\d{1,3}(?:[.,]\d+)?\s*%$/.test(value) && /^(used|utilis[ée]s?|remaining|left|restant(?:e|s|es)?|disponible(?:s)?)$/i.test(direction)) {
          texts.push(`Weekly limit\n${value} ${direction}`);
          break;
        }
      }
    }
  }
  // Only bounded quota lines leave the browser. Reset dates require an explicit
  // ISO date; relative/localized ambiguous dates are intentionally left unknown.
  const windows = [];
  const heading = /(?:current usage|utilisation actuelle|5[ -]?(?:hours?|heures?|h)\b(?:\s+(?:usage|limit|limite))?|five[ -]hour(?: usage)?(?: limit)?|weekly(?: usage| limit| pool| allowance)?|usage hebdomadaire|limite hebdomadaire|hebdomadaire|semaine)/gi;
  for (const text of texts) {
    const matches = [...text.matchAll(heading)];
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index + matches[i][0].length;
      const chunk = text.slice(start, Math.min(start + 220, matches[i + 1]?.index ?? text.length));
      let match = chunk.match(/(?:^|\s)(\d{1,3}(?:[.,]\d+)?)\s*%\s*(remaining|left|restants?|disponibles?|used|utilis[ée]s?|consomm[ée]s?)/i);
      // Z.ai's French portal mistranslates "Used" as "D'occasion". Accept
      // this only immediately after a quota heading on this provider; never
      // infer usage from an unrelated activity percentage or a bar width.
      if (!match && id === 'zai') {
        const localizedUsed = chunk.match(/^\s*(\d{1,3}(?:[.,]\d+)?)\s*%\s*D[’']occasion\b/i);
        if (localizedUsed) match = [localizedUsed[0], localizedUsed[1], 'used'];
      }
      if (!match) {
        const reversed = chunk.match(/(remaining|left|restants?|disponibles?|used|utilis[ée]s?|consomm[ée]s?)\s*:?\s*(\d{1,3}(?:[.,]\d+)?)\s*%/i);
        if (reversed) match = [reversed[0], reversed[2], reversed[1]];
      }
      if (!match) continue;
      const value = Number(match[1].replace(',', '.'));
      if (value < 0 || value > 100) continue;
      const remaining = /^(remaining|left|restant|disponible)/i.test(match[2]) ? value : 100 - value;
      const name = /current usage|utilisation actuelle/i.test(matches[i][0]) ? 'Période en cours' : /5|five/i.test(matches[i][0]) ? '5 heures' : 'Semaine';
      const reset = chunk.match(/(?:resets?|remise à zéro|réinitialisation)[^\n\d]{0,20}(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/i);
      windows.push({ label: name, remaining, resetAt: reset?.[1] || null });
    }
  }
  const unique = windows.filter((w, i) => windows.findIndex(other => other.label === w.label && other.remaining === w.remaining && other.resetAt === w.resetAt) === i);
  const conflict = unique.some((w, i) => unique.findIndex(other => other.label === w.label) !== i);
  const usageKind = unique.length && id === 'grok' ? grokDashboardScope ? 'x-subscription-shared' : /supergrok/i.test(texts.join('\n')) ? 'supergrok-legacy' : 'grok-legacy' : undefined;
  return { authenticated: !login && (authenticated || unique.length > 0), windows: conflict ? [] : unique, ...(usageKind ? { usageKind } : {}), ...(conflict ? { blocked: 'conflicting-quotas' } : {}) };
}

function parseAccountUsage(id, result, now = new Date()) {
  const config = accountConfig(id);
  if (result?.blocked === 'challenge') throw Object.assign(new Error(`${config.name} demande une vérification de sécurité du navigateur. Le dernier relevé est conservé. Clique sur Vérifier maintenant pour terminer le contrôle humain dans Chrome.`), { code: 'ACCOUNT_BROWSER_CHECK' });
  if (result?.blocked === 'conflicting-quotas') throw Object.assign(new Error(`Les quotas affichés par ${config.name} sont contradictoires. Le dernier relevé est conservé. Vérifie la page d’utilisation du compte.`), { code: 'ACCOUNT_USAGE_INVALID' });
  if (!result?.authenticated) throw Object.assign(new Error(`Session ${config.name} absente ou expirée. Ouvre le compte et connecte-toi. ${config.hint}`), { code: 'ACCOUNT_SIGNIN' });
  if (!Array.isArray(result.windows)) throw new Error('Réponse du compte illisible.');
  if (!result.windows.length) return null;
  if (id === 'grok' && result.usageKind && !['x-subscription-shared', 'supergrok-legacy', 'grok-legacy'].includes(result.usageKind)) throw new Error('Quota du compte invalide.');
  const windows = result.windows.map(w => {
    if (!['Période en cours', '5 heures', 'Semaine', 'Grok Bot · Semaine', 'Mois'].includes(w.label) || typeof w.remaining !== 'number' || !Number.isFinite(w.remaining) || w.remaining < 0 || w.remaining > 100) throw new Error('Quota du compte invalide.');
    if (w.resetAt !== null && (typeof w.resetAt !== 'string' || !Number.isFinite(Date.parse(w.resetAt)))) throw new Error('Date de remise à zéro invalide.');
    return { label: w.label, remaining: Math.round(w.remaining * 100) / 100, resetAt: w.resetAt ? new Date(w.resetAt).toISOString() : null };
  });
  // Main card shows the most constrained window; all windows remain visible.
  const tightest = windows.reduce((a, b) => a.remaining <= b.remaining ? a : b);
  const grokScope = id !== 'grok' ? null : result.usageKind === 'x-subscription-shared' ? 'X Subscription · Pool partagé Grok, Grok Bot et Cursor' : result.usageKind === 'supergrok-legacy' ? 'Quotas SuperGrok historiques séparés · Grok et Grok Bot' : result.usageKind === 'grok-legacy' ? 'Quota Grok historique · Grok uniquement' : null;
  const snapshot = { source: 'api', connectorVersion: `${id}-account-usage-v1`, updatedAt: now.toISOString(), balances: [], quotaRemaining: tightest.remaining, resetAt: tightest.resetAt, quotaWindows: windows, quotaLabel: `${grokScope ? `Grok · ${grokScope}` : config.scope} · ${tightest.label}` };
  if (id === 'grok' && ['x-subscription-shared', 'supergrok-legacy', 'grok-legacy'].includes(result.usageKind)) snapshot.usageKind = result.usageKind;
  return snapshot;
}
module.exports = { accounts, accountConfig, inspectSubscriptionPage, parseAccountUsage };
