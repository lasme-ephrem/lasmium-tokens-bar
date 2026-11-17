/* Lasmium TOKENS-HUB — pages du tableau de bord et fiche détaillée (renderer).
 * Vue d'ensemble, Abonnements, Connexions, Historique (graphe), Réglages (dont la
 * section mises à jour), champs de formulaire et fiche fournisseur (dialogue, onglets).
 * Pur affichage : lit l'état global fourni par app.js, ne modifie rien, aucun accès réseau.
 * Dépend de ui-core.js, de views-shell.js (heading, syncButton, stats, toolbar,
 * resourceLegend), de views-cards.js (filteredCards, statusBadge, healthPanel,
 * providerResourceLevel, ollamaUsageCredits) et des globals
 * d'app.js (state, filter, query, historyLoaded, historyError, historyProvider,
 * historyPeriod) au moment du rendu. reset-ui.js appelle inputField défini ici.
 * Les hooks DOM documentés dans renderer/CONTRAT-UI.md sont conservés.
 */
'use strict';

/* ------------------------------------------------------------------ *
 * Vue d'ensemble
 * ------------------------------------------------------------------ */
function overview() {
  return heading('TOUT SOUS LES YEUX', 'Tes usages, en un regard.',
    'Quotas, crédits et abonnements. Garde le fil de tes outils IA.')
    + stats()
    + `<div class="section-heading"><h2>Mes fournisseurs `
    + `<small>${state.providers.length} services</small></h2>`
    + `<p class="section-hint">Ouvre une carte pour la configurer.</p></div>`
    + toolbar(filter, query)
    + `<section class="cards" id="provider-cards" aria-label="Mes fournisseurs">${filteredCards()}</section>`
    + `<div class="bottom-note"><span>${icon('shield', 14)} Tes clés restent chiffrées sur cet appareil.</span>`
    + `<span>Aucune estimation présentée comme un solde réel.</span></div>`
    + resourceLegend();
}

/* ------------------------------------------------------------------ *
 * Abonnements
 * ------------------------------------------------------------------ */
function subscriptions() {
  const list = state.providers.filter(provider => provider.type === 'subscription');
  const rows = list.map(provider => {
    const expired = provider.subscriptionStatus === 'expired';
    const overdue = subscriptionOverdue(provider);
    const status = ollamaFree(provider) ? 'Free · compté 0 $'
      : expired ? 'Abonnement terminé · hors coûts'
        : overdue ? 'Échéance à vérifier' : '';
    const date = provider.renewalDate ? `${renewalLabel(provider.billingCycle)} · ${shortDate(provider.renewalDate)}` : 'À préciser';
    return `<tr class="${expired ? 'expired-row' : ''}">`
      + `<td><div class="table-name">${logo(provider, true)}<div>`
      + `<strong>${escapeHtml(provider.name)}</strong>`
      + `${provider.plan && provider.plan !== provider.name ? `<small>${escapeHtml(provider.plan)}</small>` : ''}`
      + `${status ? `<small class="${overdue ? 'past-date' : ''}">${status}</small>` : ''}`
      + `</div></div></td>`
      + `<td>${escapeHtml(subscriptionPriceText(provider))}</td>`
      + `<td class="muted">${BILLING_LABELS[provider.billingCycle] || 'À préciser'}</td>`
      + `<td class="${overdue ? 'warning' : 'muted'}">${date}</td>`
      + `<td><button type="button" class="secondary" data-open="${escapeHtml(provider.id)}"`
      + ` aria-label="Modifier ${escapeHtml(provider.name)}">Modifier</button></td></tr>`;
  });
  return heading('BUDGET & ÉCHÉANCES', 'Tes abonnements.',
    'Ce que tu paies chaque mois, tes paiements uniques et tes prochaines échéances.')
    + stats()
    + `<div class="table-wrap"><table class="data-table">`
    + `<thead><tr><th scope="col">Service</th><th scope="col">Prix</th>`
    + `<th scope="col">Fréquence</th><th scope="col">Échéance</th>`
    + `<th scope="col"><span class="sr-only">Actions</span></th></tr></thead>`
    + `<tbody>${rows.join('')}</tbody></table></div>`
    + `<p class="settings-foot">Coût mensuel : mensuels + annuels ÷ 12. Les paiements uniques sont comptés à part `
    + `jusqu’à la fin de la période payée. Une échéance dépassée reste comptée et passe « à vérifier ». `
    + `Ollama : le forfait lu sur son site décide s’il est compté (Free = 0 $).</p>`;
}

/* ------------------------------------------------------------------ *
 * Connexions
 * ------------------------------------------------------------------ */
