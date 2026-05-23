"""Background watchdog that pushes alerts to the user's Telegram DM.

Three watch types:

1. **Cron failures** — polls ``cron.jobs.list_jobs()`` and DMs once per
   newly-failed run (dedups on the run_id-equivalent: ``last_run`` + job_id).
2. **Error log** — tails ``~/.hermes/logs/errors.log`` and DMs each new
   ERROR/CRITICAL line, throttled to one alert per N seconds.
3. **Daily spend threshold** — sums ``estimated_cost_usd`` across today's
   sessions; once it crosses the configured threshold, fires once per
   local-day (resets at 00:00).

State lives in ``~/.hermes/state/telegram-app/alerts_state.json``.
Settings live in ``~/.hermes/state/telegram-app/alerts.json`` and are
hot-readable so the SPA can update them without restarting the daemon.

The daemon is started lazily at plugin import time via ``ensure_started()``;
calling it twice is a no-op (guarded by a module lock so reloads in dev
don't spawn multiple threads).
"""
from __future__ import annotations

import datetime as _dt
import json
import logging
import os
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

_log = logging.getLogger("hermes.plugin.telegram-app.alerts")

_PLUGIN_DIR = Path.home() / ".hermes" / "state" / "telegram-app"
_PLUGIN_DIR.mkdir(parents=True, exist_ok=True)
_SETTINGS_PATH = _PLUGIN_DIR / "alerts.json"
_STATE_PATH = _PLUGIN_DIR / "alerts_state.json"

DEFAULT_SETTINGS: Dict[str, Any] = {
    "cron_failures": True,
    "error_log": False,           # noisy; opt-in
    "cost_threshold": True,
    "cost_daily_usd": 5.0,        # alert above this dollar amount per local day
    "error_throttle_sec": 300,    # min seconds between error log alerts
    "poll_interval_sec": 30,
}

_thread_started = False
_thread_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Persistence helpers
# ---------------------------------------------------------------------------
def _read_json(path: Path, fallback: Dict[str, Any]) -> Dict[str, Any]:
    if not path.exists():
        return dict(fallback)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return dict(fallback)
        # Backfill missing keys so callers can rely on full shape.
        merged = dict(fallback)
        merged.update(data)
        return merged
    except Exception as exc:
        _log.warning("alerts: bad JSON at %s: %s", path, exc)
        return dict(fallback)


