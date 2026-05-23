import { useEffect, useMemo, useState } from "react";
import {
  getMemory,
  getSkill,
  getSkills,
  MemoryDump,
  SkillDetail,
  SkillRow,
} from "../api";
import { ErrorBox, Loading, SectionTitle, tgHapticImpact } from "../components";
import { formatRelative, truncate } from "../utils";

type Section = "skills" | "memory";

export function KnowledgeTab() {
  const [section, setSection] = useState<Section>("skills");
  return (
    <>
      <div className="section-title-row">
        <SectionTitle>Knowledge</SectionTitle>
        <div style={{ display: "flex", gap: 4, marginRight: "var(--space-4)" }}>
          <button
            type="button"
            data-active={section === "skills"}
            className="filter-pill"
            onClick={() => {
              setSection("skills");
              tgHapticImpact("light");
            }}
          >
            Skills
          </button>
          <button
            type="button"
            data-active={section === "memory"}
            className="filter-pill"
            onClick={() => {
              setSection("memory");
              tgHapticImpact("light");
            }}
          >
            Memory
          </button>
        </div>
      </div>
      {section === "skills" ? <SkillsList /> : <MemoryView />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Skills list + viewer
// ---------------------------------------------------------------------------
function SkillsList() {
  const [rows, setRows] = useState<SkillRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<SkillRow | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await getSkills();
        if (!cancelled) setRows(r.skills);
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const grouped = useMemo(() => {
    if (!rows) return null;
    const f = filter.trim().toLowerCase();
    const filtered = f
      ? rows.filter(
          (s) =>
            s.name.toLowerCase().includes(f) ||
            s.description.toLowerCase().includes(f) ||
            (s.category ?? "").toLowerCase().includes(f),
        )
      : rows;
    const map = new Map<string, SkillRow[]>();
    for (const s of filtered) {
      const cat = s.category ?? "other";
      const bucket = map.get(cat) ?? [];
      bucket.push(s);
      map.set(cat, bucket);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [rows, filter]);

  if (error) return <ErrorBox msg={error} />;
  if (!rows) return <Loading />;
  if (open) return <SkillView skill={open} onBack={() => setOpen(null)} />;

  return (
    <>
      <div style={{ padding: "0 var(--space-4) var(--space-3)" }}>
        <input
          className="filter-input"
          type="search"
          placeholder={`Search ${rows.length} skill${rows.length === 1 ? "" : "s"}…`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {grouped && grouped.length === 0 && (
        <div className="empty">No skills match.</div>
      )}
      {grouped &&
        grouped.map(([cat, items]) => (
          <div key={cat}>
            <div
              className="section-title"
              style={{
                marginLeft: "calc(var(--space-4) + var(--space-1))",
                marginTop: "var(--space-3)",
              }}
            >
              {cat}{" "}
              <span style={{ color: "var(--tg-hint)", marginLeft: 6 }}>
                {items.length}
              </span>
            </div>
            {items.map((s) => (
              <button
                key={s.id}
                type="button"
                className="list-item tappable"
                onClick={() => {
                  tgHapticImpact("light");
                  setOpen(s);
                }}
              >
                <div className="item-title">{s.name}</div>
                {s.description && (
                  <div
                    className="item-preview"
                    style={{ whiteSpace: "normal" }}
                  >
                    {truncate(s.description, 140)}
                  </div>
                )}
              </button>
            ))}
          </div>
        ))}
    </>
  );
}

function SkillView({ skill, onBack }: { skill: SkillRow; onBack: () => void }) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await getSkill(skill.id);
        if (!cancelled) setDetail(d);
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [skill.id]);

  // Telegram BackButton hookup
  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (!tg?.BackButton) return;
    const handler = () => {
      tgHapticImpact("light");
      onBack();
    };
    tg.BackButton.onClick(handler);
    tg.BackButton.show();
    return () => {
      try {
        tg.BackButton?.offClick(handler);
        tg.BackButton?.hide();
      } catch {
        /* ignore */
      }
    };
  }, [onBack]);

  return (
    <>
      <div className="detail-header">
        <button
          type="button"
          className="back-btn"
          onClick={() => {
            tgHapticImpact("light");
            onBack();
          }}
        >
          ← Back
        </button>
        <div className="detail-title" title={skill.name}>
          {skill.name}
        </div>
      </div>
      {error && <ErrorBox msg={error} />}
      {!detail && !error && <Loading />}
      {detail && (
        <pre className="md-pre">{detail.content}</pre>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Memory dump (MEMORY.md + USER.md)
// ---------------------------------------------------------------------------
function MemoryView() {
  const [data, setData] = useState<MemoryDump | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await getMemory();
        if (!cancelled) setData(d);
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <ErrorBox msg={error} />;
  if (!data) return <Loading />;

  return (
    <>
      <MemoryBlock label="Memory (MEMORY.md)" file={data.files.memory} />
      <MemoryBlock label="User profile (USER.md)" file={data.files.user} />
    </>
  );
}

function MemoryBlock({
  label,
  file,
}: {
  label: string;
  file: MemoryDump["files"]["memory"];
}) {
  return (
    <div className="memory-block">
      <div
        className="section-title"
        style={{ marginLeft: "calc(var(--space-4) + var(--space-1))" }}
      >
        {label}{" "}
        <span style={{ color: "var(--tg-hint)", marginLeft: 6 }}>
          {file.exists ? `${file.size} bytes` : "missing"}
          {file.mtime ? ` · ${formatRelative(file.mtime)}` : ""}
        </span>
      </div>
      {!file.exists ? (
        <div className="empty" style={{ paddingTop: 0 }}>
          File not present.
        </div>
      ) : (
        <pre className="md-pre">{file.content || "(empty)"}</pre>
      )}
    </div>
  );
}
