import { useEffect } from "react";
import { toast } from "sonner";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { apiUrl, refreshAccessToken } from "@/lib/api";
import i18next from "i18next";

import { STATUS_LABEL_KEYS, normalizeStatus } from "@/types/report";
import { useAuthStore } from "@/store/auth.store";
import { useReportsStore } from "@/store/reports.store";
import { useTasksStore } from "@/store/tasks.store";
import { useChatStore } from "@/store/chat.store";
import { useDMStore } from "@/store/dm.store";
import { useConnectionStore } from "@/store/connection.store";
import { usePendingStore } from "@/store/pending.store";
import { useNotificationsStore } from "@/store/notifications.store";
import { useInboxStore } from "@/store/inbox.store";
import { useVoice, type TimbreEntrante } from "@/store/voice.store";
import { useMeetingsStore, type ReunionEntrante } from "@/store/meetings.store";
import { useMyWorkStore } from "@/store/mywork.store";

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

/**
 * ¿Acaba de volver el stream de una caída?
 *
 * Un evento emitido mientras la conexión estaba muerta **no se reenvía** al
 * reconectar. Así que reconectar en silencio deja la pantalla con un hueco que
 * nada delata: los mensajes de ese rato no llegaron y no van a llegar. Quien
 * responde `true` aquí está diciendo «hay que volver a pedir lo que hay a la
 * vista».
 *
 * El primer `open` **no** cuenta: es el arranque, y ahí las pantallas acaban de
 * pedir sus datos. Distinguirlo es toda la razón de que esto tenga estado.
 *
 * Se exporta para poder probarlo de verdad, y lo usan los dos transportes —el
 * de Rust y el de `EventSource`—, que tenían el mismo agujero por separado.
 */
/**
 * ¿Este evento deja fila en la campana?
 *
 * El backend guarda la notificación en su tabla, pero la campana no se entera
 * sola: hay que volver a pedir la bandeja. Sólo lo hacían tres ramas del
 * conmutador —reportes y comentarios de tarea—, así que un mensaje de canal o un
 * directo se guardaban y **no aparecían** hasta que algo recargaba la bandeja
 * por otro motivo: arrancar la app, iniciar sesión o cambiar de organización.
 * Desde fuera parecía que llegaban al entrar en la sección.
 *
 * Se escribe como lista y no repartido por el conmutador para que se pueda leer
 * de un vistazo qué avisa y qué no — que es justo la pregunta que nadie podía
 * contestar cuando esto estaba roto.
 */
const DEJAN_FILA = new Set([
  "report:new",
  "report:comment",
  "task:comment",
  "task:assigned",
  "task:status",
  "chat:message",
  "chat:mention",
  "dm:message",
  // Una reunión deja constancia además de sonar: la tarjeta caduca en un
  // minuto, y quien no estaba delante tiene que poder enterarse después de que
  // la hubo.
  "meeting:reminder",
]);

export function tocaLaCampana(evento: string): boolean {
  return DEJAN_FILA.has(evento);
}