function connections() {
  const cards = state.providers.filter(hasConnector).map(provider => {
    const warning = provider.subscriptionStatus === 'expired'
      ? (ollamaFree(provider) ? 'Forfait Free · compté 0 $, suivi actif' : 'Abonnement terminé · suivi arrêté')
      : provider.error ? escapeHtml(provider.error) : '';
    return `<section class="connection-card" aria-labelledby="connection-${escapeHtml(provider.id)}">`
      + `<div class="card-top">${logo(provider)}<div class="provider-title">`
      + `<h3 id="connection-${escapeHtml(provider.id)}">${escapeHtml(provider.name)}</h3>`
      + `<p>${escapeHtml(provider.connector.scope)}</p></div>${statusBadge(provider)}</div>`
      + `<p class="connection-description">${escapeHtml(provider.connector.description)}</p>`
      + `${warning ? `<p class="warning">${warning}</p>` : ''}`
      + `<div class="connection-footer">`
      + `<span class="muted connection-age">${provider.connected
        ? freshnessMarkup(provider.snapshot?.updatedAt) || 'Aucun relevé'
        : 'Connexion non configurée'}</span>`
      + `<button type="button" class="primary" data-open="${escapeHtml(provider.id)}" data-tab="connection">`
      + `${icon('plug', 15)} ${provider.connected ? 'Gérer la connexion' : 'Connecter'}</button>`
      + `</div></section>`;
  });
  return heading('SYNCHRONISATION', 'Connecte tes comptes.',
    'Tes soldes et quotas, lus directement auprès des fournisseurs.')
    + healthPanel()
    + `<div class="connection-grid">${cards.join('')}</div>`
    + `<div class="info-box"><p>Les clés sont chiffrées par Windows et ne sont jamais incluses dans `
    + `les exports. Les connexions API lisent les crédits. Les autres fournisseurs utilisent chacun `
    + `une session de compte isolée. Aucun modèle n’est appelé.</p></div>`
    + `<p class="hint">Un relevé manuel reste possible depuis la fiche d’un service déconnecté.</p>`;
}

/* ------------------------------------------------------------------ *
 * Historique
 * ------------------------------------------------------------------ */
function graph(entries, provider) {
  const currencies = [...new Set(entries.flatMap(entry =>
    entry.balances.map(balance => balance.currency)))];
  const series = currencies.map(currency => ({
    label: `Solde · ${currency}`,
    points: entries.filter(entry => entry.balances.some(balance => balance.currency === currency))
      .map(entry => ({
        t: Date.parse(entry.updatedAt),
        v: entry.balances.find(balance => balance.currency === currency).remaining,
      })),
  }));
  const quotas = entries.filter(entry => entry.quotaRemaining !== null);
  if (quotas.length) {
    series.push({
      label: 'Quota restant · %',
      points: quotas.map(entry => ({ t: Date.parse(entry.updatedAt), v: entry.quotaRemaining })),
    });
  }
  return series.map(serie => {
    const points = serie.points.sort((a, b) => a.t - b.t);
    const lo = Math.min(...points.map(point => point.v));
    const hi = Math.max(...points.map(point => point.v));
    const first = points[0].t;
    const last = points.at(-1).t;
    const coords = points.map(point => ({
      x: first === last ? 350 : 30 + (point.t - first) / (last - first) * 640,
      y: hi === lo ? 75 : 130 - (point.v - lo) / (hi - lo) * 105,
    }));
    const title = `${provider.name} · ${serie.label}`;
    return `<section class="chart-panel"><h3>${escapeHtml(title)} `
      + `<span class="muted">(${points.length} relevé${points.length > 1 ? 's' : ''})</span></h3>`
      + `<svg viewBox="0 0 700 155" role="img" aria-label="${escapeHtml(serie.label)} : de `
      + `${points[0].v} à ${points.at(-1).v}">`
      + `<path class="chart-grid" d="M30 25H670M30 78H670M30 130H670"/>`
      + `<polyline class="chart-line" points="${coords.map(point => `${point.x},${point.y}`).join(' ')}"/>`
      + coords.map((point, index) => `<circle class="chart-point" cx="${point.x}" cy="${point.y}" r="3.5">`
        + `<title>${escapeHtml(new Date(points[index].t).toLocaleString('fr-FR'))} : ${points[index].v}</title>`
        + `</circle>`).join('')
      + `<text class="chart-axis" x="30" y="14">${hi.toFixed(2)}</text>`
      + `<text class="chart-axis" x="30" y="148">${lo.toFixed(2)}</text></svg>`
      + `<div class="chart-labels"><span>${new Date(first).toLocaleString('fr-FR')}</span>`
      + `<span>${new Date(last).toLocaleString('fr-FR')}</span></div></section>`;
  }).join('');
}

