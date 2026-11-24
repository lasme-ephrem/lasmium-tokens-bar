/* Lasmium TOKENS-HUB — cartes fournisseur (renderer).
 * Badges d'état, santé des connexions, groupes de quotas et niveaux de ressource,
 * notices de ressources, réserve Ollama, favoris, cartes expirées et liste filtrée.
 * Pur affichage : lit l'état global fourni par app.js, ne modifie rien, aucun accès réseau.
 * Dépend de ui-core.js (escapeHtml, icon, money, age, relativeAge, shortDate, days,
 * resetLabel, logo, levelPill, meterMarkup, freshnessMarkup, resourceClass, quotaDisplay,
 * FRESHNESS_MS, hasConnector, isTracked, ollamaFree), de reset-ui.js (resetMarkup),
 * des globaux QuotaResets et ResourceLevels (lib/) et des globals d'app.js
 * (state, filter, query) au moment du rendu.
 * statusBadge reste un global contractuel appelé directement par les smokes.
 * Les hooks DOM documentés dans renderer/CONTRAT-UI.md sont conservés.
 */
'use strict';

/* ------------------------------------------------------------------ *
 * Badges d'état des fournisseurs
 * ------------------------------------------------------------------ */
function statusBadge(provider) {
  if (provider.subscriptionStatus === 'expired' && !ollamaFree(provider)) {
    return '<span class="badge">Abonnement terminé</span>';
  }
  if (!isTracked(provider)) return '<span class="badge badge-warn">En pause</span>';
  if (provider.syncing) return '<span class="badge">Synchronisation…</span>';
  if (provider.error) {
    if (provider.id === 'claude' && typeof claudeConnectionState === 'function') {
      return claudeConnectionState(provider).state === 'reconnect'
        ? '<span class="badge badge-error">Reconnexion nécessaire</span>'
        : '<span class="badge badge-warn">Dernières valeurs · nouvel essai auto</span>';
    }
    if (provider.connected && provider.error.includes('quota indisponible')) {
      return '<span class="badge badge-warn">Quota indisponible</span>';
    }
    return '<span class="badge badge-error">Connexion à vérifier</span>';
  }
  if (ollamaFree(provider) && provider.connected) return '<span class="badge badge-warn">Free · 0 $</span>';
  if (provider.snapshot) {
    if (provider.snapshot.source === 'api' && !provider.connected) {
      return '<span class="badge">Déconnecté · dernier relevé</span>';
    }
    if (Date.now() - Date.parse(provider.snapshot.updatedAt) > FRESHNESS_MS) {
      return '<span class="badge badge-warn">Relevé ancien</span>';
    }
    return `<span class="badge ${provider.snapshot.source === 'api' ? 'badge-live' : ''}">`
      + `${provider.snapshot.source === 'api' ? 'Synchronisé' : 'Saisie manuelle'}</span>`;
  }
  return `<span class="badge">${provider.connected ? 'Compte connecté' : hasConnector(provider) ? 'À connecter' : 'Saisie manuelle'}</span>`;
}

/* ------------------------------------------------------------------ *
 * Santé des connexions
 * ------------------------------------------------------------------ */
function strategyLabel(strategy) {
  return {
    'claude-direct': 'Lecture directe',
    'claude-desktop': 'Claude Desktop',
    'openai-codex': 'Codex',
    'antigravity-local': 'Application locale',
    'ollama-browser': 'Navigateur',
    'browser-session': 'Navigateur',
    'account-session': 'Compte',
    'api-key': 'Clé API',
  }[strategy] || 'Automatique';
}

