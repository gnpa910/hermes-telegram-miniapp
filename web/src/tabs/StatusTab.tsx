import { useEffect, useState } from "react";
import { getStatus, SystemStatus } from "../api";
import { formatBytes, formatUptime } from "../utils";
import { ErrorBox, Loading, SectionTitle } from "../components";

export function StatusTab() {
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
    </>
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