function historyPage() {
  const header = heading('AU FIL DU TEMPS', 'Ton historique d’usage.',
    'Chaque synchronisation et chaque relevé manuel sont conservés.',
    `<button class="secondary" type="button" data-action="export">`
    + `${icon('download', 16)} Exporter</button>`);
  if (!historyLoaded || !Array.isArray(state.history)) {
    if (historyError) {
      return header + `<div class="empty-state" role="alert"><div class="empty-icon">${icon('warning', 28)}</div>`
        + `<h2>Historique indisponible</h2><p>${escapeHtml(historyError)}</p>`
        + `<button type="button" class="secondary" data-action="history-retry">Réessayer</button></div>`;
    }
    return header + `<div class="loading-state" role="status" aria-live="polite">`
      + `<p>Chargement de l’historique…</p></div>`;
  }
  const cutoff = historyPeriod === 'all' ? 0 : Date.now() - Number(historyPeriod) * 86400000;
  const entries = state.history.filter(entry =>
    (historyProvider === 'all' || entry.providerId === historyProvider)
    && Date.parse(entry.updatedAt) >= cutoff);
  const providerOptions = state.providers.map(provider =>
    `<option value="${escapeHtml(provider.id)}"${historyProvider === provider.id ? ' selected' : ''}>`
    + `${escapeHtml(provider.name)}</option>`).join('');
  const periodOptions = [['all', 'Tout l’historique'], ['7', '7 derniers jours'], ['30', '30 derniers jours']]
    .map(([value, label]) => `<option value="${value}"${historyPeriod === value ? ' selected' : ''}>${label}</option>`)
    .join('');
  const filters = `<div class="history-filters">`
    + `<label class="select-field"><span>Service</span>`
    + `<select id="history-provider" aria-label="Service dans l’historique">`
    + `<option value="all">Tous les services</option>${providerOptions}</select></label>`
    + `<label class="select-field"><span>Période</span>`
    + `<select id="history-period" aria-label="Période de l’historique">${periodOptions}</select></label></div>`;
  if (!entries.length) {
    return header + filters + `<div class="empty-state">`
      + `<div class="empty-icon">${icon('chart', 28)}</div>`
      + `<h2>${state.history.length ? 'Aucun relevé sur cette sélection' : 'Ton historique commence ici.'}</h2>`
      + `<p>Connecte l’un de tes comptes API, ou ajoute ton premier relevé manuel. `
      + `Tu retrouveras ici l’évolution de tes soldes et quotas.</p>`
      + `<button type="button" class="primary" data-nav="connections">`
      + `${icon('plug', 16)} Voir les connexions</button></div>`;
  }
  const chart = historyProvider !== 'all'
    ? graph(entries, state.providers.find(provider => provider.id === historyProvider))
    : '<p class="hint">Sélectionne un service pour afficher l’évolution de ses soldes et quotas.</p>';
  const rows = entries.slice(0, 200).map(entry => {
    const name = state.providers.find(provider => provider.id === entry.providerId)?.name;
    const balances = entry.balances.map(balance => money(balance.remaining, balance.currency)).join(' / ');
    const quota = entry.quotaRemaining !== null
      ? `${entry.balances.length ? ' · ' : ''}${quotaDisplay(entry.quotaRemaining, entry.providerId)} %` : '';
    return `<tr><td class="muted">${new Date(entry.updatedAt).toLocaleString('fr-FR')}</td>`
      + `<td>${escapeHtml(name)}</td><td>${balances}${quota}</td>`
      + `<td><span class="badge">${entry.source === 'api' ? 'API' : 'Manuel'}</span></td></tr>`;
  }).join('');
  const truncation = entries.length > 200
    ? 'Les 200 plus récents sont affichés. ' : '';
  return header + filters + chart
    + `<div class="table-wrap"><table class="data-table"><thead><tr>`
    + `<th scope="col">Date du relevé</th><th scope="col">Service</th>`
    + `<th scope="col">Solde / quota restant</th><th scope="col">Source</th>`
    + `</tr></thead><tbody>${rows}</tbody></table></div>`
    + `<p class="settings-foot">${entries.length} relevés · ${truncation}Jusqu’à 5 000 relevés conservés. `
    + `Une variation de solde peut inclure une recharge ; elle ne représente pas nécessairement une dépense.</p>`;
}

/* ------------------------------------------------------------------ *
 * Réglages
 * ------------------------------------------------------------------ */
function updateSection() {
  const update = state.update;
  if (!update) return '';
  const labels = {
    idle: 'Prête à vérifier', checking: 'Vérification…', 'up-to-date': 'À jour',
    available: 'Mise à jour disponible', downloading: 'Téléchargement…',
    extracting: 'Préparation…', ready: 'Prête à installer', installing: 'Installation…',
    error: 'Vérification impossible', disabled: 'Désactivées',
  };
  const busy = ['checking', 'downloading', 'extracting', 'installing'].includes(update.state);
  const available = update.available;
  const size = available ? `${(available.size / (1024 * 1024)).toFixed(1)} Mo` : '';
  const install = available && !busy
    ? `<button type="button" class="primary" data-action="update-install">Installer ${escapeHtml(available.version)} et redémarrer</button>`
    : '';
  const progress = busy && update.state !== 'checking'
    ? `<progress class="update-progress" max="100" value="${Math.max(0, Math.min(100, update.progress || 0))}">${update.progress || 0}%</progress>`
    : '';
  return `<section class="settings-panel update-panel" aria-labelledby="update-title">`
    + `<div class="section-heading"><h2 id="update-title">Mises à jour</h2>`
    + `<span class="badge">${escapeHtml(labels[update.state] || update.state)}</span></div>`
    + `<p class="hint">Version installée : <strong>${escapeHtml(update.currentVersion || state.app?.version || 'inconnue')}</strong>. `
    + `Les mises à jour sont signées et vérifiées avant tout remplacement ; le dossier <code>data/</code> est conservé.</p>`
    + (available ? `<p class="hint"><strong>${escapeHtml(available.version)}</strong> · ${escapeHtml(size)} · publiée le ${escapeHtml(String(available.publishedAt).slice(0, 10))}${available.notes ? `<br>${escapeHtml(available.notes)}` : ''}</p>` : '')
    + progress
    + `<div class="data-actions"><button type="button" class="secondary" data-action="update-check"${busy || !update.enabled ? ' disabled' : ''}>`
    + `${icon('refresh', 16)} Vérifier les mises à jour</button>${install}</div>`
    + (update.error ? `<p class="form-error" role="alert">${escapeHtml(update.error)}</p>` : '')
    + `</section>`;
}

