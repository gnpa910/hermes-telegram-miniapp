import { useEffect, useState } from "react";
import {
  AlertsSettings,
  AlertsStatus,
  getAlerts,
  getStatus,
  getUsage,
  SystemStatus,
  testAlert,
  updateAlerts,
  UsageSummary,
  UsageWindow,
} from "../api";
import {
  formatBytes,
  formatTokens,
  formatUptime,
  formatUsd,
  truncate,
} from "../utils";
import { ErrorBox, Loading, SectionTitle, tgHapticImpact } from "../components";

const WINDOWS: UsageWindow[] = ["today", "week", "month", "all"];
const WINDOW_LABEL: Record<UsageWindow, string> = {
  today: "Today",
  week: "7d",
  month: "30d",
  all: "All",
};

export function StatusTab({
  onOpenSession,
}: {
  onOpenSession: (id: string, title: string) => void;
}) {
  const [data, setData] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [window, setWindow] = useState<UsageWindow>("today");

  // ---- System gauges (5s poll) -----------------------------------
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

  // ---- Usage (refresh on window change + every 60s) --------------
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const u = await getUsage(window, 5);
        if (!cancelled) setUsage(u);
      } catch (e) {
        if (!cancelled) setUsageError(String((e as Error).message ?? e));
      }
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [window]);

  if (error) return <ErrorBox msg={error} />;
  if (!data) return <Loading />;

  return (
    <>
      <SectionTitle>System</SectionTitle>
      <div className="gauges">
        <Gauge
          name="CPU"
          pct={data.cpu_pct}
          sub={`load ${data.load_avg.map((l) => l.toFixed(2)).join(" ")}`}
        />
        <Gauge
          name="Memory"
          pct={data.mem_pct}
          sub={`${formatBytes(data.mem_used_gb)} / ${formatBytes(data.mem_total_gb)}`}
        />
        <Gauge
          name="Disk"
          pct={data.disk_pct}
          sub={`${formatBytes(data.disk_used_gb)} / ${formatBytes(data.disk_total_gb)}`}
        />
        <Gauge name="Uptime" pct={null} sub={formatUptime(data.uptime_sec)} />
      </div>

      <SectionTitle>Hermes</SectionTitle>
      <div className="card row">
        <span className="label">Sessions</span>
        <span className="value">{data.sessions_count}</span>
      </div>
      <div className="card row">
        <span className="label">Cron jobs</span>
        <span className="value">{data.cron_count}</span>
      </div>

      {/* ---- Usage --------------------------------------------- */}
      <div className="section-title-row">
        <SectionTitle>Usage</SectionTitle>
        <div
          style={{
            display: "flex",
            gap: 4,
            marginRight: "var(--space-4)",
          }}
        >
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              data-active={w === window}
              className="filter-pill"
              onClick={() => {
                setWindow(w);
                tgHapticImpact("light");
              }}
            >
              {WINDOW_LABEL[w]}
            </button>
          ))}
        </div>
      </div>

      {usageError && <ErrorBox msg={usageError} />}
      {!usage && !usageError && <Loading />}
      {usage && (
        <>
          <div className="usage-grid">
            <UsageCard
              label="Spend"
              value={formatUsd(usage.estimated_cost_usd)}
              hint={`${usage.session_count} session${
                usage.session_count === 1 ? "" : "s"
              }`}
              accent
            />
            <UsageCard
              label="Tokens"
              value={formatTokens(usage.total_tokens)}
              hint={`in ${formatTokens(usage.input_tokens)} · out ${formatTokens(
                usage.output_tokens,
              )}`}
            />
            <UsageCard
              label="Messages"
              value={String(usage.message_count)}
              hint={
                usage.session_count > 0
                  ? `${(usage.message_count / usage.session_count).toFixed(1)} avg / session`
                  : "—"
              }
            />
          </div>

          {usage.top_sessions.length > 0 && (
            <>
              <div
                className="section-title"
                style={{
                  marginLeft: "calc(var(--space-4) + var(--space-1))",
                  marginTop: 0,
                }}
              >
                Top by cost
              </div>
              {usage.top_sessions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="list-item tappable"
                  onClick={() => {
                    tgHapticImpact("light");
                    onOpenSession(s.id, s.title);
                  }}
                >
                  <div className="item-title">{truncate(s.title, 60)}</div>
                  <div className="item-meta">
                    <span className="src">{s.source ?? "?"}</span>
                    <span>{s.message_count} msgs</span>
                    <span>
                      {formatTokens(s.input_tokens + s.output_tokens)}
                    </span>
                    <span style={{ marginLeft: "auto" }}>
                      {formatUsd(s.estimated_cost_usd)}
                    </span>
                  </div>
                </button>
              ))}
            </>
          )}
        </>
      )}

      <AlertsCard />
    </>
  );
}