function healthPresentation(provider) {
  if (!provider.connected) {
    return { state: 'idle', label: 'Non connecté', detail: 'Aucune session active pour ce service.' };
  }
  const health = provider.health;
  if (!health) {
    return { state: 'unknown', label: 'Jamais vérifié', detail: 'Lance une vérification pour établir la santé de cette connexion.' };
  }
  const labels = {
    ok: 'À jour',
    stale: 'Relevé ancien',
    auth: 'Reconnexion requise',
    rate: 'Limité',
    drift: 'Interface modifiée',
    down: 'Indisponible',
    error: 'Erreur',
    idle: 'Inactif',
  };
  const details = {
    AUTH_REQUIRED: 'La session ou le jeton doit être renouvelé. Reconnecte ce service.',
    AUTH_EXPIRED: 'La session a expiré. Reconnecte ce service.',
    AUTH_RATE_LIMITED: 'Le renouvellement d’authentification est temporairement limité ; reprise automatique.',
    RATE_LIMITED: 'Le fournisseur limite les lectures ; reprise automatique au prochain cycle.',
    NETWORK: 'Réseau indisponible ; le dernier relevé sain est conservé.',
    TIMEOUT: 'Délai dépassé ; le dernier relevé sain est conservé.',
    UPSTREAM: 'Le fournisseur est momentanément indisponible ; reprise automatique.',
    SCHEMA_DRIFT: 'Réponse valide mais inattendue : aucun faux zéro n’est écrit, le dernier relevé sain est conservé.',
    PARSER_EMPTY: 'Aucune donnée exploitable dans la page ; le dernier relevé sain est conservé.',
    CONFLICT: 'Valeurs contradictoires : le dernier relevé sain est conservé.',
  };
  const state = labels[health.state] ? health.state : 'error';
  let detail = details[health.error?.code] || health.error?.message || 'Dernière lecture réussie.';
  if (state === 'stale') detail = 'La lecture a réussi, mais le relevé date de plus de 10 minutes.';
  if (state === 'ok' && Array.isArray(health.warnings) && health.warnings.length) detail = health.warnings[0];
  if (state === 'ok' && !health.error) detail = `Lecture ${strategyLabel(health.strategy)} · aucune anomalie.`;
  if (health.error?.retryAt) {
    const retry = new Date(health.error.retryAt);
    if (Number.isFinite(retry.getTime())) detail += ` Nouvel essai après ${retry.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.`;
  }
  return { state, label: labels[state] || 'Erreur', detail };
}

function healthPanel() {
  const providers = state.providers.filter(hasConnector);
  const connected = providers.filter(provider => provider.connected);
  const healthy = connected.filter(provider => provider.health?.state === 'ok').length;
  const rows = providers.map(provider => {
    const health = provider.health;
    const presentation = healthPresentation(provider);
    return `<div class="health-row" data-state="${escapeHtml(presentation.state)}">`
      + `<span class="health-dot" aria-hidden="true"></span>`
      + `<div class="health-main"><strong>${escapeHtml(provider.name)}</strong>`
      + `<span class="health-detail">${escapeHtml(presentation.detail)}</span></div>`
      + `<span class="health-strategy">${escapeHtml(strategyLabel(health?.strategy))}</span>`
      + `<span class="health-state">${escapeHtml(presentation.label)}</span>`
      + `<span class="health-age">${health?.lastSuccessAt ? escapeHtml(relativeAge(health.lastSuccessAt)) : '—'}</span>`
      + `<button type="button" class="ghost health-test" data-sync="${escapeHtml(provider.id)}"`
      + `${!provider.connected || provider.syncing ? ' disabled' : ''}>`
      + `${provider.syncing ? 'Lecture…' : 'Tester'}</button>`
      + `</div>`;
  });
  return `<section class="health-panel" aria-labelledby="health-title">`
    + `<div class="health-head"><div><p class="eyebrow">DIAGNOSTIC</p>`
    + `<h2 id="health-title">Santé des connexions</h2>`
    + `<p class="hint">Chaque lecture est typée : une réponse illisible ne remplace jamais le dernier relevé sain.</p></div>`
    + `<span class="health-summary"><strong>${healthy}/${connected.length}</strong> à jour</span></div>`
    + `<div class="health-list">${rows.join('')}</div>`
    + packStatusMarkup()
    + `</section>`;
}

