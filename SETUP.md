# Upwork Agent — Full Setup Guide

Follow these steps in order. Takes ~15 minutes.

---

## Step 1 — Get Upwork API Credentials

1. Go to **https://www.upwork.com/developer/keys/apply**
2. Log in with your Upwork account
3. Fill in the application:
   - **App Name**: `My Upwork Agent`
   - **Description**: `Personal automation agent for managing my Upwork account`
   - **Callback URL**: `http://localhost:3333/callback`
   - **Permissions**: Check all (jobs, proposals, messages, contracts)
4. Submit and wait for approval (usually instant for personal use)
5. Copy your **Client ID** and **Client Secret**

---

## Step 2 — Configure Credentials Locally

```bash
# In the upwork-mcp folder
cd upwork-mcp
cp .env.example .env
```

Edit `.env` and fill in:
```
UPWORK_CLIENT_ID=paste_your_client_id_here
UPWORK_CLIENT_SECRET=paste_your_client_secret_here
```

---

## Step 3 — Authorize Your Account (OAuth)

```bash
# Still in upwork-mcp/
node src/auth-server.js
```

This will:
1. Print a URL — open it in your browser
2. You approve access on Upwork
3. Tokens are saved to `.env` automatically
4. The script prints your Railway env vars (save them!)

---

## Step 4 — Configure Your Profile

Edit `upwork-agent/preferences.json`:
- Update `profile.bio_summary` with your actual bio
- Adjust `hourly_rate_usd` to your real rate
- Add/remove skills from the `skills` array
- Tweak `job_search.queries` for your niche
- Set `scoring.auto_apply_threshold` (7 = apply to 7+/10 jobs)

---

## Step 5 — Add Your Anthropic API Key

Get your key at **https://console.anthropic.com**

```bash
cd upwork-agent
cp .env.example .env
```

Edit `.env`:
```
ANTHROPIC_API_KEY=sk-ant-...your-key-here...
UPWORK_MCP_PATH=../upwork-mcp/src/index.js
DRY_RUN=false
```

---

## Step 6 — Test Locally (Dry Run)

```bash
cd upwork-agent
npm run dry-run
```

This searches for jobs, scores them, and logs what it WOULD do — no proposals submitted. Check the output carefully.

If it works, do a real run once:
```bash
npm run run-once
```

---

## Step 7 — Deploy to Railway

1. Go to **https://railway.app** and sign up (free)
2. Click **New Project → Deploy from GitHub repo**
3. Connect your GitHub and select this repo
4. In **Variables**, add ALL of the following (from Steps 2–5):

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your Anthropic key |
| `UPWORK_CLIENT_ID` | from Step 2 |
| `UPWORK_CLIENT_SECRET` | from Step 2 |
| `UPWORK_ACCESS_TOKEN` | from Step 3 output |
| `UPWORK_REFRESH_TOKEN` | from Step 3 output |
| `UPWORK_TOKEN_EXPIRY` | from Step 3 output |
| `UPWORK_MCP_PATH` | `../upwork-mcp/src/index.js` |
| `DRY_RUN` | `false` |
| `AGENT_CRON` | `0 */6 * * *` (every 6h) |

5. Click **Deploy** — Railway builds and starts the container
6. Check **Logs** tab to see the agent running

---

## Monitoring

- **Railway logs**: real-time output in the Railway dashboard
- **Run history locally**: `node upwork-agent/src/index.js --history`
- **Run logs**: saved to `upwork-agent/runs/` as JSON files

---

## Adjusting the Schedule

Change `AGENT_CRON` in Railway variables:
- `0 */6 * * *` — every 6 hours (default)
- `0 9,17 * * *` — 9am and 5pm daily
- `0 9 * * 1-5` — 9am on weekdays only
- `*/30 * * * *` — every 30 minutes (aggressive)

---

## Token Refresh

Access tokens expire. The agent **auto-refreshes** them using the refresh token.
If refresh fails (refresh token expired after 14 days of inactivity), re-run:
```bash
cd upwork-mcp && node src/auth-server.js
```
Then update `UPWORK_ACCESS_TOKEN`, `UPWORK_REFRESH_TOKEN`, and `UPWORK_TOKEN_EXPIRY` in Railway.
