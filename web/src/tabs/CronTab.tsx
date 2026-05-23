import { useEffect, useState } from "react";
import { CronJob, cronAction, getCron } from "../api";
import { formatRelative, truncate } from "../utils";
import { ErrorBox, Loading, SectionTitle, tgHaptic } from "../components";

export function CronTab() {
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
      <SectionTitle>Scheduled jobs</SectionTitle>
      {jobs.map((j) => {
        const enabled = j.enabled !== false;
        const acting = busy?.startsWith(j.id + "/");
        return (
          <div key={j.id} className="cron-row">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
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
                <button
                  className="btn-secondary"
                  disabled={acting}
                  onClick={() => act(j.id, "pause")}
                >
                  Pause
                </button>
              ) : (
                <button
                  className="btn-secondary"
                  disabled={acting}
                  onClick={() => act(j.id, "resume")}
                >
                  Resume
                </button>
              )}
              <button
                className="btn-secondary"
                disabled={acting}
                onClick={() => act(j.id, "trigger")}
              >
                Run now
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}
