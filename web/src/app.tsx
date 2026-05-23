import { useEffect, useState } from "react";
import { AuthUser, loginWithInitData } from "./api";
import { getTelegramWebApp, TelegramThemeParams } from "./telegram";
import { StatusTab } from "./tabs/StatusTab";
import { SessionsTab } from "./tabs/SessionsTab";
import { SessionDetail } from "./tabs/SessionDetail";
import { CronTab } from "./tabs/CronTab";
import { LogsTab } from "./tabs/LogsTab";
import { KnowledgeTab } from "./tabs/KnowledgeTab";
import { SendTab } from "./tabs/SendTab";

type Tab = "status" | "sessions" | "cron" | "logs" | "knowledge" | "send";

interface View {
  tab: Tab;
  sessionId?: string;
  sessionTitle?: string;
}

function applyTelegramTheme(
  params: TelegramThemeParams,
  scheme: "light" | "dark",
) {
  const root = document.documentElement;
  if (params.bg_color) root.style.setProperty("--tg-bg", params.bg_color);
  if (params.secondary_bg_color)
    root.style.setProperty("--tg-bg-secondary", params.secondary_bg_color);
  if (params.section_bg_color)
    root.style.setProperty("--tg-section", params.section_bg_color);
  if (params.text_color) root.style.setProperty("--tg-text", params.text_color);
  if (params.hint_color) root.style.setProperty("--tg-hint", params.hint_color);
  if (params.link_color) root.style.setProperty("--tg-link", params.link_color);
  if (params.accent_text_color)
    root.style.setProperty("--tg-accent", params.accent_text_color);
  if (params.button_color)
    root.style.setProperty("--tg-button", params.button_color);
  if (params.button_text_color)
    root.style.setProperty("--tg-button-text", params.button_text_color);
  if (params.destructive_text_color)
    root.style.setProperty("--tg-destructive", params.destructive_text_color);
  document.body.dataset.scheme = scheme;
}

/**
 * Fall back to system color-scheme when no Telegram theme is available
 * (i.e. running in a regular browser for local dev / deeplink).
 */
function applySystemColorScheme() {
  const prefersLight =
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: light)").matches;
  document.body.dataset.scheme = prefersLight ? "light" : "dark";
}

export function App() {
  const [authState, setAuthState] = useState<"loading" | "ok" | "fail">(
    "loading",
  );
  const [authReason, setAuthReason] = useState<string>("");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [view, setView] = useState<View>({ tab: "status" });

  // ---- Mount: init Telegram + login -------------------------------------
  useEffect(() => {
    const tg = getTelegramWebApp();
    if (tg) {
      try {
        tg.ready();
        tg.expand();
        applyTelegramTheme(tg.themeParams, tg.colorScheme);
      } catch (e) {
        console.warn("telegram init err", e);
        applySystemColorScheme();
      }
    } else {
      applySystemColorScheme();
    }
    let cancelled = false;
    (async () => {
      try {
        const auth = await loginWithInitData();
        if (cancelled) return;
        if (auth.ok) {
          setUser(auth.user ?? null);
          setAuthState("ok");
        } else {
          setAuthReason(auth.reason ?? "unknown");
          setAuthState("fail");
        }
      } catch (e) {
        if (cancelled) return;
        setAuthReason(String((e as Error).message ?? e));
        setAuthState("fail");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (authState === "loading") {
    return (
      <div className="auth-gate">
        <span className="spinner" />
        <p>Connecting to Hermes…</p>
      </div>
    );
  }

  if (authState === "fail") {
    return (
      <div className="auth-gate">
        <h2>Not authenticated</h2>
        {authReason === "no_init_data" ? (
          <p>
            Open this app from the Telegram bot menu button so it can sign you
            in. Direct browser access is locked.
          </p>
        ) : (
          <p>{authReason}</p>
        )}
      </div>
    );
  }

  const inDetail = view.tab === "sessions" && !!view.sessionId;

  return (
    <div className="app">
      <header className="app-header">
        <h1>⚡ Hermes</h1>
        <div className="user-chip">
          <span className="dot" />
          <span>{user?.first_name ?? user?.username ?? "you"}</span>
        </div>
      </header>
      <main className="app-content">
        {view.tab === "status" && (
          <StatusTab
            onOpenSession={(id, title) =>
              setView({ tab: "sessions", sessionId: id, sessionTitle: title })
            }
          />
        )}
        {view.tab === "sessions" && !inDetail && (
          <SessionsTab
            onOpen={(id, title) =>
              setView({ tab: "sessions", sessionId: id, sessionTitle: title })
            }
          />
        )}
        {view.tab === "sessions" && inDetail && (
          <SessionDetail
            sessionId={view.sessionId!}
            title={view.sessionTitle ?? "Session"}
            onBack={() => setView({ tab: "sessions" })}
          />
        )}
        {view.tab === "cron" && <CronTab />}
        {view.tab === "logs" && <LogsTab />}
        {view.tab === "knowledge" && <KnowledgeTab />}
        {view.tab === "send" && <SendTab />}
      </main>
      <nav className="tab-bar">
        <TabButton
          active={view.tab === "status"}
          icon="📊"
          label="Status"
          onClick={() => setView({ tab: "status" })}
        />
        <TabButton
          active={view.tab === "sessions"}
          icon="💬"
          label="Sessions"
          onClick={() => setView({ tab: "sessions" })}
        />
        <TabButton
          active={view.tab === "cron"}
          icon="⏱"
          label="Cron"
          onClick={() => setView({ tab: "cron" })}
        />
        <TabButton
          active={view.tab === "logs"}
          icon="📜"
          label="Logs"
          onClick={() => setView({ tab: "logs" })}
        />
        <TabButton
          active={view.tab === "knowledge"}
          icon="🧠"
          label="Brain"
          onClick={() => setView({ tab: "knowledge" })}
        />
        <TabButton
          active={view.tab === "send"}
          icon="✉️"
          label="Send"
          onClick={() => setView({ tab: "send" })}
        />
      </nav>
    </div>
  );
}

function TabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button data-active={active} onClick={onClick}>
      <span className="tab-icon">{icon}</span>
      {label}
    </button>
  );
}