function settingsPage({ version = null, electronVersion = null, packaged = null, erasePending = false } = {}) {
  const versionText = version ? `Version ${escapeHtml(version)}` : 'Version non exposée';
  const aboutDetail = [electronVersion ? `Electron ${escapeHtml(electronVersion)}` : null,
    packaged === true ? 'Portable Windows' : packaged === false ? 'Mode développement' : null]
    .filter(Boolean).join(' · ');
  const themeOptions = [['light', 'Clair'], ['dark', 'Sombre'], ['system', 'Système (Windows)']]
    .map(([value, label]) => {
      const selected = (state.settings.theme || 'light') === value;
      return `<option value="${value}"${selected ? ' selected' : ''}>${label}</option>`;
    }).join('');
  const eraseButton = erasePending
    ? `<div class="danger-zone" role="alert"><p><strong>Confirmer l’effacement définitif ?</strong> `
      + `Le prochain clic supprime l’inventaire, l’historique, les connexions et les clés. `
      + `Cette action est irréversible.</p>`
      + `<div class="form-actions"><button type="button" class="secondary" data-action="erase-cancel">Annuler</button>`
      + `<button type="button" class="danger" data-action="erase-data">Effacer définitivement</button></div></div>`
    : `<button type="button" class="danger" data-action="erase-data">Effacer mes données</button>`;
  return heading('À TA MAIN', 'Tes préférences.', 'Un suivi discret, sur ton appareil.')
    + `<form id="settings-form" class="settings-panel" novalidate>`
    + `<label class="settings-row"><span class="settings-row-text"><strong>Apparence</strong>`
    + `<span>Choisis le thème du tableau de bord et du widget. « Système » suit Windows.</span></span>`
    + `<select name="theme" aria-label="Thème de l’application">${themeOptions}</select></label>`
    + `<label class="settings-row"><span class="settings-row-text"><strong>Actualisation automatique</strong>`
    + `<span>Relit tes comptes connectés toutes les 5 minutes. `
    + `L’application doit rester ouverte, même dans la zone de notification.</span></span>`
    + `<input name="autoRefresh" type="checkbox" ${state.settings.autoRefresh ? 'checked' : ''}></label>`
    + `<label class="settings-row"><span class="settings-row-text"><strong>Lancer au démarrage de Windows</strong>`
    + `<span>${state.app?.autostart?.supported
      ? 'Lasmium TOKENS-HUB s’ouvre discrètement dans la zone de notification à l’ouverture de ta session.'
      : 'Disponible dans l’application installée.'}</span></span>`
    + `<input name="autostart" type="checkbox" ${state.app?.autostart?.enabled ? 'checked' : ''}`
    + `${state.app?.autostart?.supported ? '' : ' disabled'}></label>`
    + `<label class="settings-row"><span class="settings-row-text"><strong>Notifications Windows</strong>`
    + `<span>Échéance dans les 3 jours, quota inférieur ou égal à 20 % ou solde USD sous le seuil choisi. `
    + `Une alerte par jour et par motif.</span></span>`
    + `<input name="notifications" type="checkbox" ${state.settings.notifications ? 'checked' : ''}></label>`
    + `<label class="settings-row"><span class="settings-row-text"><strong>Alerte de solde faible · USD</strong>`
    + `<span>Ce seuil s’applique uniquement aux soldes en dollars US.</span></span>`
    + `<input name="lowBalance" type="number" min="0" max="10000" step="0.01"`
    + ` value="${state.settings.lowBalance}"></label>`
    + resourceLegend()
    + `<button class="primary" type="submit">Enregistrer les préférences</button>`
    + `<p class="form-error" role="alert"></p></form>`
    + `<section class="settings-panel" aria-labelledby="about-title">`
    + `<div class="section-heading"><h2 id="about-title">À propos</h2>`
    + `<span class="badge" id="app-version">${versionText}</span></div>`
    + `<p class="hint">${aboutDetail ? escapeHtml(aboutDetail) : 'Informations système indisponibles.'}</p>`
    + `<p class="hint privacy-note">${icon('shield', 15)} Aucune télémétrie : Lasmium TOKENS-HUB n’envoie `
    + `aucune donnée d’usage à un serveur Lasmium TOKENS-HUB. Les seules connexions réseau sont celles `
    + `nécessaires à la lecture des soldes chez les fournisseurs que tu as configurés.</p></section>`
    + updateSection()
    + `<section class="settings-panel" aria-labelledby="data-title">`
    + `<div class="section-heading"><h2 id="data-title">Tes données t’appartiennent</h2></div>`
    + `<p class="hint">Les données et les clés chiffrées sont enregistrées localement. `
    + `L’export contient l’inventaire, les réglages et l’historique, sans les clés. `
    + `Fermer la fenêtre laisse Lasmium TOKENS-HUB accessible près de l’horloge ; un clic droit sur `
    + `l’icône permet de quitter.</p>`
    + `<div class="data-actions"><button type="button" class="secondary" data-action="export">`
    + `${icon('download', 16)} Exporter mes données</button>`
    + `<button type="button" class="secondary" data-action="diagnostic">`
    + `${icon('info', 16)} Diagnostic</button>${eraseButton}</div>`
    + `<p class="form-error" role="alert" id="erase-error"></p></section>`;
}

/* ------------------------------------------------------------------ *
 * Fiche détaillée (dialogue)
 * ------------------------------------------------------------------ */
function inputField(label, name, value, type = 'text', extra = '', full = false) {
  return `<div class="field${full ? ' full' : ''}"><label for="${name}">${escapeHtml(label)}</label>`
    + `<input id="${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" ${extra}></div>`;
}

function selectField(label, name, value, options) {
  const items = options.map(([id, text]) =>
    `<option value="${id}"${id === value ? ' selected' : ''}>${text}</option>`).join('');
  return `<div class="field"><label for="${name}">${escapeHtml(label)}</label>`
    + `<select id="${name}" name="${name}">${items}</select></div>`;
}

