import { useEffect, useState } from "react";
import {
  CronJob,
  cronAction,
  cronCreate,
  CronCreatePayload,
  cronDelete,
  cronUpdate,
  getCron,
} from "../api";
import { formatRelative, truncate } from "../utils";
import { ErrorBox, Loading, SectionTitle, tgHaptic, tgHapticImpact } from "../components";

const SCHEDULE_PRESETS: { label: string; value: string }[] = [
  { label: "Every 30m", value: "30m" },
  { label: "Hourly", value: "1h" },
  { label: "Every 6h", value: "6h" },
  { label: "Daily 9am", value: "0 9 * * *" },
  { label: "Daily 9pm", value: "0 21 * * *" },
  { label: "Weekdays 8am", value: "0 8 * * 1-5" },
  { label: "Mondays 9am", value: "0 9 * * 1" },
];

const DELIVER_PRESETS = ["origin", "telegram", "local"];

interface FormState {
  name: string;
  schedule: string;
  prompt: string;
  deliver: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  schedule: "",
  prompt: "",
  deliver: "telegram",
};

export function CronTab() {
  const [jobs, setJobs] = useState<CronJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);

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

  const remove = async (job: CronJob) => {
    const ok = window.confirm(
      `Delete cron job "${job.name ?? job.id}"? This is permanent.`,
    );
    if (!ok) return;
    setBusy(job.id + "/delete");
    try {
      await cronDelete(job.id);
      await refresh();
      tgHaptic("success");
    } catch (e) {
      setError(String((e as Error).message ?? e));
      tgHaptic("error");
    } finally {
      setBusy(null);
    }
  };

  const startCreate = () => {
    setEditId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setShowForm(true);
    tgHapticImpact("light");
  };

  const startEdit = (job: CronJob) => {
    setEditId(job.id);
    setForm({
      name: job.name ?? "",
      schedule: String(job.schedule ?? ""),
      prompt: String(job.prompt ?? ""),
      deliver: String((job as { deliver?: string }).deliver ?? "telegram"),
    });
    setFormError(null);
    setShowForm(true);
    tgHapticImpact("light");
  };

  const cancelForm = () => {
    setShowForm(false);
    setEditId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const submitForm = async () => {
    if (!form.schedule.trim()) {
      setFormError("Schedule is required (e.g. 30m, 0 9 * * *)");
      return;
    }
    if (!form.prompt.trim()) {
      setFormError("Prompt is required");
      return;
    }
    setFormError(null);
    setBusy(editId ?? "new");
    try {
      if (editId) {
        await cronUpdate(editId, {
          name: form.name.trim() || undefined,
          schedule: form.schedule.trim(),
          prompt: form.prompt.trim(),
          deliver: form.deliver,
        });
      } else {
        const payload: CronCreatePayload = {
          name: form.name.trim() || undefined,
          schedule: form.schedule.trim(),
          prompt: form.prompt.trim(),
          deliver: form.deliver,
        };
        await cronCreate(payload);
      }
      await refresh();
      tgHaptic("success");
      cancelForm();
    } catch (e) {
      setFormError(String((e as Error).message ?? e));
      tgHaptic("error");
    } finally {
      setBusy(null);
    }
  };

  if (error) return <ErrorBox msg={error} />;
  if (!jobs) return <Loading />;

  return (
    <>
      <div className="section-title-row">
        <SectionTitle>Scheduled jobs</SectionTitle>
        <button
          type="button"
          className="ghost-btn"
          onClick={startCreate}
          aria-label="Create cron job"
        >
          + New
        </button>
      </div>

      {showForm && (
        <CronForm
          form={form}
          editing={!!editId}
          formError={formError}
          busy={busy === editId || busy === "new"}
          onChange={setForm}
          onCancel={cancelForm}
          onSubmit={submitForm}
        />
      )}

      {jobs.length === 0 && (
        <div className="empty">No cron jobs scheduled. Tap “+ New”.</div>
      )}

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
              <button
                className="btn-secondary"
                disabled={acting}
                onClick={() => startEdit(j)}
              >
                Edit
              </button>
              <button
                className="btn-secondary danger"
                disabled={acting}
                onClick={() => remove(j)}
              >
                Delete
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}

function CronForm({
  form,
  editing,
  formError,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  form: FormState;
  editing: boolean;
  formError: string | null;
  busy: boolean;
  onChange: (next: FormState) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="cron-form">
      <div className="form-title">
        {editing ? "Edit cron job" : "New cron job"}
      </div>

      <label className="field">
        <span>Name (optional)</span>
        <input
          type="text"
          value={form.name}
          onChange={(e) => onChange({ ...form, name: e.target.value })}
          placeholder="e.g. Morning briefing"
        />
      </label>

      <label className="field">
        <span>Schedule</span>
        <input
          type="text"
          value={form.schedule}
          onChange={(e) => onChange({ ...form, schedule: e.target.value })}
          placeholder="30m, 1h, 0 9 * * *, 2026-06-01T09:00"
        />
        <div className="chips" style={{ padding: "8px 0 0", marginLeft: 0 }}>
          {SCHEDULE_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              className="chip"
              onClick={() => {
                onChange({ ...form, schedule: p.value });
                tgHapticImpact("light");
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </label>

      <label className="field">
        <span>Prompt</span>
        <textarea
          value={form.prompt}
          onChange={(e) => onChange({ ...form, prompt: e.target.value })}
          rows={4}
          placeholder="What should Hermes do when this fires?"
        />
      </label>

      <label className="field">
        <span>Deliver to</span>
        <div className="filter-pills">
          {DELIVER_PRESETS.map((d) => (
            <button
              key={d}
              type="button"
              data-active={form.deliver === d}
              className="filter-pill"
              onClick={() => {
                onChange({ ...form, deliver: d });
                tgHapticImpact("light");
              }}
            >
              {d}
            </button>
          ))}
        </div>
      </label>

      {formError && (
        <p
          className="label"
          style={{ marginTop: 8, color: "var(--tg-destructive)" }}
        >
          {formError}
        </p>
      )}

      <div className="actions">
        <button
          type="button"
          className="btn-secondary"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={onSubmit}
          disabled={busy}
        >
          {busy ? (editing ? "Saving…" : "Creating…") : editing ? "Save" : "Create"}
        </button>
      </div>
    </div>
  );
}
