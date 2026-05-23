import { useEffect, useState } from "react";
import {
  getStatus,
  getUsage,
  SystemStatus,
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
    </>
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
