/**
 * Shared mini components — Loading, ErrorBox, Section helpers.
 * Kept tiny and dep-free; complex bits live in their tab file.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

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

/**
 * Pull-to-refresh wrapper. Touch-only (Telegram is mobile-first).
 * Triggers `onRefresh` once threshold is exceeded and finger is released.
 *
 * Implementation notes:
 *   - We only engage when the inner scroll position is at the very top (else
 *     we'd hijack normal scroll).
 *   - Uses a small physical resistance curve (sqrt) so the indicator never
 *     feels rubbery beyond ~120px.
 *   - `onRefresh` is awaited; while pending we keep the indicator open with
 *     a spinner.
 */
export function PullToRefresh({
  onRefresh,
  children,
  threshold = 64,
}: {
  onRefresh: () => Promise<void> | void;
  children: ReactNode;
  threshold?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef<number | null>(null);
  const engaged = useRef(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const scrollEl = (): HTMLElement => node.parentElement || document.body;

    const onStart = (e: TouchEvent) => {
      if (refreshing) return;
      const sc = scrollEl();
      if (sc.scrollTop > 0) return;
      startY.current = e.touches[0].clientY;
      engaged.current = true;
    };

    const onMove = (e: TouchEvent) => {
      if (!engaged.current || startY.current === null || refreshing) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy <= 0) {
        setPull(0);
        return;
      }
      // Resistance: sqrt curve, capped.
      const eased = Math.min(120, Math.sqrt(dy * 14));
      setPull(eased);
      if (eased > 8) e.preventDefault();
    };

    const onEnd = async () => {
      if (!engaged.current) return;
      engaged.current = false;
      startY.current = null;
      if (pull >= threshold && !refreshing) {
        setRefreshing(true);
        tgHapticImpact("medium");
        try {
          await onRefresh();
        } finally {
          setRefreshing(false);
          setPull(0);
        }
      } else {
        setPull(0);
      }
    };

    node.addEventListener("touchstart", onStart, { passive: true });
    node.addEventListener("touchmove", onMove, { passive: false });
    node.addEventListener("touchend", onEnd);
    node.addEventListener("touchcancel", onEnd);
    return () => {
      node.removeEventListener("touchstart", onStart);
      node.removeEventListener("touchmove", onMove);
      node.removeEventListener("touchend", onEnd);
      node.removeEventListener("touchcancel", onEnd);
    };
  }, [pull, refreshing, threshold, onRefresh]);

  const indicatorOpen = pull > 0 || refreshing;
  const visualPull = refreshing ? threshold : pull;

  return (
    <div
      ref={ref}
      className="ptr-wrap"
      style={{
        transform: `translateY(${Math.max(0, visualPull * 0.6)}px)`,
        transition:
          refreshing || pull === 0 ? "transform 200ms ease-out" : "none",
      }}
    >
      <div
        className="ptr-indicator"
        data-open={indicatorOpen}
        data-active={pull >= threshold || refreshing}
        style={{
          opacity: indicatorOpen ? 1 : 0,
          height: indicatorOpen ? Math.max(36, visualPull * 0.6) : 0,
        }}
      >
        {refreshing ? (
          <span className="spinner small" />
        ) : pull >= threshold ? (
          <span>Release to refresh</span>
        ) : (
          <span>Pull to refresh</span>
        )}
      </div>
      {children}
    </div>
  );
}
