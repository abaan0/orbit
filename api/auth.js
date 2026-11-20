import { createHash, timingSafeEqual } from 'node:crypto';

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Only GET is supported.' });
  if (!process.env.GEMINI_API_KEY || !process.env.APP_PASSWORD) {
    return res.status(503).json({ error: 'Deployment setup incomplete. Configure GEMINI_API_KEY and APP_PASSWORD.' });
  }
  const password = req.headers['x-app-password'];
  if (typeof password !== 'string') return res.status(401).json({ error: 'Enter the website password.' });
  const provided = createHash('sha256').update(password).digest();
  const expected = createHash('sha256').update(process.env.APP_PASSWORD).digest();
  if (!timingSafeEqual(provided, expected)) return res.status(401).json({ error: 'Incorrect website password.' });
  return res.status(200).json({ success: true });
}
