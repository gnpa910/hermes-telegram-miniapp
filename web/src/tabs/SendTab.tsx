import { useRef, useState } from "react";
import { sendCommand } from "../api";
import { SectionTitle, tgHaptic, tgHapticImpact } from "../components";
import { formatRelative, truncate } from "../utils";

const HISTORY_KEY = "hermes-tma:send-history-v1";
const PRESETS_KEY = "hermes-tma:send-presets-v1";
const HISTORY_MAX = 12;

const DEFAULT_PRESETS: string[] = [
  "Summarize today's sessions in 5 bullets",
  "List my cron jobs with their next run times",
  "What did I work on yesterday?",
  "Tail the last 30 lines of errors.log and explain anything red",
  "Disk + memory snapshot",
  "Search past sessions for the last TikTok scraper change",
];

interface HistoryEntry {
  text: string;
  ts: number;
}

function loadList<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveList<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota / private mode */
  }
}

export function SendTab() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>(() =>
    loadList<HistoryEntry[]>(HISTORY_KEY, []),
  );
  const [presets, setPresets] = useState<string[]>(() =>
    loadList<string[]>(PRESETS_KEY, DEFAULT_PRESETS),
  );
  const [editingPresets, setEditingPresets] = useState(false);
  const [newPreset, setNewPreset] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const fillFrom = (s: string) => {
    setText(s);
    tgHapticImpact("light");
    textareaRef.current?.focus();
  };

  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      await sendCommand(value);
      setFeedback("Sent. Check your chat with the bot.");
      tgHaptic("success");
      setText("");
      const newEntry: HistoryEntry = { text: value, ts: Date.now() / 1000 };
      const next = [
        newEntry,
        ...history.filter((h) => h.text !== value),
      ].slice(0, HISTORY_MAX);
      setHistory(next);
      saveList(HISTORY_KEY, next);
    } catch (e) {
      setError(String((e as Error).message ?? e));
      tgHaptic("error");
    } finally {
      setBusy(false);
    }
  };

  const addPreset = () => {
    const v = newPreset.trim();
    if (!v) return;
    if (presets.includes(v)) {
      setNewPreset("");
      return;
    }
    const next = [...presets, v];
    setPresets(next);
    saveList(PRESETS_KEY, next);
    setNewPreset("");
    tgHaptic("success");
  };

  const removePreset = (s: string) => {
    const next = presets.filter((p) => p !== s);
    setPresets(next);
    saveList(PRESETS_KEY, next);
    tgHapticImpact("light");
  };

  const restoreDefaults = () => {
    setPresets(DEFAULT_PRESETS);
    saveList(PRESETS_KEY, DEFAULT_PRESETS);
    tgHaptic("success");
  };

  const clearHistory = () => {
    setHistory([]);
    saveList(HISTORY_KEY, []);
    tgHapticImpact("medium");
  };

  return (
    <>
      <SectionTitle>Send to Hermes</SectionTitle>
      <div className="compose">
        <p
          className="label"
          style={{ margin: "0 0 8px", color: "var(--tg-hint)" }}
        >
          Type a message — it'll be sent to your bot chat as if you'd typed it
          there. Hermes will reply in the chat.
        </p>
        <textarea
          ref={textareaRef}
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
          <p
            className="label"
            style={{ marginTop: 12, color: "var(--tg-accent)" }}
          >
            {feedback}
          </p>
        )}
        {error && (
          <p
            className="label"
            style={{ marginTop: 12, color: "var(--tg-destructive)" }}
          >
            {error}
          </p>
        )}
      </div>

      <div className="section-title-row">
        <SectionTitle>Quick presets</SectionTitle>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => setEditingPresets((v) => !v)}
        >
          {editingPresets ? "Done" : "Edit"}
        </button>
      </div>
      {presets.length === 0 && (
        <div className="empty" style={{ paddingTop: 0 }}>
          No presets — add one below.
        </div>
      )}
      <div className="chips">
        {presets.map((p) => (
          <div key={p} className="chip-wrap">
            <button
              type="button"
              className="chip"
              onClick={() => fillFrom(p)}
              title={p}
            >
              {truncate(p, 60)}
            </button>
            {editingPresets && (
              <button
                type="button"
                className="chip-x"
                aria-label="Remove preset"
                onClick={() => removePreset(p)}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      {editingPresets && (
        <div className="compose" style={{ marginTop: 0 }}>
          <textarea
            placeholder="Add a new preset…"
            value={newPreset}
            onChange={(e) => setNewPreset(e.target.value)}
            rows={2}
          />
          <div className="actions" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={restoreDefaults}
            >
              Restore defaults
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!newPreset.trim()}
              onClick={addPreset}
            >
              Add
            </button>
          </div>
        </div>
      )}

      {history.length > 0 && (
        <>
          <div className="section-title-row">
            <SectionTitle>Recent</SectionTitle>
            <button
              type="button"
              className="ghost-btn"
              onClick={clearHistory}
              aria-label="Clear history"
            >
              Clear
            </button>
          </div>
          {history.map((h, i) => (
            <button
              key={i}
              type="button"
              className="list-item tappable history-row"
              onClick={() => fillFrom(h.text)}
            >
              <div className="item-preview" style={{ whiteSpace: "normal" }}>
                {truncate(h.text, 140)}
              </div>
              <div className="item-meta">
                <span style={{ marginLeft: "auto" }}>
                  {formatRelative(h.ts)}
                </span>
              </div>
            </button>
          ))}
        </>
      )}
    </>
  );
}
