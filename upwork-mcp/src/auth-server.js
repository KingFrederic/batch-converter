#!/usr/bin/env node
/**
 * Upwork OAuth2 Setup Helper
 *
 * Run this ONCE to connect your Upwork account.
 * It starts a local server, opens the auth URL, captures the callback,
 * exchanges the code for tokens, and saves everything to .env automatically.
 *
 * Usage:
 *   node src/auth-server.js
 */

import http from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import axios from "axios";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, "..", ".env");
const PORT = 3333;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

// ── Load .env ──────────────────────────────────────────────────────────────────
function loadEnv() {
  if (!existsSync(ENV_PATH)) return;
  for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf("=");
    if (idx === -1) continue;
    const key = t.slice(0, idx).trim();
    const val = t.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

function saveToEnv(updates) {
  let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf-8") : "";
  for (const [key, val] of Object.entries(updates)) {
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(content)) {
      content = content.replace(re, `${key}=${val}`);
    } else {
      content += `\n${key}=${val}`;
    }
  }
  writeFileSync(ENV_PATH, content.trim() + "\n");
}

// ── HTML responses ─────────────────────────────────────────────────────────────
const successHtml = `<!DOCTYPE html><html><head><title>Upwork Connected!</title>
<style>body{font-family:system-ui;max-width:480px;margin:80px auto;text-align:center;color:#1a1a2e}
h1{color:#14a800}p{color:#555}.box{background:#f0faf0;border:1px solid #14a800;border-radius:12px;padding:24px;margin-top:24px}</style></head>
<body><h1>✅ Upwork Connected!</h1>
<div class="box"><p>Your tokens have been saved to <code>.env</code>.</p>
<p>You can close this window.</p>
<p style="margin-top:16px;font-size:13px;color:#888">Next step: run <code>npm run dry-run</code> from the <code>upwork-agent</code> folder.</p>
</div></body></html>`;

const errorHtml = (msg) => `<!DOCTYPE html><html><head><title>Error</title>
<style>body{font-family:system-ui;max-width:480px;margin:80px auto;text-align:center}h1{color:#dc2626}</style></head>
<body><h1>❌ Error</h1><p>${msg}</p></body></html>`;

// ── Main ───────────────────────────────────────────────────────────────────────
loadEnv();

const CLIENT_ID = process.env.UPWORK_CLIENT_ID;
const CLIENT_SECRET = process.env.UPWORK_CLIENT_SECRET;

if (!CLIENT_ID || CLIENT_ID === "your_client_id_here") {
  console.error(`
❌  UPWORK_CLIENT_ID not set in .env

Steps to get your credentials:
  1. Go to: https://www.upwork.com/developer/keys/apply
  2. Sign in and create a new app
  3. App name: "My Upwork Agent" (or anything)
  4. Callback URL: http://localhost:3333/callback
  5. Copy the Client ID and Secret into .env

Then re-run this script.
`);
  process.exit(1);
}

// Build auth URL
const authUrl = new URL("https://www.upwork.com/api/v3/oauth2/authorize");
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);

// Start callback server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname !== "/callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error || !code) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(errorHtml(error || "No code received"));
    console.error("❌ OAuth error:", error);
    server.close();
    process.exit(1);
  }

  console.log("✅ Got authorization code, exchanging for tokens...");

  try {
    const resp = await axios.post(
      "https://api.upwork.com/api/v3/oauth2/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
      {
        auth: { username: CLIENT_ID, password: CLIENT_SECRET },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    const { access_token, refresh_token, expires_in } = resp.data;
    const expiry = Date.now() + expires_in * 1000;

    saveToEnv({
      UPWORK_ACCESS_TOKEN: access_token,
      UPWORK_REFRESH_TOKEN: refresh_token,
      UPWORK_TOKEN_EXPIRY: String(expiry),
    });

    console.log(`
✅  Tokens saved to .env!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Access token:  ${access_token.slice(0, 20)}...
  Expires in:    ${Math.round(expires_in / 60)} minutes
  Refresh token: saved ✓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Next steps:
  1. Test connection:    cd ../upwork-agent && npm run dry-run
  2. Deploy to Railway: see DEPLOY.md

For Railway deployment, set these env vars in your project:
  UPWORK_CLIENT_ID     = ${CLIENT_ID}
  UPWORK_CLIENT_SECRET = ${CLIENT_SECRET}
  UPWORK_ACCESS_TOKEN  = ${access_token}
  UPWORK_REFRESH_TOKEN = ${refresh_token}
  UPWORK_TOKEN_EXPIRY  = ${expiry}
  ANTHROPIC_API_KEY    = (your Anthropic key)
  UPWORK_MCP_PATH      = ../upwork-mcp/src/index.js
  DRY_RUN              = false
`);

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(successHtml);
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end(errorHtml(msg));
    console.error("❌ Token exchange failed:", msg);
  }

  server.close();
  setTimeout(() => process.exit(0), 500);
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║      Upwork OAuth2 Setup — Step 1 of 1           ║
╚══════════════════════════════════════════════════╝

1. Open this URL in your browser:

   ${authUrl.toString()}

2. Log in to Upwork and click "Allow Access"

3. You'll be redirected back here automatically

Waiting for authorization...
`);
});