export function vigilanteDeReconexion() {
  let caido = false;
  return (estado: "open" | "connecting" | "down"): boolean => {
    if (estado === "down") {
      caido = true;
      return false;
    }
    if (estado === "open" && caido) {
      caido = false;
      return true;
    }
    return false;
  };
}
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
    /**
     * Vuelve a pedir la bandeja del servidor.
     *
     * El backend ya escribe la fila; sin esto, con la app abierta el contador
     * de la campana no se movía hasta cambiar de organización o reiniciar — la
     * notificación existía y no se veía, que es la mitad del fallo original
     * contada al revés.
     *
     * Del `orgId` que la bandeja ya tiene: quien la cargó sabe de qué
     * organización es, y adivinarlo aquí sería una segunda fuente para la misma
     * verdad.
     */
    const releerBandeja = () => {
      const inbox = useInboxStore.getState();
      void inbox.load(inbox.orgId).catch(() => {});
    };

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

    /**
     * Volver a pedir lo que hay en pantalla.
     *
     * Se llama al recuperar el foco y —lo que faltaba— **cuando el stream se
     * cae y vuelve**. Un evento emitido mientras nadie escuchaba no se reenvía:
     * si no se recupera aquí, se ha perdido hasta que alguien recargue.
     *
     * Antes sólo miraba los reportes, y por eso el chat se quedaba atrás sin
     * que nada lo delatara: los mensajes llegaban en vivo o no llegaban. Es la
     * causa de tener que recargar para leer lo que te habían escrito, y se nota
     * sobre todo en una llamada, que es cuando pasas media hora sin quitarle el
     * foco a la ventana ni una vez.
     */
    const refresh = () => {
      const store = useReportsStore.getState();
      store.fetchReports();
      if (store.selectedId) store.refreshDetail();

      const chat = useChatStore.getState();
      void chat.fetchUnread();
      // Sólo el canal que está a la vista: recargar los demás sería pedir el
      // historial entero de la organización cada vez que parpadea la red.
      if (chat.panelOpen && chat.spaceId) void chat.fetch(chat.spaceId);

      const dm = useDMStore.getState();
      if (dm.conversationId) void dm.open(dm.conversationId);

      // Y la campana, que faltaba: sin esto un aviso emitido durante una caída
      // no se recuperaba nunca, ni volviendo a la ventana.
      const inbox = useInboxStore.getState();
      void inbox.load(inbox.orgId).catch(() => {});
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
      // La campana, en un solo sitio y antes del conmutador.
      //
      // Estaba repartida en tres ramas y faltaba en cinco. Ponerla aquí evita
      // además la trampa que tenía: varias ramas se cortan antes de terminar
      // —«ya estás mirando esa conversación», «no hay lista abierta»— y esos
      // cortes son razones para **no interrumpirte**, no para dejar la campana
      // sin actualizar.
      if (tocaLaCampana(event)) releerBandeja();
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
          releerBandeja();
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
            // `i18next.t` y no el hook: esto no es un componente, es el
            // repartidor de eventos. Lee el idioma que esté puesto en ese
            // momento, que es lo correcto para un aviso que se emite una vez.
            description: raw
              ? i18next.t(STATUS_LABEL_KEYS[normalizeStatus(String(raw))])
              : undefined,
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
          const p = parse(data) as { listId?: string; taskId?: string };
          const store = useTasksStore.getState();
          // Lo borrado se quita **antes** de mirar la lista en pantalla: «My
          // work» junta tareas de todas las listas, así que un borrado en otra
          // le dejaría la fila puesta y sólo al abrirla se sabría que ya no
          // está. Es local y barato — la fila no puede seguir existiendo.
          if (event === "task:delete" && p.taskId) {
            useMyWorkStore.getState().olvidar(p.taskId);
          }
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
          const p = parse(data) as Payload & {
            spaceId?: string;
            mentions?: string[];
            spaceName?: string;
            authorName?: string;
            preview?: string;
          };
          if (!p.spaceId) break;
          // Your own line, echoed back by the stream every console hears. The
          // panel already shows it — the post refetched — so there is nothing
          // to do at all here, not even a refresh.
          if (mine(p)) break;
          void useChatStore.getState().onIncoming(p.spaceId);
          // Only announce what you aren't already looking at. onIncoming has the
          // same condition; it is repeated rather than returned because the two
          // decisions are different — one updates a badge, one interrupts you.
          // El nombre lo manda el servidor; el árbol local es sólo el respaldo.
          //
          // Antes era al revés y por eso los avisos decían «a channel»: el
          // árbol de espacios sólo está cargado si has abierto esa pantalla, y
          // quien recibe un mensaje con el tablero delante no lo tiene.
          const space = useTasksStore.getState().tree.find((s) => s.id === p.spaceId);
          const nombre = p.spaceName || space?.name;
          const where = nombre ? `#${nombre}` : "a channel";
          // «Quién: qué», que es como se lee un chat.
          const linea =
            p.authorName && p.preview
              ? `${p.authorName}: ${p.preview}`
              : p.preview || (p.authorName ? `${p.authorName} escribió` : "New message in the channel");

          // Being named is different from a message arriving: it is addressed
          // to you, so it interrupts even while you are looking at the channel
          // — the one case where the "you can already see it" rule is wrong.
          const me = useAuthStore.getState().session?.id;
          if (me && p.mentions?.includes(me)) {
            toast.message(`You were mentioned in ${where}`);
            notify("chat:mention", `Mentioned in ${where}`, linea);
            break;
          }

          const chat = useChatStore.getState();
          if (chat.panelOpen && chat.spaceId === p.spaceId) break;
          toast.message(`New message in ${where}`);
          notify("chat:message", where, linea);
          break;
        }
        case "dm:message": {
          // Addressed by the server to one person, so arriving at all means it
          // is yours — the hub does the filtering that `mine()` does for the
          // org-wide streams. The actor check stays anyway: you are told about
          // your own message on no channel.
          const p = parse(data) as Payload & {
            conversationId?: string;
            authorName?: string;
          };
          if (!p.conversationId || mine(p)) break;
          void useDMStore.getState().onIncoming(p.conversationId);

          const dm = useDMStore.getState();
          if (dm.conversationId === p.conversationId) break;
          // El nombre lo manda el servidor; la lista local es sólo el respaldo.
          //
          // Antes era al revés, y `conversations` sólo está cargada si has
          // abierto la sección de directos. Quien recibe un directo con el
          // tablero delante no la tiene, y el aviso decía «Direct message» —
          // indistinguible de cualquier otro.
          const who =
            p.authorName ||
            dm.conversations.find((c) => c.conversationId === p.conversationId)?.username;
          toast.message(who ? `${who} wrote to you` : "New direct message");
          // Sin cuerpo: el texto de un directo no sale de la conversación, ni
          // aquí ni en la fila de la bandeja. Con el nombre en el título basta
          // para saber a dónde ir, que es para lo que sirve un aviso.
          notify("dm:message", who ? `${who} wrote to you` : "New direct message", "");
          break;
        }
        // ── El timbre de la voz ─────────────────────────────────────────
        //
        // Dirigidos a una persona por el servidor, igual que un directo: que
        // lleguen ya significa que son tuyos. Y no pasan por `notify` con un
        // texto cualquiera — la llamada tiene tarjeta propia, y la notificación
        // del sistema es sólo para cuando la ventana no está delante.
        case "voice.ring": {
          const t = parse(data) as unknown as TimbreEntrante | null;
          if (!t?.ringId) break;
          useVoice.getState().alTimbrar(t);
          notify("voice.ring", `${t.from.name} is calling`, `Voice call in #${t.spaceName}`);
          break;
        }
        // La reunión periódica: tarjeta propia con su timbre, como una llamada,
        // y fila en la campana —a diferencia de la llamada— porque el aviso
        // caduca solo y no deja rastro de otra forma.
        case "meeting:reminder": {
          const t = parse(data) as unknown as ReunionEntrante | null;
          if (!t?.meetingId) break;
          useMeetingsStore.getState().alSonar(t);
          notify(
            "meeting:reminder",
            t.title,
            t.spaceName ? `Starting now in #${t.spaceName}` : "Starting now",
          );
          break;
        }
        case "voice.ring.cancel": {
          const c = parse(data) as unknown as { from?: string } | null;
          if (!c?.from) break;
          useVoice.getState().alColgarTimbre(c.from);
          break;
        }
        default:
          break; // `ping` and anything new: proof of life, nothing to do
      }
    };

    // ── Rust-owned stream ────────────────────────────────────────────────────
    if (inTauri) {
      const unlisten: Array<() => void> = [];
      const volvio = vigilanteDeReconexion();
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

            // Rust reconecta solo, y eso bastaba para que el stream volviera
            // a estar vivo — pero lo emitido mientras estaba muerto no se
            // reenvía. Sin esto la reconexión era silenciosa y perfecta salvo
            // por el detalle de que faltaban mensajes.
            if (volvio(s === "open" ? "open" : s === "connecting" ? "connecting" : "down")) {
              refresh();
            }

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
    const volvio = vigilanteDeReconexion();

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
        if (volvio("open")) refresh();
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
        "meeting:reminder",
      ]) {
        es.addEventListener(kind, (e) => {
          seen();
          handle(kind, (e as MessageEvent).data ?? "");
        });
      }

      es.onerror = () => {
        useConnectionStore.getState().setStream("down");
        volvio("down");
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