def _write_json(path: Path, data: Dict[str, Any]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(path)
    except Exception as exc:
        _log.warning("alerts: write %s failed: %s", path, exc)


def get_settings() -> Dict[str, Any]:
    return _read_json(_SETTINGS_PATH, DEFAULT_SETTINGS)


def update_settings(patch: Dict[str, Any]) -> Dict[str, Any]:
    cur = get_settings()
    for k, v in patch.items():
        if k in DEFAULT_SETTINGS:
            cur[k] = v
    _write_json(_SETTINGS_PATH, cur)
    return cur


def _state() -> Dict[str, Any]:
    return _read_json(
        _STATE_PATH,
        {
            "cron_last_alert_per_job": {},   # job_id → last_run timestamp alerted
            "errors_last_size": 0,            # bytes already scanned
            "errors_last_alert_ts": 0.0,      # unix ts of last error alert
            "errors_last_signature": "",      # last alerted signature (dedup short-burst)
            "errors_count_per_day": {},       # YYYY-MM-DD → count of error alerts emitted
            "cost_alerted_for_day": "",       # YYYY-MM-DD already alerted
            "cost_alerted_value": 0.0,
            "last_test_ts": 0.0,
            "last_tick_ts": 0.0,              # unix ts of most recent watcher tick
            "last_alert_ts": 0.0,             # unix ts of most recent alert sent (any kind)
            "last_alert_kind": "",            # "cron" | "error" | "cost" | "test" | ""
        },
    )


def _save_state(state: Dict[str, Any]) -> None:
    _write_json(_STATE_PATH, state)


# ---------------------------------------------------------------------------
# Telegram delivery
# ---------------------------------------------------------------------------
def _bot_token_and_chat() -> Optional[tuple[str, int]]:
    """Pull bot token + first allowed chat id from .env / process env."""
    # Read from .env directly so we don't depend on plugin_api's helpers
    # (which import-cycle if alerts.py is imported during plugin init).
    env_path = Path.home() / ".hermes" / ".env"
    env: Dict[str, str] = dict(os.environ)
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k = k.strip()
            if k and k not in env:
                env[k] = v.strip().strip('"').strip("'")
    token = env.get("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        return None
    raw = env.get("TELEGRAM_OWNER_ID") or env.get("TELEGRAM_ALLOWED_USERS") or ""
    for piece in raw.split(","):
        piece = piece.strip()
        try:
            return token, int(piece)
        except ValueError:
            continue
    return None


def _send_telegram(text: str) -> bool:
    creds = _bot_token_and_chat()
    if not creds:
        _log.debug("alerts: no token/chat configured; skipping send")
        return False
    token, chat_id = creds
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = json.dumps(
        {"chat_id": chat_id, "text": text, "disable_web_page_preview": True}
    ).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if not data.get("ok"):
            _log.warning("alerts: Telegram API rejected: %s", data)
            return False
        return True
    except Exception as exc:
        _log.warning("alerts: send failed: %s", exc)
        return False


# ---------------------------------------------------------------------------
# Watchers
# ---------------------------------------------------------------------------
def _check_cron_failures(state: Dict[str, Any]) -> None:
    try:
        from cron.jobs import list_jobs  # type: ignore
    except Exception:
        return
    seen: Dict[str, float] = state.setdefault("cron_last_alert_per_job", {})
    try:
        jobs = list_jobs(include_disabled=True)
    except Exception as exc:
        _log.debug("alerts: list_jobs failed: %s", exc)
        return
    for j in jobs:
        last_status = str(j.get("last_status") or "").lower()
        last_run = j.get("last_run") or 0
        try:
            last_run = float(last_run)
        except (TypeError, ValueError):
            last_run = 0.0
        if last_status in ("error", "failed", "failure") and last_run > 0:
            previous = float(seen.get(j["id"], 0) or 0)
            if last_run > previous:
                # New failure → fire and remember
                seen[j["id"]] = last_run
                name = j.get("name") or j["id"]
                schedule = j.get("schedule") or ""
                err = (j.get("last_error") or "").strip()[:300]
                msg = (
                    f"🚨 Cron failed: {name}\n"
                    f"schedule: {schedule}\n"
                )
                if err:
                    msg += f"error: {err}\n"
                msg += "Open the Hermes mini app → Cron → tap the row to edit."
                if _send_telegram(msg):
                    _log.info("alerts: notified cron failure for %s", j["id"])
                    state["last_alert_ts"] = time.time()
                    state["last_alert_kind"] = "cron"


def _check_error_log(state: Dict[str, Any], settings: Dict[str, Any]) -> None:
    log_path = Path.home() / ".hermes" / "logs" / "errors.log"
    if not log_path.exists():
        return
    try:
        size = log_path.stat().st_size
    except Exception:
        return
    last_size = int(state.get("errors_last_size", 0))
    if size <= last_size:
        # Log was rotated/truncated — reset baseline
        state["errors_last_size"] = size
        return
    # Read only the new tail (with a 64 KB hard cap so a megabyte burst
    # doesn't choke us — we summarise instead of dumping every line).
    new_window = min(size - last_size, 64 * 1024)
    try:
        with log_path.open("rb") as fh:
            fh.seek(size - new_window)
            chunk = fh.read()
    except Exception as exc:
        _log.debug("alerts: cannot read errors.log: %s", exc)
        return
    state["errors_last_size"] = size

    text = chunk.decode("utf-8", errors="replace")
    candidates: List[str] = []
    for line in text.splitlines():
        upper = line.upper()
        if "ERROR" in upper or "CRITICAL" in upper:
            candidates.append(line.strip())
    if not candidates:
        return

    # Throttle: at most one alert per ``error_throttle_sec``
    throttle = float(settings.get("error_throttle_sec", 300))
    last_ts = float(state.get("errors_last_alert_ts", 0))
    now = time.time()
    if last_ts and (now - last_ts) < throttle:
        return

    # Cheap signature dedup so a re-fired identical message inside two
    # ticks isn't sent twice.
    sig = candidates[-1][:120]
    if sig == state.get("errors_last_signature"):
        return

    # Build alert: 1 sample line + count if >1
    sample = candidates[-1][:300]
    extra = ""
    if len(candidates) > 1:
        extra = f"\n(+{len(candidates) - 1} more error lines in this burst)"
    msg = f"🔥 Hermes error\n{sample}{extra}\n\nLogs tab → errors for full context."
    if _send_telegram(msg):
        state["errors_last_alert_ts"] = now
        state["errors_last_signature"] = sig
        state["last_alert_ts"] = now
        state["last_alert_kind"] = "error"
        today = _dt.datetime.now().strftime("%Y-%m-%d")
        per_day = state.setdefault("errors_count_per_day", {})
        per_day[today] = int(per_day.get(today, 0)) + 1
        # Trim history to last 7 days so the dict can't grow forever.
        if len(per_day) > 14:
            for old in sorted(per_day.keys())[:-7]:
                per_day.pop(old, None)
        _log.info("alerts: notified error burst (%d lines)", len(candidates))


def _check_cost_threshold(state: Dict[str, Any], settings: Dict[str, Any]) -> None:
    threshold = float(settings.get("cost_daily_usd", 0) or 0)
    if threshold <= 0:
        return
    today = _dt.datetime.now().strftime("%Y-%m-%d")
    if state.get("cost_alerted_for_day") == today:
        return
    try:
        from hermes_state import SessionDB  # type: ignore
        rows = SessionDB().list_sessions_rich(
            limit=500, order_by_last_active=True
        )
    except Exception as exc:
        _log.debug("alerts: SessionDB unavailable: %s", exc)
        return

    midnight = _dt.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    cutoff = midnight.timestamp()
    total = 0.0
    for s in rows:
        ts = s.get("last_active") or s.get("started_at") or 0
        try:
            ts = float(ts)
        except (TypeError, ValueError):
            ts = 0.0
        if ts >= cutoff:
            total += float(s.get("estimated_cost_usd") or 0)

    if total >= threshold:
        msg = (
            f"💸 Daily Hermes spend over ${threshold:.2f}\n"
            f"Today's cost so far: ${total:.2f}\n\n"
            f"Status tab → Usage to see top sessions."
        )
        if _send_telegram(msg):
            state["cost_alerted_for_day"] = today
            state["cost_alerted_value"] = total
            state["last_alert_ts"] = time.time()
            state["last_alert_kind"] = "cost"
            _log.info("alerts: notified cost threshold (%.2f >= %.2f)", total, threshold)


# ---------------------------------------------------------------------------
# Daemon
# ---------------------------------------------------------------------------
def _watcher_loop() -> None:
    _log.info("alerts: watcher thread started")
    # Initial baseline: don't fire on stuff that already happened before we
    # turned on. So at first start, snapshot current state and persist.
    state = _state()
    if state.get("errors_last_size", 0) == 0:
        log_path = Path.home() / ".hermes" / "logs" / "errors.log"
        try:
            state["errors_last_size"] = (
                log_path.stat().st_size if log_path.exists() else 0
            )
        except Exception:
            pass
    if not state.get("cron_last_alert_per_job"):
        # Snapshot existing failures so we don't spam on first boot
        try:
            from cron.jobs import list_jobs  # type: ignore
            for j in list_jobs(include_disabled=True):
                if str(j.get("last_status") or "").lower() in (
                    "error", "failed", "failure"
                ):
                    state["cron_last_alert_per_job"][j["id"]] = float(
                        j.get("last_run") or 0
                    )
        except Exception:
            pass
    _save_state(state)

    while True:
        try:
            settings = get_settings()
            interval = max(15, int(settings.get("poll_interval_sec", 30)))
            state = _state()
            if settings.get("cron_failures"):
                _check_cron_failures(state)
            if settings.get("error_log"):
                _check_error_log(state, settings)
            if settings.get("cost_threshold"):
                _check_cost_threshold(state, settings)
            state["last_tick_ts"] = time.time()
            _save_state(state)
        except Exception as exc:
            _log.exception("alerts: tick failed: %s", exc)
        time.sleep(interval)


def ensure_started() -> None:
    """Start the watcher thread once per process. Idempotent."""
    global _thread_started
    with _thread_lock:
        if _thread_started:
            return
        # Initialise settings file with defaults if missing so users see
        # the toggles populated correctly on first open.
        if not _SETTINGS_PATH.exists():
            _write_json(_SETTINGS_PATH, DEFAULT_SETTINGS)
        t = threading.Thread(
            target=_watcher_loop, name="hermes-tma-alerts", daemon=True
        )
        t.start()
        _thread_started = True


def trigger_test() -> Dict[str, Any]:
    """Fire a synthetic test message immediately."""
    creds = _bot_token_and_chat()
    if not creds:
        return {
            "ok": True,
            "sent": False,
            "reason": "no_bot_token_or_owner_chat",
        }
    text = (
        "✅ Hermes alerts test\n"
        "If you can see this, alerts are wired up and your bot is reachable."
    )
    sent = _send_telegram(text)
    state = _state()
    now = time.time()
    state["last_test_ts"] = now
    if sent:
        state["last_alert_ts"] = now
        state["last_alert_kind"] = "test"
    _save_state(state)
    return {
        "ok": True,
        "sent": sent,
        "reason": None if sent else "telegram_api_rejected",
    }


def get_status() -> Dict[str, Any]:
    """Return settings + state for the SPA.

    Shape mirrors the frontend ``AlertsStatus`` interface:
      settings, running, last_tick, last_alert_at, last_alert_kind,
      errors_emitted_today, cron_failures_seen, state_path,
      has_bot_token, has_owner_chat.
    """
    settings = get_settings()
    state = _state()
    creds = _bot_token_and_chat()
    today = _dt.datetime.now().strftime("%Y-%m-%d")
    errors_per_day = state.get("errors_count_per_day") or {}
    return {
        "settings": settings,
        "running": _thread_started,
        "last_tick": float(state.get("last_tick_ts") or 0) or None,
        "last_alert_at": float(state.get("last_alert_ts") or 0) or None,
        "last_alert_kind": state.get("last_alert_kind") or None,
        "errors_emitted_today": int(errors_per_day.get(today, 0) or 0),
        "cron_failures_seen": len(state.get("cron_last_alert_per_job") or {}),
        "state_path": str(_STATE_PATH),
        "has_bot_token": bool(creds and creds[0]),
        "has_owner_chat": bool(creds and creds[1]),
    }
