import { createHash, timingSafeEqual } from 'node:crypto';

// Shared Code Vault for text that is approved for storage on this service.
// Independent of Gemini and Firebase. Requires Upstash Redis REST env vars.
const MAX_CHARS = 800_000;
const MAX_BYTES = 3_500_000;
const KEY_PREFIX = 'orbit:shared-code-vault:v1:';
const MAX_SLOT = 5;

function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(status).json(body);
}

function secretMatches(provided, expected) {
  if (typeof provided !== 'string' || !expected) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function credentials() {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
  };
}

async function redisCommand(command) {
  const { url, token } = credentials();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Redis HTTP ${response.status}`);
  const json = await response.json();
  if (json.error) throw new Error('Redis command failed');
  return json.result;
}

export default async function handler(req, res) {
  if (!['GET', 'PUT', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, PUT, DELETE');
    return reply(res, 405, { error: 'Unsupported method.' });
  }

  const requiredPassword = process.env.VAULT_PASSWORD || process.env.APP_PASSWORD;
  if (!requiredPassword) return reply(res, 503, { error: 'APP_PASSWORD is not configured.' });
  if (!secretMatches(req.headers['x-app-password'], requiredPassword)) {
    return reply(res, 401, { error: 'Incorrect website password.' });
  }

  const { url, token } = credentials();
  if (!url || !token || !/^https:\/\//i.test(url)) {
    return reply(res, 503, { error: 'Vault storage not connected. Add Upstash Redis to your Vercel project.' });
  }

  const slot = Number(req.query?.slot);
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOT) {
    return reply(res, 400, { error: `Select a slot from 1 to ${MAX_SLOT}.` });
  }
  const key = KEY_PREFIX + slot;

  try {
    if (req.method === 'GET') {
      const stored = await redisCommand(['GET', key]);
      if (stored === null || stored === undefined) {
        return reply(res, 200, { slot, title: '', code: '', updatedAt: null });
      }
      const parsed = JSON.parse(stored);
      if (typeof parsed?.code !== 'string') throw new Error('Invalid stored draft');
      return reply(res, 200, {
        slot,
        title: typeof parsed.title === 'string' ? parsed.title : '',
        code: parsed.code,
        updatedAt: Number(parsed.updatedAt) || null
      });
    }

    if (req.method === 'DELETE') {
      await redisCommand(['DEL', key]);
      return reply(res, 200, { slot, deleted: true });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body || typeof body.title !== 'string' || typeof body.code !== 'string') {
      return reply(res, 400, { error: 'Title and code must be text.' });
    }
    if (body.title.length > 100 || body.code.length > MAX_CHARS ||
        Buffer.byteLength(body.code, 'utf8') > MAX_BYTES ||
        (!body.title.trim() && !body.code.trim())) {
      return reply(res, 413, { error: 'Invalid or oversized draft. Maximum 800,000 characters (3.5 MB) per slot.' });
    }
    const draft = {
      title: body.title.trim() || `Draft ${slot}`,
      code: body.code,
      updatedAt: Date.now()
    };
    await redisCommand(['SET', key, JSON.stringify(draft)]);
    return reply(res, 200, { slot, saved: true, title: draft.title, updatedAt: draft.updatedAt });
  } catch (error) {
    console.error('Code Vault storage error', { method: req.method, slot, type: error?.name || 'Error', message: error?.message });
    return reply(res, 502, { error: 'Vault storage request failed. Check the Upstash connection or retry.' });
  }
}
