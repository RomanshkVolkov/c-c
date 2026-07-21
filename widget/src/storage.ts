// The ONLY thing the widget persists to the site's localStorage: the reporter's
// own per-report tokens, so "my reports" survives reloads. First-party, minimal
// (just tokens for reports this browser filed) — telemetry buffers stay in
// memory. Namespaced per project key.

export interface StoredReport {
  id: string;
  folio: string;
  title: string;
  token: string;
  createdAt: number;
  /** unix seconds of the last time the reporter viewed this thread (for unread) */
  lastSeenAt?: number;
}

const KEY = "gsrw:reports:";

function storageKey(projectKey: string) {
  return KEY + projectKey;
}

export function loadReports(projectKey: string): StoredReport[] {
  try {
    const raw = window.localStorage.getItem(storageKey(projectKey));
    return raw ? (JSON.parse(raw) as StoredReport[]) : [];
  } catch {
    return [];
  }
}

export function saveReport(projectKey: string, r: StoredReport) {
  try {
    const all = loadReports(projectKey).filter((x) => x.id !== r.id);
    all.unshift(r);
    window.localStorage.setItem(storageKey(projectKey), JSON.stringify(all.slice(0, 50)));
  } catch {
    /* storage may be blocked — follow-up just won't persist */
  }
}

/** Mark a report's thread as seen now (resets its unread count). */
export function markSeen(projectKey: string, id: string) {
  try {
    const all = loadReports(projectKey);
    const r = all.find((x) => x.id === id);
    if (!r) return;
    // Round UP to the next second: comments created in the current second carry a
    // sub-second fraction, so flooring would keep them "unread" forever.
    r.lastSeenAt = Math.ceil(Date.now() / 1000);
    window.localStorage.setItem(storageKey(projectKey), JSON.stringify(all));
  } catch {
    /* ignore */
  }
}
