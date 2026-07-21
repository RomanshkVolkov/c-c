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

/** Ensure OS-notification permission (asks once). */
async function ensureNotifyPermission(): Promise<boolean> {
  try {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch {
    return false; // not in a Tauri context / plugin unavailable
  }
}

/**
 * useReportEvents subscribes to the backend SSE stream (org-scoped) and keeps
 * the reports board live: it toasts incoming events and refetches. When the app
 * is NOT focused it also fires a native OS notification, so agents get pulled
 * back without watching the window. EventSource can't send an Authorization
 * header, so the access token rides the query string.
 */
export function useReportEvents() {
  const token = useAuthStore((s) => s.accessToken);

  useEffect(() => {
    if (!token) return;

    let canNotify = false;
    ensureNotifyPermission().then((ok) => (canNotify = ok));

    // Native OS notification only when the window is hidden/unfocused (toast
    // covers the focused case), so we never double-notify.
    const notify = (title: string, body: string) => {
      if (canNotify && document.hidden) {
        try {
          sendNotification({ title, body });
        } catch {
          /* ignore */
        }
      }
    };

    const es = new EventSource(apiUrl(`/api/v1/events?token=${token}`));

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
    es.addEventListener("report:attachment", () => {
      refresh();
    });

    es.onerror = () => {
      // EventSource auto-reconnects; if the token expired the reconnect 401s and
      // this handler fires repeatedly — close and let a token refresh remount us.
      es.close();
    };

    return () => es.close();
  }, [token]);
}
