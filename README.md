# Hermes Telegram Mini App

A mobile control panel for [Hermes Agent](https://github.com/NousResearch/hermes-agent) that runs as a Telegram Mini App. Tap the bot menu button on your phone, see live system status, recent sessions, cron jobs, and send messages back into your bot chat without leaving Telegram.

Built as a **Hermes dashboard plugin**, so it lives entirely in `~/.hermes/plugins/telegram-app/` and survives every `hermes update` without touching the upstream repo.

## What you get

- **Status** — live CPU / memory / disk gauges, load average, sessions count, cron count, uptime
- **Sessions** — recent agent sessions with title, preview, message count, token usage, cost
- **Cron** — list scheduled jobs, pause / resume / trigger now
- **Send** — type a message that lands in your DM with the bot, exactly as if you'd typed it there. Hermes replies in the chat.
- **Telegram-native theming** — picks up your Telegram light/dark theme automatically
- **Haptic feedback** on button taps via the WebApp SDK

## Architecture

```
┌─────────────────┐  Telegram WebView
│ Telegram phone  │  ┌─────────────────────────┐
│   bot menu  →───┼──┤ React SPA               │
└─────────────────┘  │ window.Telegram.WebApp  │
                     │   .initData             │
                     └──────────┬──────────────┘
                                │ POST initData
                                │ HTTPS, Caddy reverse-proxy
                                ▼
       ┌──────────────────────────────────────────┐
       │ Hermes dashboard (FastAPI on :9119)      │
       │   /api/plugins/telegram-app/auth/verify  │
       │     ├─ HMAC-SHA256(bot_token, …)         │
       │     ├─ fallback: Ed25519 + Telegram pub  │
       │     └─ owner-id allowlist                │
       │   returns: dashboard session token       │
       └──────────────────────────────────────────┘
```

The auth flow:

1. SPA loads inside Telegram WebView, reads `window.Telegram.WebApp.initData`
2. `POST /api/plugins/telegram-app/auth/verify` with the initData payload
3. Plugin validates with HMAC-SHA256 (primary) and falls back to Ed25519 against [Telegram's published public key](https://core.telegram.org/bots/webapps#validating-data-for-third-party-use)
4. Allowlist check against `TELEGRAM_OWNER_ID` (or `TELEGRAM_ALLOWED_USERS`)
5. On success the plugin returns the upstream dashboard session token
6. The SPA caches the token and sends it as `X-Hermes-Session-Token` on every subsequent call. The dashboard's existing auth middleware accepts those calls — no parallel auth system to maintain.

## Why a plugin, not a fork

Earlier Hermes mini apps shipped as forks that overlay `web_server.py`. That breaks every time `hermes update` runs because:

- Upstream `web_server.py` keeps adding routes (plugins, themes, profiles, etc.)
- The fork's overlay is older, so update wipes out half the dashboard
- The post-merge git hook arms race is a chore

This plugin instead lives outside the upstream repo (`~/.hermes/plugins/telegram-app/`) and uses the dashboard's stable plugin contract:

- `manifest.json` — declared at boot
- `plugin_api.py` — auto-discovered, mounted at `/api/plugins/telegram-app/*`
- Static SPA — served via Caddy on its own subdomain (no overlap with the dashboard at `:9119`)

`hermes update` cannot touch any of those locations. There's no monkey-patching of upstream files, no overlay copying, no git-hook reapplication.

## Prerequisites

- Hermes Agent v0.14.0 or later (uses the dashboard plugin loader)
- A Telegram bot — create one via [@BotFather](https://t.me/BotFather), save the token
- Your numeric Telegram user ID — get it from [@userinfobot](https://t.me/userinfobot)
- A publicly reachable HTTPS endpoint for your Hermes dashboard. Easiest: a domain pointing at your VPS with [Caddy](https://caddyserver.com/) in front. DuckDNS works.
- Python `cryptography` package (already bundled in the Hermes venv on most installs)
- Node.js 18+ to build the frontend

## Setup

### 1. Environment variables

Add to `~/.hermes/.env`:

```bash
TELEGRAM_BOT_TOKEN=123456789:AABBCC…
TELEGRAM_OWNER_ID=1234567890
# Optional — comma-separated for multi-user
# TELEGRAM_ALLOWED_USERS=1234567890,9876543210
```

### 2. Install the plugin

Clone, build, and symlink into the Hermes plugins folder:

```bash
git clone https://github.com/gnpa910/hermes-telegram-miniapp.git ~/projects/hermes-telegram-miniapp
cd ~/projects/hermes-telegram-miniapp
./scripts/install.sh
```

That script:

1. Builds the Vite frontend → `dist/`
2. Symlinks `plugin/` → `~/.hermes/plugins/telegram-app`
3. Restarts the dashboard (`systemctl restart hermes-dashboard` or `hermes dashboard --reload` depending on your install)
4. Verifies the plugin shows up in `/api/dashboard/plugins`

### 3. Caddy site

Add to your `Caddyfile` and reload:

```caddy
app.example.com {
    handle /api/* {
        reverse_proxy localhost:9119 {
            header_up Host {upstream_hostport}
        }
    }
    handle {
        root * /var/www/telegram-app
        try_files {path} /index.html
        file_server
    }
    encode gzip
    @assets path /assets/*
    header @assets Cache-Control "public, max-age=31536000, immutable"
    header /index.html Cache-Control "no-cache"
    header Content-Security-Policy "default-src 'self' https://telegram.org; script-src 'self' https://telegram.org 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://telegram.org; frame-ancestors https://web.telegram.org https://*.telegram.org;"
}
```

Replace `app.example.com` with your subdomain. Copy `dist/*` to `/var/www/telegram-app/`:

```bash
sudo mkdir -p /var/www/telegram-app
sudo cp -r dist/* /var/www/telegram-app/
sudo systemctl reload caddy
```

### 4. Set the bot menu button

```bash
TOKEN=<your_bot_token>
USER_ID=<your_numeric_id>
URL=https://app.example.com/

curl -sS -X POST "https://api.telegram.org/bot${TOKEN}/setChatMenuButton" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\": ${USER_ID}, \"menu_button\": {\"type\": \"web_app\", \"text\": \"Hermes\", \"web_app\": {\"url\": \"${URL}\"}}}"
```

The button appears next to the message input in your DM with the bot.

### 5. Verify

- Tap the menu button on your phone — the mini app should load with your Telegram theme
- Status tab should show CPU / memory / disk gauges with live values
- Sessions tab should show your recent Hermes sessions
- Send tab — type "hello" and submit; you should see the message land in your bot chat and Hermes reply

If the auth gate shows "Open this app from the Telegram bot menu button", you opened the URL outside Telegram. Use the menu button.

## Endpoints

All under `/api/plugins/telegram-app/`:

| Method | Path                        | Auth     | Description                       |
|--------|-----------------------------|----------|-----------------------------------|
| GET    | `/health`                   | public   | Liveness probe (Caddy / uptime)   |
| POST   | `/auth/verify`              | initData | Validate initData, issue session token |
| GET    | `/auth/verify`              | initData header | Same, GET form for browser tests |
| GET    | `/status`                   | session  | CPU / mem / disk + Hermes counts  |
| GET    | `/sessions?limit=N`         | session  | Recent sessions (slim)            |
| GET    | `/sessions/{id}/messages`   | session  | Message log for a session         |
| GET    | `/cron`                     | session  | List cron jobs                    |
| POST   | `/cron/{id}/pause`          | session  | Pause a job                       |
| POST   | `/cron/{id}/resume`         | session  | Resume a job                      |
| POST   | `/cron/{id}/trigger`        | session  | Run a job now                     |
| POST   | `/command`                  | session  | Send text to user's bot DM        |

## Security

- **HMAC-SHA256 + Ed25519** validation of every initData payload (24-hour freshness window)
- **Allowlist** — `TELEGRAM_OWNER_ID` / `TELEGRAM_ALLOWED_USERS` are checked after signature passes; non-owner users get 403
- **CSP** — frame-ancestors limited to `*.telegram.org`, no inline scripts beyond Telegram SDK
- **No bot token in client** — the SPA never sees the bot token. All validation happens server-side
- **Dashboard session token** — issued server-side after initData validation, never embedded in HTML, only in API responses to authenticated requests

## Compatibility

| Hermes version | Status |
|----------------|--------|
| 0.14.0         | ✅ tested |
| 0.13.x         | likely (plugin loader unchanged) |
| < 0.13         | ❌ no dashboard plugin system |

## Development

```bash
cd web
npm install
npm run dev   # Vite dev server on :5173, /api/* proxies to :9119
```

For testing outside Telegram, set `localStorage.devSessionToken` to your dashboard's session token (visible in `view-source:` of `http://127.0.0.1:9119/`, look for `window.__HERMES_SESSION_TOKEN__`).

## License

MIT — see `LICENSE`.

## Credits

Inspired by [clawvader-tech/hermes-telegram-miniapp](https://github.com/clawvader-tech/hermes-telegram-miniapp) — but rebuilt as a non-invasive plugin instead of an upstream overlay.
