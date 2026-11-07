const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  ollamaCookie, orcaCookie, openSubscriptionBrowser, openAccountBrowser, openOrcaBrowser, createCdpPipeTransport,
  readerArguments, stopBrowserProcess, sweepTemporaryProfiles, deleteOrcaAccountProfile,
} = require('../lib/account-browser.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lasmium-browser-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
  return dir;
}
async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

// Faux processus navigateur : seuls les flux 3/4 comptent pour le transport.
function fakeBrowser() {
  let handler = () => {};
  const inbound = new PassThrough();
  const writes = [];
  const toBrowser = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString('utf8');
      writes.push(text);
      for (const part of text.split('\0')) {
        if (!part) continue;
        let message;
        try { message = JSON.parse(part); } catch { continue; }
        handler(message, reply => inbound.write(JSON.stringify(reply) + '\0'));
      }
      callback();
    },
  });
  const child = new EventEmitter();
  child.pid = 4321; child.exitCode = null; child.signalCode = null;
  child.stdio = [null, null, null, toBrowser, inbound];
  child.kill = () => {
    if (child.exitCode != null) return;
    child.exitCode = 0;
    inbound.end();
    child.emit('exit', 0);
  };
  return { child, writes, inbound, setHandler(fn) { handler = fn; } };
}
function replyHandler(browser) {
  return (message, reply) => {
    const result = (() => {
      switch (message.method) {
        case 'Target.getTargets': return { targetInfos: [{ type: 'page', url: 'https://grok.com/dashboard', targetId: 'T1' }] };
        case 'Target.attachToTarget': return { sessionId: 'SESSION-1' };
        case 'Runtime.evaluate': return { result: { value: { authenticated: true, windows: [{ label: 'Semaine', remaining: 42, resetAt: null }] } } };
        default: return {};
      }
    })();
    reply({ id: message.id, result });
    if (message.method === 'Browser.close') queueMicrotask(() => browser.child.kill());
  };
}

test('Repeated Grok automatic refreshes use no browser window; login and explicit checks remain visible', async () => {
  const launches = [];
  const dependencies = {
    openLogin: async (...args) => { launches.push({ kind: 'login', args }); return {}; },
    openReader: async (...args) => { launches.push({ kind: 'reader', args }); return {}; },
  };
  for (let i = 0; i < 3; i++) await openSubscriptionBrowser('fixture-profile', 'grok', true, {}, dependencies);
  assert.equal(launches.length, 3);
  for (const launch of launches) {
    assert.equal(launch.kind, 'reader');
    assert.equal(launch.args[2], true, 'automatic Grok readings must be headless');
    assert.equal(launch.args[3].minimized, false, 'a minimized window is still an unwanted window');
  }
  await openSubscriptionBrowser('fixture-profile', 'grok', true, { interactive: true }, dependencies);
  assert.equal(launches.at(-1).args[2], false);
  await openSubscriptionBrowser('fixture-profile', 'grok', false, {}, dependencies);
  assert.equal(launches.at(-1).kind, 'login');
});
test('Session transfer strictly excludes Google, WorkOS and other domains', () => {
  for(const domain of ['accounts.google.com','.google.com','signin.ollama.com','.evilollama.com','ollama.com.evil.example']) assert.equal(ollamaCookie({domain,name:'session',value:'test'}),null);
  const c=ollamaCookie({domain:'.ollama.com',name:'session',value:'test',path:'/',secure:true,httpOnly:true,sameSite:'Lax',expires:1900000000});
  assert.equal(c.url,'https://ollama.com/'); assert.equal(c.sameSite,'lax'); assert.equal(c.httpOnly,true); assert.equal(c.expirationDate,1900000000);
  const host=ollamaCookie({domain:'ollama.com',name:'__Host-session',value:'test',path:'/',secure:true,httpOnly:true,expires:-1});
  assert.equal(host.domain,undefined); assert.equal(host.expirationDate,undefined);
});

