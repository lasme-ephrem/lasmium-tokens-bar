const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { collectDiagnostics, defaultEndpoints, CRITICAL_IDS, checkEndpoint, checkDataDir, checkClaudeCode, checkAntigravity } = require('../lib/diagnostics.cjs');
const { formatReport, exitCode, criticalFailures } = require('../scripts/doctor.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lasmium-doctor-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('Diagnostics collects every prerequisite without secrets and without authenticated requests', async t => {
  const root = await fixture(t);
  const credentialPath = path.join(root, '.credentials.json');
  const secretToken = 'super-secret-test-token';
  await fs.writeFile(credentialPath, JSON.stringify({ claudeAiOauth: { accessToken: secretToken, expiresAt: Date.now() + 3600000 } }));
  const chromePath = path.join('C:/Program Files', 'Google/Chrome/Application/chrome.exe');
  const fsImpl = {
    stat: (target, ...rest) => target === chromePath ? Promise.resolve({ isFile: () => true }) : fs.stat(target, ...rest),
    access: target => (target === chromePath || target === root) ? Promise.resolve() : Promise.reject(Object.assign(new Error('absent'), { code: 'ENOENT' })),
    readFile: (...args) => fs.readFile(...args),
  };
  const requests = [];
  const items = await collectDiagnostics({
    dataDir: root,
    platform: 'win32',
    env: { ProgramFiles: 'C:/Program Files' },
    fsImpl,
    exec: async () => ({ stdout: 'OK' }),
    findCodexImpl: async () => 'C:/Codex/codex.exe',
    discover: async () => [{ port: 1, csrf: 'private-csrf-token' }, { port: 2, csrf: 'private-csrf-token' }],
    credentialPath,
    endpoints: [{ id: 'endpoint:test', label: 'Accès test', url: 'https://example.test/' }],
    fetchImpl: async (url, options) => { requests.push({ url, options }); return { status: 401 }; },
  });
  assert.deepEqual(items.map(item => item.id), ['data-dir', 'encryption', 'browser', 'codex', 'claude-code', 'antigravity', 'endpoint:test']);
  assert.equal(items.find(item => item.id === 'data-dir').ok, true);
  assert.equal(items.find(item => item.id === 'encryption').ok, true);
  assert.equal(items.find(item => item.id === 'browser').ok, true);
  assert.equal(items.find(item => item.id === 'codex').ok, true);
  assert.equal(items.find(item => item.id === 'claude-code').ok, true);
  assert.equal(items.find(item => item.id === 'antigravity').ok, true);
  assert.equal(items.find(item => item.id === 'endpoint:test').ok, true);
  assert.match(items.find(item => item.id === 'claude-code').detail, /jeton valide/);
  assert.match(items.find(item => item.id === 'antigravity').detail, /2 port/);
  // The reachability probe stays anonymous.
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.equal(requests[0].options.credentials, undefined);
  assert.equal(requests[0].options.method, 'GET');
  // No token, cookie or CSRF value may leak into the report.
  const printed = JSON.stringify(items);
  assert.equal(printed.includes(secretToken), false);
  assert.equal(printed.includes('private-csrf-token'), false);
  // All critical prerequisites pass, so the exit code stays 0 even with warnings.
  assert.deepEqual(criticalFailures(items), []);
  assert.equal(exitCode(items), 0);
  // La version affichée suit package.json : aucun test ne doit coder une
  // version en dur (les correctifs changent la version).
  const packageVersion = require('../package.json').version.replace(/\./g, '\\.');
  assert.match(formatReport(items), new RegExp(`Lasmium TOKENS-HUB ${packageVersion}`));
  assert.match(formatReport(items), /Tous les prérequis sont présents/);
});

test('Missing data directory and unavailable encryption are critical failures', async t => {
  const root = await fixture(t);
  const items = await collectDiagnostics({
    dataDir: path.join(root, 'absent'),
    platform: 'win32',
    env: {},
    exec: async () => { throw new Error('DPAPI inaccessible'); },
    findCodexImpl: async () => { throw new Error('Codex absent'); },
    discover: async () => [],
    credentialPath: path.join(root, 'missing-credentials.json'),
    endpoints: [],
  });
  assert.equal(items.find(item => item.id === 'data-dir').ok, false);
  assert.equal(items.find(item => item.id === 'encryption').ok, false);
  assert.equal(items.find(item => item.id === 'browser').ok, false);
  assert.equal(items.find(item => item.id === 'codex').ok, false);
  assert.equal(items.find(item => item.id === 'claude-code').ok, false);
  assert.equal(items.find(item => item.id === 'antigravity').ok, false);
  assert.deepEqual(criticalFailures(items).map(item => item.id), ['data-dir', 'encryption']);
  assert.equal(exitCode(items), 1);
  assert.match(formatReport(items), /Prérequis critique/);
  // Error bodies are never echoed: only a stable French status is reported.
  const printed = JSON.stringify(items);
  assert.equal(printed.includes('DPAPI inaccessible'), false);
  assert.equal(printed.includes('Codex absent'), false);
});

