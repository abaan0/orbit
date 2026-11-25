import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

// V1.1: unchanged Redis slot keys, atomic compare-and-swap, short-lived vault session.
const MAX_CHARS = 800_000;
const MAX_BYTES = 3_500_000;
const MAX_JSON_BYTES = 4_000_000;
const KEY_PREFIX = 'orbit:shared-code-vault:v1:';
const MAX_SLOT = 5;
const COOKIE = '__Secure-orbit_vault';
const SESSION_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW = 300;
const LOGIN_LIMIT = 15;
const LOGIN_KEY = 'orbit:vault:login-limit:v1';
const MISSING_REVISION = 'empty';

// The server compares the exact original Redis value inside one atomic operation.
// This works for older records too, without a migration or separate revision key.
const CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if ARGV[1] == 'empty' then
  if current then return 0 end
else
  if not current or current ~= ARGV[2] then return 0 end
end
if ARGV[3] == 'delete' then
  redis.call('DEL', KEYS[1])
else
  redis.call('SET', KEYS[1], ARGV[4])
end
return 1`;
const LOGIN_SCRIPT = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count >= tonumber(ARGV[1]) then return 0 end
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2])) end
return 1`;

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(status).json(body);
}
const digest = text => createHash('sha256').update(text).digest('hex');
function sameSecret(a, b) {
  return typeof a === 'string' && typeof b === 'string' && !!b &&
    timingSafeEqual(Buffer.from(digest(a), 'hex'), Buffer.from(digest(b), 'hex'));
}
const revisionOf = raw => raw == null ? MISSING_REVISION : digest(raw);
const validRevision = r => typeof r === 'string' && (r === MISSING_REVISION || /^[a-f0-9]{64}$/.test(r));
function credentials() {
  return { url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN };
}
async function redisCommand(command) {
  const { url, token } = credentials();
  const body = JSON.stringify(command);
  if (Buffer.byteLength(body, 'utf8') > 9_500_000) {
    const error = new Error('Redis request is too large.'); error.httpStatus = 413; throw error;
  }
  const response = await fetch(url, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Redis request failed');
  const result = await response.json();
  if (result.error || !Object.hasOwn(result, 'result')) throw new Error('Redis command failed');
  return result.result;
}
function sign(value, password) {
  return createHmac('sha256', process.env.VAULT_SESSION_SECRET || password)
    .update('orbit-vault-v1.1:' + digest(password) + ':' + value).digest('hex');
}
function setCookie(res, value, age) {
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/api/vault; Max-Age=${age}; HttpOnly; Secure; SameSite=Strict`);
}
function authenticated(req, password) {
  const value = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 3 || !/^\d{1,12}$/.test(parts[0]) || !/^[a-f0-9-]{36}$/.test(parts[1])) return false;
  const expiry = Number(parts[0]);
  return expiry > Math.floor(Date.now() / 1000) && sameSecret(parts[2], sign(parts[0] + '.' + parts[1], password));
}
function parseBody(req) {
  if (typeof req.body !== 'string') return req.body;
  try { return JSON.parse(req.body); } catch { return null; }
}
function parseDraft(raw) {
  if (raw == null) return { title: '', code: '', updatedAt: null };
  if (typeof raw !== 'string') throw new Error('Invalid saved record');
  const value = JSON.parse(raw);
  if (typeof value?.code !== 'string') throw new Error('Invalid saved record');
  return { title: typeof value.title === 'string' ? value.title : '', code: value.code,
    updatedAt: Number(value.updatedAt) || null };
}

export default async function handler(req, res) {
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return reply(res, 405, { error: 'Unsupported method.' });
  }
  // Non-simple header prevents cross-origin browser requests from silently changing data.
  if (req.headers['x-vault-request'] !== '1') return reply(res, 403, { error: 'Refresh the Vault to use the latest version.' });
  const requiredPassword = process.env.VAULT_PASSWORD || process.env.APP_PASSWORD;
  if (!requiredPassword) return reply(res, 503, { error: 'Vault password is not configured.' });
  const body = parseBody(req);
  if (req.method === 'POST' && body?.action === 'logout') {
    setCookie(res, '', 0);
    return reply(res, 200, { locked: true });
  }
  const { url, token } = credentials();
  if (!url || !token || !/^https:\/\//i.test(url)) return reply(res, 503, { error: 'Vault storage not connected.' });
  try {
    if (req.method === 'POST') {
      if (body?.action !== 'login' || typeof body.password !== 'string' || body.password.length > 1024) {
        return reply(res, 400, { error: 'Invalid login request.' });
      }
      const allowed = await redisCommand(['EVAL', LOGIN_SCRIPT, '1', LOGIN_KEY, String(LOGIN_LIMIT), String(LOGIN_WINDOW)]);
      if (Number(allowed) !== 1) {
        res.setHeader('Retry-After', String(LOGIN_WINDOW));
        return reply(res, 429, { error: 'Too many Vault login attempts. Try again in a few minutes.' });
      }
      if (!sameSecret(body.password, requiredPassword)) return reply(res, 401, { error: 'Incorrect Vault password.' });
      const value = `${Math.floor(Date.now()/1000) + SESSION_SECONDS}.${randomUUID()}`;
      setCookie(res, `${value}.${sign(value, requiredPassword)}`, SESSION_SECONDS);
      return reply(res, 200, { authenticated: true });
    }
    if (!authenticated(req, requiredPassword)) return reply(res, 401, { error: 'Vault session expired. Unlock again.' });
    const slot = Number(req.query?.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOT) return reply(res, 400, { error: `Select a slot from 1 to ${MAX_SLOT}.` });
    const key = KEY_PREFIX + slot;
    if (req.method === 'GET') {
      const raw = await redisCommand(['GET', key]);
      const draft = parseDraft(raw);
      return reply(res, 200, { slot, ...draft, revision: revisionOf(raw) });
    }
    if (!validRevision(body?.revision)) return reply(res, 428, { error: 'Load the slot before changing it.' });
    let draft = null;
    let nextRaw = '';
    if (req.method === 'PUT') {
      if (typeof body.title !== 'string' || typeof body.code !== 'string') return reply(res, 400, { error: 'Title and code must be text.' });
      if (body.title.length > 100 || body.code.length > MAX_CHARS || Buffer.byteLength(body.code, 'utf8') > MAX_BYTES || (!body.title.trim() && !body.code.trim())) {
        return reply(res, 413, { error: 'Invalid or oversized draft. Limit: 800,000 characters and 3.5 MB of UTF-8 text.' });
      }
      draft = { title: body.title.trim() || `Draft ${slot}`, code: body.code, updatedAt: Date.now(), writeId: randomUUID() };
      nextRaw = JSON.stringify(draft);
      if (Buffer.byteLength(nextRaw, 'utf8') > MAX_JSON_BYTES) return reply(res, 413, { error: 'Encoded draft is too large. Split it into two slots.' });
    }
    const current = await redisCommand(['GET', key]);
    // Validate the old record rather than overwriting an unreadable record.
    parseDraft(current);
    if (revisionOf(current) !== body.revision) return reply(res, 409, { error: 'This slot changed on another device. Your text was not overwritten. Copy or download your draft before loading the latest version.' });
    const changed = await redisCommand(['EVAL', CAS_SCRIPT, '1', key, current == null ? 'empty' : 'present', current ?? '', req.method === 'DELETE' ? 'delete' : 'save', nextRaw]);
    if (Number(changed) !== 1) return reply(res, 409, { error: 'Another device changed this slot. Your draft is still in the editor; load the latest version after saving a separate copy.' });
    if (req.method === 'DELETE') return reply(res, 200, { slot, deleted: true, revision: MISSING_REVISION });
    return reply(res, 200, { slot, saved: true, title: draft.title, updatedAt: draft.updatedAt, revision: revisionOf(nextRaw) });
  } catch (error) {
    // Never log code, credentials, Redis replies, or request headers.
    console.error('Vault operation failed', { method: req.method, type: error?.name || 'Error' });
    return reply(res, error.httpStatus === 413 ? 413 : 502, { error: error.httpStatus === 413 ? 'Encoded Redis request is too large. Split the draft into smaller slots.' : 'Vault storage request failed. Your local draft was not cleared. Check the connection and retry; if a save may have completed, verify the latest copy first.' });
  }
}
