import { createHash, timingSafeEqual } from 'node:crypto';

// Vercel duration is configured in vercel.json for this plain Node.js API route.
const MODELS = new Set(['gemini-3.8-flash', 'gemini-3.5-flash-lite']);
const API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const REQUEST_TIMEOUT_MS = 240_000;
const MAX_PROMPT_CHARS = 500_000;

function sameSecret(a, b) {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

function write(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(body);
}

export default async function handler(req, res) {
  const started = Date.now();
  if (req.method !== 'POST') return write(res, 405, { error: 'Only POST is supported.' });
  if (!process.env.GEMINI_API_KEY || !process.env.APP_PASSWORD) {
    return write(res, 503, { error: 'Server is not configured. Set GEMINI_API_KEY and APP_PASSWORD in Vercel.' });
  }

  const password = req.headers['x-app-password'];
  if (typeof password !== 'string' || !sameSecret(password, process.env.APP_PASSWORD)) {
    return write(res, 401, { error: 'Incorrect website password.' });
  }

  const { prompt, model, previousInteractionId } = req.body || {};
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_CHARS) {
    return write(res, 400, { error: `Enter a message (maximum ${MAX_PROMPT_CHARS.toLocaleString()} characters).` });
  }
  if (!MODELS.has(model)) return write(res, 400, { error: 'Unknown model.' });
  if (previousInteractionId != null && (typeof previousInteractionId !== 'string' || previousInteractionId.length > 200)) {
    return write(res, 400, { error: 'Invalid conversation identifier.' });
  }

  const body = {
    model,
    input: prompt.trim(),
    store: true,
    system_instruction: [
      'You are an expert SAP ABAP and SAP BTP programming assistant.',
      'Explain clearly and simply, and give accurate, complete, copyable code when requested.',
      'Pay attention to classic ABAP vs ABAP Cloud/RAP differences, release constraints, CDS, Open SQL, and internal tables.',
      'If information is uncertain, say so. Do not invent SAP APIs or features.',
      'Use Markdown fenced code blocks with l anguage abap where appropriate.',
      'Do not request confidential company source code or secrets.'
    ].join(' '),
    ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {})
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  console.log('Orbit Gemini start', { model, inputChars: prompt.length });
  try {
    const upstream = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-goog-api-key': process.env.GEMINI_API_KEY,
        'Api-Revision': '2026-05-20',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const raw = await upstream.text();
    let data = {};
    try { data = JSON.parse(raw); } catch { /* unexpected response */ }
    console.log('Orbit Gemini upstream', { status: upstream.status, ms: Date.now() - started, responseBytes: raw.length });

    if (!upstream.ok) {
      let message = 'Gemini API returned an error.';
      const detail = typeof data?.error?.message === 'string' ? data.error.message.slice(0, 350) : '';
      if (upstream.status === 401) message = 'Gemini rejected the API key.';
      else if (upstream.status === 403) message = 'Gemini denied access. Check model access and API project settings.';
      else if (upstream.status === 404) message = 'The selected Gemini model was not found for this API key.';
      else if (upstream.status === 429) message = 'Gemini quota reached. Try again later or choose the Lite model.';
      else if (upstream.status >= 500) message = 'Gemini is temporarily unavailable.';
      return write(res, upstream.status >= 500 ? 502 : upstream.status, { error: message, detail });
    }

    const output = (Array.isArray(data.steps) ? data.steps : [])
      .filter(step => step?.type === 'model_output')
      .flatMap(step => Array.isArray(step.content) ? step.content : [])
      .filter(item => item?.type === 'text' && typeof item.text === 'string')
      .map(item => item.text).join('\n\n').trim();

    if (!output) return write(res, 502, { error: 'Gemini responded but returned no text.' });
    // Never silently truncate the generated ABAP program.
    return write(res, 200, {
      reply: output,
      interactionId: typeof data.id === 'string' ? data.id : null,
      model,
      usage: data.usage ? { input: data.usage.total_input_tokens, output: data.usage.total_output_tokens } : null,
      status: data.status || 'unknown'
    });
  } catch (err) {
    const timeoutError = controller.signal.aborted;
    console.error('Orbit Gemini error', { elapsedMs: Date.now() - started, type: err?.name, cause: err?.cause?.code || null, timeoutError });
    return write(res, 502, {
      error: timeoutError
        ? `Gemini did not finish within ${REQUEST_TIMEOUT_MS / 1000} seconds. Try a lighter model or a smaller task.`
        : 'Orbit could not connect to Gemini. Check the Vercel function logs.'
    });
  } finally {
    clearTimeout(timeout);
  }
}
