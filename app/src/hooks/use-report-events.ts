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
import { useTasksStore } from "@/store/tasks.store";

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
// The server pings every 25s. If two go missing the stream is dead — even if
// the browser still thinks it's open (a half-open connection never fires
// onerror), which is precisely the state that made the app look frozen until a
// restart. Tear it down and build a fresh connection.
const PING_TIMEOUT_MS = 60_000;
const WATCHDOG_TICK_MS = 15_000;

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
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let lastSeenAt = Date.now();
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
      lastSeenAt = Date.now();
      es.onopen = () => {
        attempts = 0;
        lastSeenAt = Date.now();
      };

      // Any inbound traffic proves the stream is alive.
      const seen = () => {
        lastSeenAt = Date.now();
      };
      es.addEventListener("ping", seen);
      es.onmessage = seen;

      es.addEventListener("report:new", (e) => {
        seen();
        const p = parse(e as MessageEvent);
        const desc = `${p.folio ?? ""} ${p.title ?? ""}`.trim();
        toast.info("New report", { description: desc });
        notify("New report", desc || "A new report was filed");
        refresh();
      });
      es.addEventListener("report:status", (e) => {
        seen();
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
        seen();
        refresh();
      });

      // Task board changes ride the same org-scoped stream. Refetch only when
      // the event belongs to the list currently on screen — a busy org would
      // otherwise reload the board on every unrelated card someone touches.
      const onTaskEvent = (e: Event) => {
        seen();
        const p = parse(e as MessageEvent) as { listId?: string };
        const store = useTasksStore.getState();
        if (!store.activeListId) return;
        if (p.listId && p.listId !== store.activeListId) return;
        store.refreshBoard();
        if (store.openTaskId) store.openTask(store.openTaskId);
      };
      for (const kind of ["task:new", "task:update", "task:move", "task:delete", "task:comment"]) {
        es.addEventListener(kind, onTaskEvent);
      }

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

    // Force a fresh connection: closing is what makes the browser drop the
    // (possibly poisoned) underlying connection instead of reusing it.
    const reconnect = () => {
      es?.close();
      es = null;
      if (stopped) return;
      attempts = 0;
      connect();
    };

    connect();

    watchdog = setInterval(() => {
      if (stopped || !es) return;
      if (Date.now() - lastSeenAt > PING_TIMEOUT_MS) reconnect();
    }, WATCHDOG_TICK_MS);

    // Coming back to the app after it sat idle is the moment the connection is
    // most likely stale — and the moment the user expects fresh data.
    const onVisible = () => {
      if (document.hidden || stopped) return;
      if (Date.now() - lastSeenAt > PING_TIMEOUT_MS) reconnect();
      refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (watchdog) clearInterval(watchdog);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      es?.close();
    };
  }, [authed]);
}