// Fiche d'un abonnement (0.6.9) : forfait, prix, fréquence, échéance. Rien
// d'autre : les quotas, dates de remise à zéro et soldes sont lus seuls.
const BILLING_LABELS = { monthly: 'Mensuel', yearly: 'Annuel', 'one-time': 'Paiement unique', unknown: 'À préciser' };

function renewalLabel(cycle) {
  return cycle === 'one-time' ? 'Fin de la période payée' : 'Prochain paiement';
}

function subscriptionOverdue(provider) {
  return provider.type === 'subscription' && provider.subscriptionStatus !== 'expired'
    && provider.billingCycle !== 'one-time' && Boolean(provider.renewalDate) && days(provider.renewalDate) < 0;
}

function subscriptionPriceText(provider) {
  if (ollamaFree(provider)) return 'Free · 0 $';
  if (typeof provider.amount !== 'number') return '—';
  const price = money(provider.amount, provider.currency || 'USD');
  return { monthly: `${price} / mois`, yearly: `${price} / an`, 'one-time': `${price} · une fois` }[provider.billingCycle] || price;
}

// Ce que l'abonnement représente dans les coûts, recalculé pendant la saisie.
function subscriptionCostLine(provider) {
  if (ollamaFree(provider)) return 'Forfait Free lu sur Ollama : compté 0 $.';
  if (provider.subscriptionStatus === 'expired') return 'Abonnement terminé : il n’est plus compté.';
  const currency = provider.currency || 'USD';
  if (typeof provider.amount !== 'number') return 'Indique le prix pour l’inclure dans tes coûts.';
  if (provider.billingCycle === 'monthly') return `Compté ${money(provider.amount, currency)} par mois.`;
  if (provider.billingCycle === 'yearly') return `Compté ${money(provider.amount / 12, currency)} par mois (${money(provider.amount, currency)} par an).`;
  if (provider.billingCycle === 'one-time') {
    return `Compté à part dans « Paiements uniques en cours »${provider.renewalDate
      ? ` jusqu’au ${shortDate(provider.renewalDate)}` : ''}, pas dans le coût mensuel.`;
  }
  return 'Choisis la fréquence pour l’inclure dans tes coûts.';
}

function providerInfoBody(provider) {
  const currencies = [['USD', 'USD'], ['EUR', 'EUR'], ['CNY', 'CNY']];
  const expired = provider.subscriptionStatus === 'expired';
  const overdue = subscriptionOverdue(provider);
  const currencyOptions = currencies.map(([id, text]) =>
    `<option value="${id}"${id === provider.currency ? ' selected' : ''}>${text}</option>`).join('');
  return `<form id="provider-form">`
    + `${expired ? `<div class="connection-note">${ollamaFree(provider)
      ? 'Ollama indique le forfait Free : il est compté 0 $ et reste suivi. Si tu reprends un forfait payant, '
        + 'il sera détecté à la prochaine synchronisation ; indique ici son prix et sa fréquence.'
      : 'Tu n’as plus cet abonnement : il est exclu des coûts et du suivi. '
        + 'Pour le réactiver, indique la prochaine échéance puis « Réactiver ».'}</div>` : ''}`
    + `<div class="fields">`
    + `${inputField('Forfait', 'plan', provider.plan, 'text', 'maxlength="200" placeholder="Ex. Max, Plus, Pro"', true)}`
    + `<div class="field"><label for="amount">Prix</label><div class="price-input">`
    + `<input id="amount" name="amount" type="number" min="0" max="1000000000000" step="0.01" placeholder="Inconnu"`
    + ` value="${escapeHtml(provider.amount ?? '')}">`
    + `<select id="currency" name="currency" aria-label="Devise">${currencyOptions}</select></div></div>`
    + `${selectField('Fréquence', 'billingCycle', provider.billingCycle,
      [['monthly', 'Mensuel'], ['yearly', 'Annuel'], ['one-time', 'Paiement unique'], ['unknown', 'À préciser']])}`
    + `<div class="field"><label for="renewalDate" id="renewalDate-label">${renewalLabel(provider.billingCycle)}</label>`
    + `<input id="renewalDate" name="renewalDate" type="date" value="${escapeHtml(provider.renewalDate || '')}"></div>`
    + `</div>`
    + `<p class="cost-line" id="cost-line" aria-live="polite">${escapeHtml(subscriptionCostLine(provider))}</p>`
    + `${overdue ? '<p class="form-warning">Échéance dépassée : l’abonnement reste compté. '
      + 'Indique la prochaine date de paiement pour confirmer le renouvellement.</p>' : ''}`
    + `<p class="form-error" role="alert"></p>`
    + `<div class="form-actions">`
    + `${expired ? '' : '<button type="button" class="link-button" data-action="subscription-end">Je n’ai plus cet abonnement</button>'}`
    + `<button type="button" class="secondary" data-action="close-dialog">Annuler</button>`
    + `<button type="submit" class="primary">${expired && !ollamaFree(provider) ? 'Réactiver' : 'Enregistrer'}</button></div></form>`;
}

function quotaWindowsNote(provider, extra = '') {
  if (!provider.snapshot?.quotaWindows?.length) return '';
  return `<div class="source-note">${provider.snapshot.quotaWindows.map(quotaWindow =>
    `<strong>${escapeHtml(quotaWindow.label)} : ${quotaWindow.remaining} % restants</strong>`
    + `${quotaWindow.resetAt
      ? `<br>Remise à zéro : ${new Date(quotaWindow.resetAt).toLocaleString('fr-FR')}` : ''}`)
    .join('<br>')}${extra ? `<br>${escapeHtml(extra)}` : ''}</div>`;
}

