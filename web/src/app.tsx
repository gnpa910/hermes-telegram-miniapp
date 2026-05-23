import { useEffect, useState } from "react";
import {
  AuthUser,
  getStatus,
  getSessions,
  getCron,
  cronAction,
  sendCommand,
  loginWithInitData,
  SystemStatus,
  SessionRow,
  CronJob,
} from "./api";
import { getTelegramWebApp, TelegramThemeParams } from "./telegram";
import {
  formatBytes,
  formatRelative,
  formatTokens,
  formatUptime,
  formatUsd,
  truncate,
} from "./utils";

type Tab = "status" | "sessions" | "cron" | "send";

function applyTelegramTheme(params: TelegramThemeParams, scheme: "light" | "dark") {
  const root = document.documentElement;
  if (params.bg_color) root.style.setProperty("--tg-bg", params.bg_color);
  if (params.secondary_bg_color)
    root.style.setProperty("--tg-bg-secondary", params.secondary_bg_color);
  if (params.section_bg_color)
    root.style.setProperty("--tg-section", params.section_bg_color);
  if (params.text_color) root.style.setProperty("--tg-text", params.text_color);
  if (params.hint_color) root.style.setProperty("--tg-hint", params.hint_color);
  if (params.link_color) root.style.setProperty("--tg-link", params.link_color);
  if (params.accent_text_color)
    root.style.setProperty("--tg-accent", params.accent_text_color);
  if (params.button_color) root.style.setProperty("--tg-button", params.button_color);
  if (params.button_text_color)
    root.style.setProperty("--tg-button-text", params.button_text_color);
  if (params.destructive_text_color)
    root.style.setProperty("--tg-destructive", params.destructive_text_color);
  document.body.dataset.scheme = scheme;
}

