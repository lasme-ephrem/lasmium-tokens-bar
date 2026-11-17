'use strict';

// Parcours d'authentification et de lecture propres aux fournisseurs à compte.
// main.cjs ne connaît plus leurs fenêtres, timers ni états internes : il injecte
// les services Electron et reçoit des méthodes stables.
//
// Claude : une seule connexion, celle de l'abonnement Claude via Claude Code
// (comme Codex pour OpenAI). « Connecter Claude » délègue la connexion à
// `claude auth login`, puis les quotas sont lus auprès d'Anthropic.
const CLAUDE_CONNECTED_MESSAGE = 'Connecté à ton abonnement Claude. Quotas à jour ; nouvelle lecture toutes les 5 minutes.';
const CLAUDE_LOGIN_MESSAGE = 'Connexion en cours : termine la connexion à ton compte Claude dans ton navigateur.';

function createProviderFlows({
  BrowserWindow,
  secureAccountWindow,
  ACCOUNT_ORIGINS,
  OLLAMA_ORIGIN,
  SETTINGS_URL,
  dataDir,
  getState,
  getMainWindow,
  provider,
  isTracked,
  disconnecting,
  busy,
  isQuitting = () => false,
  broadcast,
  persist,
  publicState,
  record,
  markHealthSuccess,
  markHealthFailure,
  showMain,
  syncOne,
  claudeReader,
  claudeCli,
  antigravityTransport,
  fetchOllamaCredits,
  ollamaSession,
  openOllamaBrowser,
  assumeOllamaFree,
} = {}) {
  let ollamaLoginWindow, ollamaDetectionTimer, ollamaVerification;
  let ollamaBrowser, ollamaBrowserOpening;
  let ollamaConnection = { status: 'idle', message: '' };
  let antigravityWork;
  let antigravityConnection = { status: 'idle', message: '' };
  let claudeConnection = { status: 'idle', message: '' };
  let claudeWork;

  // credentialsChanged : Claude Code (connexion ou renouvellement) vient de
  // réécrire son fichier de connexion : un cooldown d'authentification est levé.
  function syncClaudeWhenDue({ credentialsChanged = false } = {}) {
    const state = getState();
    const p = state?.providers.find(item => item.id === 'claude');
    if (credentialsChanged) claudeReader.credentialsChanged();
    if (isQuitting() || !state?.settings.autoRefresh || !p || !isTracked(p) || p.accountSession?.kind !== 'claude-live-local') return;
    if (Date.parse(claudeReader.info().nextAttemptAt) > Date.now()) return;
    syncOne('claude', { force: false }).catch(() => {});
  }

  function claudeSession(p, identity) {
    const session = { kind: 'claude-live-local' };
    const previous = p.accountSession?.kind === 'claude-live-local' ? p.accountSession : {};
    const plan = identity?.plan ?? previous.plan;
    const email = identity?.email ?? previous.email;
    if (plan) session.plan = plan;
    if (email) session.email = email;
    return session;
  }

  // Lecture des quotas de l'abonnement. `manual` (bouton Vérifier) lève un
  // cooldown d'authentification pour retenter tout de suite.
  async function verifyClaude({ manual = false } = {}) {
    if (disconnecting.has('claude') || isQuitting()) throw new Error('Déconnexion en cours.');
    if (claudeWork) return claudeWork;
    claudeWork = (async () => {
      const p = provider('claude');
      if (manual) claudeReader.credentialsChanged();
      claudeConnection = { status: 'verifying', message: 'Lecture de tes quotas Claude…' };
      p.accountSession = claudeSession(p);
      p.lastAttempt = new Date().toISOString(); broadcast();
      try {
        const snapshot = await claudeReader.read();
        if (p.snapshot?.updatedAt !== snapshot.updatedAt || p.snapshot?.connectorVersion !== snapshot.connectorVersion) record(p, snapshot);
        else { p.snapshot = snapshot; p.error = null; markHealthSuccess(p, snapshot); }
        claudeConnection = { status: 'connected', message: CLAUDE_CONNECTED_MESSAGE };
      } catch (error) {
        p.error = error.message;
        markHealthFailure(p, error);
        claudeConnection = { status: 'error', message: error.message, errorCode: error.code || null };
        throw error;
      } finally {
        p.claudeSync = claudeReader.info();
        Object.assign(claudeConnection, p.claudeSync);
        await persist(); broadcast();
      }
      return publicState();
    })();
    const work = claudeWork;
    try { return await work; } finally { if (claudeWork === work) claudeWork = null; }
  }

  // « Connecter Claude » : si Claude Code est déjà connecté à l'abonnement, la
  // lecture suffit ; sinon (ou si la connexion est refusée) la connexion
  // officielle s'ouvre dans le navigateur, puis les quotas sont relus.
  async function connectClaude() {
    if (disconnecting.has('claude') || isQuitting()) throw new Error('Déconnexion en cours.');
    await claudeWork?.catch(() => {});
    const p = provider('claude');
    const fail = error => {
      claudeConnection = { status: 'error', message: error.message, errorCode: error.code || null };
      broadcast();
      throw error;
    };
    let identity = null;
    try { identity = await claudeCli.subscription(); }
    catch (error) { if (error.code === 'cli-missing' || error.code === 'cli-failed') fail(error); }
    if (identity) {
      p.accountSession = claudeSession(p, identity);
      if (identity.plan) p.plan = identity.plan;
      try { return await verifyClaude({ manual: true }); }
      catch (error) { if (!['auth-required', 'auth-unavailable', 'auth-refused'].includes(error.code)) throw error; }
    }
    claudeConnection = { status: 'waiting', message: CLAUDE_LOGIN_MESSAGE }; broadcast();
    try { identity = await claudeCli.login(); }
    catch (error) { fail(error); }
    p.accountSession = claudeSession(p, identity);
    if (identity.plan) p.plan = identity.plan;
    return verifyClaude({ manual: true });
  }

  async function verifyAntigravity() {
    if (disconnecting.has('antigravity') || isQuitting()) throw new Error('Déconnexion en cours.');
    if (antigravityWork) return antigravityWork;
    antigravityWork = (async () => {
      const p = provider('antigravity');
      antigravityConnection = { status: 'verifying', message: 'Lecture des quotas dans Antigravity…' };
      p.lastAttempt = new Date().toISOString(); broadcast();
      try {
        const snapshot = await antigravityTransport.fetchAntigravityQuota();
        p.accountSession = { kind: 'antigravity-local' };
        record(p, snapshot);
        antigravityConnection = { status: 'connected', message: 'Antigravity connecté. Quotas disponibles Gemini, Claude/GPT et Argon lus.' };
      } catch (error) {
        p.error = error.message;
        markHealthFailure(p, error);
        antigravityConnection = { status: 'error', message: error.message };
        throw error;
      } finally { await persist(); broadcast(); }
      return publicState();
    })();
    try { return await antigravityWork; } finally { antigravityWork = null; }
  }

  async function openOllamaSystemAccount() {
    if (disconnecting.has('ollama') || isQuitting()) throw new Error('Déconnexion en cours.');
    if (['login', 'verifying'].includes(ollamaBrowser?.phase?.())) return true;
    if (ollamaBrowserOpening) return ollamaBrowserOpening;
    const work = (async () => {
      if (ollamaLoginWindow && !ollamaLoginWindow.isDestroyed()) ollamaLoginWindow.close();
      clearInterval(ollamaDetectionTimer); ollamaDetectionTimer = null;
      ollamaConnection = { status: 'waiting', message: 'Connecte-toi sur Ollama dans Chrome ou Edge, puis ferme cette fenêtre. La vérification démarrera ensuite.' }; broadcast();
      if (ollamaBrowser) { const browser = ollamaBrowser; ollamaBrowser = null; await browser.close(); }
      ollamaBrowser = await openOllamaBrowser(dataDir);
      ollamaDetectionTimer = setInterval(async () => {
        if (ollamaVerification || busy.has('ollama') || ollamaBrowser?.phase?.() !== 'verifying') return;
        clearInterval(ollamaDetectionTimer); ollamaDetectionTimer = null;
        await verifyOllamaAccount(true).catch(() => {});
      }, 750);
      ollamaDetectionTimer.unref();
      return true;
    })();
    ollamaBrowserOpening = work;
    try { return await work; }
    catch (error) { ollamaConnection = { status: 'error', message: error.message }; broadcast(); throw error; }
    finally { ollamaBrowserOpening = null; }
  }

  async function openOllamaAccount() {
    if (disconnecting.has('ollama') || isQuitting()) throw new Error('Déconnexion en cours.');
    if (ollamaLoginWindow && !ollamaLoginWindow.isDestroyed()) { ollamaLoginWindow.show(); ollamaLoginWindow.focus(); return true; }
    const isolated = ollamaSession();
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    if (!isolated.lasmiumConfigured) { isolated.on('will-download', event => event.preventDefault()); isolated.lasmiumConfigured = true; }
    ollamaLoginWindow = new BrowserWindow({ width: 1100, height: 850, title: 'Connexion au compte Ollama', parent: getMainWindow(),
      webPreferences: { partition: 'persist:ollama-account', nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false } });
    secureAccountWindow(ollamaLoginWindow, ACCOUNT_ORIGINS);
    ollamaConnection = { status: 'waiting', message: 'Connecte-toi sur Ollama. Les crédits seront récupérés automatiquement.' }; broadcast();
    const loginWindow = ollamaLoginWindow;
    loginWindow.on('closed', () => {
      if (ollamaLoginWindow === loginWindow) ollamaLoginWindow = null;
      if (!ollamaBrowserOpening && !ollamaBrowser) {
        clearInterval(ollamaDetectionTimer); ollamaDetectionTimer = null;
        if (ollamaConnection.status === 'waiting') ollamaConnection = { status: 'idle', message: 'Fenêtre fermée. Rouvre le compte pour reprendre la connexion.' };
      }
      broadcast();
    });
    let nextAttempt = 0;
    ollamaDetectionTimer = setInterval(async () => {
      if (!ollamaLoginWindow || ollamaLoginWindow.isDestroyed() || ollamaVerification || busy.has('ollama') || Date.now() < nextAttempt) return;
      let url;
      try { url = new URL(ollamaLoginWindow.webContents.getURL()); } catch { return; }
      if (url.origin !== OLLAMA_ORIGIN || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/signin')) return;
      nextAttempt = Date.now() + 15000;
      await verifyOllamaAccount(true).catch(() => {});
    }, 1000);
    ollamaDetectionTimer.unref();
    try { await ollamaLoginWindow.loadURL(SETTINGS_URL); }
    catch { ollamaConnection = { status: 'error', message: 'Le site Ollama ne peut pas être ouvert. Vérifie ta connexion Internet.' }; broadcast(); throw new Error(ollamaConnection.message); }
    return true;
  }

  async function verifyOllamaAccount(automatic = false) {
    if (disconnecting.has('ollama') || isQuitting()) throw new Error('Déconnexion en cours.');
    if (ollamaVerification) { await ollamaVerification; return publicState(); }
    const p = provider('ollama');
    if (busy.has(p.id)) throw new Error('Une synchronisation Ollama est déjà en cours.');
    const work = (async () => {
      try {
        if (ollamaBrowser) {
          const cookies = await ollamaBrowser.readOllamaCookies();
          if (!cookies.length) throw Object.assign(new Error('En attente de ta connexion Ollama dans le navigateur.'), { code: 'OLLAMA_SIGNIN' });
          for (const cookie of cookies) await ollamaSession().cookies.set(cookie);
          await ollamaSession().cookies.flushStore();
        }
        if (p.accountSession?.kind !== 'ollama-credits') { p.accountSession = { kind: 'ollama-credits' }; await persist(); }
        const snapshot = await fetchOllamaCredits(ollamaSession().fetch.bind(ollamaSession()), new Date(), { assumeFree: assumeOllamaFree(p) });
        await ollamaSession().cookies.flushStore();
        ollamaConnection = { status: 'verifying', message: 'Crédits Ollama récupérés. Enregistrement de la session…' };
        clearInterval(ollamaDetectionTimer); ollamaDetectionTimer = null;
        if (ollamaLoginWindow && !ollamaLoginWindow.isDestroyed()) ollamaLoginWindow.close();
        if (ollamaBrowser) { const browser = ollamaBrowser; ollamaBrowser = null; await browser.close(); }
        p.accountSession = { kind: 'ollama-credits' };
        record(p, snapshot); p.lastAttempt = snapshot.updatedAt;
        await persist();
        const freeLimitUnavailable = snapshot.planTier === 'free' && !snapshot.balances.length && snapshot.quotaRemaining === null;
        ollamaConnection = { status: 'connected', message: freeLimitUnavailable
          ? `Session Ollama active. ${snapshot.usageCredits ? 'Réserve supplémentaire à jour. ' : ''}Le site ne fournit pas le détail de la limite Free ; aucun montant mensuel n’est estimé.`
          : 'Ollama connecté. Les crédits mensuels sont à jour.' };
        showMain();
      } catch (error) {
        const code = error.code || null;
        markHealthFailure(p, error);
        if (code === 'OLLAMA_LOGIN_PENDING') ollamaConnection = { status: 'waiting', message: error.message };
        else if (code === 'OLLAMA_SIGNIN' && ollamaBrowser?.phase?.() === 'closed') {
          const browser = ollamaBrowser; ollamaBrowser = null;
          clearInterval(ollamaDetectionTimer); ollamaDetectionTimer = null;
          await browser.close().catch(() => {});
          delete p.accountSession;
          p.error = error.message;
          await persist();
          ollamaConnection = { status: 'error', message: 'Aucune session Ollama détectée après la fermeture du navigateur. Réessaie et termine la connexion Google jusqu’au retour sur Ollama.' };
        }
        else if (code === 'OLLAMA_SIGNIN') {
          delete p.accountSession;
          p.error = error.message;
          await persist();
          ollamaConnection = automatic
            ? { status: 'waiting', message: 'En attente de ta connexion sur le site officiel Ollama.' }
            : { status: 'error', message: error.message, errorCode: code };
        }
        else {
          p.error = error.message;
          await persist();
          ollamaConnection = { status: 'error', message: error.message, errorCode: code };
        }
        throw error;
      }
    })();
    ollamaVerification = work; busy.set(p.id, work); broadcast();
    try { await work; } finally { ollamaVerification = null; busy.delete(p.id); broadcast(); }
    return publicState();
  }

  async function openOllamaEmailAccount() {
    // Un lancement en cours réarme la détection après son propre await : il
    // faut l'attendre avant de nettoyer le timer, sinon celui-ci reste armé.
    await ollamaBrowserOpening?.catch(() => {});
    clearInterval(ollamaDetectionTimer); ollamaDetectionTimer = null;
    if (ollamaBrowser) { const browser = ollamaBrowser; ollamaBrowser = null; await browser.close(); }
    return openOllamaAccount();
  }

  function clearTimers() {
    clearInterval(ollamaDetectionTimer); ollamaDetectionTimer = null;
  }

  function closeWindows() {
    try { if (ollamaLoginWindow && !ollamaLoginWindow.isDestroyed()) ollamaLoginWindow.close(); } catch { /* déjà fermée */ }
    ollamaLoginWindow = null;
  }

  async function cancelClaude() {
    await claudeWork?.catch(() => {});
    claudeWork = null;
    claudeConnection = { status: 'idle', message: '' };
  }
  async function cancelAntigravity() {
    await antigravityWork?.catch(() => {});
    antigravityWork = null;
    antigravityConnection = { status: 'idle', message: '' };
  }
  async function cancelOllama() {
    await ollamaBrowserOpening?.catch(() => {});
    ollamaBrowserOpening = null;
    clearInterval(ollamaDetectionTimer); ollamaDetectionTimer = null;
    const browser = ollamaBrowser;
    ollamaBrowser = null;
    if (browser) await browser.close().catch(() => {});
    if (ollamaLoginWindow && !ollamaLoginWindow.isDestroyed()) ollamaLoginWindow.close();
    ollamaLoginWindow = null;
    ollamaConnection = { status: 'idle', message: '' };
  }
  function pending() {
    return [claudeWork, antigravityWork, ollamaVerification, ollamaBrowserOpening].filter(Boolean);
  }
  async function closeAll({ reset = false } = {}) {
    clearTimers();
    await Promise.allSettled(pending().map(item => Promise.resolve(item).catch(() => {})));
    // Un lancement de navigateur terminé pendant l'attente a réarmé sa détection.
    clearTimers();
    closeWindows();
    const browser = ollamaBrowser;
    ollamaBrowser = null;
    if (browser) await browser.close().catch(() => {});
    if (reset) {
      ollamaConnection = { status: 'idle', message: '' };
      antigravityConnection = { status: 'idle', message: '' };
      claudeConnection = { status: 'idle', message: '' };
    }
  }

  return {
    info: () => ({
      claude: claudeConnection,
      antigravity: antigravityConnection,
      ollama: ollamaConnection,
    }),
    syncClaudeWhenDue,
    verifyClaude,
    connectClaude,
    verifyAntigravity,
    openOllamaSystemAccount,
    openOllamaAccount,
    openOllamaEmailAccount,
    verifyOllamaAccount,
    cancelClaude,
    cancelAntigravity,
    cancelOllama,
    closeAll,
    pending,
  };
}

module.exports = { createProviderFlows, CLAUDE_CONNECTED_MESSAGE, CLAUDE_LOGIN_MESSAGE };
