const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createClaudeConnection, TOKEN_URL, CLIENT_ID, EXPIRY_MARGIN_MS } = require('../lib/claude-connection.cjs');
const stamp = Date.parse('2026-10-02T00:00:00Z');
const fresh = () => ({ access_token: 'new-test-access', refresh_token: 'rotated-test-refresh', expires_in: 28800, scope: 'user:profile user:inference' });
const reply = body => ({ status: 200, ok: true, json: async () => body });
async function fixture(t, override = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lasmium-claude-auth-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.credentials.json');
  await fs.writeFile(file, JSON.stringify({ otherAccount: { preserve: true }, claudeAiOauth: {
    accessToken: 'old-test-access', refreshToken: 'old-test-refresh', expiresAt: stamp - 1000,
    scopes: ['user:profile', 'user:inference'], subscriptionType: 'max', rateLimitTier: 'default', ...override } }));
  return { dir, file, options: { credentialPath: file, now: () => new Date(stamp) } };
}

test('Expired credentials renew automatically, rotate both tokens and preserve all unrelated data', async t => {
  const { file, dir, options } = await fixture(t);
  let calls = 0;
  const connection = createClaudeConnection({ ...options, fetchImpl: async (url, request) => {
    calls++;
    assert.equal(url, TOKEN_URL); assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error');
    assert.deepEqual(JSON.parse(request.body), { grant_type: 'refresh_token', refresh_token: 'old-test-refresh',
      client_id: CLIENT_ID, scope: 'user:profile user:inference' });
    assert.ok(request.signal instanceof AbortSignal);
    return reply(fresh());
  } });
  const tokens = await Promise.all([connection.read(), connection.read()]);
  assert.deepEqual(tokens, ['new-test-access', 'new-test-access']); assert.equal(calls, 1);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.claudeAiOauth.refreshToken, 'rotated-test-refresh');
  assert.equal(saved.claudeAiOauth.expiresAt, stamp + 28800000);
  assert.equal(saved.claudeAiOauth.subscriptionType, 'max'); assert.equal(saved.claudeAiOauth.rateLimitTier, 'default');
  assert.deepEqual(saved.otherAccount, { preserve: true });
  assert.equal(await connection.read(), 'new-test-access'); assert.equal(calls, 1);
  assert.deepEqual(await fs.readdir(dir), ['.credentials.json']);
  await assert.rejects(fs.stat(dir + '.lock'), { code: 'ENOENT' });
});

test('Renewal anticipates expiry and respects existing scopes and non-default client registration', async t => {
  const { options } = await fixture(t, { expiresAt: stamp + EXPIRY_MARGIN_MS, clientId: '11111111-1111-1111-1111-111111111111' });
  let calls = 0;
  const connection = createClaudeConnection({ ...options, fetchImpl: async (_url, request) => {
    calls++; assert.equal(JSON.parse(request.body).client_id, '11111111-1111-1111-1111-111111111111');
    const body = fresh(); delete body.refresh_token; delete body.scope;
    return reply(body);
  } });
  assert.equal(await connection.read(), 'new-test-access'); assert.equal(calls, 1);
  const valid = await fixture(t, { expiresAt: stamp + EXPIRY_MARGIN_MS + 1 });
  const reader = createClaudeConnection({ ...valid.options, fetchImpl: async () => { throw new Error('Must not renew'); } });
  assert.equal(await reader.read(), 'old-test-access');
});

test('Two independent readers coordinate through Claude Code locks and adopt the rotated connection', async t => {
  const { options } = await fixture(t);
  let posts = 0;
  const fetchImpl = async () => { posts++; await new Promise(resolve => setTimeout(resolve, 40)); return reply(fresh()); };
  const readers = [createClaudeConnection({ ...options, fetchImpl }), createClaudeConnection({ ...options, fetchImpl })];
  assert.deepEqual(await Promise.all(readers.map(r => r.read())), ['new-test-access', 'new-test-access']);
  assert.equal(posts, 1);
});

test('Separate Node processes share the refresh locks and perform a single rotation', async t => {
  const { file } = await fixture(t);
  const modulePath = require.resolve('../lib/claude-connection.cjs');
  const code = `const { createClaudeConnection } = require(${JSON.stringify(modulePath)});
    const reader = createClaudeConnection({ credentialPath: process.argv[1], now: () => new Date(${stamp}),
      fetchImpl: async () => { console.log('POST'); await new Promise(resolve => setTimeout(resolve, 150));
        return { status: 200, ok: true, json: async () => (${JSON.stringify(fresh())}) }; } });
    reader.read().then(token => { if (token !== 'new-test-access') process.exitCode = 2; }).catch(() => { process.exitCode = 3; });`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code, file], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = ''; child.stdout.on('data', part => { output += part; });
    child.on('error', reject); child.on('exit', status => status === 0 ? resolve(output) : reject(new Error('Child refresh failed: ' + status)));
  });
  const output = (await Promise.all([run(), run()])).join('');
  assert.equal(output.trim(), 'POST');
});

