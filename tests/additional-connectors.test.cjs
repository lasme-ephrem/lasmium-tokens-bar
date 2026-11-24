const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseResponse, fetchUsage } = require('../lib/connectors.cjs');
const { connectionInfo } = require('../lib/provider-catalog.cjs');
const credits = { object: 'credits', currency: 'usd', balance_cents: 5476, held_cents: 34, available_cents: 5476, period: { spent_cents: 1500 }, as_of: '2026-08-27T10:41:12.318Z' };

test('RightNow (ex-RunInfra) converts integer cents without subtracting holds twice or using a spend cap', () => {
  const result = parseResponse('runinfra', { ...credits, spend_cap: { remaining_cents: 99999 } });
  assert.deepEqual(result.balances, [{ currency: 'USD', remaining: 54.76 }]);
  assert.deepEqual(result.details.map(d => d.amount), [54.76, 0.34, 15]);
  assert.equal(result.updatedAt, credits.as_of);
  const zero = parseResponse('runinfra', { ...credits, balance_cents: 0, available_cents: 0, held_cents: 0 });
  assert.equal(zero.balances[0].remaining, 0);
});

test('RightNow (ex-RunInfra) rejects incomplete, negative or inconsistent amounts instead of displaying them', () => {
  for (const patch of [{ balance_cents: null }, { balance_cents: 4.5 }, { balance_cents: -25 }, { held_cents: -1 }, { available_cents: 5442 }, { currency: 'eur' }, { object: 'other' }, { as_of: 'bad' }, { period: { spent_cents: -2 } }]) {
    assert.throws(() => parseResponse('runinfra', { ...credits, ...patch }));
  }
  // A date without timezone is ambiguous and must be refused (not interpreted locally).
  assert.throws(() => parseResponse('runinfra', { ...credits, as_of: '2026-08-27T10:41:12' }), /fuseau/);
});

test('DeepSeek rejects malformed decimal strings, negative balances and duplicate currencies', () => {
  for (const total_balance of ['0x10', ' 12.50 ', '1e3', '']) {
    assert.throws(() => parseResponse('deepseek', { balance_infos: [{ currency: 'USD', total_balance }] }));
  }
  assert.throws(() => parseResponse('deepseek', { balance_infos: [null] }));
  assert.throws(() => parseResponse('deepseek', { balance_infos: [{ currency: 'USD', total_balance: '-12.50' }] }), /négatif/);
  assert.throws(() => parseResponse('deepseek', { balance_infos: [
    { currency: 'USD', total_balance: '12.50' }, { currency: 'USD', total_balance: '2.00' },
  ] }), /ambigus/);
  assert.throws(() => parseResponse('openrouter', { data: { total_credits: '0x10', total_usage: 0 } }));
});

test('OpenRouter keeps a plausible overdraft and rejects impossible balances', () => {
  assert.deepEqual(parseResponse('openrouter', { data: { total_credits: 10, total_usage: 4 } }).balances, [{ currency: 'USD', remaining: 6, total: 10, used: 4 }]);
  assert.deepEqual(parseResponse('openrouter', { data: { total_credits: 10, total_usage: 12 } }).balances, [{ currency: 'USD', remaining: -2, total: 10, used: 12 }]);
  const real = parseResponse('openrouter', { data: { total_credits: 45, total_usage: 45.08283509 } }).balances[0];
  assert.equal(real.currency, 'USD');
  assert.ok(Math.abs(real.remaining + 0.08283509) < 1e-9);
  assert.throws(() => parseResponse('openrouter', { data: { total_credits: 4, total_usage: 10 } }), /incohérent/);
  assert.throws(() => parseResponse('openrouter', { data: { total_credits: 0, total_usage: 2 } }), /incohérent/);
});

test('OrcaRouter (retiré en 0.6.17) n’a plus de connecteur API', () => {
  assert.throws(() => parseResponse('orcarouter', { object: 'billing_subscription', hard_limit_usd: 53.2, total_usage: 0 }), /Connecteur non disponible/);
});

test('Additional connectors send only fixed read-only authenticated requests and sanitize errors', async () => {
  for (const [id, url, body] of [
    ['runinfra', 'https://api.rightnowai.co/v1/credits', credits],
  ]) {
    await fetchUsage(id, ' test-key ', async (actualUrl, options) => {
      assert.equal(actualUrl, url);
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      assert.equal(options.redirect, 'error');
      return { ok: true, json: async () => body };
    });
    await assert.rejects(fetchUsage(id, 'key', async () => ({ ok: false, status: 401 })), /Clé refusée/);
    await assert.rejects(fetchUsage(id, 'key', async () => ({ ok: false, status: 404 })), /route.*indisponible/);
  }
  await assert.rejects(fetchUsage('runinfra', 'key', async () => ({ ok: false, status: 403 })), /clé d’espace de travail/);
  assert.equal(connectionInfo('toString'), null);
  assert.equal(connectionInfo('ollama').mode, 'account');
});
