'use strict';

// Connexion Claude simplifiée : comme pour Codex, Lasmium TOKENS-HUB confie la
// connexion au logiciel officiel. Claude Code ouvre la connexion au compte
// Claude dans le navigateur (`claude auth login --claudeai`) et indique le
// compte connecté (`claude auth status --json`). Aucun jeton ne transite par
// ce module : seul le statut (connecté, méthode, forfait, e-mail) est lu.

const fs = require('node:fs/promises');
const path = require('node:path');
// Lu à l'appel (et non déstructuré) : les smokes Electron simulent Claude Code
// dans le processus principal sans jamais lancer le vrai logiciel.
const childProcess = require('node:child_process');
const { ClaudeError } = require('./claude-connection.cjs');

const STATUS_TIMEOUT_MS = 20000;
const RENEW_TIMEOUT_MS = 90000;
const LOGIN_TIMEOUT_MS = 5 * 60000;
const MAX_OUTPUT = 64 * 1024;

// Variables qui feraient utiliser à Claude Code une autre connexion que
// l'abonnement claude.ai : clé API facturée à l'usage, jeton longue durée sans
// accès aux quotas, passerelle ou fournisseur cloud, session parente.
const OVERRIDES = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
];

function subscriptionEnv(env = process.env) {
  const copy = { ...env };
  for (const name of Object.keys(copy)) if (OVERRIDES.includes(name.toUpperCase())) delete copy[name];
  return copy;
}

const PLAN_NAMES = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' };
function planName(subscription) {
  return typeof subscription === 'string' ? PLAN_NAMES[subscription.toLowerCase()] || null : null;
}

async function findClaude({ env = process.env, access = fs.access } = {}) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const candidates = dirs.map(dir => path.join(dir, 'claude.exe'));
  // Emplacement de l'installeur officiel, absent du PATH d'une application lancée
  // avant l'installation de Claude Code.
  if (env.USERPROFILE) candidates.push(path.join(env.USERPROFILE, '.local', 'bin', 'claude.exe'));
  for (const candidate of [...new Set(candidates)]) {
    try { await access(candidate); return candidate; } catch { /* candidat suivant */ }
  }
  throw new ClaudeError('cli-missing');
}

// Exécute Claude Code sans fenêtre, sans entrée et avec un délai maximal.
function run(file, args, { env, timeout, cwd, spawnImpl = (...spawnArgs) => childProcess.spawn(...spawnArgs) } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(file, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}) }); }
    catch { reject(new ClaudeError('cli-failed')); return; }
    let stdout = '', stderr = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { try { child.kill(); } catch { /* déjà arrêté */ } reject(error); }
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new ClaudeError(timeout >= LOGIN_TIMEOUT_MS ? 'login-timeout' : 'cli-failed')), timeout);
    timer.unref?.();
    child.stdout?.on('data', chunk => { if (stdout.length < MAX_OUTPUT) stdout += chunk; });
    child.stderr?.on('data', chunk => { if (stderr.length < MAX_OUTPUT) stderr += chunk; });
    child.on('error', () => finish(new ClaudeError('cli-failed')));
    child.on('close', code => finish(null, { code, stdout, stderr }));
  });
}

function parseStatus(text) {
  let body;
  try { body = JSON.parse(String(text).trim()); } catch { throw new ClaudeError('cli-failed'); }
  if (!body || typeof body !== 'object' || typeof body.loggedIn !== 'boolean') throw new ClaudeError('cli-failed');
  const clean = value => (typeof value === 'string' && value.length <= 200 && !/[\r\n]/.test(value) ? value : null);
  return {
    loggedIn: body.loggedIn,
    method: clean(body.authMethod),
    subscription: clean(body.subscriptionType),
    email: clean(body.email),
    loginExpiresAt: Number.isFinite(Date.parse(body.loginExpiresAt)) ? new Date(body.loginExpiresAt).toISOString() : null,
  };
}

function createClaudeCli({ env = process.env, spawnImpl = (...args) => childProcess.spawn(...args), access = fs.access, find = findClaude } = {}) {
  const runClaude = async (args, timeout, cwd) => run(await find({ env, access }), args, { env: subscriptionEnv(env), timeout, cwd, spawnImpl });

  async function status() {
    const result = await runClaude(['auth', 'status', '--json'], STATUS_TIMEOUT_MS);
    // « Non connecté » sort avec un code non nul mais un JSON valide.
    return parseStatus(result.stdout);
  }

  // Abonnement Claude uniquement : une connexion par clé API ou par jeton
  // longue durée ne donne pas accès aux quotas du forfait.
  async function subscription() {
    const current = await status();
    if (!current.loggedIn) throw new ClaudeError('auth-unavailable');
    if (current.method !== 'claude.ai') throw new ClaudeError('not-subscription');
    return { ...current, plan: planName(current.subscription) };
  }

  async function login() {
    const result = await runClaude(['auth', 'login', '--claudeai'], LOGIN_TIMEOUT_MS);
    if (result.code !== 0) throw new ClaudeError('login-failed');
    return subscription();
  }

  // Renouvellement de la connexion par Claude Code lui-même : un lancement
  // non interactif (-p, sans question de confiance du dossier) renouvelle le
  // jeton à son démarrage. Requête minimale sur l'abonnement (Haiku, aucun
  // outil, aucune conversation conservée), dans un dossier dédié et vide.
  async function renewConnection({ cwd } = {}) {
    if (cwd) await fs.mkdir(cwd, { recursive: true });
    const result = await runClaude(['-p', 'Réponds uniquement : OK', '--model', 'haiku', '--no-session-persistence', '--tools', ''],
      RENEW_TIMEOUT_MS, cwd);
    if (result.code !== 0) throw new ClaudeError('cli-failed');
  }

  return { status, subscription, login, renewConnection };
}

module.exports = { createClaudeCli, findClaude, subscriptionEnv, parseStatus, planName, run, OVERRIDES, STATUS_TIMEOUT_MS, LOGIN_TIMEOUT_MS, RENEW_TIMEOUT_MS };
