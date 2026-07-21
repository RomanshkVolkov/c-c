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
