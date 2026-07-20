// Passive breadcrumb collection (decision 7 of the proposal). Everything here
// runs in try/catch and is pure passthrough: the widget NEVER blocks, delays,
// retries or mutates a request, so it can't be the cause of a failed payment or
// login. Buffers live only in memory (no localStorage/sessionStorage writes),
// no eval/inline scripts — so it doesn't force loosening the site's CSP.

import type {
  ConsoleBreadcrumb,
  ErrorBreadcrumb,
  NavBreadcrumb,
  NetworkBreadcrumb,
  Telemetry,
  WidgetConfig,
} from "./types";

const CAP_ERRORS = 20;
const CAP_CONSOLE = 30;
const CAP_NETWORK = 20;
const CAP_NAV = 20;
const CONSOLE_TRUNCATE = 500;
const BODY_TRUNCATE = 4096;
const TOTAL_CAP_BYTES = 30 * 1024;

// Hard host denylist — payments/auth. captureBodies can NEVER override these;
// for these hosts we never capture body or query, at most host + status code.
const DENY_HOSTS = [
  "stripe.com",
  "paypal.com",
  "mercadopago.com",
  "mercadolibre.com",
  "conekta.io",
  "openpay.mx",
  "auth0.com",
  "accounts.google.com",
  "clerk.com",
  "cognito-idp",
];

// Field names scrubbed recursively from captured bodies.
const DEFAULT_SCRUB = [
  "password",
  "pass",
  "token",
  "secret",
  "authorization",
  "card",
  "cardnumber",
  "cvv",
  "cvc",
  "ssn",
  "pin",
  "clientsecret",
];

const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._-]+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SENSITIVE_QS = ["token", "code", "client_secret", "access_token", "id_token", "key", "password"];

function redactPatterns(s: string): string {
  return s
    .replace(JWT_RE, "[jwt]")
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(EMAIL_RE, "[email]");
}

function hostOf(url: string): string {
  try {
    return new URL(url, location.href).hostname;
  } catch {
    return "";
  }
}

function isDenied(url: string): boolean {
  const host = hostOf(url);
  return DENY_HOSTS.some((d) => host.includes(d));
}

/** Strip sensitive query params, then redact token/email patterns in the rest. */
function scrubUrl(url: string): string {
  try {
    const u = new URL(url, location.href);
    for (const p of SENSITIVE_QS) if (u.searchParams.has(p)) u.searchParams.set(p, "[redacted]");
    return redactPatterns(u.toString());
  } catch {
    return redactPatterns(url);
  }
}

function matchGlob(path: string, pattern: string): boolean {
  // supports trailing/embedded '*'
  const re = new RegExp(
    "^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"
  );
  return re.test(path);
}

