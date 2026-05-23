import { useCallback, useEffect, useRef, useState } from "react";
import { getLogs, LogFile, LogLevel, LogsResponse } from "../api";
import { ErrorBox, Loading, SectionTitle, tgHapticImpact } from "../components";
import { formatRelative } from "../utils";

const FILES: LogFile[] = ["agent", "errors", "gateway"];
const LEVELS: LogLevel[] = ["ALL", "INFO", "WARNING", "ERROR"];
const LINE_OPTIONS = [100, 200, 500] as const;

function classify(line: string): "error" | "warning" | "info" | "debug" {
  const u = line.toUpperCase();
  if (u.includes("CRITICAL") || u.includes("ERROR")) return "error";
  if (u.includes("WARNING") || u.includes("WARN")) return "warning";
  if (u.includes("DEBUG")) return "debug";
  return "info";
}

export function LogsTab() {
  const [file, setFile] = useState<LogFile>("agent");
  const [level, setLevel] = useState<LogLevel>("ALL");
  const [lineCount, setLineCount] =
    useState<(typeof LINE_OPTIONS)[number]>(200);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [data, setData] = useState<LogsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  const fetchOnce = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await getLogs(file, lineCount, level);
      setData(r);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }, [file, lineCount, level]);

  // Initial + on filter change
  useEffect(() => {
    fetchOnce();
  }, [fetchOnce]);

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(fetchOnce, 5000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchOnce]);

  // Auto-stick scroll to bottom unless user scrolled up
  useEffect(() => {
    if (!data || !containerRef.current) return;
    if (userScrolledUp.current) return;
    const el = containerRef.current;
    el.scrollTop = el.scrollHeight;
  }, [data]);

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.clientHeight - el.scrollTop < 50;
    userScrolledUp.current = !atBottom;
  };

  return (
    <>
      <div className="section-title-row">
        <SectionTitle>Logs</SectionTitle>
        <div style={{ display: "flex", gap: 6, marginRight: "var(--space-4)" }}>
          <label className="toggle-pill">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            <span>{autoRefresh ? "Live" : "Paused"}</span>
          </label>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              tgHapticImpact("light");
              fetchOnce();
            }}
            aria-label="Refresh logs now"
          >
            ↻
          </button>
        </div>
      </div>

      <div className="filter-bar">
        <FilterRow
          label="File"
          options={FILES}
          value={file}
          onChange={(v) => {
            setFile(v);
            tgHapticImpact("light");
          }}
        />
        <FilterRow
          label="Level"
          options={LEVELS}
          value={level}
          onChange={(v) => {
            setLevel(v);
            tgHapticImpact("light");
          }}
        />
        <FilterRow
          label="Lines"
          options={LINE_OPTIONS.map(String)}
          value={String(lineCount)}
          onChange={(v) => {
            setLineCount(Number(v) as (typeof LINE_OPTIONS)[number]);
            tgHapticImpact("light");
          }}
        />
      </div>

      {error && <ErrorBox msg={error} />}

      <div
        ref={containerRef}
        onScroll={onScroll}
        className="log-viewer"
      >
        {!data && !error && <Loading />}
        {data && data.lines.length === 0 && !loading && (
          <div className="log-empty">No log lines match the filter.</div>
        )}
        {data &&
          data.lines.map((line, i) => {
            const cls = classify(line);
            return (
              <div key={i} className={`log-line log-${cls}`}>
                {line}
              </div>
            );
          })}
      </div>

      {data && (
        <div className="log-footer">
          <span>{data.count} lines</span>
          {data.mtime > 0 && (
            <span>file updated {formatRelative(data.mtime)}</span>
          )}
          {loading && <span className="spinner-dot" />}
        </div>
      )}
    </>
  );
}

function FilterRow<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="filter-row">
      <span className="filter-label">{label}</span>
      <div className="filter-pills">
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            data-active={value === opt}
            className="filter-pill"
            onClick={() => onChange(opt)}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}
