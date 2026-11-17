'use strict';

// Orchestration des synchronisations. Les branches fournisseur (compte,
// navigateur, Claude, Antigravity, API) et le disjoncteur vivent ici plutôt que
// dans main.cjs. Les dépendances Electron restent injectées : ce module est
// testable sans lancer l'application.

function assumeOllamaFree(p) {
  // « Actif » est l'interrupteur de suivi local, pas la preuve d'un forfait
  // payant. On conserve le Free vérifié tant que la page ne fournit pas de
  // section mensuelle, plutôt que d'afficher une fausse erreur.
  return p.subscriptionStatus === 'expired' || p.snapshot?.planTier === 'free';
}

function createConnectorSync({
  getState,
  provider,
  isTracked,
  isConnected,
  disconnecting,
  busy,
  publicState,
  broadcast,
  persist,
  notify,
  record,
  markHealthFailure,
  safeStorage,
  credentials,
  fetchUsage,
  apiFetch,
  cooldowns,
  endpointFor = () => undefined,
  fetchOllamaCredits,
  ollamaSession,
  openAiAccount,
  verifyAntigravity,
  verifyClaude,
  subscriptionAccounts,
  isBrowserAccount = () => false,
  breakerOpen,
} = {}) {
  async function syncOne(id, { force = true } = {}) {
    if (disconnecting.has(id)) throw new Error('Déconnexion en cours.');
    if (busy.has(id)) { await busy.get(id); return publicState(); }
    const p = provider(id);
    if (!isTracked(p)) throw new Error(p.subscriptionStatus === 'expired' ? 'Cet abonnement est expiré. Réactive-le dans sa fiche pour reprendre la synchronisation.' : 'Ce service est en pause.');
    if (!isConnected(p)) throw new Error('Connecte ce service dans Connexions.');
    // Disjoncteur : après une panne transitoire, ne pas marteler le fournisseur.
    // Une action manuelle (« Tester ») force une tentative immédiate.
    if (!force && breakerOpen(getState().connectorHealth?.[id])) {
      return publicState();
    }
    const work = (async () => {
      p.lastAttempt = new Date().toISOString();
      try {
        cooldowns.prune(Date.now());
        if (id === 'ollama') record(p, await fetchOllamaCredits(ollamaSession().fetch.bind(ollamaSession()), new Date(), { assumeFree: assumeOllamaFree(p) }));
        else if (id === 'openai') await openAiAccount.read(p.accountSession?.identity);
        else if (id === 'antigravity') await verifyAntigravity();
        else if (id === 'claude') await verifyClaude();
        else if (isBrowserAccount(id)) await subscriptionAccounts.read(id, { background: true });
        else {
          let key;
          try { key = safeStorage.decryptString(Buffer.from(credentials.get(id), 'base64')); }
          catch { throw new Error('La clé enregistrée ne peut plus être déchiffrée sur ce compte Windows. Renseigne de nouveau la clé dans Connexions.'); }
          record(p, await fetchUsage(id, key, apiFetch, { cooldowns, endpoint: endpointFor(id) }));
        }
      } catch (error) {
        p.error = error.message;
        markHealthFailure(p, error);
        // Session explicitement invalide : repasser « non connecté » pour que la
        // prochaine action soit une reconnexion, pas une boucle d'échecs.
        if (id === 'ollama' && error.code === 'OLLAMA_SIGNIN') delete p.accountSession;
      }
      await persist();
      notify();
    })();
    busy.set(id, work);
    broadcast();
    try { await work; } finally { busy.delete(id); broadcast(); }
    return publicState();
  }

  async function syncAll({ force = false } = {}) {
    await Promise.allSettled(getState().providers.filter(p => isTracked(p) && isConnected(p)).map(p => syncOne(p.id, { force })));
    return publicState();
  }

  return { syncOne, syncAll, assumeOllamaFree };
}

module.exports = { createConnectorSync, assumeOllamaFree };
