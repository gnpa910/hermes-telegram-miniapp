"""Telegram Mini App plugin — backend API routes.

Mounted by Hermes dashboard plugin loader at ``/api/plugins/telegram-app/``.

Auth model
----------
Hermes dashboard already gates every ``/api/*`` route with an ephemeral
session token (``X-Hermes-Session-Token``). The plugin lets two paths
through *without* that token by adding them to the public-paths set:

  /api/plugins/telegram-app/health        — no auth, used by Caddy/uptime
  /api/plugins/telegram-app/auth/verify   — accepts Telegram initData and
                                            issues the dashboard session token

A Telegram Mini App client therefore:

  1. Loads with ``window.Telegram.WebApp.initData`` from Telegram.
  2. Calls ``/auth/verify`` posting initData; the plugin validates it
     (HMAC-SHA256 with bot token, with Ed25519 fallback against Telegram's
     published public key).
  3. Receives the upstream dashboard session token in the JSON response.
  4. Sends ``X-Hermes-Session-Token: <token>`` on every subsequent
     dashboard API call. The upstream middleware accepts those calls
     normally — we don't fork the auth system.

Everything below ``/api/plugins/telegram-app/...`` aside from health and
auth/verify is just convenience wrappers (status, sessions, cron) that
operate inside the dashboard process and rely on upstream auth.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

HERMES_ROOT = Path("/usr/local/lib/hermes-agent")
if HERMES_ROOT.exists() and str(HERMES_ROOT) not in sys.path:
    sys.path.insert(0, str(HERMES_ROOT))

router = APIRouter()
_log = logging.getLogger("hermes.plugin.telegram-app")
_start_time = time.time()


# ---------------------------------------------------------------------------
# Patch upstream's public-paths set so /health and /auth/verify pass through
# the dashboard's auth middleware. This is done at plugin import time.
# ---------------------------------------------------------------------------
def _allow_public(paths: List[str]) -> None:
    try:
        import hermes_cli.web_server as ws  # type: ignore
        # _PUBLIC_API_PATHS is a frozenset; rebuild it as a frozenset with
        # our paths added so the membership check at line ~240 passes.
        existing = set(getattr(ws, "_PUBLIC_API_PATHS", frozenset()))
        existing.update(paths)
        ws._PUBLIC_API_PATHS = frozenset(existing)
        _log.info("telegram-app: registered public paths %s", paths)
    except Exception as exc:
        _log.warning("telegram-app: could not patch _PUBLIC_API_PATHS: %s", exc)


_allow_public([
    "/api/plugins/telegram-app/health",
    "/api/plugins/telegram-app/auth/verify",
])


def _get_session_token() -> str:
    """Fetch the dashboard session token from the running web_server module.

    Token is generated fresh on every server start (web_server.py:_SESSION_TOKEN)
    and never persisted. We just need to read it from the same process.
    """
    try:
        import hermes_cli.web_server as ws  # type: ignore
        return getattr(ws, "_SESSION_TOKEN", "") or ""
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Config — read at request time so .env edits picked up without reload.
# ---------------------------------------------------------------------------
def _env(name: str, default: str = "") -> str:
    val = os.getenv(name, "").strip()
    if val:
        return val
    env_file = Path.home() / ".hermes" / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            if k.strip() == name:
                return v.strip().strip('"').strip("'")
    return default


def _bot_token() -> str:
    return _env("TELEGRAM_BOT_TOKEN")


def _allowed_user_ids() -> List[str]:
    raw = _env("TELEGRAM_OWNER_ID") or _env("TELEGRAM_ALLOWED_USERS")
    return [x.strip() for x in raw.split(",") if x.strip()]


# Telegram production Ed25519 public key (32 bytes hex).
# Ref: https://core.telegram.org/bots/webapps#validating-data-for-third-party-use
TELEGRAM_ED25519_PUBKEY_HEX = (
    "e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d"
)


# ---------------------------------------------------------------------------
# Telegram initData validation — HMAC primary, Ed25519 fallback.
# ---------------------------------------------------------------------------
def _parse_init_data(init_data: str) -> Dict[str, Any]:
    """Parse the URL-encoded initData query string.

    Telegram now ships *both* ``hash`` (HMAC) and ``signature`` (Ed25519)
    in the same payload. For HMAC validation only ``hash`` is excluded
    from the data_check_string — ``signature`` is treated like any other
    data field. Ed25519 validation uses a different DCS (built separately
    in ``_validate_ed25519``) that excludes ``signature`` itself but
    includes ``hash``. Reference:
    https://core.telegram.org/bots/webapps#validating-data-for-third-party-use
    """
    pairs: Dict[str, str] = {}
    hash_val: Optional[str] = None
    signature: Optional[str] = None
    for part in init_data.split("&"):
        if "=" not in part:
            continue
        k, _, v = part.partition("=")
        v_dec = urllib.parse.unquote(v)
        if k == "hash":
            hash_val = v_dec
            continue
        if k == "signature":
            signature = v_dec
            # signature is *also* part of the HMAC data_check_string.
            pairs[k] = v_dec
            continue
        pairs[k] = v_dec
    sorted_kv = sorted(pairs.items())
    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted_kv)
    return {
        "raw_pairs": pairs,
        "hash": hash_val,
        "signature": signature,
        "data_check_string": data_check_string,
    }


def _validate_hmac(parsed: Dict[str, Any]) -> bool:
    token = _bot_token()
    if not token or not parsed.get("hash"):
        return False
    secret = hmac.new(b"WebAppData", token.encode("utf-8"), hashlib.sha256).digest()
    computed = hmac.new(
        secret, parsed["data_check_string"].encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(computed, parsed["hash"])


def _validate_ed25519(parsed: Dict[str, Any]) -> bool:
    sig_b64 = parsed.get("signature")
    if not sig_b64:
        return False
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import (
            Ed25519PublicKey,
        )
    except ImportError:
        _log.warning("cryptography missing — Ed25519 validation skipped")
        return False
    pubkey = Ed25519PublicKey.from_public_bytes(
        bytes.fromhex(TELEGRAM_ED25519_PUBKEY_HEX)
    )
    padding = "=" * (-len(sig_b64) % 4)
    try:
        sig_bytes = base64.urlsafe_b64decode(sig_b64 + padding)
    except Exception as exc:
        _log.debug("ed25519 sig decode fail: %s", exc)
        return False
    # Ed25519 DCS *excludes* signature but *includes* hash. Build it
    # from raw_pairs (which already contains signature for HMAC) by
    # dropping signature and adding hash back.
    fields = {k: v for k, v in parsed["raw_pairs"].items() if k != "signature"}
    if parsed.get("hash"):
        fields["hash"] = parsed["hash"]
    ed_dcs = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    try:
        pubkey.verify(sig_bytes, ed_dcs.encode("utf-8"))
        return True
    except Exception as exc:
        _log.debug("ed25519 verify fail: %s", exc)
        return False


def _validate_init_data(init_data: str) -> Optional[Dict[str, Any]]:
    if not init_data:
        return None
    parsed = _parse_init_data(init_data)
    auth_date_str = parsed["raw_pairs"].get("auth_date", "0")
    try:
        auth_date = int(auth_date_str)
    except ValueError:
        return None
    if auth_date and (time.time() - auth_date) > 86400:
        _log.warning("initData expired age=%ds", int(time.time() - auth_date))
        return None

    hmac_ok = _validate_hmac(parsed)
    ed_ok = _validate_ed25519(parsed) if not hmac_ok else False
    if not (hmac_ok or ed_ok):
        _log.warning(
            "initData failed: keys=%s has_sig=%s",
            sorted(parsed["raw_pairs"].keys()),
            bool(parsed.get("signature")),
        )
        return None

    user_json = parsed["raw_pairs"].get("user")
    if not user_json:
        return None
    try:
        user = json.loads(user_json)
    except Exception:
        return None

    user_id = str(user.get("id", ""))
    allowed = _allowed_user_ids()
    if allowed and user_id not in allowed:
        _log.warning("user %s not in allowlist %s", user_id, allowed)
        return None
    return user


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@router.get("/health")
async def health():
    """Public — no auth required. Used by Caddy / uptime checks."""
    return {
        "ok": True,
        "plugin": "telegram-app",
        "version": "0.1.0",
        "uptime_sec": int(time.time() - _start_time),
    }


class _AuthVerifyBody(BaseModel):
    init_data: str


@router.post("/auth/verify")
async def auth_verify(body: _AuthVerifyBody, request: Request):
    """Validate Telegram initData and return the dashboard session token.

    The frontend stores the returned token and sends it as
    ``X-Hermes-Session-Token`` on every subsequent API call. Upstream
    auth middleware accepts those calls without further modification.
    """
    if not body.init_data:
        raise HTTPException(status_code=400, detail="init_data required")

    user = _validate_init_data(body.init_data)
    if not user:
        raise HTTPException(status_code=403, detail="Invalid Telegram initData")

    token = _get_session_token()
    if not token:
        raise HTTPException(
            status_code=503,
            detail="Dashboard session token unavailable",
        )

    return {
        "ok": True,
        "session_token": token,
        "user": {
            "id": user.get("id"),
            "first_name": user.get("first_name"),
            "username": user.get("username"),
            "language_code": user.get("language_code"),
            "is_premium": user.get("is_premium", False),
        },
        "expires_at": int(time.time()) + 86400,
    }


@router.get("/auth/verify")
async def auth_verify_get(request: Request):
    """GET version for browsers — accepts initData via header.

    Useful for desktop testing where you can paste a header but not a body.
    The Telegram Mini App SDK sends initData on a POST in production.
    """
    init_data = request.headers.get("x-telegram-init-data", "")
    if not init_data:
        # Empty initData → return a "not logged in" stub for the frontend
        # to know we're reachable but unauthenticated.
        return {"ok": False, "reason": "no_init_data"}

    user = _validate_init_data(init_data)
    if not user:
        raise HTTPException(status_code=403, detail="Invalid Telegram initData")

    token = _get_session_token()
    if not token:
        raise HTTPException(
            status_code=503, detail="Dashboard session token unavailable"
        )

    return {
        "ok": True,
        "session_token": token,
        "user": {
            "id": user.get("id"),
            "first_name": user.get("first_name"),
            "username": user.get("username"),
        },
    }


# ---------------------------------------------------------------------------
# Read-only convenience endpoints (gated by upstream auth — caller must
# include ``X-Hermes-Session-Token``).
# ---------------------------------------------------------------------------
@router.get("/status")
async def status_endpoint():
    import shutil
    cpu = -1
    mem_pct = -1
    mem_used_gb = 0.0
    mem_total_gb = 0.0
    load: List[float] = []
    try:
        import psutil  # type: ignore
        cpu = psutil.cpu_percent(interval=0.1)
        mem = psutil.virtual_memory()
        mem_pct = mem.percent
        mem_total_gb = round(mem.total / 1024**3, 2)
        mem_used_gb = round(mem.used / 1024**3, 2)
    except Exception as exc:
        _log.debug("psutil missing: %s", exc)
    try:
        load = list(os.getloadavg())
    except Exception:
        pass

    disk = shutil.disk_usage("/")
    disk_pct = round(100 * disk.used / disk.total, 1)
    disk_used_gb = round(disk.used / 1024**3, 1)
    disk_total_gb = round(disk.total / 1024**3, 1)

    sessions_count = 0
    try:
        from hermes_state import SessionDB  # type: ignore
        sessions_count = len(SessionDB().list_sessions(limit=1000))
    except Exception:
        pass

    cron_count = 0
    try:
        from cron.jobs import list_jobs  # type: ignore
        cron_count = len(list_jobs())
    except Exception:
        pass

    return {
        "cpu_pct": cpu,
        "mem_pct": mem_pct,
        "mem_used_gb": mem_used_gb,
        "mem_total_gb": mem_total_gb,
        "load_avg": load,
        "disk_pct": disk_pct,
        "disk_used_gb": disk_used_gb,
        "disk_total_gb": disk_total_gb,
        "sessions_count": sessions_count,
        "cron_count": cron_count,
        "uptime_sec": int(time.time() - _start_time),
    }


@router.get("/sessions")
async def sessions_list(limit: int = 30, source: Optional[str] = None):
    """Recent sessions, slimmed for mobile UI (omits the ~20KB system prompt)."""
    try:
        from hermes_state import SessionDB  # type: ignore
        rows = SessionDB().list_sessions_rich(
            source=source, limit=limit, order_by_last_active=True,
        )
        return {
            "sessions": [
                {
                    "id": s.get("id"),
                    "title": s.get("title") or "(untitled)",
                    "preview": (s.get("preview") or "")[:200],
                    "source": s.get("source"),
                    "model": s.get("model"),
                    "started_at": s.get("started_at"),
                    "last_active": s.get("last_active"),
                    "message_count": s.get("message_count"),
                    "tool_call_count": s.get("tool_call_count"),
                    "input_tokens": s.get("input_tokens", 0),
                    "output_tokens": s.get("output_tokens", 0),
                    "estimated_cost_usd": s.get("estimated_cost_usd", 0),
                }
                for s in rows
            ]
        }
    except Exception as exc:
        _log.exception("sessions list failed")
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/sessions/{session_id}/messages")
async def session_messages(session_id: str, limit: int = 200):
    """Messages for a session. ``limit`` clamps the trailing slice for the UI."""
    try:
        from hermes_state import SessionDB  # type: ignore
        msgs = SessionDB().get_messages(session_id=session_id) or []
        if limit and len(msgs) > limit:
            msgs = msgs[-limit:]
        # Slim each message: drop tool_calls payloads + reasoning to keep
        # the response phone-friendly. The dashboard's full message view
        # uses upstream /api/sessions/{id}/messages for full fidelity.
        slim = []
        for m in msgs:
            if not isinstance(m, dict):
                continue
            content = m.get("content")
            if isinstance(content, list):
                # Multipart content (vision messages, etc.) — collapse to
                # a text-only summary.
                parts = []
                for p in content:
                    if isinstance(p, dict):
                        if p.get("type") == "text":
                            parts.append(p.get("text", ""))
                        elif p.get("type") in ("image_url", "image"):
                            parts.append("[image]")
                        elif p.get("type") == "input_audio":
                            parts.append("[voice]")
                content = "\n".join(parts)
            if isinstance(content, str) and len(content) > 4000:
                content = content[:4000] + " …[truncated]"
            slim.append({
                "role": m.get("role"),
                "content": content,
                "name": m.get("name"),
                "timestamp": m.get("timestamp"),
            })
        return {"session_id": session_id, "messages": slim}
    except Exception as exc:
        _log.exception("session messages failed")
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/cron")
async def cron_list():
    try:
        from cron.jobs import list_jobs  # type: ignore
        return {"jobs": list_jobs()}
    except Exception as exc:
        _log.exception("cron list failed")
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------------------------
# Skills index + memory dump (read-only).
# ---------------------------------------------------------------------------
def _skills_root() -> Path:
    return Path.home() / ".hermes" / "skills"


def _parse_skill_meta(skill_md: Path) -> Dict[str, Any]:
    """Pull name + description from the YAML frontmatter of a SKILL.md."""
    name = skill_md.parent.name
    description = ""
    try:
        text = skill_md.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return {"name": name, "description": "", "size": 0}
    size = len(text.encode("utf-8"))
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end > 0:
            front = text[3:end]
            for line in front.splitlines():
                line = line.strip()
                if line.startswith("name:"):
                    name = line.split(":", 1)[1].strip().strip('"').strip("'")
                elif line.startswith("description:"):
                    description = (
                        line.split(":", 1)[1].strip().strip('"').strip("'")
                    )
    return {"name": name, "description": description, "size": size}


@router.get("/skills")
async def skills_list():
    """List all installed skills (one entry per SKILL.md)."""
    root = _skills_root()
    if not root.exists():
        return {"skills": [], "root": str(root)}

    items: List[Dict[str, Any]] = []
    for skill_md in sorted(root.rglob("SKILL.md")):
        try:
            rel = skill_md.parent.relative_to(root)
        except ValueError:
            continue
        category = rel.parts[0] if len(rel.parts) > 1 else None
        meta = _parse_skill_meta(skill_md)
        items.append(
            {
                "id": str(rel).replace("\\", "/"),
                "name": meta["name"],
                "description": meta["description"],
                "category": category,
                "size": meta["size"],
                "path": str(skill_md),
            }
        )
    items.sort(key=lambda x: ((x["category"] or "zzz"), x["name"]))
    return {"skills": items, "count": len(items), "root": str(root)}


def _safe_skill_path(skill_id: str) -> Optional[Path]:
    """Resolve a skill id to its absolute SKILL.md, refusing escapes."""
    if not skill_id or ".." in skill_id.split("/"):
        return None
    root = _skills_root().resolve()
    candidate = (root / skill_id / "SKILL.md").resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate if candidate.exists() else None


@router.get("/skills/{skill_id:path}")
async def skill_view(skill_id: str):
    """Return the full SKILL.md text for a single skill."""
    p = _safe_skill_path(skill_id)
    if not p:
        raise HTTPException(status_code=404, detail="Skill not found")
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {
        "id": skill_id,
        "content": text,
        "size": len(text.encode("utf-8")),
        "path": str(p),
    }


@router.get("/memory")
async def memory_dump():
    """Return the agent's persistent memory + user profile (read-only)."""
    base = Path.home() / ".hermes" / "memories"
    out: Dict[str, Any] = {"root": str(base), "files": {}}
    for label, fname in (("memory", "MEMORY.md"), ("user", "USER.md")):
        path = base / fname
        if not path.exists():
            out["files"][label] = {
                "exists": False, "content": "", "size": 0, "mtime": 0,
            }
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
            stat = path.stat()
            out["files"][label] = {
                "exists": True,
                "content": text,
                "size": stat.st_size,
                "mtime": stat.st_mtime,
                "path": str(path),
            }
        except Exception as exc:
            out["files"][label] = {
                "exists": True,
                "content": f"<read error: {exc}>",
                "size": 0,
                "mtime": 0,
            }
    return out


