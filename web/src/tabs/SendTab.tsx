import { useState } from "react";
import { sendCommand } from "../api";
import { SectionTitle, tgHaptic } from "../components";

export function SendTab() {
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
    </>
  );
}