function providerConnectionBody(provider) {
  if (provider.id === 'claude') return claudeConnectionBody(provider);
  if (provider.id === 'antigravity') return antigravityConnectionBody(provider);
  if (!hasConnector(provider)) return '';
  if (provider.connector?.mode === 'account') return accountConnectionBody(provider);
  return apiKeyConnectionBody(provider);
}

function apiKeyConnectionBody(provider) {
  return `${provider.connected ? '<div class="connection-success">Clé enregistrée et chiffrée sur ce PC</div>' : ''}`
    + `<form id="connection-form"><div class="field">`
    + `<label for="api-key">${provider.connected ? 'Remplacer la clé API' : 'Clé API'}</label>`
    + `<input id="api-key" name="key" type="password" autocomplete="off" spellcheck="false" required`
    + ` maxlength="4096" placeholder="Colle ta clé ici">`
    + `<small>Vérifiée avant d’être enregistrée ; jamais affichée ni exportée.</small></div>`
    + `<p class="form-error" role="alert"></p>`
    + `<div class="form-actions">${provider.connected
      ? '<button type="button" class="secondary" data-action="disconnect">Déconnecter</button>' : ''}`
    + `<button type="submit" class="primary">${provider.connected ? 'Vérifier et remplacer' : 'Vérifier et connecter'}</button>`
    + `</div></form>`
    + `${provider.error ? `<p class="form-error">${escapeHtml(provider.error)}</p>` : ''}`;
}