# ---------------------------------------------------------------------------
# Usage / cost aggregation — totals + top-cost sessions, filtered by window.
# ---------------------------------------------------------------------------
def _now() -> float:
    return time.time()


def _window_start(window: str) -> float:
    """Returns the unix-timestamp lower bound for a named window."""
    import datetime as dt

    now = dt.datetime.now()
    if window == "today":
        # Local-day boundary
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return start.timestamp()
    if window == "week":
        start = now - dt.timedelta(days=7)
        return start.timestamp()
    if window == "month":
        start = now - dt.timedelta(days=30)
        return start.timestamp()
    # "all" or anything else
    return 0.0


@router.get("/usage")
async def usage_summary(window: str = "today", top: int = 5):
    """Sum tokens + cost across sessions started inside the chosen window.

    window : today (00:00 local) | week (last 7d) | month (last 30d) | all
    top    : number of expensive sessions to surface (capped 1..20)
    """
    if window not in ("today", "week", "month", "all"):
        raise HTTPException(
            status_code=400,
            detail="window must be today | week | month | all",
        )
    top = max(1, min(20, int(top)))

    try:
        from hermes_state import SessionDB  # type: ignore
        # Pull a generous slice — ordered by recency. For 'all' grab a hard
        # cap so we don't walk the whole DB just for a phone widget.
        rows = SessionDB().list_sessions_rich(
            limit=2000 if window == "all" else 500,
            order_by_last_active=True,
        )
    except Exception as exc:
        _log.exception("usage list failed")
        raise HTTPException(status_code=500, detail=str(exc))

    cutoff = _window_start(window)

    in_window: List[Dict[str, Any]] = []
    for s in rows:
        # last_active is more representative of "active during window" than
        # started_at for long-running conversations (a session started 8h
        # ago that just sent a message at 10pm should still count today).
        ts = s.get("last_active") or s.get("started_at") or 0
        try:
            ts = float(ts)
        except (TypeError, ValueError):
            ts = 0
        if ts >= cutoff:
            in_window.append(s)

    total_input = sum(int(s.get("input_tokens") or 0) for s in in_window)
    total_output = sum(int(s.get("output_tokens") or 0) for s in in_window)
    total_cost = sum(float(s.get("estimated_cost_usd") or 0) for s in in_window)
    total_messages = sum(int(s.get("message_count") or 0) for s in in_window)

    # Top by cost (fall back to total tokens when cost is 0/unknown so the
    # widget still ranks something useful for free-tier providers).
    def _rank_key(s: Dict[str, Any]) -> float:
        c = float(s.get("estimated_cost_usd") or 0)
        if c > 0:
            return c
        return float((s.get("input_tokens") or 0) + (s.get("output_tokens") or 0)) / 1e9

    top_rows = sorted(in_window, key=_rank_key, reverse=True)[:top]
    top_slim = [
        {
            "id": s.get("id"),
            "title": (s.get("title") or "(untitled)")[:80],
            "source": s.get("source"),
            "model": s.get("model"),
            "input_tokens": int(s.get("input_tokens") or 0),
            "output_tokens": int(s.get("output_tokens") or 0),
            "estimated_cost_usd": float(s.get("estimated_cost_usd") or 0),
            "message_count": int(s.get("message_count") or 0),
            "last_active": s.get("last_active"),
        }
        for s in top_rows
    ]

    return {
        "window": window,
        "session_count": len(in_window),
        "input_tokens": total_input,
        "output_tokens": total_output,
        "total_tokens": total_input + total_output,
        "estimated_cost_usd": round(total_cost, 4),
        "message_count": total_messages,
        "top_sessions": top_slim,
        "as_of": _now(),
    }