function packStatusMarkup() {
  const packs = Array.isArray(state.connectorPacks) ? state.connectorPacks : [];
  const errors = Array.isArray(state.connectorPackErrors) ? state.connectorPackErrors : [];
  const active = packs.map(pack => `${pack.provider} ${pack.version}`).join(' · ');
  return `<p class="health-packs">${packs.length
    ? `Packs signés actifs : ${escapeHtml(active)}.`
    : 'Aucun pack signé actif ; les connecteurs intégrés restent utilisés.'}`
    + `${errors.length ? ` ${errors.length} pack(s) refusé(s) : ${escapeHtml(errors[0].reason)}.` : ''}</p>`;
}

/* ------------------------------------------------------------------ *
 * Quotas : regroupements et libellés (sémantique conservée)
 * ------------------------------------------------------------------ */
function quotaGroups(provider) {
  if (provider.type !== 'subscription' || provider.id === 'ollama') return [];
  const slots = QuotaResets.slots(provider);
  const groups = [];
  for (const slot of slots) {
    let group = groups.find(item => item.groupKey === slot.group);
    if (!group) {
      let name = slot.group;
      if (provider.id === 'claude' && slot.group === 'Fable') name = '';
      else if (slot.group === 'Claude et GPT') name = 'Claude / GPT';
      else if (provider.id === 'antigravity' && slot.group === 'Gemini 4 Argon') name = 'Argon';
      else if (provider.id === 'grok' && !slot.group) {
        name = provider.snapshot?.usageKind === 'x-subscription-shared'
          ? 'Grok / Bot / Cursor'
          : slots.some(item => item.group === 'Grok Bot') ? 'Grok' : '';
      }
      group = { groupKey: slot.group, name, periods: [] };
      groups.push(group);
    }
    let quota = provider.snapshot?.quotaWindows?.find(window =>
      QuotaResets.canonical(window.label) === slot.key);
    if (!quota && !provider.snapshot?.quotaWindows?.length && slots.length === 1) {
      quota = { remaining: provider.snapshot?.quotaRemaining, resetAt: provider.snapshot?.resetAt };
    }
    group.periods.push({ label: slot.period, key: slot.key, quota });
  }
  return groups;
}

// Hebdo Fable n'est pas incluse avec Pro : on le dit plutôt que d'afficher un
// vide. Avec Max, la ligne apparaît dès qu'Anthropic la fournit.
function claudeFableHint(provider, groups) {
  const fableShown = groups.some(group => group.periods.some(period => period.key === 'Fable · Semaine'));
  if (fableShown) return '';
  const plan = provider.accountSession?.plan || provider.plan || '';
  return /^pro$/i.test(plan.trim()) ? 'Hebdo Fable : non incluse avec Pro.' : '';
}

function quotaPeriodLabel(provider, key, label) {
  if (provider.id === 'claude' && key === 'Fable · Semaine') return 'Hebdo Fable';
  if (provider.id === 'antigravity' && key.includes('Argon')) return 'Hebdo Argon';
  if (label === 'Semaine') return 'Hebdo';
  if (label === '5 heures' || label === 'Période en cours') return 'Horaire';
  return label;
}

// Une fenêtre absente du relevé n'est jamais rendue comme une ligne « — ».
function displayedQuotaGroups(provider) {
  const windows = provider.snapshot?.quotaWindows || [];
  if (!windows.length) return [];
  const present = new Set(windows.map(window => QuotaResets.canonical(window.label)));
  return quotaGroups(provider)
    .map(group => ({ ...group, periods: group.periods.filter(period => present.has(period.key)) }))
    .filter(group => group.periods.length);
}

function quotaStatusPeriods(provider) {
  return displayedQuotaGroups(provider).flatMap(group =>
    group.periods.map(period => ({ ...period, groupName: group.name })));
}

function allQuotaPeriodsExhausted(provider) {
  const periods = quotaStatusPeriods(provider);
  if (!periods.length) return false;
  return periods.every(({ quota }) =>
    typeof quota?.remaining === 'number' && Number.isFinite(quota.remaining) && quota.remaining === 0);
}

