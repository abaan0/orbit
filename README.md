# Orbit Code: personal Gemini-powered ABAP chat website

A browser-based coding assistant designed for SAP ABAP learning. No PowerShell is needed on the computer where you use the site.

## Features

- Gemini 3.8 Flash or 3.5 Flash-Lite, both with listed API free tiers (subject to quotas and availability)
- Code formatting and one-click code copy
- Conversations saved locally in that browser, not in a central database
- Server-side Gemini API key (never sent to the user's browser)
- Website password (`APP_PASSWORD`) required for API calls
- Multi-turn chat via Google's Interactions API
- `/api/health` shows whether the server is configured (does not contact Google)
- Responsive desktop and mobile layout

## Deploy with your browser, no terminal commands needed

1. On a **personal device**, generate a **new** key at https://aistudio.google.com/api-keys . Revoke any previously shared keys.
2. Create a **private** GitHub repository, e.g. `orbit-code`.
3. Unzip the project. In GitHub, use **Add file → Upload files** and upload the contents of the `gemini-abap-chat` folder at the repository root. The `api/` folder must remain intact. Do not upload `.env` files or any actual API keys.
4. Open https://vercel.com/new and sign in. Choose **Import Git Repository**, select your repository, and leave the framework preset as **Other** if asked.
5. Under **Environment Variables** add:
   - `GEMINI_API_KEY` = your fresh Gemini API key
   - `APP_PASSWORD` = a long, unique password for your private website
6. Click **Deploy**. If variables were entered after deployment, redeploy from Vercel so the server picks them up.
7. Open the generated `https://<your-project>.vercel.app` link, enter the website password, then send: `Explain SAP ABAP internal tables in two sentences.`
8. A response means the deployed site's backend can reach Gemini. Separately, check whether the website itself is accessible from the office laptop under company policies.

**No API key ever belongs in `app.js`, `index.html`, GitHub commits, screenshots, or chat messages.**

## How traffic flows

Browser → `your-site.vercel.app/api/chat` (password checked) → Google Gemini Interactions API → response displayed in browser.

The office browser sends requests only to **your site's domain**. The website's backend contacts Google. This arrangement should only be used on networks and for data where the deployment is authorized; it does not imply approval from an employer.

## API model choices

Uses the Gemini Interactions API `POST https://generativelanguage.googleapis.com/v1beta/interactions` with `Api-Revision: 2026-05-20`. Model availability, rate limits and prices may change. See https://aistudio.google.com/docs/pricing .

## Security notes

- This is a private personal demo, not an enterprise-ready confidential-code tool. The site password is stored in sessionStorage for convenience; chats are stored in localStorage on that browser.
- The default Gemini **free tier can use prompts to improve Google's products**. Avoid confidential company/client data and secrets unless your organization explicitly approves the provider, deployment, data handling, and tier.
- Anyone with your website password can consume your Google quota; do not share it. For wider use, implement enterprise login, audit logging, persistent rate limits, and approved data retention before deployment.
- Local chat history is not synced across devices. Clearing browser site storage deletes it.
- Never put API keys or passwords in the repository or in frontend code.

## Troubleshooting

- **Site shows a 404 on `/api/health`:** Vercel likely didn't recognize the repository structure; check that `api/` is at repo root.
- **Setup required / 503:** Set both environment variables in Vercel and redeploy.
- **Incorrect website password / 401:** Enter exactly the value of `APP_PASSWORD`.
- **Gemini rejected key / 401:** Replace the Gemini key in Vercel with a valid fresh key.
- **Gemini API returned 403:** Verify AI Studio project/model access.
- **Gemini quota / 429:** Try a lighter model or check AI Studio usage limits.
- **Site opens but answers fail:** The website server can be reached but its outbound Google API call may be failing. Check Vercel deployment logs.
- **Website cannot load on a managed laptop:** Its network policy may block Vercel-hosted sites. Do not try to defeat the restriction; request access through the approved company process.

## Source references

- Google Interactions API: https://aistudio.google.com/docs/interactions-overview
- Google API getting started: https://aistudio.google.com/docs/get-started
- Vercel functions: https://vercel.com/docs/functions
- Vercel deploy from Git: https://vercel.com/docs/git