# ---------------------------------------------------------------------------
# Logs — read tail of ~/.hermes/logs/<file>.log with optional level filter.
# ---------------------------------------------------------------------------
_LOG_FILES = {"agent", "errors", "gateway"}
_LOG_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
# Standard Python logger.Formatter("%(asctime)s ...") prefix is e.g.
# "2026-05-23 17:42:18,123 - hermes.agent - INFO - msg" — extract level
# from the third "-"-separated field. We're forgiving: anything that
# matches a known level token in the line counts as that level.
_LEVEL_PRIORITY = {
    "DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40, "CRITICAL": 50,
}


def _classify_level(line: str) -> str:
    upper = line.upper()
    # Cheap order: most specific first so 'WARNING' isn't beaten by 'INFO'
    for lv in ("CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"):
        if lv in upper:
            return lv
    return "INFO"


def _tail_file(path: Path, max_lines: int) -> List[str]:
    """Read the last ``max_lines`` lines of a file efficiently.

    For mini-app log tails we cap reads at the last ~512 KB. Logs longer
    than that get clipped to the most recent slice — fine for a phone UI.
    """
    if not path.exists() or not path.is_file():
        return []
    try:
        size = path.stat().st_size
        read_window = min(size, 512 * 1024)
        with path.open("rb") as fh:
            fh.seek(size - read_window)
            data = fh.read()
        text = data.decode("utf-8", errors="replace")
        lines = text.splitlines()
        if read_window < size:
            # We started mid-line; drop the (likely partial) first line.
            lines = lines[1:]
        return lines[-max_lines:]
    except Exception as exc:
        _log.warning("log tail failed for %s: %s", path, exc)
        return []


