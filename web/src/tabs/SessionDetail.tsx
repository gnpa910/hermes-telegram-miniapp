import { useEffect, useRef, useState } from "react";
import { getSessionMessages, SessionMessage } from "../api";
import { formatRelative } from "../utils";
import { ErrorBox, Loading, tgHapticImpact } from "../components";

export function SessionDetail({
  sessionId,
  title,
  onBack,
}: {
  sessionId: string;
  title: string;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<SessionMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await getSessionMessages(sessionId, 200);
        if (!cancelled) setMessages(r.messages);
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message ?? e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Wire Telegram BackButton when available
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

  // Scroll to bottom once messages load
  useEffect(() => {
    if (messages && messages.length > 0) {
      bottomRef.current?.scrollIntoView({ behavior: "auto" });
    }
  }, [messages]);

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
          aria-label="Back"
        >
          ← Back
        </button>
        <div className="detail-title" title={title}>
          {title}
        </div>
      </div>
      {error && <ErrorBox msg={error} />}
      {!error && !messages && <Loading />}
      {messages && messages.length === 0 && (
        <div className="empty">Empty session.</div>
      )}
      {messages && messages.length > 0 && (
        <div className="messages">
          {messages.map((m, i) => (
            <MessageBubble key={i} msg={m} />
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </>
  );
}

const ROLE_LABEL: Record<string, string> = {
  user: "You",
  assistant: "Hermes",
  system: "System",
  tool: "Tool",
};

function MessageBubble({ msg }: { msg: SessionMessage }) {
  const role = msg.role ?? "system";
  const label = msg.name ? `Tool: ${msg.name}` : (ROLE_LABEL[role] ?? role);
  const content = msg.content ?? "";
  return (
    <div className={`msg msg-${role}`}>
      <div className="msg-meta">
        <span className="msg-role">{label}</span>
        {msg.timestamp ? (
          <span className="msg-ts">{formatRelative(msg.timestamp)}</span>
        ) : null}
      </div>
      <div className="msg-body">{content}</div>
    </div>
  );
}
