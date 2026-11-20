export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Only GET is supported.' });
  const configured = Boolean(process.env.GEMINI_API_KEY && process.env.APP_PASSWORD);
  return res.status(configured ? 200 : 503).json({
    server: configured ? 'ready' : 'setup_required',
    geminiKeyConfigured: Boolean(process.env.GEMINI_API_KEY),
    websitePasswordConfigured: Boolean(process.env.APP_PASSWORD),
    note: 'This checks configuration, not connectivity to Gemini.'
  });
}