function providerResourceLevel(provider) {
  const currentLevel = ResourceLevels.providerLevel(provider);
  if (provider.type !== 'subscription' || provider.id === 'ollama' || currentLevel === 'unknown') {
    return currentLevel;
  }
  if ((provider.snapshot?.balances || [])
    .some(balance => ResourceLevels.level(balance.remaining, balance.currency) === 'empty')) {
    return 'empty';
  }
  const periods = quotaGroups(provider).flatMap(group => group.periods);
  if (!periods.some(({ quota }) =>
    typeof quota?.remaining === 'number' && Number.isFinite(quota.remaining))) {
    return ResourceLevels.providerLevel(provider);
  }
  if (allQuotaPeriodsExhausted(provider)) return 'empty';
  const levels = [
    ...(provider.snapshot?.balances || [])
      .map(balance => ResourceLevels.level(balance.remaining, balance.currency)),
    ...periods.map(({ quota }) => ResourceLevels.level(quota?.remaining, '%')),
  ].filter(value => value !== 'unknown' && value !== 'empty');
  return ['critical', 'low', 'healthy'].find(value => levels.includes(value)) || 'unknown';
}

function quotaLimitStatus(provider, key, label, groupName = '') {
  const period = label === 'Semaine' ? 'hebdo'
    : (label === '5 heures' || label === 'Période en cours') ? 'horaire'
      : label.toLocaleLowerCase('fr-FR');
  if (provider.id === 'antigravity' && key.includes('Argon')) {
    return 'Limite hebdo Argon atteinte';
  }
  if (provider.id === 'claude') {
    const model = key.includes(' · ') ? key.slice(0, key.lastIndexOf(' · ')) : '';
    return `Limite ${period}${model ? ' ' + model : ''} atteinte`;
  }
  return `Limite ${groupName ? groupName + ' · ' : ''}${period} atteinte`;
}

function quotaSlotLabel(provider, slot) {
  if (provider.id === 'antigravity' && slot.group === 'Gemini 4 Argon') return 'Hebdo Argon';
  const label = quotaPeriodLabel(provider, slot.key, slot.period);
  if (label === 'Hebdo Fable') return label;
  const group = slot.group === 'Claude et GPT' ? 'Claude / GPT' : slot.group;
  return group ? `${group} · ${label}` : label;
}

function resourceAmount(balance) {
  const levelName = ResourceLevels.level(balance.remaining, balance.currency);
  return `<span class="resource-value resource-${levelName}"`
    + ` title="${escapeHtml(ResourceLevels.describe(levelName, balance.currency))}">`
    + `${money(balance.remaining, balance.currency)}</span>`;
}

function resourceUnverified(provider) {
  return Boolean(provider.error
    || (provider.snapshot?.source === 'api' && !provider.connected)
    || Date.now() - Date.parse(provider.snapshot?.updatedAt) > FRESHNESS_MS);
}

function ollamaUsageCredits(provider) {
  const reserve = provider.id === 'ollama'
    && provider.snapshot?.connectorVersion === 'ollama-monthly-credits-v1'
    ? provider.snapshot.usageCredits : null;
  return reserve?.currency === 'USD'
    && typeof reserve.remaining === 'number'
    && Number.isFinite(reserve.remaining)
    && reserve.remaining >= 0 ? reserve : null;
}

function ollamaReserveMarkup(provider, compact = false) {
  if (provider.id !== 'ollama' || provider.snapshot?.connectorVersion !== 'ollama-monthly-credits-v1') {
    return '';
  }
  const reserve = ollamaUsageCredits(provider);
  const label = reserve?.stale
    ? `Dernière valeur connue · ${age(reserve.observedAt)}`
    : reserve ? 'Réserve supplémentaire' : 'Réserve indisponible';
  const className = compact ? 'quick-ollama-reserve' : 'ollama-reserve';
  const title = reserve?.stale
    ? ` title="Dernier montant lu le ${escapeHtml(new Date(reserve.observedAt).toLocaleString('fr-FR'))}"`
    : '';
  return `<span class="${className}${reserve?.stale ? ' stale' : ''}">`
    + `<span class="reserve-label">${escapeHtml(label)}</span>`
    + `<strong class="resource-value resource-${resourceClass(reserve?.remaining, 'USD').replace('resource-', '')}"${title}>`
    + `${reserve ? money(reserve.remaining, 'USD') : '—'}</strong></span>`;
}

