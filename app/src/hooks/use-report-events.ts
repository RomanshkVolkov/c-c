import { useEffect } from "react";
import { toast } from "sonner";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { apiUrl, refreshAccessToken } from "@/lib/api";
import { STATUS_LABELS, normalizeStatus } from "@/types/report";
import { useAuthStore } from "@/store/auth.store";
import { useReportsStore } from "@/store/reports.store";
import { useTasksStore } from "@/store/tasks.store";
import { useConnectionStore } from "@/store/connection.store";
import { usePendingStore } from "@/store/pending.store";

type Payload = { reportId?: string; folio?: string; title?: string; status?: string };

async function ensureNotifyPermission(): Promise<boolean> {
  try {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch {
    return false; // not in a Tauri context / plugin unavailable
  }
}

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Fallback (browser, no Tauri) only — in the app the stream lives in Rust.
const MAX_BACKOFF_MS = 30_000;
const PING_TIMEOUT_MS = 60_000;
const WATCHDOG_TICK_MS = 15_000;

/**
 * Subscribes to the backend's org-scoped event stream and keeps the boards live.
 *
 * The stream itself runs in the Rust core: `EventSource` can't set headers, so
 * it forced the access token into the query string — where it ends up in the
 * server's access log — and left reconnection, backoff and the missed-ping
 * watchdog sitting on a connection the webview owned. Rust holds the socket now
 * and forwards each frame; this hook only decides what a frame means.
 *
 * The `EventSource` path below is kept for running the UI in a plain browser.
 */
export function useReportEvents() {
  // The token itself, not a boolean: access tokens live 60 minutes, and Rust is
  // handed the value once at connect time. Depending on `!!accessToken` meant a
  // refresh swapped the token without anything reconnecting — the stream 401'd
  // and stayed down until the app was restarted, roughly once an hour.
  const token = useAuthStore((s) => s.accessToken);

  useEffect(() => {
    const authed = !!token;
    // Guests never subscribe, so the stream is idle rather than broken — without
    // this the connection banner would nag them about live updates being down.
    if (!authed) {
      useConnectionStore.getState().setStream("idle");
      return;
    }
    useConnectionStore.getState().setStream("connecting");

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

    const parse = (raw: string): Payload => {
      try {
        return JSON.parse(raw);
      } catch {
        return {};
      }
    };

    /** One frame → toasts, notifications and refetches. Transport-agnostic. */
    const handle = (event: string, data: string) => {
      // The dashboard's pending lists go stale on anything that changes a
      // report or a task, whichever branch below handles it. The store
      // debounces and ignores this until the dashboard has been opened once,
      // so a user who never goes there pays nothing.
      if (event.startsWith("report:") || event.startsWith("task:")) {
        usePendingStore.getState().markStale();
      }
      switch (event) {
        case "report:new": {
          const p = parse(data);
          const desc = `${p.folio ?? ""} ${p.title ?? ""}`.trim();
          toast.info("New report", { description: desc });
          notify("New report", desc || "A new report was filed");
          refresh();
          break;
        }
        case "report:status": {
          // Folded through the same map as the board, so the toast can't name a
          // state using the spelling the rest of the UI stopped using.
          const raw = parse(data).status;
          toast.message("Report status changed", {
            description: raw ? STATUS_LABELS[normalizeStatus(String(raw))] : undefined,
          });
          refresh();
          break;
        }
        case "report:comment": {
          toast.message("New comment on a report");
          notify("New reply", "A reporter replied to a report");
          refresh();
          break;
        }
        case "report:attachment":
          refresh();
          break;
        case "task:new":
        case "task:update":
        case "task:move":
        case "task:delete":
        case "task:comment": {
          // Task board changes ride the same org-scoped stream. Refetch only when
          // the event belongs to the list currently on screen — a busy org would
          // otherwise reload the board on every unrelated card someone touches.
          const p = parse(data) as { listId?: string };
          const store = useTasksStore.getState();
          if (!store.activeListId) return;
          if (p.listId && p.listId !== store.activeListId) return;
          store.refreshBoard();
          // refreshOpenTask, never openTask: this fires on anyone's edit to any
          // card in the list, so blanking `detail` here would unmount the open
          // drawer — and the description someone is writing in it — because a
          // colleague moved an unrelated card.
          if (store.openTaskId) store.refreshOpenTask();
          break;
        }
        default:
          break; // `ping` and anything new: proof of life, nothing to do
      }
    };

    // ── Rust-owned stream ────────────────────────────────────────────────────
    if (inTauri) {
      const unlisten: Array<() => void> = [];
      void (async () => {
        const [{ invoke }, { listen }] = await Promise.all([
          import("@tauri-apps/api/core"),
          import("@tauri-apps/api/event"),
        ]);
        if (stopped) return;

        unlisten.push(
          await listen<{ event: string; data: string }>("sse://message", (e) =>
            handle(e.payload.event, e.payload.data),
          ),
        );
        unlisten.push(
          await listen<{ state: string; detail?: string }>("sse://status", (e) => {
            const s = e.payload.state;
            useConnectionStore
              .getState()
              .setStream(s === "open" ? "open" : s === "connecting" ? "connecting" : "down");

            // Rust stops retrying on an auth failure — retrying with the same
            // token would just fail again. Getting a fresh one is the UI's job,
            // and swapping it in the store re-runs this effect with the new
            // token, which reconnects.
            if (s === "down" && /401|403/.test(e.payload.detail ?? "")) {
              void refreshAccessToken();
            }
          }),
        );

        // The token goes to Rust, which sends it as an Authorization header.
        await invoke("sse_connect", { url: apiUrl("/api/v1/events"), token });
      })();

      // Coming back after the app sat idle is when the user expects fresh data;
      // the stream's own health is Rust's problem now.
      const onVisible = () => {
        if (!document.hidden && !stopped) refresh();
      };
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("focus", onVisible);

      return () => {
        stopped = true;
        useConnectionStore.getState().setStream("idle");
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("focus", onVisible);
        for (const off of unlisten) off();
        void import("@tauri-apps/api/core").then(({ invoke }) => invoke("sse_disconnect"));
      };
    }

    // ── Browser fallback ─────────────────────────────────────────────────────
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let lastSeenAt = Date.now();
    let attempts = 0;

    const connect = () => {
      if (stopped) return;
      const token = useAuthStore.getState().accessToken;
      if (!token) return;

      es = new EventSource(apiUrl(`/api/v1/events?token=${token}`));
      lastSeenAt = Date.now();
      es.onopen = () => {
        attempts = 0;
        lastSeenAt = Date.now();
        useConnectionStore.getState().setStream("open");
      };

      const seen = () => {
        lastSeenAt = Date.now();
      };
      es.onmessage = seen;
      for (const kind of [
        "ping",
        "report:new",
        "report:status",
        "report:comment",
        "report:attachment",
        "task:new",
        "task:update",
        "task:move",
        "task:delete",
        "task:comment",
      ]) {
        es.addEventListener(kind, (e) => {
          seen();
          handle(kind, (e as MessageEvent).data ?? "");
        });
      }

      es.onerror = () => {
        useConnectionStore.getState().setStream("down");
        es?.close();
        es = null;
        if (stopped) return;
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempts);
        attempts += 1;
        timer = setTimeout(connect, delay);
      };
    };

    const reconnect = () => {
      useConnectionStore.getState().setStream("connecting");
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

    const onVisible = () => {
      if (document.hidden || stopped) return;
      if (Date.now() - lastSeenAt > PING_TIMEOUT_MS) reconnect();
      refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      stopped = true;
      useConnectionStore.getState().setStream("idle");
      if (timer) clearTimeout(timer);
      if (watchdog) clearInterval(watchdog);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      es?.close();
    };
  }, [token]);
}