// Onglet Dépenses d'un accès API : montant de départ, puis recharges détectées.
function apiSpendingBody(provider) {
  const spending = provider.spending;
  if (!spending) {
    return `<form id="spending-form"><p class="hint">Indique le montant de ta dernière recharge : le suivi `
      + `démarre à partir de là. Ensuite, chaque hausse du solde est comptée automatiquement comme une `
      + `recharge payée ; tu pourras marquer un crédit offert.</p>`
      + `<div class="fields">${inputField('Montant de départ', 'startAmount', '', 'number',
        'min="0" max="1000000000" step="0.01" required placeholder="Ex. 10"')}</div>`
      + `${provider.snapshot?.balances?.length ? '' : '<p class="hint">Le solde de ce service n’est pas encore lu : '
        + 'connecte-le pour que les recharges soient détectées.</p>'}`
      + `<p class="form-error" role="alert"></p>`
      + `<div class="form-actions"><button type="submit" class="primary">Démarrer le suivi</button></div></form>`;
  }
  const currency = spending.currency || 'USD';
  const totals = provider.spendingTotals || { thisMonth: 0, total: spending.startAmount };
  const since = new Date(spending.startedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  const topUps = (spending.topUps || []).slice(0, 20).map(topUp =>
    `<li class="top-up${topUp.offered ? ' is-offered' : ''}">`
    + `<span>${new Date(topUp.at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}</span>`
    + `<strong>${money(topUp.amount, currency)}</strong>`
    + `<span class="muted">${topUp.offered ? 'Crédit offert' : 'Recharge payée'}</span>`
    + `<button type="button" class="link-button" data-action="topup-toggle" data-topup="${escapeHtml(topUp.id)}"`
    + ` data-offered="${topUp.offered ? 'false' : 'true'}">${topUp.offered ? 'C’était payé' : 'C’était un crédit offert'}</button></li>`).join('');
  return `<div class="spending-totals">`
    + `<div><span>Ce mois-ci</span><strong>${money(totals.thisMonth, currency)}</strong></div>`
    + `<div><span>Depuis le ${escapeHtml(since)}</span><strong>${money(totals.total, currency)}</strong></div></div>`
    + `<p class="source-note">Montant de départ : ${money(spending.startAmount, currency)}. Une recharge est la hausse `
    + `du solde entre deux lectures : si des crédits ont été consommés entre-temps, elle était un peu plus élevée.</p>`
    + `${topUps ? `<ul class="top-ups" aria-label="Recharges détectées">${topUps}</ul>`
      : '<p class="hint">Aucune recharge détectée pour l’instant.</p>'}`
    + `<form id="spending-form" class="inline-form"><div class="fields">${inputField('Corriger le montant de départ', 'startAmount',
      spending.startAmount, 'number', 'min="0" max="1000000000" step="0.01" required')}</div>`
    + `<p class="form-error" role="alert"></p>`
    + `<div class="form-actions"><button type="button" class="secondary" data-action="spending-stop">Arrêter le suivi</button>`
    + `<button type="submit" class="primary">Enregistrer</button></div></form>`;
}

function accountConnectionBody(provider) {
  const prefix = (provider.connector.browserAccount || provider.connector.codexAccount || provider.connector.localAccount)
    ? 'account' : 'ollama';
  const progress = provider.accountConnection;
  const balanceLine = provider.connected && (provider.snapshot?.balances?.length || ollamaUsageCredits(provider))
    ? `<div class="source-note">`
      + `${provider.snapshot?.balances?.length
        ? `<strong>${escapeHtml(provider.snapshot.balanceLabel || 'Solde du portefeuille')} : `
          + `${provider.snapshot.balances.map(balance => money(balance.remaining, balance.currency)).join(' / ')}</strong>`
        : ''}`
      + `${provider.id === 'ollama'
        ? `<br><strong>${ollamaUsageCredits(provider)?.stale ? 'Dernier solde acheté connu' : 'Réserve supplémentaire'} : `
          + `${ollamaUsageCredits(provider) ? money(ollamaUsageCredits(provider).remaining, 'USD') : '—'}</strong>`
          + `${ollamaUsageCredits(provider)?.stale
            ? `<br>Dernière lecture : ${age(ollamaUsageCredits(provider).observedAt)}` : ''}`
        : ''}`
      + `${(provider.snapshot?.details || []).map(detail =>
        `<br>${escapeHtml(detail.label)} : ${money(detail.amount, detail.currency)}`).join('')}`
      + `${provider.snapshot?.resetAt
        ? `<br>Remise à zéro : ${new Date(provider.snapshot.resetAt).toLocaleString('fr-FR')}` : ''}`
      + `<br>${age(provider.snapshot?.updatedAt)}</div>`
    : '';
  const prefixLabel = provider.connector.codexAccount
    ? (provider.connected ? 'Actualiser via Codex' : 'Connecter avec Codex')
    : provider.connected ? 'Ouvrir mon compte' : `Se connecter sur ${escapeHtml(provider.name)}`;
  return `${provider.connected
    ? `<div class="${provider.error ? 'connection-note' : 'connection-success'}">${provider.error
      ? 'Session enregistrée · dernier relevé à vérifier'
      : `Session ${escapeHtml(provider.name)} enregistrée sur cet appareil`}</div>` : ''}`
    + `<p class="connection-note">${escapeHtml(provider.connector.instructions)}</p>`
    + `${progress?.message
      ? `<p class="${progress.status === 'error' ? 'form-error' : 'connection-note'}" role="status"`
        + ` id="${prefix}-connection-progress">${escapeHtml(progress.message)}</p>` : ''}`
    + `${balanceLine}`
    + `<p class="source-note">${provider.id === 'ollama'
      ? (ollamaUsageCredits(provider)?.stale
        ? 'Ollama ne fournit pas de montant plus récent ; cette valeur est le dernier solde acheté confirmé. '
        : 'Le montant des crédits achetés est affiché avec le compte Ollama. ')
      : ''}`
    + `${provider.connector.codexAccount
      ? 'La session est gérée par Codex sur ce PC.'
      : 'La session reste dans un navigateur isolé de l’application.'}`
    + ` Aucun mot de passe n’est lu par Lasmium TOKENS-HUB.</p>`
    + `<div class="form-actions">`
    + `<button type="button" class="secondary" data-action="${prefix}-open">${prefixLabel}</button>`
    + `<button type="button" class="primary" data-action="${prefix}-verify">Vérifier maintenant</button></div>`
    + `<p class="form-error" id="${prefix}-account-error" role="alert"></p>`
    + `${provider.connected
      ? `<div class="form-actions"><button type="button" class="secondary" data-action="disconnect">`
        + `Déconnecter et effacer la session</button></div>` : ''}`
    + `${provider.error ? `<p class="form-error">${escapeHtml(provider.error)}</p>` : ''}`;
}

// Claude : une seule connexion, l'abonnement via Claude Code (comme Codex).
// Trois états lisibles : connecté, valeurs conservées en attente d'un nouvel
// essai automatique, reconnexion nécessaire (bouton « Connecter Claude »).
const CLAUDE_RECONNECT_CODES = ['auth-required', 'auth-unavailable', 'auth-refused', 'not-subscription',
  'login-failed', 'login-timeout', 'cli-missing', 'cli-failed'];

function claudeConnectionState(provider) {
  const session = provider.accountSession || {};
  const progress = provider.accountConnection || {};
  const code = provider.claudeSync?.errorCode || progress.errorCode || null;
  if (progress.status === 'waiting' || progress.status === 'verifying') return { state: 'busy', code };
  if (!provider.connected || session.kind !== 'claude-live-local') return { state: 'disconnected', code };
  if (provider.error && CLAUDE_RECONNECT_CODES.includes(code)) return { state: 'reconnect', code };
  if (provider.error) return { state: 'waiting', code };
  return { state: 'connected', code };
}

function claudeConnectionBody(provider) {
  const session = provider.accountSession || {};
  const { state: status } = claudeConnectionState(provider);
  const retry = provider.claudeSync?.nextAttemptAt;
  const planName = session.plan || provider.plan;
  const subscription = `ton abonnement Claude${planName && planName !== provider.name ? ' ' + planName : ''}`;
  const account = session.email ? ` (${session.email})` : '';
  const headline = {
    connected: `<div class="connection-success">Connecté à ${escapeHtml(subscription + account)} · lecture toutes les 5 minutes</div>`,
    waiting: `<div class="connection-note">Connecté à ${escapeHtml(subscription + account)} · dernières valeurs affichées</div>`,
    reconnect: '<div class="form-error" role="status">Reconnexion nécessaire</div>',
    busy: '',
    disconnected: '',
  }[status];
  // Un échec de connexion alors que Claude n'est pas (ou plus) suivi reste
  // affiché : c'est la seule explication de l'absence de connexion.
  const failedConnection = provider.accountConnection?.status === 'error' ? provider.accountConnection.message : '';
  const message = status === 'busy' ? provider.accountConnection.message
    : (status === 'waiting' || status === 'reconnect') ? provider.error
      : failedConnection;
  const windows = provider.snapshot?.quotaWindows?.length && status !== 'disconnected'
    ? `<div class="source-note">${provider.snapshot.quotaWindows.map(window =>
      `<strong>${escapeHtml(quotaPeriodLabel(provider, QuotaResets.canonical(window.label), window.label))} : `
      + `${window.remaining} % restants</strong>`
      + `${window.resetAt ? `<br>Remise à zéro : ${new Date(window.resetAt).toLocaleString('fr-FR')}` : ''}`)
      .join('<br>')}<br>Relevé du ${new Date(provider.snapshot.updatedAt).toLocaleString('fr-FR')}`
      + ` · ${age(provider.snapshot.updatedAt)}</div>`
    : '';
  const primary = status === 'connected' || status === 'waiting'
    ? '<button type="button" class="primary" data-action="account-verify">Vérifier maintenant</button>'
    : `<button type="button" class="primary" data-action="claude-enable-live"${status === 'busy' ? ' disabled' : ''}>`
      + 'Connecter Claude</button>';
  return headline
    + `${status === 'disconnected' || status === 'reconnect'
      ? `<p class="connection-note">${escapeHtml(provider.connector.instructions)}</p>` : ''}`
    + `${message ? `<p class="${status === 'reconnect' || (status === 'disconnected' && failedConnection) ? 'form-error' : 'connection-note'}" role="status">`
      + `${escapeHtml(message)}</p>` : ''}`
    + `${status === 'waiting' && retry && Date.parse(retry) > Date.now()
      ? `<p class="connection-note">Prochain essai automatique : ${new Date(retry).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.</p>` : ''}`
    + `${windows}`
    + `<p class="source-note">La connexion est celle de Claude Code sur ce PC, toujours sur ton abonnement `
    + `(jamais une clé API). Aucun mot de passe n’est lu par Lasmium TOKENS-HUB.`
    + `${provider.connected && !state.settings.autoRefresh
      ? ' <strong>Actualisation automatique désactivée dans Réglages.</strong>' : ''}</p>`
    + `<div class="form-actions">${primary}</div>`
    + `<p class="form-error" id="account-account-error" role="alert"></p>`
    + `${provider.connected
      ? `<div class="form-actions"><button type="button" class="secondary" data-action="disconnect">`
        + `Arrêter le suivi Claude</button></div>` : ''}`;
}

function antigravityConnectionBody(provider) {
  return `<p class="connection-note">${escapeHtml(provider.connector.instructions)}</p>`
    + `${provider.accountConnection?.message
      ? `<p class="connection-note" role="status">${escapeHtml(provider.accountConnection.message)}</p>` : ''}`
    + `<div class="source-note">Ces quotas concernent les modèles utilisés dans Antigravity. `
    + `Le pourcentage principal correspond à la limite la plus basse.<br>`
    + `Antigravity 2.0 doit rester ouvert pour l’actualisation automatique.</div>`
    + `${quotaWindowsNote(provider)}`
    + `<div class="form-actions">`
    + `<button type="button" class="primary" data-action="account-open">`
    + `${provider.connected ? 'Actualiser Antigravity' : 'Connecter Antigravity'}</button>`
    + `<button type="button" class="secondary" data-action="account-verify">Vérifier maintenant</button></div>`
    + `<p class="form-error" id="account-account-error" role="alert"></p>`
    + `${provider.connected
      ? `<div class="form-actions"><button type="button" class="secondary" data-action="disconnect">`
        + `Arrêter le suivi Antigravity</button></div>` : ''}`;
}

// Abonnement : Informations + Connexion. API : Connexion (la clé) + Dépenses.
function dialogTabList(provider) {
  if (provider.type === 'subscription') {
    return [['info', 'Informations'], ...(hasConnector(provider) ? [['connection', 'Connexion']] : [])];
  }
  return [...(hasConnector(provider) ? [['connection', 'Connexion']] : []), ['spending', 'Dépenses']];
}

function normalizeDialogTab(provider, tab) {
  const ids = dialogTabList(provider).map(([id]) => id);
  return ids.includes(tab) ? tab : ids[0];
}

function dialogTabs(provider, activeTab) {
  return `<div class="dialog-tabs" role="tablist" aria-label="Sections de la fiche">`
    + dialogTabList(provider).map(([id, label]) => `<button type="button" role="tab" id="tab-${id}"`
      + ` data-dialog-tab="${id}" aria-selected="${activeTab === id}"`
      + ` aria-controls="dialog-panel" tabindex="${activeTab === id ? '0' : '-1'}"`
      + ` class="dialog-tab${activeTab === id ? ' is-active' : ''}">${label}</button>`).join('')
    + `</div>`;
}

function dialogBody(provider, activeTab) {
  if (activeTab === 'connection') return providerConnectionBody(provider);
  if (activeTab === 'spending') return apiSpendingBody(provider);
  return providerInfoBody(provider);
}

function dialogMarkup(provider, requestedTab) {
  const activeTab = normalizeDialogTab(provider, requestedTab);
  return `<div class="dialog-head">${logo(provider)}`
    + `<div class="dialog-head-text"><h2 id="detail-title">${escapeHtml(provider.name)}</h2>`
    + `<p>${provider.type === 'subscription'
      ? `Abonnement · ${escapeHtml(subscriptionPriceText(provider))}` : 'Accès API'}</p>`
    + `${levelPill(providerResourceLevel(provider),
      provider.type === 'api' ? (provider.snapshot?.balances?.[0]?.currency || 'USD') : '%',
      'dialog-level')}</div>`
    + `<button type="button" class="icon-button" data-action="close-dialog" aria-label="Fermer la fiche">`
    + `${icon('close', 20)}</button></div>`
    + dialogTabs(provider, activeTab)
    + `<div class="dialog-body" id="dialog-panel" role="tabpanel"`
    + ` aria-labelledby="tab-${escapeHtml(activeTab)}" tabindex="0">${dialogBody(provider, activeTab)}</div>`;
}
