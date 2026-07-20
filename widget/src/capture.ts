import type { SnapshotConfig } from "./types";

/** Page context captured at report time. */
export function captureContext() {
  return {
    url: location.href,
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
  };
}

/**
 * Build the opt-in snapshot. Only allowlisted localStorage keys are read (never
 * a wholesale dump — that would hoover up third-party JWTs/PII). The server
 * redacts/encrypts; the widget is not the trust boundary.
 */
export function buildSnapshot(cfg?: SnapshotConfig): Record<string, unknown> | undefined {
  if (!cfg) return undefined;
  const out: Record<string, unknown> = {};
  if (cfg.localStorage?.length) {
    const ls: Record<string, string | null> = {};
    for (const key of cfg.localStorage) {
      try {
        ls[key] = window.localStorage.getItem(key);
      } catch {
        /* storage may be blocked */
      }
    }
    out.localStorage = ls;
  }
  if (cfg.cookies) {
    // Only non-HttpOnly cookies are visible here by definition.
    out.cookies = document.cookie;
  }
  return Object.keys(out).length ? out : undefined;
}