@router.get("/logs")
async def logs_tail(
    file: str = "agent",
    lines: int = 200,
    level: str = "ALL",
):
    """Tail of ``~/.hermes/logs/<file>.log`` with optional level filter.

    Parameters
    ----------
    file : agent | errors | gateway
    lines : 1..2000 (clamped) — how many tail lines to return after filter
    level : ALL | DEBUG | INFO | WARNING | ERROR | CRITICAL —
            include this level *and above*, e.g. WARNING returns warnings,
            errors and criticals.
    """
    if file not in _LOG_FILES:
        raise HTTPException(
            status_code=400,
            detail=f"file must be one of {sorted(_LOG_FILES)}",
        )
    lines = max(1, min(2000, int(lines)))
    level_upper = (level or "ALL").upper()
    min_priority = 0
    if level_upper != "ALL":
        if level_upper not in _LOG_LEVELS:
            raise HTTPException(
                status_code=400,
                detail=f"level must be ALL or one of {sorted(_LOG_LEVELS)}",
            )
        min_priority = _LEVEL_PRIORITY[level_upper]

    log_path = Path.home() / ".hermes" / "logs" / f"{file}.log"
    # Read 4× requested so the post-filter slice has room.
    raw = _tail_file(log_path, lines * 4 if min_priority else lines)

    if min_priority:
        filtered = [
            line for line in raw
            if _LEVEL_PRIORITY.get(_classify_level(line), 0) >= min_priority
        ]
    else:
        filtered = raw
    filtered = filtered[-lines:]

    # Best-effort file mtime (UI shows "as of …")
    try:
        mtime = log_path.stat().st_mtime if log_path.exists() else 0
    except Exception:
        mtime = 0

    return {
        "file": file,
        "level": level_upper,
        "lines": filtered,
        "count": len(filtered),
        "mtime": mtime,
        "path": str(log_path),
    }


