import { mkdir, open, readFile, rename, unlink, stat } from 'node:fs/promises';
import path from 'node:path';

export const API_ORIGIN = 'https://api.monobank.ua';
export const MAX_PERIOD = 2682000;
export const GAP_MS = 61000;

export class SafeError extends Error {
  constructor(code, message, retryAfterSeconds) {
    super(message);
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function safeError(error) {
  return error instanceof SafeError
    ? { code: error.code, message: error.message, ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) }
    : { code: 'LOCAL_ERROR', message: 'Local connection failed. No credentials or bank response were logged.' };
}

// The file contains only rate-limit timestamps, never account or transaction data.
export class RateLimiter {
  constructor(directory, now = Date.now) { this.directory = directory; this.now = now; }
  async reserve(bucket) {
    if (!['client', 'statement'].includes(bucket)) throw new SafeError('INVALID_REQUEST', 'Unsupported request group.');
    await mkdir(this.directory, { recursive: true });
    const lockPath = path.join(this.directory, 'request.lock');
    let lock;
    try { lock = await open(lockPath, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Recover an abandoned short-lived reservation after a process crash.
      const info = await stat(lockPath).catch(() => null);
      if (info && this.now() - info.mtimeMs > 120000) {
        await unlink(lockPath).catch(() => {});
      }
      throw new SafeError('BUSY', 'Another request is reserving a bank rate-limit slot. Retry shortly.', 2);
    }
    try {
      const file = path.join(this.directory, 'rate-limits.json');
      let state = {};
      try { state = JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const now = this.now();
      const next = Number(state[bucket] ?? 0);
      if (!Number.isFinite(next)) throw new SafeError('LOCAL_ERROR', 'Rate-limit state is invalid.');
      if (next > now) throw new SafeError('RATE_LIMIT', 'Wait before the next bank request.', Math.ceil((next - now) / 1000));
      state[bucket] = now + GAP_MS;
      const temp = file + '.' + process.pid + '.tmp';
      const handle = await open(temp, 'w', 0o600);
      try { await handle.writeFile(JSON.stringify(state)); } finally { await handle.close(); }
      await rename(temp, file);
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
}

export function statementPath(account, from, to, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof account !== 'string' || !/^[A-Za-z0-9_=-]{1,128}$/.test(account)) {
    throw new SafeError('INVALID_ACCOUNT', 'Use an accountId returned by monobank_accounts.');
  }
  if (![from, to].every(Number.isSafeInteger) || from < 0 || to <= from || to - from > MAX_PERIOD || to > nowSeconds + 60) {
    throw new SafeError('INVALID_PERIOD', 'Use Unix seconds: from < to, at most 31 days + 1 hour, and no future end date.');
  }
  return `/personal/statement/${encodeURIComponent(account)}/${from}/${to}`;
}

export function projectAccounts(data) {
  if (!Array.isArray(data.accounts)) throw new SafeError('BANK_RESPONSE', 'The bank returned an unexpected account response.');
  return {
    accounts: data.accounts.filter(a => a.type !== 'fop').map(a => ({
      accountId: a.id, type: a.type, currencyCode: a.currencyCode,
      balanceMinor: a.balance, creditLimitMinor: a.creditLimit,
      cardLast4: (a.maskedPan ?? []).map(v => String(v).slice(-4))
    })),
    jars: (data.jars ?? []).map(j => ({ accountId: j.id, title: j.title, currencyCode: j.currencyCode, balanceMinor: j.balance, goalMinor: j.goal })),
    amountUnit: 'integer minor units (UAH: kopiykas; divide by 100 for hryvnias)',
    privacy: 'Name, IBAN, clientId, sendId, managed clients and FOP accounts omitted.'
  };
}

export function projectStatement(items) {
  if (!Array.isArray(items)) throw new SafeError('BANK_RESPONSE', 'The bank returned an unexpected statement response.');
  return items.map(t => ({
    id: t.id, time: t.time, description: t.description,
    mcc: t.mcc, originalMcc: t.originalMcc, hold: t.hold,
    amountMinor: t.amount, operationAmountMinor: t.operationAmount,
    operationCurrencyCode: t.currencyCode,
    commissionMinor: t.commissionRate, cashbackMinor: t.cashbackAmount, balanceMinor: t.balance
  }));
}

export class MonobankClient {
  constructor({ getToken, getVersion, limiter, fetchImpl = fetch, now = Date.now }) {
    Object.assign(this, { getToken, getVersion, limiter, fetchImpl, now });
    this.version = null;
    this.accountsCache = null;
    this.statementCache = new Map();
    this.queue = Promise.resolve();
  }
  async exclusive(fn) {
    const previous = this.queue;
    let release;
    this.queue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const version = await this.getVersion();
      if (!version) throw new SafeError('TOKEN_MISSING', 'Open the local Monobank token shortcut and save your API token. Never paste it into chat.');
      if (this.version !== version) {
        this.accountsCache = null;
        this.statementCache.clear();
        this.version = version;
      }
      return await fn();
    } finally { release(); }
  }
  async request(urlPath, bucket) {
    // Fixed origin, fixed GET method and an explicit path allowlist; no generic HTTP tool.
    const allowed = bucket === 'client' ? urlPath === '/personal/client-info'
      : bucket === 'statement' && /^\/personal\/statement\/[A-Za-z0-9_%=-]+\/\d+\/\d+$/.test(urlPath);
    if (!allowed) throw new SafeError('READ_ONLY', 'This connection permits only personal account and statement GET requests.');
    let token = await this.getToken();
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/=-]{20,2048}$/.test(token)) {
      throw new SafeError('TOKEN_UNREADABLE', 'The saved API token could not be read. Save it again using the local window.');
    }
    await this.limiter.reserve(bucket);
    let response;
    try {
      response = await this.fetchImpl(API_ORIGIN + urlPath, {
        method: 'GET', headers: { 'X-Token': token, Accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(20000)
      });
    } catch {
      throw new SafeError('NETWORK_ERROR', 'Could not reach monobank. Network errors and redirects are not followed or logged.');
    } finally { token = null; }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) throw new SafeError('TOKEN_REJECTED', 'monobank rejected the token. Check it in the bank API cabinet and save it again locally.');
      if (response.status === 429) throw new SafeError('RATE_LIMIT', 'monobank requested a pause. Retry after at least 61 seconds.', 61);
      throw new SafeError('BANK_ERROR', `monobank returned HTTP ${response.status}. No response body was logged.`);
    }
    try { return await response.json(); }
    catch { throw new SafeError('BANK_RESPONSE', 'monobank returned invalid JSON.'); }
  }
  async loadAccounts() {
    if (this.accountsCache && this.now() - this.accountsCache.fetchedAt < GAP_MS) return this.accountsCache;
    const data = projectAccounts(await this.request('/personal/client-info', 'client'));
    this.accountsCache = { ...data, fetchedAt: this.now() };
    return this.accountsCache;
  }
  async accounts() {
    return this.exclusive(async () => ({ ...(await this.loadAccounts()), fetchedAt: new Date(this.accountsCache.fetchedAt).toISOString() }));
  }
  async statement({ accountId, from, to, offset = 0, limit = 200 }) {
    return this.exclusive(async () => {
      const urlPath = statementPath(accountId, from, to, Math.floor(this.now() / 1000));
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        throw new SafeError('INVALID_PAGE', 'Use offset >= 0 and limit between 1 and 500.');
      }
      let cached = this.statementCache.get(urlPath);
      if (!cached || this.now() - cached.fetchedAt > 15 * 60000) {
        if (offset > 0) throw new SafeError('PAGE_EXPIRED', 'The in-memory statement expired. Start again with offset 0.');
        const accounts = await this.loadAccounts();
        const account = [...accounts.accounts, ...accounts.jars].find(a => a.accountId === accountId);
        if (!account) throw new SafeError('ACCOUNT_NOT_ALLOWED', 'Only a personal account or jar returned by monobank_accounts is allowed. FOP and managed accounts are excluded.');
        const items = projectStatement(await this.request(urlPath, 'statement'));
        cached = { items, fetchedAt: this.now(), accountCurrencyCode: account.currencyCode };
        this.statementCache.set(urlPath, cached);
        if (this.statementCache.size > 12) this.statementCache.delete(this.statementCache.keys().next().value);
      }
      const items = cached.items.slice(offset, offset + limit);
      const more = offset + items.length < cached.items.length;
      const oldestTime = cached.items.length ? Math.min(...cached.items.map(t => t.time)) : null;
      return {
        accountId, from, to, accountCurrencyCode: cached.accountCurrencyCode,
        fetchedAt: new Date(cached.fetchedAt).toISOString(), totalReturnedByBank: cached.items.length,
        items, nextOffset: more ? offset + items.length : null,
        possiblyTruncatedByBank: cached.items.length >= 500,
        olderRangeEnd: cached.items.length >= 500 && oldestTime > from ? oldestTime : null,
        note: 'amountMinor and balanceMinor use the account currency; operationAmountMinor uses operationCurrencyCode. Negative amounts are outflows, positive amounts inflows. Inflows are not necessarily income (transfers/refunds). Hold transactions are pending. If possiblyTruncatedByBank is true, query older subperiods with overlapping boundary and deduplicate by id; completeness is not guaranteed by the bank response. Results are cached in memory for 15 minutes.',
        privacy: 'Comments, counterparty names, tax identifiers, IBANs, receipt and invoice identifiers omitted.'
      };
    });
  }
}
