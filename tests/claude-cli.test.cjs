'use strict';
// Connexion Claude déléguée à Claude Code : environnement « abonnement
// seulement », recherche de l'exécutable, lecture du statut et connexion, sans
// lancer le vrai Claude Code (processus simulé).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createClaudeCli, findClaude, subscriptionEnv, parseStatus, planName, run, OVERRIDES, LOGIN_TIMEOUT_MS } = require('../lib/claude-cli.cjs');

const STATUS = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'moi@example.test',
  subscriptionType: 'max', loginExpiresAt: '2026-12-05T00:57:32.463Z', orgId: 'org-test' };

// Processus simulé : sortie, code de retour, erreur de lancement ou blocage.
function fakeSpawn(script) {
  const launches = [];
  const spawnImpl = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    const step = script(args);
    launches.push({ file, args, options, child });
    if (step.throws) throw new Error('spawn impossible');
    setImmediate(() => {
      if (step.error) { child.emit('error', new Error('ENOENT')); return; }
      if (step.hang) return;
      if (step.stdout) child.stdout.emit('data', step.stdout);
      if (step.stderr) child.stderr.emit('data', step.stderr);
      child.emit('close', step.code ?? 0);
    });
    return child;
  };
  return { spawnImpl, launches };
}

const cli = (script, env = { PATH: '' }) => {
  const fake = fakeSpawn(script);
  return { ...fake, claude: createClaudeCli({ env, spawnImpl: fake.spawnImpl, find: async () => 'C:/outils/claude.exe' }) };
};

