/**
 * Shared mini components — Loading, ErrorBox, Section helpers.
 * Kept tiny and dep-free; complex bits live in their tab file.
 */

import type { ReactNode } from "react";

export function Loading() {
  return (
    <div className="loading">
      <span className="spinner" />
    </div>
  );
}

export function ErrorBox({ msg }: { msg: string }) {
  return <div className="error-box">{msg}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div
      className="section-title"
      style={{ marginLeft: "calc(var(--space-4) + var(--space-1))" }}
    >
      {children}
    </div>
  );
}

export function tgHaptic(kind: "success" | "error" | "warning") {
  try {
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred(kind);
  } catch {
    /* ignore */
  }
}

export function tgHapticImpact(
  style: "light" | "medium" | "heavy" | "rigid" | "soft" = "light",
) {
  try {
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred(style);
  } catch {
    /* ignore */
  }
}