function resourceNotice(provider, compact = false) {
  const levelName = providerResourceLevel(provider);
  if (levelName === 'unknown') return '';
  const emptyBalance = (provider.snapshot?.balances || [])
    .some(balance => ResourceLevels.level(balance.remaining, balance.currency) === 'empty');
  const quotaPeriods = provider.type === 'subscription' && provider.id !== 'ollama'
    ? quotaStatusPeriods(provider) : [];
  const hasQuota = quotaPeriods.some(({ quota }) =>
    typeof quota?.remaining === 'number' && Number.isFinite(quota.remaining));
  let text;
  if (provider.id === 'ollama' && emptyBalance) {
    text = `Crédits inclus épuisés${ollamaUsageCredits(provider)?.remaining > 0 ? ' · réserve disponible' : ''}`;
  } else if (emptyBalance) {
    text = 'Solde épuisé';
  } else if (hasQuota) {
    if (!allQuotaPeriodsExhausted(provider)) return '';
    text = quotaPeriods.length > 1 ? 'Toutes les limites atteintes' : 'Limite atteinte';
  } else if (levelName === 'empty') {
    text = 'Limite atteinte';
  } else {
    return '';
  }
  const className = compact ? 'quick-resource-status' : 'resource-status';
  const suffix = resourceUnverified(provider) ? ' · dernier relevé' : '';
  return `<span class="${className}">${escapeHtml(text + suffix)}</span>`;
}

/* ------------------------------------------------------------------ *
 * Cartes fournisseurs
 * ------------------------------------------------------------------ */
function quotaGroupsMarkup(groups, provider) {
  const periodRank = period => period.label === 'Semaine' ? 0
    : (period.label === '5 heures' || period.label === 'Période en cours') ? 1 : 2;
  return `<div class="quota-groups">${groups.map(group => {
    const sorted = [...group.periods].sort((a, b) => periodRank(a) - periodRank(b));
    const periods = sorted.map(({ label, quota, key }) => {
      const value = quota?.remaining;
      const known = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
      const levelName = known ? ResourceLevels.level(value, '%') : 'unknown';
      const status = known && value === 0
        ? `<p class="quota-period-status">${escapeHtml(quotaLimitStatus(provider, key, label, group.name))}</p>`
        : '';
      const pill = known && value !== 0 ? levelPill(levelName, '%') : '';
      return `<div class="quota-period resource-${levelName}">`
        + `<span class="quota-period-label">${escapeHtml(quotaPeriodLabel(provider, key, label))}</span>`
        + `${meterMarkup(known ? value : undefined,
          `${quotaPeriodLabel(provider, key, label)} : quota restant`)}`
        + `<span class="quota-period-value">${known ? `${value}<small>%</small>` : '—'}</span>`
        + `${pill}${status}${resetMarkup(provider, key)}</div>`;
    }).join('');
    return `<section class="quota-group">`
      + `${group.name ? `<h4>${escapeHtml(group.name)}</h4>` : ''}`
      + `<div class="quota-periods${group.periods.length === 1 ? ' single' : ''}">${periods}</div></section>`;
  }).join('')}</div>`;
}

function expiredCard(provider) {
  const status = statusBadge(provider);
  const message = 'Tu n’as plus cet abonnement : il est exclu des coûts. Ouvre la fiche pour le réactiver.';
  return `<article class="card expired-card">`
    + `<button type="button" class="card-open" data-open="${escapeHtml(provider.id)}"`
    + ` aria-label="Configurer ${escapeHtml(provider.name)}"></button>`
    + `<div class="card-top">${logo(provider)}`
    + `<div class="provider-title"><h3>${escapeHtml(provider.name)}</h3>`
    + `<p>${escapeHtml(provider.plan && provider.plan !== provider.name ? provider.plan : 'Abonnement')} · terminé</p></div>`
    + `${favoriteButton(provider)}</div>`
    + `<div class="card-content"><p class="expired-title">Abonnement terminé</p>`
    + `<p class="expired-message">${message}</p>`
    + `<div class="card-bottom"><span class="card-meta">Exclu des coûts · suivi arrêté</span>${status}</div>`
    + `</div></article>`;
}

