// Public configuration for the widget (React props and vanilla data-attrs map
// onto this).

export interface SnapshotConfig {
  /** allowlist of localStorage keys to include (never a wholesale dump) */
  localStorage?: string[];
  /** include non-HttpOnly document.cookie (default false) */
  cookies?: boolean;
}

import type { Locale } from "./i18n";

export interface WidgetConfig {
  /** public write-only ingest key (pk_…) */
  projectKey: string;
  /** UI language (default 'es') */
  locale?: Locale;
  /** ingest base URL, e.g. https://cac.guz-studio.dev */
  endpoint?: string;
  /** curated extra context attached to every report */
  context?: () => Record<string, unknown>;
  /**
   * Identity of the reporter, taken from the host app's session (not asked in
   * the form). Populates who-reported in the console and scopes the future
   * "my reports" view. e.g. () => ({ id: session.user.id, name: session.user.name })
   */
  reporter?: () => { id?: string; name?: string; email?: string };
  /** opt-in localStorage/cookie snapshot (server redacts/encrypts) */
  snapshot?: SnapshotConfig;
  /**
   * allowlist of URL path globs whose request bodies are captured on FAILURE
   * only (e.g. ['/api/checkout', '/api/forms/*']). Payment/auth hosts are
   * always excluded regardless of this list.
   */
  captureBodies?: string[];
  /** extra field names to scrub from captured bodies (merged with defaults) */
  scrubFields?: string[];
  /** theme for the launcher button */
  theme?: { color?: string; position?: "bottom-right" | "bottom-left" };
}

// ─── Telemetry payload shapes ─────────────────────────────────────────────────

export interface ErrorBreadcrumb {
  ts: number;
  message: string;
  stack?: string;
  source?: string; // file:line
  kind: "error" | "unhandledrejection";
}

export interface ConsoleBreadcrumb {
  ts: number;
  level: "error" | "warn";
  text: string;
}

export interface NetworkBreadcrumb {
  ts: number;
  method: string;
  url: string;
  status: number; // 0 = network error
  durationMs: number;
  body?: string; // only for allowlisted failed routes, scrubbed
}

export interface NavBreadcrumb {
  ts: number;
  from: string;
  to: string;
}

export interface Telemetry {
  errors: ErrorBreadcrumb[];
  console: ConsoleBreadcrumb[];
  network: NetworkBreadcrumb[];
  nav: NavBreadcrumb[];
}
