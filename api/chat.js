import { createHash, timingSafeEqual } from 'node:crypto';

// Gemini-only router. Provider adapters (OpenRouter, etc.) can be added separately later.
export const MODEL_ORDER = [
  'gemini-3.8-flash',
  'gemini-4-hydrogen',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite'
];
const ALLOWED = new Set(['auto', ...MODEL_ORDER]);
const API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MAX_PROMPT_CHARS = 500_000;
const MAX_HISTORY_CHARS = 600_000;
const MAX_RUNTIME_MS = 240_000; // Keep below the Vercel function's 300s limit.
const SYSTEM_PROMPT = [
  'You are an expert SAP ABAP and SAP BTP programming assistant.',
  'Understand supplied existing code and functional specifications before proposing changes.',
  'Preserve unchanged business logic; prefer precise, ready-to-paste ABAP edits with insertion locations.',
  'Respect classic ABAP versus ABAP Cloud syntax and the system release when known.',
  'Do not invent SAP objects, dependencies, or missing code.',
  'For long results, clearly identify incomplete or omitted sections.',
  'Use Markdown fenced code blocks with language abap where relevant.',
  'Never request secrets or restricted company data.'
].join(' ');

function sameSecret(a, b) {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}
function reply(res, status, data) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(data);
}
function getHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-30).filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length <= MAX_PROMPT_CHARS)
    .map(({ role, content }) => ({ role, content }));
}
function rebuildContext(history, prompt) {
  // Only needed if the key changes: stored conversation IDs belong to the original project.
  // Keep newer messages first. If history cannot fit, tell the UI instead of hiding it.
  const selected = [];
  let remaining = MAX_HISTORY_CHARS - prompt.length;
  for (const item of [...history].reverse()) {
    if (remaining - item.content.length < 0) break;
    selected.unshift(item);
    remaining -= item.content.length;
  }
  if (!selected.length) return { input: prompt, dropped: history.length > 0 };
  const transcript = selected.map(m => `[${m.role === 'user' ? 'USER' : 'ASSISTANT'}]\n${m.content}`).join('\n\n');
  return {
    input: `Previous conversation for context:\n${transcript}\n\n[USER - CURRENT REQUEST]\n${prompt}`,
    dropped: selected.length < history.length
  };
}
function parseAnswer(data) {
  const steps = Array.isArray(data?.steps) ? data.steps : [];
  const text = steps.filter(s => s?.type === 'model_output')
    .flatMap(s => Array.isArray(s.content) ? s.content : [])
    .filter(c => c?.type === 'text' && typeof c.text === 'string')
    .map(c => c.text).join('\n\n').trim();
  return text;
}
function buildModelOrder(model) {
  return model === 'auto' ? [...MODEL_ORDER] : [model, ...MODEL_ORDER.filter(m => m !== model)];
}
async function attempt({ model, key, previousInteractionId, input, remainingMs }) {
  // A slow first model must leave time for at least one failover.
  const perAttemptMs = Math.min(remainingMs, 120_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), perAttemptMs);
  try {
    const body = {
      model, input, store: true, system_instruction: SYSTEM_PROMPT,
      ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {})
    };
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-goog-api-key': key,
        'Api-Revision': '2026-05-20',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body), signal: controller.signal
    });
    const raw = await r.text();
    let data = {};
    try { data = JSON.parse(raw); } catch { /* caller handles bad responses */ }
    return { statusCode: r.status, data, retryAfter: r.headers.get('retry-after') };
  } catch (err) {
    return { statusCode: 0, timedOut: controller.signal.aborted, errorName: err?.name || 'NetworkError' };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { error: 'Only POST is supported.' });
  const primary = process.env.GEMINI_API_KEY;
  const backup = process.env.GEMINI_API_KEY_BACKUP;
  if (!primary || !process.env.APP_PASSWORD) return reply(res, 503, { error: 'Set GEMINI_API_KEY and APP_PASSWORD in Vercel.' });
  if (typeof req.headers['x-app-password'] !== 'string' || !sameSecret(req.headers['x-app-password'], process.env.APP_PASSWORD)) {
    return reply(res, 401, { error: 'Incorrect website password.' });
  }
  const { prompt, model = 'auto', previousInteractionId, previousKeySlot, history } = req.body || {};
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_CHARS) {
    return reply(res, 400, { error: 'Message must contain 1–500,000 characters.' });
  }
  if (!ALLOWED.has(model)) return reply(res, 400, { error: 'Unknown model.' });
  if (previousInteractionId != null && (typeof previousInteractionId !== 'string' || previousInteractionId.length > 200)) {
    return reply(res, 400, { error: 'Invalid conversation ID.' });
  }
  if (previousKeySlot != null && !['primary', 'backup'].includes(previousKeySlot)) {
    return reply(res, 400, { error: 'Invalid credential slot.' });
  }
  const messages = getHistory(history);
  const start = Date.now();
  const tried = [];
  let keySlot = previousKeySlot === 'backup' && backup ? 'backup' : 'primary';
  let lastProblem = { statusCode: 503 };
  let keyHadAuthFailure = false;

  for (const candidate of buildModelOrder(model)) {
    if (Date.now() - start > MAX_RUNTIME_MS - 8_000) break;
    let key = keySlot === 'backup' ? backup : primary;
    let result;
    let replayed = false;
    let contextDropped = false;

    // Try another credential only for authentication/permission failures.
    // Never rotate keys on 429: all keys in one Google Cloud project share quotas.
    for (let credentialsAttempt = 0; credentialsAttempt < 2; credentialsAttempt++) {
      const priorIdAllowed = previousInteractionId && (!previousKeySlot || previousKeySlot === keySlot);
      const rebuilt = priorIdAllowed ? { input: prompt.trim(), dropped: false } : rebuildContext(messages, prompt.trim());
      replayed = !priorIdAllowed && messages.length > 0;
      contextDropped = rebuilt.dropped;
      const remainingMs = MAX_RUNTIME_MS - (Date.now() - start) - 6_000;
      if (remainingMs < 3_000) break;
      result = await attempt({ model: candidate, key, input: rebuilt.input,
        previousInteractionId: priorIdAllowed ? previousInteractionId : null, remainingMs });
      tried.push({ model: candidate, httpStatus: result.statusCode || (result.timedOut ? 'timeout' : 'network') });
      console.log('Orbit model attempt', { model: candidate, status: result.statusCode, ms: Date.now() - start, keySlot });

      if ([401, 403].includes(result.statusCode) && keySlot === 'primary' && backup && backup !== primary) {
        keyHadAuthFailure = true;
        keySlot = 'backup';
        key = backup;
        continue;
      }
      break;
    }
    if (!result) break;
    lastProblem = result;

    if (result.statusCode === 200) {
      const output = parseAnswer(result.data);
      if (output) {
        const status = String(result.data.status || 'unknown');
        return reply(res, 200, {
          reply: output,
          interactionId: typeof result.data.id === 'string' ? result.data.id : null,
          keySlot, model: candidate, requestedModel: model,
          fallbackUsed: tried.length > 1,
          attempts: tried,
          status,
          incomplete: ['incomplete', 'failed', 'cancelled'].includes(status),
          contextDropped,
          usage: result.data.usage ? {
            input: result.data.usage.total_input_tokens,
            output: result.data.usage.total_output_tokens
          } : null
        });
      }
      // A 200 with no usable text is a failed model attempt.
      lastProblem = { statusCode: 502, detail: 'Model returned no text.' };
      continue;
    }
    if (result.statusCode === 401) {
      return reply(res, 401, { error: 'Gemini API key rejected. Check GEMINI_API_KEY and optional backup key.', attempts: tried });
    }
    if (result.statusCode === 403 && keyHadAuthFailure) {
      return reply(res, 403, { error: 'Both Gemini credentials were denied access.', attempts: tried });
    }
    // Model-specific rate limits, unavailable IDs, capacity errors, or network timeouts.
    if ([0, 403, 404, 408, 429, 500, 502, 503, 504].includes(result.statusCode)) continue;
    return reply(res, result.statusCode || 502, {
      error: result.data?.error?.message?.slice?.(0, 250) || 'Gemini rejected the request. No fallback was attempted.', attempts: tried
    });
  }
  const quota = tried.some(a => a.httpStatus === 429);
  const lastDetail = lastProblem.data?.error?.message;
  return reply(res, quota ? 429 : 502, {
    error: quota ? 'Available Gemini models are rate-limited. Wait for quota to reset or check Google AI Studio rate limits.'
      : 'All Gemini model attempts failed. Check Vercel logs and API/model access.',
    detail: typeof lastDetail === 'string' ? lastDetail.slice(0, 240) : '',
    attempts: tried
  });
}