test('Le lecteur n’ouvre aucun port TCP : arguments pipe, flux 3/4, aucun DevToolsActivePort', async t => {
  const dir = await tempDir(t);
  const browser = fakeBrowser();
  browser.setHandler(replyHandler(browser));
  const launches = [];
  const reader = await openAccountBrowser(dir, 'grok', true, {}, {
    findBrowser: async () => 'chrome.exe',
    spawn: (executable, args, options) => { launches.push({ executable, args, options }); return browser.child; },
  });
  assert.equal(launches.length, 1);
  const { args, options } = launches[0];
  assert.equal(launches[0].executable, 'chrome.exe');
  assert.ok(args.includes('--remote-debugging-pipe'), 'le CDP doit passer par le pipe');
  assert.ok(!args.some(arg => /--remote-debugging-(port|address)/.test(arg)), 'aucun port TCP de débogage');
  assert.ok(!args.some(arg => /DevToolsActivePort/.test(arg)));
  assert.equal(args.filter(arg => arg.startsWith('--user-data-dir=')).length, 1);
  assert.equal(args.at(-1), 'https://grok.com/dashboard');
  assert.deepEqual(options.stdio.slice(3), ['pipe', 'pipe']);
  assert.deepEqual(options.stdio.slice(0, 3), ['ignore', 'ignore', 'ignore']);
  assert.equal(options.windowsHide, true);
  assert.equal(await exists(path.join(dir, 'account-browsers', 'grok', 'DevToolsActivePort')), false);

  const page = await reader.readSubscriptionPage();
  assert.deepEqual(page.windows, [{ label: 'Semaine', remaining: 42, resetAt: null }]);
  assert.equal(reader.isOpen(), true);

  // Chaque message sortant est un JSON terminé par NUL ; la session CDP est
  // transmise dans l'enveloppe, comme sur le WebSocket d'origine.
  assert.ok(browser.writes.length > 0);
  assert.ok(browser.writes.every(chunk => chunk.endsWith('\0')));
  const messages = browser.writes.join('').split('\0').filter(Boolean).map(JSON.parse);
  assert.ok(messages.some(message => message.method === 'Runtime.evaluate' && message.sessionId === 'SESSION-1'));
  assert.ok(messages.some(message => message.method === 'Target.attachToTarget' && message.params.flatten === true));

  await reader.close();
  assert.equal(reader.isOpen(), false);
  assert.ok(browser.child.exitCode != null, 'le navigateur doit être réellement arrêté');
  await reader.close(); // idempotent
});
test('Un navigateur qui sort avant de répondre échoue vite et proprement', async t => {
  const dir = await tempDir(t);
  const browser = fakeBrowser();
  const started = Date.now();
  await assert.rejects(openAccountBrowser(dir, 'grok', true, {}, {
    findBrowser: async () => 'chrome.exe',
    spawn: () => { setImmediate(() => browser.child.kill()); return browser.child; },
  }), /s’est arrêté avant la vérification/);
  assert.ok(Date.now() - started < 5000, 'détection bornée d’un processus déjà sorti');
});
test('Transport pipe : framing partiel, messages multiples, événements ignorés et erreur CDP', async () => {
  const outbound = new PassThrough(), inbound = new PassThrough();
  const transport = createCdpPipeTransport({ toBrowser: outbound, fromBrowser: inbound, timeoutMs: 1000 });
  const written = [];
  outbound.on('data', chunk => written.push(chunk.toString('utf8')));
  const sent = () => written.join('').split('\0').filter(Boolean).map(JSON.parse);
  assert.equal(transport.isOpen(), true);

  // 1. Réponse coupée en deux écritures : rien ne résout avant le NUL final.
  let settled = false;
  const partial = transport.command('Target.getTargets').then(value => { settled = true; return value; });
  await tick();
  const first = sent().at(-1);
  const payload = JSON.stringify({ id: first.id, result: { targetInfos: [] } });
  inbound.write(payload.slice(0, 7));
  await tick();
  assert.equal(settled, false);
  inbound.write(payload.slice(7) + '\0');
  assert.deepEqual(await partial, { targetInfos: [] });

  // 2. Plusieurs messages (dont un événement sans id et un JSON invalide) dans le même lot.
  const one = transport.command('One'), two = transport.command('Two');
  await tick();
  const [firstId, secondId] = sent().slice(-2).map(message => message.id);
  inbound.write('{invalide\0' + JSON.stringify({ method: 'Target.targetCreated', params: {} }) + '\0'
    + JSON.stringify({ id: firstId, result: { n: 1 } }) + '\0'
    + JSON.stringify({ id: secondId, result: { n: 2 } }) + '\0');
  assert.deepEqual(await one, { n: 1 });
  assert.deepEqual(await two, { n: 2 });

  // 3. Une erreur CDP ne fuit pas ses détails vers l'UI.
  const failing = transport.command('Boom');
  await tick();
  inbound.write(JSON.stringify({ id: sent().at(-1).id, error: { message: 'secret interne', data: 'pile' } }) + '\0');
  await assert.rejects(failing, error => error.message === 'La lecture de la session a échoué.' && !error.message.includes('secret'));

  // 4. Fermeture du flux : les demandes en attente échouent et le transport se ferme.
  const pending = transport.command('Pending');
  await tick();
  inbound.end();
  await assert.rejects(pending, /navigateur a été fermé/);
  assert.equal(transport.isOpen(), false);
  await assert.rejects(transport.command('AfterClose'), /fenêtre du navigateur est fermée/);
  transport.close();
});
test('Transport pipe : délai borné, close() rejette l’attente, une réponse tardive est ignorée', async () => {
  const slowOutbound = new PassThrough(), slowInbound = new PassThrough();
  const slow = createCdpPipeTransport({ toBrowser: slowOutbound, fromBrowser: slowInbound, timeoutMs: 20 });
  await assert.rejects(slow.command('Slow'), /ne répond pas/);
  const pending = slow.command('Pending');
  slow.close();
  await assert.rejects(pending, /navigateur a été fermé/);
  assert.equal(slow.isOpen(), false);

  const outbound = new PassThrough(), inbound = new PassThrough();
  const written = [];
  outbound.on('data', chunk => written.push(chunk.toString('utf8')));
  const transport = createCdpPipeTransport({ toBrowser: outbound, fromBrowser: inbound, timeoutMs: 1000 });
  const answer = transport.command('Answer');
  await tick();
  const id = written.join('').split('\0').filter(Boolean).map(JSON.parse).at(-1).id;
  inbound.write(JSON.stringify({ id: id + 999, result: { ignore: true } }) + '\0'); // réponse inconnue
  inbound.write(JSON.stringify({ id, result: { ok: true } }) + '\0');
  assert.deepEqual(await answer, { ok: true });
  transport.close();
});
test('Arguments du lecteur : pipe partout, port nulle part, fenêtre visible conservée', () => {
  const headless = readerArguments('C:\\data\\profile', 'https://grok.com/dashboard', { headless: true });
  assert.ok(headless.includes('--remote-debugging-pipe'));
  assert.ok(headless.includes('--headless=new'));
  assert.ok(!headless.some(arg => /remote-debugging-(port|address)/.test(arg)));
  const visible = readerArguments('C:\\data\\profile', 'https://claude.ai/settings/usage', { headless: false, minimized: true });
  assert.ok(visible.includes('--new-window'));
  assert.ok(visible.includes('--start-minimized'));
  assert.ok(visible.includes('--remote-debugging-pipe'), 'la vérification interactive lit par pipe, sans port');
  assert.ok(!visible.some(arg => /remote-debugging-(port|address)/.test(arg)));
  assert.equal(visible.at(-1), 'https://claude.ai/settings/usage');
});
function minimalChild({ stubborn = false } = {}) {
  const child = new EventEmitter();
  child.pid = 9876; child.exitCode = null; child.signalCode = null;
  child.kill = () => { if (stubborn) return; child.exitCode = 0; child.emit('exit', 0); };
  return child;
}
test('Arrêt de processus : exit réel, puis kill, puis arbre de processus en repli borné', async () => {
  const already = minimalChild(); already.exitCode = 0;
  assert.equal(await stopBrowserProcess(already), true);

  const graceful = minimalChild();
  assert.equal(await stopBrowserProcess(graceful, true, { gracefulMs: 10, killMs: 100, treeMs: 100 }), true);
  assert.equal(graceful.exitCode, 0);

  let treeCalls = 0;
  const stubborn = minimalChild({ stubborn: true });
  const stopped = await stopBrowserProcess(stubborn, false, {
    gracefulMs: 5, killMs: 5, treeMs: 500,
    killTree: async child => { treeCalls++; child.exitCode = 9; child.emit('exit', 9); },
  });
  assert.equal(stopped, true);
  assert.equal(treeCalls, 1, 'taskkill /T /F est le repli quand kill() ne suffit pas');
});
test('sweepTemporaryProfiles purge les profils temporaires orphelins sans toucher aux sessions dédiées', async t => {
  const dir = await tempDir(t);
  assert.deepEqual(await sweepTemporaryProfiles(path.join(dir, 'absent')), { removed: 0, failed: 0 });

  const temporary = path.join(dir, 'temporary-account-browsers');
  await fs.mkdir(path.join(temporary, 'ollama-abc', 'Default'), { recursive: true });
  await fs.writeFile(path.join(temporary, 'ollama-abc', 'Default', 'Cookies'), 'session');
  await fs.writeFile(path.join(temporary, 'stray-file'), 'x');
  const dedicated = path.join(dir, 'account-browsers', 'grok');
  await fs.mkdir(dedicated, { recursive: true });
  await fs.writeFile(path.join(dedicated, 'keep'), 'session conservée');

  const result = await sweepTemporaryProfiles(dir);
  assert.equal(result.removed, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(await fs.readdir(temporary), []);
  assert.equal(await fs.readFile(path.join(dedicated, 'keep'), 'utf8'), 'session conservée');
});
test('sweepTemporaryProfiles supprime un lien sans jamais effacer sa cible', async t => {
  const dir = await tempDir(t);
  const temporary = path.join(dir, 'temporary-account-browsers');
  const outside = path.join(dir, 'cible-externe');
  await fs.mkdir(temporary, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'garder'), 'intact');
  try { await fs.symlink(outside, path.join(temporary, 'lien'), 'junction'); }
  catch { t.skip('création de lien non autorisée sur cette machine'); return; }

  await sweepTemporaryProfiles(dir);
  assert.equal(await fs.readFile(path.join(outside, 'garder'), 'utf8'), 'intact');
  assert.equal(await exists(path.join(temporary, 'lien')), false);
});