function scrubBody(value: unknown, fields: string[], depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (Array.isArray(value)) return value.map((v) => scrubBody(v, fields, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = fields.includes(k.toLowerCase()) ? "[redacted]" : scrubBody(v, fields, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return redactPatterns(value);
  return value;
}

export class TelemetryCollector {
  private errors: ErrorBreadcrumb[] = [];
  private console: ConsoleBreadcrumb[] = [];
  private network: NetworkBreadcrumb[] = [];
  private nav: NavBreadcrumb[] = [];
  private scrubFields: string[];
  private captureBodies: string[];
  private uninstallers: Array<() => void> = [];

  constructor(cfg: WidgetConfig) {
    this.scrubFields = [...DEFAULT_SCRUB, ...(cfg.scrubFields ?? []).map((f) => f.toLowerCase())];
    this.captureBodies = cfg.captureBodies ?? [];
  }

  private push<T>(arr: T[], item: T, cap: number) {
    arr.push(item);
    if (arr.length > cap) arr.shift();
  }

  install() {
    try {
      this.installErrors();
      this.installConsole();
      this.installFetch();
      this.installXHR();
      this.installNav();
    } catch {
      /* telemetry must never break the host page */
    }
  }

  uninstall() {
    for (const u of this.uninstallers) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    this.uninstallers = [];
  }

  private installErrors() {
    const onError = (e: ErrorEvent) => {
      this.push(this.errors, {
        ts: Date.now(),
        kind: "error",
        message: redactPatterns(String(e.message ?? "")),
        stack: e.error?.stack ? redactPatterns(String(e.error.stack)) : undefined,
        source: e.filename ? `${e.filename}:${e.lineno}` : undefined,
      }, CAP_ERRORS);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason;
      this.push(this.errors, {
        ts: Date.now(),
        kind: "unhandledrejection",
        message: redactPatterns(String(reason?.message ?? reason ?? "")),
        stack: reason?.stack ? redactPatterns(String(reason.stack)) : undefined,
      }, CAP_ERRORS);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    this.uninstallers.push(() => window.removeEventListener("error", onError));
    this.uninstallers.push(() => window.removeEventListener("unhandledrejection", onRejection));
  }

  private installConsole() {
    (["error", "warn"] as const).forEach((level) => {
      const orig = console[level];
      const patched = (...args: unknown[]) => {
        try {
          const text = args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ");
          this.push(this.console, {
            ts: Date.now(),
            level,
            text: redactPatterns(text).slice(0, CONSOLE_TRUNCATE),
          }, CAP_CONSOLE);
        } catch {
          /* ignore */
        }
        orig.apply(console, args as []);
      };
      console[level] = patched as typeof orig;
      this.uninstallers.push(() => {
        console[level] = orig;
      });
    });
  }

  private recordNetwork(method: string, url: string, status: number, durationMs: number, rawBody?: string) {
    // Only failures are recorded (4xx/5xx/network error).
    if (status >= 200 && status < 400) return;
    const denied = isDenied(url);
    const bc: NetworkBreadcrumb = {
      ts: Date.now(),
      method,
      url: denied ? hostOf(url) : scrubUrl(url),
      status,
      durationMs: Math.round(durationMs),
    };
    if (!denied && rawBody !== undefined && this.shouldCaptureBody(url)) {
      bc.body = this.scrubRawBody(rawBody);
    }
    this.push(this.network, bc, CAP_NETWORK);
  }

  private shouldCaptureBody(url: string): boolean {
    if (this.captureBodies.length === 0) return false;
    let path: string;
    try {
      path = new URL(url, location.href).pathname;
    } catch {
      return false;
    }
    return this.captureBodies.some((g) => matchGlob(path, g));
  }

  private scrubRawBody(raw: string): string {
    let scrubbed: string;
    try {
      scrubbed = JSON.stringify(scrubBody(JSON.parse(raw), this.scrubFields));
    } catch {
      scrubbed = redactPatterns(raw); // form-encoded / plain
    }
    return scrubbed.slice(0, BODY_TRUNCATE);
  }

  private installFetch() {
    const orig = window.fetch;
    const self = this;
    window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      const start = Date.now();
      const [input, init] = args;
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      const body = typeof init?.body === "string" ? init.body : undefined;
      const p = orig.apply(this, args);
      p.then(
        (res) => self.safe(() => self.recordNetwork(method, url, res.status, Date.now() - start, body)),
        () => self.safe(() => self.recordNetwork(method, url, 0, Date.now() - start, body))
      );
      return p;
    } as typeof fetch;
    this.uninstallers.push(() => {
      window.fetch = orig;
    });
  }

  private installXHR() {
    const OrigOpen = XMLHttpRequest.prototype.open;
    const OrigSend = XMLHttpRequest.prototype.send;
    const self = this;
    type Tracked = XMLHttpRequest & { __rw?: { method: string; url: string; start: number; body?: string } };

    XMLHttpRequest.prototype.open = function (this: Tracked, method: string, url: string | URL, ...rest: unknown[]) {
      this.__rw = { method: String(method).toUpperCase(), url: String(url), start: 0 };
      // @ts-expect-error passthrough to native signature
      return OrigOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (this: Tracked, body?: Document | XMLHttpRequestBodyInit | null) {
      if (this.__rw) {
        this.__rw.start = Date.now();
        if (typeof body === "string") this.__rw.body = body;
        this.addEventListener("loadend", () => {
          self.safe(() => {
            const m = this.__rw!;
            self.recordNetwork(m.method, m.url, this.status, Date.now() - m.start, m.body);
          });
        });
      }
      return OrigSend.call(this, body ?? null);
    };
    this.uninstallers.push(() => {
      XMLHttpRequest.prototype.open = OrigOpen;
      XMLHttpRequest.prototype.send = OrigSend;
    });
  }

  private installNav() {
    let current = location.pathname + location.search;
    const record = () => {
      const to = location.pathname + location.search;
      if (to !== current) {
        this.push(this.nav, { ts: Date.now(), from: scrubUrl(current), to: scrubUrl(to) }, CAP_NAV);
        current = to;
      }
    };
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function (this: History, ...args: Parameters<History["pushState"]>) {
      const r = origPush.apply(this, args);
      record();
      return r;
    };
    history.replaceState = function (this: History, ...args: Parameters<History["replaceState"]>) {
      const r = origReplace.apply(this, args);
      record();
      return r;
    };
    window.addEventListener("popstate", record);
    this.uninstallers.push(() => {
      history.pushState = origPush;
      history.replaceState = origReplace;
      window.removeEventListener("popstate", record);
    });
  }

  private safe(fn: () => void) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }

  /** Snapshot the buffers, trimmed to the total byte cap (drops oldest first). */
  snapshot(): Telemetry {
    const t: Telemetry = {
      errors: [...this.errors],
      console: [...this.console],
      network: [...this.network],
      nav: [...this.nav],
    };
    while (JSON.stringify(t).length > TOTAL_CAP_BYTES) {
      // drop oldest across the largest buffer
      const largest = [t.console, t.network, t.errors, t.nav].sort((a, b) => b.length - a.length)[0];
      if (largest.length === 0) break;
      largest.shift();
    }
    return t;
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