function AlertsCard() {
  const [status, setStatus] = useState<AlertsStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [costInput, setCostInput] = useState("");

  const refresh = async () => {
    try {
      const s = await getAlerts();
      setStatus(s);
      setCostInput(String(s.settings.cost_daily_usd));
      setErr(null);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const toggle = async (key: keyof AlertsSettings, value: boolean) => {
    if (!status) return;
    setBusy(key);
    tgHapticImpact("light");
    try {
      const s = await updateAlerts({ [key]: value } as Partial<AlertsSettings>);
      setStatus(s);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const saveCost = async () => {
    const n = parseFloat(costInput);
    if (Number.isNaN(n) || n < 0) {
      setErr("invalid threshold");
      return;
    }
    setBusy("cost");
    tgHapticImpact("light");
    try {
      const s = await updateAlerts({ cost_daily_usd: n });
      setStatus(s);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    setBusy("test");
    setTestMsg(null);
    tgHapticImpact("medium");
    try {
      const r = await testAlert();
      setTestMsg(r.sent ? "Test DM sent ✓" : `Failed: ${r.reason ?? "unknown"}`);
    } catch (e) {
      setTestMsg(`Failed: ${(e as Error).message ?? e}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <SectionTitle>Push alerts</SectionTitle>
      {err && <ErrorBox msg={err} />}
      {!status && !err && <Loading />}
      {status && (
        <div className="alerts-card">
          {!status.has_bot_token || !status.has_owner_chat ? (
            <div className="alerts-warn">
              ⚠ Bot token / owner chat not configured — alerts won't be
              delivered. Check Telegram gateway settings.
            </div>
          ) : null}

          <ToggleRow
            label="Cron failures"
            hint="DM when a job's last_status is failed/error"
            checked={status.settings.cron_failures}
            disabled={busy === "cron_failures"}
            onChange={(v) => toggle("cron_failures", v)}
          />
          <ToggleRow
            label="Error log"
            hint={`Tail ~/.hermes/logs/errors.log (${status.settings.error_throttle_sec}s throttle)`}
            checked={status.settings.error_log}
            disabled={busy === "error_log"}
            onChange={(v) => toggle("error_log", v)}
          />
          <ToggleRow
            label="Daily spend threshold"
            hint={`Fire once when today's spend ≥ $${status.settings.cost_daily_usd}`}
            checked={status.settings.cost_threshold}
            disabled={busy === "cost_threshold"}
            onChange={(v) => toggle("cost_threshold", v)}
          />

          <div className="alerts-row threshold">
            <span className="alerts-label">Threshold (USD/day)</span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="0.5"
              value={costInput}
              onChange={(e) => setCostInput(e.target.value)}
              className="alerts-input"
            />
            <button
              type="button"
              className="btn small"
              onClick={saveCost}
              disabled={busy === "cost"}
            >
              Save
            </button>
          </div>

          <div className="alerts-meta">
            <span>
              Watcher: <b>{status.running ? "running" : "stopped"}</b>
            </span>
            {status.last_alert_kind && (
              <span>last: {status.last_alert_kind}</span>
            )}
            <span>err today: {status.errors_emitted_today}</span>
          </div>

          <div className="alerts-actions">
            <button
              type="button"
              className="btn"
              onClick={sendTest}
              disabled={busy === "test"}
            >
              {busy === "test" ? "Sending…" : "Send test DM"}
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={refresh}
              disabled={busy !== null}
            >
              Refresh
            </button>
          </div>
          {testMsg && <div className="alerts-toast">{testMsg}</div>}
        </div>
      )}
    </>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="alerts-row toggle">
      <div className="alerts-text">
        <div className="alerts-label">{label}</div>
        <div className="alerts-hint">{hint}</div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

function UsageCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  accent?: boolean;
}) {
  return (
    <div className={accent ? "usage-card accent" : "usage-card"}>
      <div className="name">{label}</div>
      <div className="big">{value}</div>
      <div className="sub">{hint}</div>
    </div>
  );
}

function Gauge({
  name,
  pct,
  sub,
}: {
  name: string;
  pct: number | null;
  sub: string;
}) {
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
