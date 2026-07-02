#!/usr/bin/env bash
# install.sh — Install the Hermes Telegram Mini App plugin.
#
# What it does:
#   1. Builds the Vite frontend → ./dist/
#   2. Symlinks ./plugin/ to ~/.hermes/plugins/telegram-app
#   3. Restarts the Hermes dashboard
#   4. Verifies the plugin shows up in /api/dashboard/plugins
#
# Override paths via env vars:
#   HERMES_HOME           default ~/.hermes
#   WEB_ROOT              default /var/www/telegram-app
#   DASHBOARD_URL         default http://127.0.0.1:9119
#   SKIP_BUILD=1          skip npm build (useful when iterating on plugin only)
#   SKIP_DEPLOY=1         skip copying dist to WEB_ROOT (no Caddy yet)

set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
WEB_ROOT="${WEB_ROOT:-/var/www/telegram-app}"
DASHBOARD_URL="${DASHBOARD_URL:-http://127.0.0.1:9119}"

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[install]${NC} $*"; }
warn() { echo -e "${YELLOW}[install]${NC} $*"; }
die()  { echo -e "${RED}[install]${NC} $*" >&2; exit 1; }

# ---- Pre-checks ------------------------------------------------------------
[[ -d "$HERE/plugin/dashboard" ]] || die "plugin/dashboard not found at $HERE"
[[ -f "$HERE/plugin/dashboard/manifest.json" ]] || die "manifest.json missing"
[[ -f "$HERE/plugin/dashboard/plugin_api.py" ]] || die "plugin_api.py missing"
[[ -d "$HERMES_HOME" ]] || die "Hermes home not found at $HERMES_HOME"

# ---- Build frontend --------------------------------------------------------
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
    command -v npm >/dev/null || die "npm not found — install Node.js 18+"
    log "Building frontend (web/) → dist/"
    (cd "$HERE/web" && npm install --silent --no-audit --no-fund && npm run build)
    [[ -d "$HERE/dist" ]] || die "Build did not produce dist/"
    log "Frontend built — $(du -sh "$HERE/dist" | cut -f1)"
else
    log "Skipping frontend build (SKIP_BUILD=1)"
    if [[ ! -d "$HERE/dist" ]]; then
        warn "dist/ not found and SKIP_BUILD=1 — SPA will NOT be deployed!"
        warn "Run without SKIP_BUILD to build, or: cd web && npm install && npm run build"
    fi
fi

# ---- Deploy to web root ---------------------------------------------------
if [[ "${SKIP_DEPLOY:-0}" != "1" ]] && [[ -d "$HERE/dist" ]]; then
    if [[ ! -d "$WEB_ROOT" ]]; then
        log "Creating $WEB_ROOT (will need sudo if not root)"
        ${SUDO:-} mkdir -p "$WEB_ROOT"
    fi
    log "Copying dist/ → $WEB_ROOT/"
    ${SUDO:-} cp -r "$HERE/dist/." "$WEB_ROOT/"
else
    if [[ "${SKIP_DEPLOY:-0}" != "1" ]]; then
        warn "dist/ not found — skipping deploy to $WEB_ROOT"
    fi
fi

# ---- Symlink plugin --------------------------------------------------------
mkdir -p "$HERMES_HOME/plugins"
LINK="$HERMES_HOME/plugins/telegram-app"
if [[ -L "$LINK" ]] || [[ -d "$LINK" ]]; then
    warn "Existing $LINK — removing"
    rm -rf "$LINK"
fi
ln -sfn "$HERE/plugin" "$LINK"
log "Symlinked $LINK → $HERE/plugin"

# ---- Restart dashboard ----------------------------------------------------
if systemctl is-active hermes-dashboard >/dev/null 2>&1; then
    log "Restarting hermes-dashboard service"
    systemctl restart hermes-dashboard
    sleep 4
elif command -v hermes >/dev/null; then
    warn "No systemd unit — start your dashboard manually: hermes dashboard"
else
    warn "Cannot find hermes CLI; start the dashboard yourself."
fi

# ---- Verify ---------------------------------------------------------------
log "Verifying plugin discovery at $DASHBOARD_URL/api/dashboard/plugins"
out=$(curl -sS --max-time 5 "$DASHBOARD_URL/api/dashboard/plugins" || true)
if echo "$out" | grep -q '"name":"telegram-app"'; then
    log "✓ Plugin discovered"
else
    warn "Plugin not in discovery output yet — may take a moment, or check your dashboard logs"
    warn "Output was: $out"
fi

log "Verifying /health"
health=$(curl -sS --max-time 5 "$DASHBOARD_URL/api/plugins/telegram-app/health" || true)
if echo "$health" | grep -q '"ok":true'; then
    log "✓ /health returns OK"
else
    warn "/health probe failed: $health"
fi

log "Done. Open Telegram and tap your bot's menu button."
