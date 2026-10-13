import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MonobankClient, RateLimiter, GAP_MS, MAX_PERIOD, statementPath, projectAccounts, projectStatement, safeError } from '../core.mjs';

const token = 'synthetic-test-token-not-a-real-secret';
const personal = { id: 'personal_1', type: 'black', currencyCode: 980, balance: 12345, creditLimit: 0, iban: 'PRIVATE_IBAN', maskedPan: ['444444******4321'] };
const bankAccounts = { name: 'PRIVATE_NAME', clientId: 'PRIVATE_ID', accounts: [personal, { id: 'business_1', type: 'fop' }], jars: [{ id: 'jar_1', title: 'Savings', currencyCode: 980, balance: 10 }], managedClients: [{ name: 'PRIVATE_MANAGED' }] };
const transaction = { id: 'tx_1', time: 1000, description: 'Store', amount: -1255, operationAmount: -1255, currencyCode: 980, balance: 12345, hold: false, mcc: 5411, counterIban: 'PRIVATE_IBAN', counterName: 'PRIVATE_NAME', comment: 'PRIVATE_COMMENT', receiptId: 'PRIVATE_RECEIPT' };

function fixture(options = {}) {
  const calls = [];
  let version = 'v1';
  let clock = 2000000;
  const client = new MonobankClient({
    getToken: async () => token, getVersion: async () => version,
    limiter: { reserve: async () => {} }, now: () => clock,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(url.includes('client-info') ? bankAccounts : [transaction])); },
    ...options
  });
  return { client, calls, setVersion: v => { version = v; }, setClock: t => { clock = t; } };
}

test('account projection removes personal identifiers, FOP and managed accounts', () => {
  const projected = projectAccounts(bankAccounts);
  assert.equal(projected.accounts.length, 1);
  assert.equal(projected.accounts[0].balanceMinor, 12345);
  assert.deepEqual(projected.accounts[0].cardLast4, ['4321']);
  assert.equal(projected.jars[0].accountId, 'jar_1');
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_|business_1|444444/);
});

test('statement projection preserves exact minor units and omits counterparty metadata', () => {
  const [item] = projectStatement([transaction]);
  assert.equal(item.amountMinor, -1255);
  assert.equal(item.operationCurrencyCode, 980);
  assert.doesNotMatch(JSON.stringify(item), /PRIVATE_/);
});

test('period validation and path injection are rejected', () => {
  assert.equal(statementPath('personal_1', 1, MAX_PERIOD + 1, MAX_PERIOD + 1), `/personal/statement/personal_1/1/${MAX_PERIOD + 1}`);
  for (const id of ['https://evil.test', '../webhook', 'x?query=1', 'x\r\nHeader: bad']) assert.throws(() => statementPath(id, 1, 2));
  for (const range of [[-1, 2], [2, 1], [1, 1], [1.1, 2], [0, MAX_PERIOD + 1], [0, Infinity]]) assert.throws(() => statementPath('personal_1', ...range));
  assert.throws(() => statementPath('personal_1', 0, 999, 1));
});

test('only fixed-origin GET is possible and redirects are forbidden', async () => {
  const { client, calls } = fixture();
  await client.accounts();
  const result = await client.statement({ accountId: 'personal_1', from: 1, to: 1500 });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, 'https://api.monobank.ua');
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.headers['X-Token'], token);
    assert.equal(call.init.body, undefined);
  }
  assert.equal(result.accountCurrencyCode, 980);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-test-token|PRIVATE_/);
  for (const url of ['/personal/webhook', 'https://evil.test/', '/personal/client-info?extra=1']) {
    await assert.rejects(client.request(url, 'client'), { code: 'READ_ONLY' });
  }
  assert.equal(calls.length, 2);
});

test('FOP and unlisted account IDs cannot request a statement', async () => {
  const { client, calls } = fixture();
  for (const accountId of ['business_1', 'unknown', '0']) {
    await assert.rejects(client.statement({ accountId, from: 1, to: 1500 }), { code: 'ACCOUNT_NOT_ALLOWED' });
  }
  assert.equal(calls.length, 1);
});

test('missing token causes no network calls, and deletion blocks cached results', async () => {
  const { client, calls, setVersion } = fixture();
  await client.accounts();
  setVersion(null);
  await assert.rejects(client.accounts(), { code: 'TOKEN_MISSING' });
  assert.equal(calls.length, 1);
});

test('token rotation invalidates cached bank data', async () => {
  const { client, calls, setVersion } = fixture();
  await client.accounts(); await client.accounts();
  assert.equal(calls.length, 1);
  setVersion('v2');
  await client.accounts();
  assert.equal(calls.length, 2);
});

test('concurrent reads use one account fetch', async () => {
  const { client, calls } = fixture();
  await Promise.all([client.accounts(), client.accounts(), client.accounts()]);
  assert.equal(calls.length, 1);
});

test('pagination uses cached data and expired pagination does not silently refetch', async () => {
  let calls = 0;
  const { client, setClock } = fixture({ fetchImpl: async url => {
    calls++;
    return new Response(JSON.stringify(url.includes('client-info') ? bankAccounts : Array.from({ length: 501 }, (_, i) => ({ ...transaction, id: 'tx_' + i }))));
  } });
  const args = { accountId: 'personal_1', from: 1, to: 1500, limit: 200 };
  const first = await client.statement(args);
  assert.equal(first.items.length, 200);
  assert.equal(first.nextOffset, 200);
  assert.equal(first.possiblyTruncatedByBank, true);
  const second = await client.statement({ ...args, offset: 200 });
  assert.equal(second.items[0].id, 'tx_200');
  assert.equal(calls, 2);
  setClock(2000000 + 16 * 60000);
  await assert.rejects(client.statement({ ...args, offset: 400 }), { code: 'PAGE_EXPIRED' });
  assert.equal(calls, 2);
});

test('HTTP and network errors cannot echo a secret or bank error body', async () => {
  for (const status of [401, 403, 429, 500]) {
    const { client } = fixture({ fetchImpl: async () => new Response(token, { status }) });
    try { await client.accounts(); assert.fail('Expected failure'); }
    catch (error) { assert.doesNotMatch(JSON.stringify(safeError(error)), /synthetic-test-token/); }
  }
  const { client } = fixture({ fetchImpl: async () => { throw new Error(token); } });
  await assert.rejects(client.accounts(), { code: 'NETWORK_ERROR' });
  assert.doesNotMatch(JSON.stringify(safeError(new Error(token))), /synthetic-test-token/);
});

test('persistent limiter survives a new process instance and isolates method groups', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'mono-limits-test-'));
  let now = 100000;
  try {
    await new RateLimiter(temp, () => now).reserve('client');
    const second = new RateLimiter(temp, () => now);
    await assert.rejects(second.reserve('client'), { code: 'RATE_LIMIT', retryAfterSeconds: 61 });
    await second.reserve('statement');
    now += GAP_MS;
    await second.reserve('client');
    await assert.rejects(second.reserve('webhook'), { code: 'INVALID_REQUEST' });
  } finally { await rm(temp, { recursive: true }); }
});

test('concurrent limiter reservations permit at most one request', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'mono-limits-test-'));
  try {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => new RateLimiter(temp).reserve('statement')));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  } finally { await rm(temp, { recursive: true }); }
});