@router.post("/cron/{job_id}/pause")
async def cron_pause(job_id: str):
    try:
        from cron.jobs import pause_job  # type: ignore
        pause_job(job_id)
        return {"ok": True, "id": job_id, "action": "paused"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/cron/{job_id}/resume")
async def cron_resume(job_id: str):
    try:
        from cron.jobs import resume_job  # type: ignore
        resume_job(job_id)
        return {"ok": True, "id": job_id, "action": "resumed"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/cron/{job_id}/trigger")
async def cron_trigger(job_id: str):
    try:
        from cron.jobs import trigger_job  # type: ignore
        trigger_job(job_id)
        return {"ok": True, "id": job_id, "action": "triggered"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


class _SendCommandBody(BaseModel):
    text: str
    chat_id: Optional[int] = None  # falls back to first allowed user


@router.post("/command")
async def send_command(body: _SendCommandBody):
    """Forward text to the user's Telegram DM via the bot.

    The user types in the mini app, we POST it via Bot API ``sendMessage``,
    so the message appears in their normal chat with the bot, where the
    Hermes gateway routes it to the agent and the reply streams back as
    Telegram messages. The mini app stays a control-surface, not a chat
    surface — Telegram itself is the chat surface.
    """
    token = _bot_token()
    if not token:
        raise HTTPException(status_code=500, detail="Bot token not configured")

    chat_id = body.chat_id
    if not chat_id:
        allowed = _allowed_user_ids()
        if not allowed:
            raise HTTPException(
                status_code=400,
                detail="No chat_id and no TELEGRAM_OWNER_ID configured",
            )
        try:
            chat_id = int(allowed[0])
        except ValueError:
            raise HTTPException(
                status_code=400, detail="Allowed user is not a numeric id"
            )

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = json.dumps({"chat_id": chat_id, "text": body.text}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if not data.get("ok"):
            raise HTTPException(status_code=502, detail=f"Telegram API: {data}")
        return {"ok": True, "message_id": data["result"]["message_id"]}
    except HTTPException:
        raise
    except Exception as exc:
        _log.exception("send_command failed")
        raise HTTPException(status_code=502, detail=str(exc))
