import { useEffect, useState } from "react";
import { getSessions, SessionRow } from "../api";
import { formatRelative, formatTokens, formatUsd, truncate } from "../utils";
import { ErrorBox, Loading, SectionTitle, tgHapticImpact } from "../components";

export function SessionsTab({
  onOpen,
}: {
  onOpen: (id: string, title: string) => void;
}) {
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
      <SectionTitle>Recent sessions</SectionTitle>
      {rows.map((s) => (
        <button
          key={s.id}
          type="button"
          className="list-item tappable"
          onClick={() => {
            tgHapticImpact("light");
            onOpen(s.id, s.title);
          }}
        >
          <div className="item-title">{truncate(s.title, 60)}</div>
          <div className="item-preview">{truncate(s.preview, 80)}</div>
          <div className="item-meta">
            <span className="src">{s.source}</span>
            <span>{s.message_count ?? 0} msgs</span>
            <span>
              {formatTokens((s.input_tokens ?? 0) + (s.output_tokens ?? 0))}
            </span>
            <span>{formatUsd(s.estimated_cost_usd ?? 0)}</span>
            <span style={{ marginLeft: "auto" }}>
              {formatRelative(s.last_active)}
            </span>
          </div>
        </button>
      ))}
    </>
  );
}