test('A sibling login during the request wins; renewed credentials never overwrite the new account', async t => {
  const { file, options } = await fixture(t);
  const connection = createClaudeConnection({ ...options, fetchImpl: async () => {
    await fs.writeFile(file, JSON.stringify({ claudeAiOauth: { accessToken: 'sibling-access', refreshToken: 'sibling-refresh', expiresAt: stamp + 28800000 } }));
    return reply(fresh());
  } });
  assert.equal(await connection.read(), 'sibling-access');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).claudeAiOauth.refreshToken, 'sibling-refresh');
});

test('A failed Windows save retains rotation in memory and retries the save without refreshing twice', async t => {
  const { file, options } = await fixture(t);
  let posts = 0, writes = 0;
  const connection = createClaudeConnection({ ...options, fetchImpl: async () => { posts++; return reply(fresh()); },
    writeCredentials: async (file, document) => { if (++writes === 1) throw new Error('private content'); await fs.writeFile(file, JSON.stringify(document)); } });
  await assert.rejects(connection.read(), e => !e.message.includes('private content'));
  assert.equal(await connection.read(), 'new-test-access');
  assert.equal(posts, 1); assert.equal(writes, 2);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).claudeAiOauth.refreshToken, 'rotated-test-refresh');
});

test('Logout while renewing does not recreate credentials; a compromised lock cannot publish the response', async t => {
  const { file, options } = await fixture(t);
  const connection = createClaudeConnection({ ...options, fetchImpl: async () => { await fs.unlink(file); return reply(fresh()); } });
  await assert.rejects(connection.read(), /n’est pas connecté/);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  const second = await fixture(t);
  const controller = new AbortController();
  const locked = createClaudeConnection({ ...second.options,
    acquireLock: async () => ({ signal: controller.signal, release: async () => {} }),
    fetchImpl: async () => { controller.abort(); return reply(fresh()); } });
  await assert.rejects(locked.read(), e => e.code === 'auth-busy');
  assert.equal(JSON.parse(await fs.readFile(second.file, 'utf8')).claudeAiOauth.accessToken, 'old-test-access');
});

test('Revoked refresh tokens are not posted repeatedly and a new local login restores renewal', async t => {
  const { file, options } = await fixture(t);
  let posts = 0;
  const connection = createClaudeConnection({ ...options, fetchImpl: async () => {
    posts++; return posts === 1 ? { status: 400, ok: false, json: async () => { throw new Error('Must not expose the response'); } } : reply(fresh());
  } });
  await assert.rejects(connection.read(), e => e.code === 'auth-required');
  await assert.rejects(connection.read(), e => e.code === 'auth-required'); assert.equal(posts, 1);
  const document = JSON.parse(await fs.readFile(file, 'utf8')); document.claudeAiOauth.refreshToken = 'new-login-test-refresh';
  await fs.writeFile(file, JSON.stringify(document));
  assert.equal(await connection.read(), 'new-test-access'); assert.equal(posts, 2);
});

test('Refresh failures leave the existing credentials intact, honor server cooldown and sanitize errors', async t => {
  for (const status of [429, 403, 503]) {
    const { file, options } = await fixture(t);
    const original = await fs.readFile(file, 'utf8');
    const connection = createClaudeConnection({ ...options, fetchImpl: async () => ({ status, ok: false,
      headers: new Headers({ 'retry-after': '7200' }), json: async () => { throw new Error('private response'); } }) });
    await assert.rejects(connection.read(), error => {
      assert.ok(!error.message.includes('private response'));
      if (status === 429) {
        // The OAuth refresh endpoint is throttled, not the usage endpoint.
        assert.equal(error.code, 'auth-rate-limit');
        assert.equal(error.retryAt, stamp + 7200000);
        assert.match(error.message, /limite temporairement le renouvellement/);
        assert.doesNotMatch(error.message, /Desktop|Déconnecter/);
        assert.ok(!error.message.includes('old-test-access') && !error.message.includes('old-test-refresh'));
      } else {
        assert.equal(error.code, 'auth-network');
      }
      return true;
    });
    assert.equal(await fs.readFile(file, 'utf8'), original);
  }
  const { options } = await fixture(t);
  const connection = createClaudeConnection({ ...options, fetchImpl: async () => { throw new Error('Connexion private-test-refresh'); } });
  await assert.rejects(connection.read(), e => e.code === 'auth-network' && !e.message.includes('private-test-refresh'));
});