test('Endpoint probe reports reachability without reading the body or sending credentials', async () => {
  const seen = [];
  const reachable = await checkEndpoint({ id: 'endpoint:openrouter', label: 'Accès openrouter', url: 'https://openrouter.ai/api/v1/credits' }, {
    fetchImpl: async (url, options) => { seen.push({ url, options }); return { status: 401, text: async () => 'private body' }; },
  });
  assert.equal(reachable.ok, true);
  assert.match(reachable.detail, /HTTP 401.*sans clé/);
  assert.equal(seen[0].options.headers.Authorization, undefined);
  assert.equal(seen[0].options.redirect, 'manual');
  assert.equal(seen[0].options.cache, 'no-store');
  const serviceError = await checkEndpoint({ id: 'endpoint:test', label: 'Accès test', url: 'https://example.test/' }, { fetchImpl: async () => ({ status: 503 }) });
  assert.equal(serviceError.ok, false);
  const unreachable = await checkEndpoint({ id: 'endpoint:test', label: 'Accès test', url: 'https://example.test/' }, { fetchImpl: async () => { throw new Error('private network detail'); } });
  assert.equal(unreachable.ok, false);
  assert.equal(JSON.stringify(unreachable).includes('private network detail'), false);
  const invalid = await checkEndpoint({ id: 'endpoint:test', label: 'Accès test', url: 'https://example.test/' }, { fetchImpl: async () => ({}) });
  assert.equal(invalid.ok, false);
});

test('Data directory and Claude Code checks fail closed without exposing the token', async t => {
  const root = await fixture(t);
  const missing = await checkDataDir({ dataDir: path.join(root, 'nope') });
  assert.equal(missing.ok, false);
  const directory = await checkDataDir({ dataDir: root });
  assert.equal(directory.ok, true);
  const credentialPath = path.join(root, '.credentials.json');
  const secretToken = 'another-secret-test-token';
  await fs.writeFile(credentialPath, JSON.stringify({ claudeAiOauth: { accessToken: secretToken, expiresAt: Date.now() + 60000 } }));
  const present = await checkClaudeCode({ credentialPath });
  assert.equal(present.ok, true);
  assert.equal(JSON.stringify(present).includes(secretToken), false);
  await fs.writeFile(credentialPath, JSON.stringify({ claudeAiOauth: { accessToken: secretToken, expiresAt: Date.now() - 60000 } }));
  const expired = await checkClaudeCode({ credentialPath });
  assert.equal(expired.ok, true);
  assert.match(expired.detail, /à renouveler/);
  await fs.writeFile(credentialPath, JSON.stringify({ other: true }));
  assert.equal((await checkClaudeCode({ credentialPath })).ok, false);
});

test('Default endpoint list covers every connector and every account origin without duplicates', () => {
  const endpoints = defaultEndpoints();
  const urls = endpoints.map(endpoint => endpoint.url);
  assert.equal(new Set(urls).size, urls.length);
  for (const expected of ['https://openrouter.ai/api/v1/credits', 'https://api.deepseek.com/user/balance', 'https://api.rightnowai.co/v1/credits', 'https://api.anthropic.com/api/oauth/usage', 'https://chatgpt.com/', 'https://claude.ai/', 'https://grok.com/', 'https://z.ai/', 'https://ollama.com/settings']) {
    assert.ok(urls.includes(expected), `Missing endpoint ${expected}`);
  }
  for (const endpoint of endpoints) {
    assert.match(endpoint.id, /^endpoint:/);
    assert.ok(endpoint.label.startsWith('Accès '));
    assert.equal(new URL(endpoint.url).protocol, 'https:');
  }
  assert.deepEqual(CRITICAL_IDS, ['data-dir', 'encryption']);
});

test('Antigravity diagnostic distinguishes a missing service from unreadable ports', async () => {
  const detected = await checkAntigravity({ discover: async () => [{ port: 53733, csrf: 'private-csrf-token' }] });
  assert.equal(detected.ok, true);
  assert.match(detected.detail, /1 port/);
  assert.equal(JSON.stringify(detected).includes('private-csrf-token'), false);
  const noPorts = await checkAntigravity({ discover: async () => { throw Object.assign(new Error('private token'), { code: 'ANTIGRAVITY_NO_PORTS' }); } });
  assert.equal(noPorts.ok, false);
  assert.match(noPorts.detail, /ports locaux/);
  assert.match(noPorts.hint, /rouvre/);
  assert.equal(JSON.stringify(noPorts).includes('private token'), false);
  const notRunning = await checkAntigravity({ discover: async () => { throw Object.assign(new Error('private token'), { code: 'ANTIGRAVITY_NOT_RUNNING' }); } });
  assert.equal(notRunning.ok, false);
  assert.match(notRunning.detail, /introuvable/);
  const unknown = await checkAntigravity({ discover: async () => { throw new Error('private token'); } });
  assert.equal(unknown.ok, false);
  assert.equal(JSON.stringify(unknown).includes('private token'), false);
});

test('Doctor formats reports and derives the exit code from critical checks only', () => {
  const critical = [
    { id: 'data-dir', label: 'Dossier de données', ok: false, detail: 'Dossier absent.', hint: 'Il sera créé.' },
    { id: 'browser', label: 'Navigateur Chrome ou Edge', ok: false, detail: 'Aucun navigateur détecté.', hint: 'Installe Chrome.' },
  ];
  assert.equal(exitCode(critical), 1);
  const report = formatReport(critical);
  assert.match(report, /\[ÉCHEC\] Dossier de données/);
  assert.match(report, /→ Il sera créé/);
  assert.match(report, /Prérequis critique\(s\) manquant\(s\) : Dossier de données/);
  const warningOnly = [{ id: 'browser', label: 'Navigateur Chrome ou Edge', ok: false, detail: 'Aucun navigateur détecté.', hint: 'Installe Chrome.' }];
  assert.equal(exitCode(warningOnly), 0);
  assert.match(formatReport(warningOnly), /avertissements/);
  const success = [{ id: 'data-dir', label: 'Dossier de données', ok: true, detail: 'Dossier accessible en écriture.', hint: '' }];
  assert.equal(exitCode(success), 0);
  assert.match(formatReport(success), /Tous les prérequis sont présents/);
});