function favoriteButton(provider) {
  const label = `${provider.favorite ? 'Retirer' : 'Ajouter'} ${escapeHtml(provider.name)} `
    + `${provider.favorite ? 'des' : 'aux'} favoris`;
  return `<button type="button" class="icon-button${provider.favorite ? ' is-selected' : ''}"`
    + ` data-favorite="${escapeHtml(provider.id)}"`
    + ` title="${provider.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}"`
    + ` aria-label="${label}" aria-pressed="${provider.favorite}">${icon('star', 16)}</button>`;
}

function card(provider) {
  if (provider.subscriptionStatus === 'expired' && !ollamaFree(provider)) return expiredCard(provider);
  const snapshot = provider.snapshot;
  const groups = displayedQuotaGroups(provider);
  const levelName = providerResourceLevel(provider);
  const unverified = resourceUnverified(provider);
  let metric;
  let label;
  let note;
  let unit = '%';
  let rawValue = null;
  // Pourcentage réellement restant pour la ligne et la jauge du bas : quota
  // d'abonnement, ou part restante d'un crédit total connu. Un solde en devise
  // n'est jamais affiché comme un pourcentage.
  let percentLeft = null;
  let footLabel = null;
  let footValue = null;
  if (snapshot?.balances?.length) {
    label = escapeHtml(snapshot.balanceLabel || 'Dernier solde connu');
    metric = snapshot.balances.map(resourceAmount).join('<small class="separator"> / </small>');
    note = age(snapshot.updatedAt);
    unit = snapshot.balances[0].currency;
    rawValue = snapshot.balances[0].remaining;
    const first = snapshot.balances[0];
    if (typeof first.total === 'number' && first.total > 0 && Number.isFinite(first.remaining)) {
      percentLeft = Math.min(100, Math.max(0, Math.round(first.remaining / first.total * 1000) / 10));
      footLabel = `Reste sur ${money(first.total, first.currency)}`;
    } else {
      footLabel = 'Solde du compte';
      footValue = money(first.remaining, first.currency);
    }
  } else if (snapshot?.quotaRemaining !== null && snapshot?.quotaRemaining !== undefined) {
    label = escapeHtml(snapshot.quotaLabel || 'Quota restant');
    rawValue = snapshot.quotaRemaining;
    percentLeft = rawValue;
    metric = `<span class="resource-value resource-${ResourceLevels.level(rawValue, '%')}">`
      + `${quotaDisplay(rawValue, provider.id)}<small>%</small></span>`;
    note = age(snapshot.updatedAt);
  } else if (ollamaFree(provider)) {
    label = 'Limite Free';
    metric = '<span class="unknown">—</span>';
    note = 'Usage de base mensuel · une requête à la fois · limite non communiquée';
  } else if (provider.type === 'subscription') {
    label = 'Tarif renseigné';
    metric = typeof provider.amount === 'number'
      ? money(provider.amount, provider.currency || 'USD') : '<span class="unknown">—</span>';
    note = provider.billingCycle === 'monthly' ? 'par mois'
      : provider.billingCycle === 'yearly' ? 'par an'
        : provider.billingCycle === 'one-time' ? 'paiement unique'
          : 'Fréquence à préciser';
    unit = provider.currency || 'USD';
  } else {
    label = 'Crédits restants';
    metric = '<span class="unknown">—</span>';
    note = 'Connecte le compte ou ajoute un relevé';
  }
  const hasQuota = typeof rawValue === 'number';
  const metricPill = hasQuota ? levelPill(ResourceLevels.level(rawValue, unit), unit) : '';
  const subline = ollamaFree(provider) ? 'Forfait expiré · Free'
    : snapshot?.resetAt ? resetLabel(snapshot.resetAt)
      : provider.type === 'subscription'
        ? (provider.renewalDate
          ? `${subscriptionOverdue(provider) ? 'Échéance à vérifier'
            : provider.billingCycle === 'one-time' ? 'Fin du paiement unique' : 'Prochain paiement'} · ${shortDate(provider.renewalDate)}`
          : 'Échéance à préciser')
        : '';
  const meta = groups.length ? freshnessMarkup(snapshot?.updatedAt) : escapeHtml(subline);
  const freeHint = ollamaFree(provider)
    ? '<p class="card-hint">Forfait payant expiré · usage Free suivi</p>' : '';
  const fableHint = provider.id === 'claude' ? claudeFableHint(provider, groups) : '';
  const claudeHint = fableHint ? `<p class="card-hint">${fableHint}</p>` : '';
  const simpleQuota = groups.length ? '' : `<div class="metric-label">${label}</div>`
    + `<div class="metric-row"><p class="metric">${metric}</p>${metricPill}</div>`
    + `<p class="metric-note">${escapeHtml(note)}</p>`
    + `<div class="quota${hasQuota ? ' resource-' + ResourceLevels.level(rawValue, unit) : ''}">`
    + `<div class="quota-label"><span>${footLabel || (hasQuota ? 'Quota restant'
      : ollamaFree(provider) ? 'Limite Free à vérifier'
        : provider.type === 'subscription' ? 'Usage non renseigné' : 'Solde du compte')}</span>`
    + `<strong>${footValue || (percentLeft !== null
      ? `${quotaDisplay(percentLeft, provider.id).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %` : '—')}</strong></div>`
    + `${meterMarkup(percentLeft ?? undefined, footLabel || 'Quota restant')}</div>`;
  return `<article class="card resource-${levelName}${unverified ? ' is-stale' : ''}`
    + `${ollamaFree(provider) && !hasQuota ? ' ollama-free-unknown' : ''}">`
    + `<button type="button" class="card-open" data-open="${escapeHtml(provider.id)}"`
    + ` aria-label="Ouvrir la fiche de ${escapeHtml(provider.name)}"></button>`
    + `<div class="card-top">${logo(provider)}<div class="provider-title">`
    + `<h3>${escapeHtml(provider.name)}</h3>`
    + `<p>${escapeHtml(ollamaFree(provider) ? 'Free · 0 $/mo'
      : provider.plan && provider.plan !== provider.name ? provider.plan : '')
      || (provider.type === 'subscription' ? 'Abonnement' : 'API à la consommation')}`
    + `${provider.active ? '' : ' · en pause'}</p></div>${favoriteButton(provider)}</div>`
    + `<div class="card-content">${freeHint}`
    + `${groups.length
      ? `<p class="metric-label">Quotas restants</p>${quotaGroupsMarkup(groups, provider)}${claudeHint}`
      : simpleQuota}`
    + `${provider.id === 'ollama' ? resetMarkup(provider, 'Mois') : ''}`
    + `${ollamaReserveMarkup(provider)}${resourceNotice(provider)}`
    + `<div class="card-bottom"><span class="card-meta">${meta}</span>`
    + `<span class="card-badges">${levelPill(levelName, unit)}${statusBadge(provider)}</span></div>`
    + `${provider.error ? `<p class="card-error">${escapeHtml(provider.error)}</p>` : ''}`
    + `</div></article>`;
}

function filteredCards() {
  const providers = state.providers.filter(provider => {
    const matchesFilter = filter === 'all'
      || (filter === 'favorite' ? provider.favorite : provider.type === filter);
    const matchesQuery = provider.name.toLowerCase().includes(query.toLowerCase());
    return matchesFilter && matchesQuery;
  });
  if (!providers.length) {
    return `<div class="empty-state" role="status"><h2>Aucun service trouvé</h2>`
      + `<p>Essaie un autre nom ou un autre filtre.</p></div>`;
  }
  return providers.map(card).join('');
}