test('subscriptionEnv retire toute connexion autre que l’abonnement, quelle que soit la casse', () => {
  const env = { PATH: 'C:/bin', ANTHROPIC_API_KEY: 'cle', claude_code_oauth_token: 'jeton', ANTHROPIC_AUTH_TOKEN: 'x', CLAUDECODE: '1', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' };
  const clean = subscriptionEnv(env);
  assert.deepEqual(clean, { PATH: 'C:/bin', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' });
  assert.equal(env.ANTHROPIC_API_KEY, 'cle', 'l’environnement d’origine n’est pas modifié');
  for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK']) assert.ok(OVERRIDES.includes(name));
});

test('findClaude cherche dans le PATH puis l’installation officielle, sinon demande l’installation', async () => {
  const seen = [];
  const accessOnly = allowed => async file => { seen.push(file); if (!allowed.includes(file)) throw new Error('absent'); };
  const inPath = path.join('C:/outils', 'claude.exe');
  assert.equal(await findClaude({ env: { PATH: ['C:/autre', 'C:/outils'].join(path.delimiter) }, access: accessOnly([inPath]) }), inPath);
  const official = path.join('C:/Users/moi', '.local', 'bin', 'claude.exe');
  assert.equal(await findClaude({ env: { Path: 'C:/autre', USERPROFILE: 'C:/Users/moi' }, access: accessOnly([official]) }), official);
  await assert.rejects(findClaude({ env: {}, access: accessOnly([]) }), { code: 'cli-missing', message: /n’est pas installé/ });
});

test('parseStatus ne garde que le statut utile et refuse une sortie illisible', () => {
  assert.deepEqual(parseStatus(JSON.stringify(STATUS)), { loggedIn: true, method: 'claude.ai', subscription: 'max', email: 'moi@example.test', loginExpiresAt: '2026-12-05T00:57:32.463Z' });
  assert.deepEqual(parseStatus('{"loggedIn":false,"authMethod":"none","loginExpiresAt":null}'), { loggedIn: false, method: 'none', subscription: null, email: null, loginExpiresAt: null });
  assert.equal(parseStatus(JSON.stringify({ ...STATUS, email: 'a\nb' })).email, null);
  for (const bad of ['', 'pas du json', '[]', '{"authMethod":"claude.ai"}']) assert.throws(() => parseStatus(bad), { code: 'cli-failed' });
  assert.equal(planName('max'), 'Max');
  assert.equal(planName('PRO'), 'Pro');
  assert.equal(planName('inconnu'), null);
  assert.equal(planName(null), null);
});

test('subscription lit le statut avec un environnement « abonnement seulement »', async () => {
  const { claude, launches } = cli(() => ({ stdout: JSON.stringify(STATUS) }), { PATH: '', ANTHROPIC_API_KEY: 'cle', CLAUDE_CODE_OAUTH_TOKEN: 'jeton' });
  assert.deepEqual(await claude.subscription(), { loggedIn: true, method: 'claude.ai', subscription: 'max', email: 'moi@example.test', loginExpiresAt: '2026-12-05T00:57:32.463Z', plan: 'Max' });
  assert.deepEqual(launches[0].args, ['auth', 'status', '--json']);
  assert.equal(launches[0].options.windowsHide, true);
  assert.equal(launches[0].options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(launches[0].options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('subscription refuse un Claude Code non connecté ou connecté hors abonnement', async () => {
  const off = cli(() => ({ code: 1, stdout: '{"loggedIn":false,"authMethod":"none"}' }));
  await assert.rejects(off.claude.subscription(), { code: 'auth-unavailable' });
  const apiKey = cli(() => ({ stdout: JSON.stringify({ ...STATUS, authMethod: 'api_key', subscriptionType: null }) }));
  await assert.rejects(apiKey.claude.subscription(), { code: 'not-subscription', message: /abonnement Claude \(Pro ou Max\)/ });
  const broken = cli(() => ({ stdout: 'erreur inattendue' }));
  await assert.rejects(broken.claude.subscription(), { code: 'cli-failed' });
  const crashed = cli(() => ({ error: true }));
  await assert.rejects(crashed.claude.subscription(), { code: 'cli-failed' });
  const unlaunchable = cli(() => ({ throws: true }));
  await assert.rejects(unlaunchable.claude.subscription(), { code: 'cli-failed' });
});

test('login lance la connexion officielle sur l’abonnement puis relit le statut', async () => {
  const { claude, launches } = cli(args => (args[1] === 'login' ? { code: 0, stdout: 'Opening browser to sign in…\nLogin successful.' } : { stdout: JSON.stringify(STATUS) }));
  const identity = await claude.login();
  assert.equal(identity.plan, 'Max');
  assert.deepEqual(launches.map(item => item.args), [['auth', 'login', '--claudeai'], ['auth', 'status', '--json']]);
  const failed = cli(() => ({ code: 1, stderr: 'OAuth error' }));
  await assert.rejects(failed.claude.login(), { code: 'login-failed', message: /n’a pas abouti/ });
});

test('run arrête un Claude Code bloqué : délai de connexion distinct du délai de statut', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { spawnImpl, launches } = fakeSpawn(() => ({ hang: true }));
  const login = run('claude.exe', ['auth', 'login'], { env: {}, timeout: LOGIN_TIMEOUT_MS, spawnImpl });
  const status = run('claude.exe', ['auth', 'status'], { env: {}, timeout: 20000, spawnImpl });
  t.mock.timers.tick(LOGIN_TIMEOUT_MS);
  await assert.rejects(login, { code: 'login-timeout', message: /5 minutes/ });
  await assert.rejects(status, { code: 'cli-failed' });
  assert.ok(launches.every(item => item.child.killed), 'les processus bloqués sont arrêtés');
});

test('renewConnection lance Claude Code sans fenêtre ni conversation, dans un dossier dédié', async t => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'lasmium-renew-')), 'claude-code');
  t.after(() => fs.rm(path.dirname(dir), { recursive: true, force: true }));
  const { claude, launches } = cli(() => ({ code: 0, stdout: 'OK' }), { PATH: '', ANTHROPIC_API_KEY: 'cle' });
  await claude.renewConnection({ cwd: dir });
  assert.deepEqual(launches[0].args, ['-p', 'Réponds uniquement : OK', '--model', 'haiku', '--no-session-persistence', '--tools', '']);
  assert.equal(launches[0].options.cwd, dir);
  assert.equal(launches[0].options.windowsHide, true);
  assert.equal(launches[0].options.env.ANTHROPIC_API_KEY, undefined, 'toujours sur l’abonnement');
  assert.ok((await fs.stat(dir)).isDirectory(), 'dossier dédié créé');
  const failing = cli(() => ({ code: 1, stderr: 'erreur' }));
  await assert.rejects(failing.claude.renewConnection(), { code: 'cli-failed' });
});