test('OrcaRouter : seuls les cookies www.orcarouter.ai et orcarouter.ai sont transférés', () => {
  for (const domain of ['github.com', '.google.com', 'login.microsoftonline.com', 'evilorcarouter.ai', 'orcarouter.ai.evil.example', 'api.orcarouter.ai'])
    assert.equal(orcaCookie({ domain, name: 'session', value: 'test' }), null, domain);
  const apex = orcaCookie({ domain: '.orcarouter.ai', name: 'session', value: 'test', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
  assert.equal(apex.url, 'https://orcarouter.ai/'); assert.equal(apex.domain, '.orcarouter.ai'); assert.equal(apex.sameSite, 'lax');
  const host = orcaCookie({ domain: 'www.orcarouter.ai', name: 'session', value: 'test', path: '/console' });
  assert.equal(host.url, 'https://www.orcarouter.ai/console'); assert.equal(host.domain, undefined);
});

test('OrcaRouter : Chrome ordinaire sans pipe, puis lecteur sans fenêtre qui lit le compte et les cookies', async t => {
  const dir = await tempDir(t);
  const login = new EventEmitter();
  login.exitCode = null; login.kill = () => {};
  const launches = [];
  const browser = fakeBrowser();
  const evaluated = [];
  browser.setHandler((message, reply) => {
    const result = (() => {
      switch (message.method) {
        case 'Target.getTargets': return { targetInfos: [{ type: 'page', url: 'https://accounts.google.com/x', targetId: 'G' }, { type: 'page', url: 'https://www.orcarouter.ai/console', targetId: 'O' }] };
        case 'Target.attachToTarget': assert.equal(message.params.targetId, 'O'); return { sessionId: 'S' };
        case 'Runtime.evaluate': evaluated.push(message.params.expression); return { result: { value: { userId: 12, workspaceId: 34 } } };
        case 'Network.getCookies': return { cookies: [{ domain: 'www.orcarouter.ai', name: 'session', value: 'v', path: '/' }, { domain: '.github.com', name: 'gh', value: 'x', path: '/' }] };
        default: return {};
      }
    })();
    reply({ id: message.id, result });
    if (message.method === 'Browser.close') queueMicrotask(() => browser.child.kill());
  });
  let profileLocked = false;
  const native = await openOrcaBrowser(dir, {
    launchFailureMs: 0,
    profileInUse: () => profileLocked,
    findBrowser: async () => 'chrome.exe',
    spawn: (executable, args, options) => {
      launches.push({ args, options });
      if (launches.length === 1) { queueMicrotask(() => login.emit('spawn')); return login; }
      return browser.child;
    },
  });
  const [first] = launches;
  assert.ok(!first.args.includes('--remote-debugging-pipe'), 'la connexion se fait dans un navigateur ordinaire');
  assert.equal(first.args.at(-1), 'https://www.orcarouter.ai/console');
  assert.ok(first.args.includes(`--user-data-dir=${path.resolve(dir, 'account-browsers', 'orcarouter')}`));
  assert.equal(native.phase(), 'login');
  await assert.rejects(native.readOrcaSession(), { code: 'ORCA_LOGIN_PENDING' });
  // Profil déjà ouvert dans une autre fenêtre : Chrome rend la main aussitôt,
  // mais la connexion continue tant que le profil est utilisé.
  profileLocked = true;
  login.emit('exit', 0);
  assert.equal(native.phase(), 'login');
  await assert.rejects(native.readOrcaSession(), { code: 'ORCA_LOGIN_PENDING' });
  profileLocked = false;
  assert.equal(native.phase(), 'verifying');
  const session = await native.readOrcaSession();
  assert.deepEqual(session.ref, { userId: 12, workspaceId: 34 });
  assert.deepEqual(session.cookies.map(cookie => cookie.name), ['session'], 'aucun cookie GitHub ou Google');
  assert.ok(launches[1].args.includes('--headless=new'));
  assert.ok(evaluated.every(expression => !/cookie|token/i.test(expression)), 'aucun jeton lu dans la page');
  assert.equal(native.phase(), 'closed');
  assert.ok(browser.child.exitCode != null, 'le lecteur est arrêté');
  // Déconnexion : le profil dédié est supprimé.
  assert.equal(await exists(path.join(dir, 'account-browsers', 'orcarouter')), true);
  await deleteOrcaAccountProfile(dir);
  assert.equal(await exists(path.join(dir, 'account-browsers', 'orcarouter')), false);
});

test('Connexion OrcaRouter : un navigateur qui se ferme dès son ouverture est signalé clairement', async t => {
  const dir = await tempDir(t);
  const login = new EventEmitter();
  login.kill = () => {};
  let readerOpened = 0;
  const native = await openOrcaBrowser(dir, {
    profileInUse: () => false,
    findBrowser: async () => 'chrome.exe',
    openReader: async () => { readerOpened++; throw new Error('ne doit pas être ouvert'); },
    spawn: () => { queueMicrotask(() => login.emit('spawn')); return login; },
  });
  login.emit('exit', 0);
  assert.equal(native.phase(), 'verifying');
  await assert.rejects(native.readOrcaSession(), { code: 'BROWSER_FAILED', message: /fermé dès son ouverture/ });
  assert.equal(readerOpened, 0, 'aucun lecteur lancé sur un profil jamais ouvert');
  assert.equal(native.phase(), 'closed');
});