test('A refresh 429 carries a distinct auth-rate-limit code for retry-after seconds and dates', async t => {
  for (const header of ['7200', new Date(stamp + 7200000).toUTCString()]) {
    const { options } = await fixture(t);
    const connection = createClaudeConnection({ ...options, fetchImpl: async () => ({ status: 429, ok: false, headers: new Headers({ 'retry-after': header }) }) });
    await assert.rejects(connection.read(), error => error.code === 'auth-rate-limit' && error.retryAt === stamp + 7200000 && /limite temporairement le renouvellement/.test(error.message));
  }
});

test('Early 401 renewal adopts an already replaced token, avoiding unnecessary rotation', async t => {
  const { file, options } = await fixture(t, { expiresAt: stamp + 28800000 });
  const connection = createClaudeConnection({ ...options, fetchImpl: async () => { throw new Error('Must not renew a sibling token'); } });
  const document = JSON.parse(await fs.readFile(file, 'utf8')); document.claudeAiOauth.accessToken = 'sibling-valid-test-access';
  await fs.writeFile(file, JSON.stringify(document));
  assert.equal(await connection.read(new Date(stamp), { forceRefresh: true, rejectedToken: 'old-test-access' }), 'sibling-valid-test-access');
});

// Claude Code renouvelle lui-même sa connexion (Anthropic refuse durablement
// celle faite par une autre application) : Lasmium le lance, puis relit.
test('Claude Code renews the expired connection itself; the direct refresh is never posted', async t => {
  const { file, options } = await fixture(t);
  let launches = 0, posts = 0;
  const connection = createClaudeConnection({ ...options,
    fetchImpl: async () => { posts++; throw new Error('Must not post a refresh'); },
    renewWithClaudeCode: async () => {
      launches++;
      // Comme Claude Code : il réécrit le fichier avec un jeton neuf.
      const document = JSON.parse(await fs.readFile(file, 'utf8'));
      document.claudeAiOauth = { ...document.claudeAiOauth, accessToken: 'claude-code-access', expiresAt: stamp + 8 * 3600000 };
      await fs.writeFile(file, JSON.stringify(document));
    } });
  const tokens = await Promise.all([connection.read(), connection.read()]);
  assert.deepEqual(tokens, ['claude-code-access', 'claude-code-access']);
  assert.equal(launches, 1, 'un seul lancement pour des lectures simultanées');
  assert.equal(posts, 0);
  assert.equal(await connection.read(), 'claude-code-access');
  assert.equal(launches, 1, 'jeton valide : Claude Code n’est pas relancé');
});

test('If Claude Code cannot renew, the direct refresh remains the fallback and Claude Code waits a quarter-hour', async t => {
  const { DELEGATE_RETRY_MS } = require('../lib/claude-connection.cjs');
  let time = stamp;
  const { options } = await fixture(t);
  let launches = 0, posts = 0;
  const connection = createClaudeConnection({ ...options, now: () => new Date(time),
    fetchImpl: async () => { posts++; return { status: 429, ok: false, headers: new Headers() }; },
    renewWithClaudeCode: async () => { launches++; throw new Error('Claude Code absent'); } });
  await assert.rejects(connection.read(new Date(time)), { code: 'auth-rate-limit' });
  assert.deepEqual([launches, posts], [1, 1], 'Claude Code d’abord, puis le renouvellement direct');
  time += 60000;
  await assert.rejects(connection.read(new Date(time)), { code: 'auth-rate-limit' });
  assert.deepEqual([launches, posts], [1, 2], 'pas de nouveau lancement avant un quart d’heure');
  time = stamp + DELEGATE_RETRY_MS;
  await assert.rejects(connection.read(new Date(time)), { code: 'auth-rate-limit' });
  assert.equal(launches, 2);
  // Claude Code a tourné mais sans renouveler (fichier inchangé) : recours direct.
  const unchanged = await fixture(t);
  let fallbackPosts = 0;
  const silent = createClaudeConnection({ ...unchanged.options, renewWithClaudeCode: async () => {},
    fetchImpl: async () => { fallbackPosts++; return reply(fresh()); } });
  assert.equal(await silent.read(), 'new-test-access');
  assert.equal(fallbackPosts, 1);
});

test('A token refused by the quota service is renewed by Claude Code only if it really changes', async t => {
  const { file, options } = await fixture(t, { expiresAt: stamp + 8 * 3600000 });
  let posts = 0;
  const connection = createClaudeConnection({ ...options,
    fetchImpl: async () => { posts++; return reply(fresh()); },
    renewWithClaudeCode: async () => {
      const document = JSON.parse(await fs.readFile(file, 'utf8'));
      document.claudeAiOauth.accessToken = 'claude-code-access';
      await fs.writeFile(file, JSON.stringify(document));
    } });
  assert.equal(await connection.read(new Date(stamp), { forceRefresh: true, rejectedToken: 'old-test-access' }), 'claude-code-access');
  assert.equal(posts, 0);
});