export function App() {
  const [authState, setAuthState] = useState<"loading" | "ok" | "fail">("loading");
  const [authReason, setAuthReason] = useState<string>("");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [tab, setTab] = useState<Tab>("status");

  // ---- Mount: init Telegram + login ------------------------------------
  useEffect(() => {
    const tg = getTelegramWebApp();
    if (tg) {
      try {
        tg.ready();
        tg.expand();
        applyTelegramTheme(tg.themeParams, tg.colorScheme);
      } catch (e) {
        console.warn("telegram init err", e);
      }
    }
    let cancelled = false;
    (async () => {
      try {
        const auth = await loginWithInitData();
        if (cancelled) return;
        if (auth.ok) {
          setUser(auth.user ?? null);
          setAuthState("ok");
        } else {
          setAuthReason(auth.reason ?? "unknown");
          setAuthState("fail");
        }
      } catch (e) {
        if (cancelled) return;
        setAuthReason(String((e as Error).message ?? e));
        setAuthState("fail");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (authState === "loading") {
    return (
      <div className="auth-gate">
        <span className="spinner" />
        <p>Connecting to Hermes…</p>
      </div>
    );
  }

  if (authState === "fail") {
    return (
      <div className="auth-gate">
        <h2>Not authenticated</h2>
        {authReason === "no_init_data" ? (
          <p>
            Open this app from the Telegram bot menu button so it can
            sign you in. Direct browser access is locked.
          </p>
        ) : (
          <p>{authReason}</p>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>⚡ Hermes</h1>
        <div className="user-chip">
          <span className="dot" />
          <span>{user?.first_name ?? user?.username ?? "you"}</span>
        </div>
      </header>
      <main className="app-content">
        {tab === "status" && <StatusTab />}
        {tab === "sessions" && <SessionsTab />}
        {tab === "cron" && <CronTab />}
        {tab === "send" && <SendTab />}
      </main>
      <nav className="tab-bar">
        <button data-active={tab === "status"} onClick={() => setTab("status")}>
          <span className="tab-icon">📊</span>
          Status
        </button>
        <button data-active={tab === "sessions"} onClick={() => setTab("sessions")}>
          <span className="tab-icon">💬</span>
          Sessions
        </button>
        <button data-active={tab === "cron"} onClick={() => setTab("cron")}>
          <span className="tab-icon">⏱</span>
          Cron
        </button>
        <button data-active={tab === "send"} onClick={() => setTab("send")}>
          <span className="tab-icon">✉️</span>
          Send
        </button>
      </nav>
    </div>
  );
}

// ----------------------------------------------------------------------
// Status tab
// ----------------------------------------------------------------------
function StatusTab() {
  const [data, setData] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await getStatus();
        if (!cancelled) setData(s);
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message ?? e));
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (error) return <ErrorBox msg={error} />;
  if (!data) return <Loading />;

  return (
    <>
      <div className="section-title" style={{ marginLeft: "calc(var(--space-4) + var(--space-1))" }}>
        System
      </div>
      <div className="gauges">
        <Gauge name="CPU" pct={data.cpu_pct} sub={`load ${data.load_avg.map((l) => l.toFixed(2)).join(" ")}`} />
        <Gauge name="Memory" pct={data.mem_pct} sub={`${formatBytes(data.mem_used_gb)} / ${formatBytes(data.mem_total_gb)}`} />
        <Gauge name="Disk" pct={data.disk_pct} sub={`${formatBytes(data.disk_used_gb)} / ${formatBytes(data.disk_total_gb)}`} />
        <Gauge name="Uptime" pct={null} sub={formatUptime(data.uptime_sec)} />
      </div>

      <div className="section-title">Hermes</div>
      <div className="card row">
        <span className="label">Sessions</span>
        <span className="value">{data.sessions_count}</span>
      </div>
      <div className="card row">
        <span className="label">Cron jobs</span>
        <span className="value">{data.cron_count}</span>
      </div>
    </>
  );
}

function Gauge({ name, pct, sub }: { name: string; pct: number | null; sub: string }) {
  let cls = "gauge";
  if (pct !== null && pct >= 90) cls += " crit";
  else if (pct !== null && pct >= 70) cls += " warn";
  return (
    <div className={cls}>
      <div className="name">{name}</div>
      <div className="pct">{pct !== null ? `${pct.toFixed(0)}%` : sub}</div>
      {pct !== null && (
        <>
          <div className="sub">{sub}</div>
          <div className="bar">
            <div style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
        </>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------
// Sessions tab
// ----------------------------------------------------------------------
function SessionsTab() {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await getSessions(50);
        if (!cancelled) setRows(r.sessions);
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <ErrorBox msg={error} />;
  if (!rows) return <Loading />;
  if (rows.length === 0) return <div className="empty">No sessions yet.</div>;

  return (
    <>
      <div className="section-title" style={{ marginLeft: "calc(var(--space-4) + var(--space-1))" }}>
        Recent sessions
      </div>
      {rows.map((s) => (
        <div key={s.id} className="list-item">
          <div className="item-title">{truncate(s.title, 60)}</div>
          <div className="item-preview">{truncate(s.preview, 80)}</div>
          <div className="item-meta">
            <span className="src">{s.source}</span>
            <span>{s.message_count ?? 0} msgs</span>
            <span>{formatTokens((s.input_tokens ?? 0) + (s.output_tokens ?? 0))}</span>
            <span>{formatUsd(s.estimated_cost_usd ?? 0)}</span>
            <span style={{ marginLeft: "auto" }}>{formatRelative(s.last_active)}</span>
          </div>
        </div>
      ))}
    </>
  );
}

// ----------------------------------------------------------------------
// Cron tab
// ----------------------------------------------------------------------
function CronTab() {
  const [jobs, setJobs] = useState<CronJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const r = await getCron();
      setJobs(r.jobs);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const act = async (id: string, action: "pause" | "resume" | "trigger") => {
    setBusy(id + "/" + action);
    try {
      await cronAction(id, action);
      await refresh();
      tgHaptic("success");
    } catch (e) {
      setError(String((e as Error).message ?? e));
      tgHaptic("error");
    } finally {
      setBusy(null);
    }
  };

  if (error) return <ErrorBox msg={error} />;
  if (!jobs) return <Loading />;
  if (jobs.length === 0)
    return <div className="empty">No cron jobs scheduled.</div>;

  return (
    <>
      <div className="section-title" style={{ marginLeft: "calc(var(--space-4) + var(--space-1))" }}>
        Scheduled jobs
      </div>
      {jobs.map((j) => {
        const enabled = j.enabled !== false;
        const acting = busy?.startsWith(j.id + "/");
        return (
          <div key={j.id} className="cron-row">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="name">{j.name ?? j.id}</span>
              <span className={enabled ? "badge" : "badge paused"}>
                {enabled ? "active" : "paused"}
              </span>
            </div>
            <div className="meta">
              <span>{j.schedule ?? "—"}</span>
              {j.next_run && <span>next {formatRelative(j.next_run)}</span>}
              {j.last_run && <span>last {formatRelative(j.last_run)}</span>}
            </div>
            {j.prompt && (
              <div className="item-preview" style={{ marginTop: 4 }}>
                {truncate(String(j.prompt), 100)}
              </div>
            )}
            <div className="actions">
              {enabled ? (
                <button className="btn-secondary" disabled={acting} onClick={() => act(j.id, "pause")}>
                  Pause
                </button>
              ) : (
                <button className="btn-secondary" disabled={acting} onClick={() => act(j.id, "resume")}>
                  Resume
                </button>
              )}
              <button className="btn-secondary" disabled={acting} onClick={() => act(j.id, "trigger")}>
                Run now
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}

// ----------------------------------------------------------------------
// Send tab — drops a message into the user's Telegram DM with the bot
// ----------------------------------------------------------------------
function SendTab() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      await sendCommand(text.trim());
      setFeedback("Sent. Check your chat with the bot.");
      tgHaptic("success");
      setText("");
    } catch (e) {
      setError(String((e as Error).message ?? e));
      tgHaptic("error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="section-title" style={{ marginLeft: "calc(var(--space-4) + var(--space-1))" }}>
        Send to Hermes
      </div>
      <div className="compose">
        <p className="label" style={{ margin: "0 0 8px", color: "var(--tg-hint)" }}>
          Type a message — it'll be sent to your bot chat as if you'd typed it
          there. Hermes will reply in the chat.
        </p>
        <textarea
          placeholder="e.g. summarize today's sessions"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
        />
        <div className="actions">
          <button
            className="btn-primary"
            disabled={!text.trim() || busy}
            onClick={submit}
          >
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
        {feedback && (
          <p className="label" style={{ marginTop: 12, color: "var(--tg-accent)" }}>
            {feedback}
          </p>
        )}
        {error && (
          <p className="label" style={{ marginTop: 12, color: "var(--tg-destructive)" }}>
            {error}
          </p>
        )}
      </div>
    </>
  );
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------
function Loading() {
  return (
    <div className="loading">
      <span className="spinner" />
    </div>
  );
}

function ErrorBox({ msg }: { msg: string }) {
  return <div className="error-box">{msg}</div>;
}

function tgHaptic(kind: "success" | "error" | "warning") {
  try {
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred(kind);
  } catch {
    /* ignore */
  }
}
