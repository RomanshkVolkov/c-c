import { useEffect } from "react";
import { toast } from "sonner";
import { apiUrl } from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";
import { useReportsStore } from "@/store/reports.store";

type Payload = { reportId?: string; folio?: string; title?: string; status?: string };

/**
 * useReportEvents subscribes to the backend SSE stream (org-scoped) and keeps
 * the reports board live: it toasts incoming events and refetches. EventSource
 * can't send an Authorization header, so the access token rides the query
 * string (the backend accepts ?token=).
 */
export function useReportEvents() {
  const token = useAuthStore((s) => s.accessToken);

  useEffect(() => {
    if (!token) return;

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
      toast.info("New report", { description: `${p.folio ?? ""} ${p.title ?? ""}`.trim() });
      refresh();
    });
    es.addEventListener("report:status", (e) => {
      const p = parse(e as MessageEvent);
      toast.message("Report status changed", { description: p.status });
      refresh();
    });
    es.addEventListener("report:comment", () => {
      toast.message("New comment on a report");
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
