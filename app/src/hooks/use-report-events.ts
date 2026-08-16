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
import { useChatStore } from "@/store/chat.store";
import { useDMStore } from "@/store/dm.store";
import { useConnectionStore } from "@/store/connection.store";
import { usePendingStore } from "@/store/pending.store";
import { useNotificationsStore } from "@/store/notifications.store";

type Payload = {
  reportId?: string;
  folio?: string;
  title?: string;
  status?: string;
  /**
   * Which side caused the event — "team", "reporter", or "project:<slug>". A
   * tenant uses it to ignore its own actions; it names a side, not a person.
   */
  from?: string;
  /**
   * Which *person* caused it, when it was one of ours.
   *
   * Needed because every console in the organization hears "team", including
   * the one that just wrote the comment — so without this you get told about
   * your own reply, which is how this was noticed.
   */
  actorId?: string;
};

async function ensureNotifyPermission(): Promise<boolean> {
  try {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch {
    return false; // not in a Tauri context / plugin unavailable
  }
}

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Is the window in front of the user right now?
 *
 * Not `document.hidden`, which is what this used to ask. The Page Visibility
 * API is driven by the compositor, and on WebKitGTK — the webview on Linux — a
 * window that's minimised or on another workspace can still report itself
 * visible. The gate never opened, so no notification was ever sent, and nothing
 * anywhere recorded that a decision had been made.
 *
 * Tauri knows, because it owns the window. In a plain browser there is no
 * window to ask, so fall back to the old question.
 */
async function windowIsFocused(): Promise<boolean> {
  if (!inTauri) return !document.hidden;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return await getCurrentWindow().isFocused();
  } catch {
    return false; // can't tell → notify, rather than swallow it
  }
}

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

    /**
     * Record it, and tell the OS unless the user is already looking at us.
     *
     * The record happens either way. An OS notification that never fires
     * leaves no trace at all, which is exactly what made "it didn't arrive"
     * indistinguishable from "nothing happened" — see the notifications store.
     */
    const notify = (kind: string, title: string, body: string, reportId?: string) => {
      void (async () => {
        const log = useNotificationsStore.getState().add;
        if (await windowIsFocused()) {
          log({ kind, title, body, delivery: "focused", reportId });
          return;
        }
        if (!canNotify) {
          log({ kind, title, body, reportId, delivery: "failed", error: "permission not granted" });
          return;
        }
        try {
          await Promise.resolve(sendNotification({ title, body }));
          log({ kind, title, body, delivery: "os", reportId });
        } catch (e) {
          log({
            kind, title, body, reportId,
            delivery: "failed",
            error: e instanceof Error ? e.message : String(e),
          });
        }
      })();
    };

    const refresh = () => {
      const store = useReportsStore.getState();
      store.fetchReports();
      if (store.selectedId) store.refreshDetail();
    };

    /**
     * Did this console cause the event?
     *
     * Every console in the organization hears the same stream, so an event has
     * to name the person and not just the side — "team" is true for the one who
     * typed it and for everyone else. Without this you get told about your own
     * comment, your own drag, your own card.
     *
     * The refresh still happens either way: the screen should show what you did.
     * What stops is the announcement.
     */
    const mine = (p: Payload) =>
      Boolean(p.actorId) && p.actorId === useAuthStore.getState().session?.id;

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
          if (mine(p)) {
            refresh();
            break;
          }
          const desc = `${p.folio ?? ""} ${p.title ?? ""}`.trim();
          toast.info("New report", { description: desc });
          notify("report:new", "New report", desc || "A new report was filed", p.reportId);
          refresh();
          break;
        }
        case "report:status": {
          const moved = parse(data);
          if (mine(moved)) {
            refresh();
            break;
          }
          // Folded through the same map as the board, so the toast can't name a
          // state using the spelling the rest of the UI stopped using.
          const raw = moved.status;
          toast.message("Report status changed", {
            description: raw ? STATUS_LABELS[normalizeStatus(String(raw))] : undefined,
          });
          refresh();
          break;
        }
        case "report:comment": {
          const p = parse(data);
          // Not your own. The refresh below still runs — the thread should show
          // your comment — but nothing announces it back at you.
          if (mine(p)) {
            refresh();
            break;
          }
          // Who actually replied, rather than assuming it was the reporter: the
          // same event carries replies from the team and from a tenant's app,
          // and calling all of them "a reporter" made two thirds of them wrong.
          const who =
            p.from === "reporter"
              ? "The reporter replied"
              : p.from && p.from.startsWith("project:")
                ? "The client's app replied"
                : "Someone on the team replied";
          toast.message(who);
          notify("report:comment", "New reply", who, p.reportId);
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
        case "chat:message": {
          const p = parse(data) as Payload & { spaceId?: string; mentions?: string[] };
          if (!p.spaceId) break;
          // Your own line, echoed back by the stream every console hears. The
          // panel already shows it — the post refetched — so there is nothing
          // to do at all here, not even a refresh.
          if (mine(p)) break;
          void useChatStore.getState().onIncoming(p.spaceId);
          // Only announce what you aren't already looking at. onIncoming has the
          // same condition; it is repeated rather than returned because the two
          // decisions are different — one updates a badge, one interrupts you.
          const space = useTasksStore
            .getState()
            .tree.find((s) => s.id === p.spaceId);
          const where = space ? `#${space.name}` : "a channel";

          // Being named is different from a message arriving: it is addressed
          // to you, so it interrupts even while you are looking at the channel
          // — the one case where the "you can already see it" rule is wrong.
          const me = useAuthStore.getState().session?.id;
          if (me && p.mentions?.includes(me)) {
            toast.message(`You were mentioned in ${where}`);
            notify("chat:mention", `Mentioned in ${where}`, "Somebody named you");
            break;
          }

          const chat = useChatStore.getState();
          if (chat.panelOpen && chat.spaceId === p.spaceId) break;
          toast.message(`New message in ${where}`);
          notify("chat:message", where, "New message in the channel");
          break;
        }
        case "dm:message": {
          // Addressed by the server to one person, so arriving at all means it
          // is yours — the hub does the filtering that `mine()` does for the
          // org-wide streams. The actor check stays anyway: you are told about
          // your own message on no channel.
          const p = parse(data) as Payload & { conversationId?: string };
          if (!p.conversationId || mine(p)) break;
          void useDMStore.getState().onIncoming(p.conversationId);

          const dm = useDMStore.getState();
          if (dm.conversationId === p.conversationId) break;
          const who = dm.conversations.find(
            (c) => c.conversationId === p.conversationId,
          )?.username;
          toast.message(who ? `${who} wrote to you` : "New direct message");
          notify("dm:message", who ?? "Direct message", "You have a new message");
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
