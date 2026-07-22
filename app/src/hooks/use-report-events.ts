import { useEffect } from "react";
import { toast } from "sonner";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { apiUrl } from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";
import { useReportsStore } from "@/store/reports.store";

type Payload = { reportId?: string; folio?: string; title?: string; status?: string };

async function ensureNotifyPermission(): Promise<boolean> {
  try {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch {
    return false; // not in a Tauri context / plugin unavailable
  }
}

const MAX_BACKOFF_MS = 30_000;

/**
 * Subscribes to the backend SSE stream (org-scoped) and keeps the board live.
 * Reconnects with exponential backoff on drops (a closed EventSource does NOT
 * auto-reconnect), reading a fresh token each attempt so a token refresh
 * elsewhere is picked up. When the app is unfocused it also fires a native OS
 * notification (toast covers the focused case). The token rides the query
 * string because EventSource can't set headers.
 */
export function useReportEvents() {
  const authed = useAuthStore((s) => !!s.accessToken);

  useEffect(() => {
    if (!authed) return;

    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let stopped = false;
    let canNotify = false;
    ensureNotifyPermission().then((ok) => (canNotify = ok));

    const notify = (title: string, body: string) => {
      if (canNotify && document.hidden) {
        void Promise.resolve()
          .then(() => sendNotification({ title, body }))
          .catch(() => {});
      }
    };

    const refresh = () => {
      const store = useReportsStore.getState();
      store.fetchReports();
      if (store.selectedId) store.refreshDetail();
    };

    const parse = (e: MessageEvent): Payload => {
      try {
        return JSON.parse(e.data);
      } catch {
        return {};
      }
    };

    const connect = () => {
      if (stopped) return;
      const token = useAuthStore.getState().accessToken;
      if (!token) return;

      es = new EventSource(apiUrl(`/api/v1/events?token=${token}`));
      es.onopen = () => {
        attempts = 0;
      };

      es.addEventListener("report:new", (e) => {
        const p = parse(e as MessageEvent);
        const desc = `${p.folio ?? ""} ${p.title ?? ""}`.trim();
        toast.info("New report", { description: desc });
        notify("New report", desc || "A new report was filed");
        refresh();
      });
      es.addEventListener("report:status", (e) => {
        const p = parse(e as MessageEvent);
        toast.message("Report status changed", { description: p.status });
        refresh();
      });
      es.addEventListener("report:comment", () => {
        toast.message("New comment on a report");
        notify("New reply", "A reporter replied to a report");
        refresh();
      });
      es.addEventListener("report:attachment", refresh);

      es.onerror = () => {
        es?.close();
        es = null;
        if (stopped) return;
        // Reconnect with capped exponential backoff (also covers a stale token:
        // next attempt reads whatever the store now holds).
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempts);
        attempts += 1;
        timer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      es?.close();
    };
  }, [authed]);
}
