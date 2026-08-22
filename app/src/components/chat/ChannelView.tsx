import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Bell, BellOff, ChevronDown, Loader2, Pencil, Plus, Send, Trash2, Volume2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import MarkdownEditor from "@/components/markdown/MarkdownEditor";
import Markdown from "@/components/markdown/Markdown";
import { taskIdFromHref } from "@/components/markdown/card-menu";
import { useConfirm } from "@/components/ConfirmDialog";
import { useChatStore } from "@/store/chat.store";
import { usePeopleStore } from "@/store/people.store";
import { userIdFromHref } from "@/components/markdown/mention-menu";
import type { ChatMessage } from "@/store/chat.store";
import { useAuthStore } from "@/store/auth.store";
import { useOrgsStore } from "@/store/orgs.store";
import { activo } from "@/lib/desde";
import VoiceBar from "@/components/chat/VoiceBar";
import VoiceStage from "@/components/voice/VoiceStage";
import { quienHabla } from "@/components/voice/frase";
import { useVoice } from "@/store/voice.store";
import { useTasksStore } from "@/store/tasks.store";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ItemVisibility } from "@/types/task";

/**
 * The space's channel, beside the board rather than on top of it.
 *
 * A panel and not a tab, because the whole reason to build this instead of
 * using Slack is proximity: you talk about the cards while looking at them. A
 * tab would have made it a worse Slack in a window you have to leave.
 *
 * Known collision, accepted for v1: the task drawer also opens on the right and
 * covers this. Opening a card from the chat therefore hides the chat. Fixing it
 * properly means a two-column right rail, which is a layout change larger than
 * the feature.
 */
export default function ChannelView({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const messages = useChatStore((s) => s.messages);
  const loading = useChatStore((s) => s.loading);
  const hasMore = useChatStore((s) => s.hasMore);
  const loadingOlder = useChatStore((s) => s.loadingOlder);
  const openSpaceId = useChatStore((s) => s.spaceId);
  const fetch = useChatStore((s) => s.fetch);
  const fetchOlder = useChatStore((s) => s.fetchOlder);
  const markRead = useChatStore((s) => s.markRead);
  const post = useChatStore((s) => s.post);
  const following = useChatStore((s) => s.following);
  const fetchFollowing = useChatStore((s) => s.fetchFollowing);
  const setFollowing = useChatStore((s) => s.setFollowing);
  const sigo = following.includes(spaceId);
  // Dos condiciones y no una: se puede estar conectado a esta sala con la
  // pantalla minimizada, y entonces lo que toca ver es el hilo con el botón de
  // volver — no la llamada.
  const enLlamada = useVoice((s) => s.escenario && s.spaceId === spaceId && s.estado !== "fuera");

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // Reads the store at call time — see the `cards` prop on MarkdownEditor.
  const citableCards = useCallback(
    () =>
      (useTasksStore.getState().board?.tasks ?? []).map((t) => ({
        id: t.id,
        seq: t.seq,
        title: t.title,
      })),
    [],
  );
  // Colleagues for the `@` picker, read at trigger time like the cards.
  const fetchPeople = usePeopleStore((s) => s.fetchPeople);
  const people = useCallback(() => usePeopleStore.getState().current(), []);
  useEffect(() => {
    fetchPeople().catch(() => {});
    fetchFollowing().catch(() => {});
  }, [fetchPeople, fetchFollowing]);

  const scroller = useRef<HTMLDivElement>(null);
  // How tall the list was before an older page landed, so the view can stay put.
  const heightBefore = useRef<number | null>(null);

  // Following the space the person navigated to.
  useEffect(() => {
    if (openSpaceId === spaceId) return;
    fetch(spaceId)
      .then(() => markRead(spaceId))
      .catch((e) => toast.error(String(e)));
  }, [spaceId, openSpaceId, fetch, markRead]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (heightBefore.current !== null) {
      // An older page was prepended. Jumping to the bottom here would throw the
      // person back down to the newest message every time they scroll up.
      el.scrollTop = el.scrollHeight - heightBefore.current;
      heightBefore.current = null;
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el || el.scrollTop > 40 || !hasMore || loadingOlder) return;
    heightBefore.current = el.scrollHeight;
    fetchOlder().catch((e) => toast.error(String(e)));
  };

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await post(spaceId, body);
      setDraft("");
    } catch (e) {
      // The draft stays in the box: losing what someone typed because the
      // network blinked is worse than the failure itself.
      toast.error(String(e));
    } finally {
      setSending(false);
    }
  };

  const upload = async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await api.postForm<{ data: { url: string; fileName: string } }>(
        `/api/v1/task-spaces/${spaceId}/chat/attachments`,
        form,
      );
      return { url: res.data.url, fileName: res.data.fileName };
    } catch (e) {
      toast.error(String(e));
      return null;
    }
  };

  // La llamada de *este* canal, abierta. Ocupa el sitio del hilo en vez de
  // flotar encima: una llamada tapada a medias por lo que hay detrás se lee
  // como un diálogo que se puede cerrar sin consecuencias, y colgar no lo es.
  if (enLlamada) return <VoiceStage spaceName={spaceName} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <h2 className="truncate text-sm font-medium">#{spaceName}</h2>
        <QuienAnda />
        <VoiceBar spaceId={spaceId} />
        {/* Salirse de un canal es pedir que lo corriente deje de avisar; las
            menciones llegan igual. Vive aquí y no en preferencias porque es una
            decisión por canal: los que te importan los sabes estando dentro. */}
        <button
          onClick={() => setFollowing(spaceId, !sigo).catch((e) => toast.error(String(e)))}
          title={
            sigo
              ? "You get a notification for every message here"
              : "You left this channel — only mentions notify you here"
          }
          className={cn(
            "ml-auto flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs",
            sigo
              ? "border-primary/40 text-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {sigo ? <Bell className="size-3" /> : <BellOff className="size-3" />}
          {sigo ? "Following" : "Follow"}
        </button>
      </header>

      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto p-3">
        {loadingOlder && (
          <div className="flex justify-center pb-2">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {loading && messages.length === 0 ? (
          <div className="flex justify-center pt-6">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : messages.length === 0 ? (
          <p className="pt-6 text-center text-xs text-muted-foreground">
            Nothing here yet. This channel is only for the team — it never reaches a client.
          </p>
        ) : (
          <div className="space-y-3">
            {messages.map((m, i) => (
              <Message
                key={m.id}
                m={m}
                spaceId={spaceId}
                spaceName={spaceName}
                onUpload={upload}
                cards={citableCards}
                people={people}
                // Consecutive lines from one person read as one turn of speech.
                grouped={i > 0 && messages[i - 1].authorUserId === m.authorUserId}
              />
            ))}
          </div>
        )}
      </div>

      <VozEnCurso spaceId={spaceId} />

      <div className="shrink-0 border-t p-2">
        <MarkdownEditor
          value={draft}
          onChange={setDraft}
          onUpload={upload}
          // The cards of whichever board is open, read when `#` is typed rather
          // than captured now: the composer outlives the board it was mounted
          // beside.
          cards={citableCards}
          people={people}
          minHeight="3rem"
          onSubmit={send}
          // The rule that keeps the four ways of writing in cac apart, said
          // where the decision is actually made rather than in a doc nobody
          // opens. If people don't know where to write, the feature failed.
          placeholder="Message the team — # cites a card, @ names somebody"
        />
        <div className="mt-1 flex justify-end">
          <Button size="sm" onClick={send} disabled={sending || !draft.trim()}>
            {sending ? (
              <Loader2 className="mr-1 size-3 animate-spin" />
            ) : (
              <Send className="mr-1 size-3" />
            )}
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

function Message({
  m,
  spaceId,
  spaceName,
  grouped,
  onUpload,
  cards,
  people,
}: {
  m: ChatMessage;
  spaceId: string;
  spaceName: string;
  grouped: boolean;
  // Editing is composing: the same citation picker and the same image upload,
  // or fixing a typo in a message that has an image would drop it.
  onUpload: (file: File) => Promise<{ url: string; fileName: string } | null>;
  cards: () => { id: string; seq: number; title: string }[];
  people: () => { id: string; username: string }[];
}) {
  const session = useAuthStore((s) => s.session);
  const edit = useChatStore((s) => s.edit);
  const withdraw = useChatStore((s) => s.withdraw);
  const openTask = useTasksStore((s) => s.openTask);
  const confirm = useConfirm();

  /**
   * A cited card opens in the drawer instead of navigating.
   *
   * Returning true claims the click; anything else falls through to the
   * attachment and browser paths Markdown already has, so an ordinary link in a
   * message still behaves like a link.
   */
  const openCited = (href: string) => {
    const id = taskIdFromHref(href);
    if (id) {
      openTask(id).catch((e) => toast.error(String(e)));
      return true;
    }
    // A mention names a person rather than pointing somewhere. Claimed anyway,
    // so the click doesn't fall through to the attachment and browser paths and
    // try to open "cac:user/…" as a file.
    return userIdFromHref(href) !== null;
  };

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.body);
  const [saving, setSaving] = useState(false);

  // Only the author edits or withdraws. A superadmin may too, but the button is
  // not offered — the server allows it for cleanup, the UI doesn't invite it.
  const mine = session?.id === m.authorUserId;
  const edited = m.updatedAt && m.updatedAt !== m.createdAt;

  const save = async () => {
    const body = draft.trim();
    if (!body) return;
    setSaving(true);
    try {
      await edit(spaceId, m.id, body);
      setEditing(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    // Lo propio a la derecha, lo demás a la izquierda: la señal se lee antes
    // que cualquier nombre, que es lo que hace falta en una conversación
    // rápida.
    //
    // Sólo el globo propio se limita en ancho. Partir la columna por la mitad
    // dejaría los mensajes de terceros a media anchura sin ganar nada —son los
    // que más se leen—, así que los ajenos siguen ocupando la línea entera y es
    // el mío el que se aparta.
    <div className={cn("group flex flex-col", mine && "items-end")}>
      {!grouped && (
        <div
          className={cn(
            "mb-0.5 flex items-center gap-2 text-xs text-muted-foreground",
            mine && "flex-row-reverse",
          )}
        >
          <span className={cn("font-medium", mine ? "text-primary" : "text-foreground")}>
            {mine ? "You" : m.authorName || "unknown"}
          </span>
          <span>
            {new Date(m.createdAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          {edited && <span className="italic">edited</span>}
        </div>
      )}
      <div
        className={cn(
          // `pr-7` es el hueco de la flecha. Sin él el texto pasa por debajo y
          // la flecha tapa justo las primeras letras de la línea que ibas a
          // leer; reservarle el sitio es lo que hace que no cubra nada nunca.
          "relative rounded-md py-1 pl-2 pr-7 hover:bg-muted/40",
          grouped && "mt-0.5",
          mine
            ? "max-w-[75%] rounded-tr-sm border border-primary/25 bg-primary/10"
            : "w-full",
        )}
      >
        {editing ? (
          <div className="space-y-2">
            <MarkdownEditor
              value={draft}
              onChange={setDraft}
              onUpload={onUpload}
              cards={cards}
              people={people}
              minHeight="3rem"
              autoFocus
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={save} disabled={saving || !draft.trim()}>
                {saving && <Loader2 className="mr-1 size-3 animate-spin" />}
                Save
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Markdown onInternalLink={openCited}>{m.body}</Markdown>
            {/* Con aire: iban a `px-1` y `gap-1` sobre iconos de 12px, así que
                las tres acciones formaban un solo borrón imposible de acertar.
                Cada botón tiene ahora su propia zona de pulsación. */}
            {/* Una flecha, y las opciones dentro. La barra flotante ponía
                tres iconos de 12px sobre el texto: había que acertarle a uno
                de tres blancos diminutos que además tapaban lo escrito. Una
                sola diana abre una lista con los nombres de las cosas. */}
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Message actions"
                className="absolute right-1 top-1 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100"
              >
                <ChevronDown className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                <MessageToTask body={m.body} spaceId={spaceId} spaceName={spaceName} />
                {mine && (
                  <>
                    <DropdownMenuItem
                      onClick={() => {
                        setDraft(m.body);
                        setEditing(true);
                      }}
                    >
                      <Pencil className="size-4" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Withdraw this message?",
                          description: "It stops showing in the channel for everyone.",
                          confirmText: "Withdraw",
                          destructive: true,
                        });
                        if (!ok) return;
                        withdraw(spaceId, m.id).catch((e) => toast.error(String(e)));
                      }}
                    >
                      <Trash2 className="size-4" />
                      Withdraw
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Turn a message into a card in the list currently open.
 *
 * Deliberately no list picker: the target is the board you are looking at, and
 * the button says so. A picker would be a second tree to navigate inside a
 * 320px panel to save one drag.
 *
 * It goes through the same visibility question the board asks, rather than
 * around it. A message written in an internal channel becoming a card a client
 * can read is exactly the leak this whole feature was designed to make
 * impossible, and skipping the prompt "because chat is internal" would be the
 * one code path that does it.
 */
function MessageToTask({
  body,
  spaceId,
  spaceName,
}: {
  body: string;
  spaceId: string;
  spaceName: string;
}) {
  const activeListId = useTasksStore((s) => s.activeListId);
  const tree = useTasksStore((s) => s.tree);
  const createTask = useTasksStore((s) => s.createTask);
  const confirm = useConfirm();

  // The list has to belong to this space: a card made from #portento's channel
  // landing on a list of another client's board is a mistake with a blast
  // radius, so it is refused rather than warned about.
  const space = tree.find((s) => s.id === spaceId);
  const inThisSpace = Boolean(
    space &&
      activeListId &&
      (space.lists.some((l) => l.id === activeListId) ||
        space.folders.some((f) => f.lists.some((l) => l.id === activeListId))),
  );

  const channelOfList = (() => {
    if (!space || !activeListId) return undefined;
    for (const l of space.lists) if (l.id === activeListId) return l.projectId ?? space.projectId;
    for (const f of space.folders) {
      for (const l of f.lists) if (l.id === activeListId) return l.projectId ?? space.projectId;
    }
    return undefined;
  })();

  const title = firstLine(body);

  return (
    <DropdownMenuItem
      disabled={!inThisSpace}
      title={
        inThisSpace
          ? undefined
          : `Open a list in #${spaceName} to turn messages into tasks`
      }
      onClick={async () => {
        if (!inThisSpace) return;
        let visibility: ItemVisibility | undefined;
        if (channelOfList) {
          const share = await confirm({
            title: "Can the client see this?",
            description:
              "This came from the team's channel, which the client never sees. Making the card " +
              "visible puts its text on their board and takes one of their ticket numbers.",
            confirmText: "Visible to them",
            cancelText: "Internal",
          });
          visibility = share ? "public" : "internal";
        }
        // The whole message becomes the body, not just the title line — the
        // detail is usually in the lines after the first, and a card that
        // dropped them would send people back to the channel to re-read it.
        const description = `${body}\n\n— from the #${spaceName} channel`;
        createTask(title, undefined, visibility, description).catch((e) =>
          toast.error(String(e)),
        );
      }}
    >
      <Plus className="size-4" />
      Create a task
    </DropdownMenuItem>
  );
}

/** A card needs a title, and a message's first line is the closest thing it has. */
function firstLine(body: string): string {
  const line = body.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "Message";
  return line.length > 120 ? line.slice(0, 117) + "…" : line;
}

/**
 * Quién de esta organización anda por aquí.
 *
 * En la cabecera y no junto a cada mensaje: un punto por línea es ruido, y la
 * pregunta que un canal contesta es «¿hay alguien ahora mismo?». Se lee de la
 * misma lista de colegas que ya alimenta el selector de `@`, así que no cuesta
 * ninguna petición nueva.
 *
 * Sale con cuentagotas —tres caras y un contador— porque la cabecera mide 48px
 * y una fila de veinte iniciales tapa el nombre del canal, que es lo que la
 * gente viene a leer.
 */
function QuienAnda() {
  const orgId = useOrgsStore((s) => s.currentOrgId);
  const gente = usePeopleStore((s) => (orgId ? s.byOrg[orgId] : undefined)) ?? [];
  const yo = useAuthStore((s) => s.session?.id);
  const aqui = gente.filter((p) => p.id !== yo && activo(p.lastSeenAt));
  if (aqui.length === 0) return null;

  return (
    <span
      className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
      title={`Active recently: ${aqui.map((p) => p.username).join(", ")}`}
    >
      <span className="size-1.5 rounded-full bg-success" />
      {aqui.slice(0, 3).map((p) => p.username).join(", ")}
      {aqui.length > 3 && ` +${aqui.length - 3}`}
    </span>
  );
}

/**
 * «Están hablando aquí ahora mismo».
 *
 * Pegado al hilo y no sólo en la cabecera porque el hilo es donde está la
 * mirada: se llega a un canal a leer lo que se dijo, y sin este aviso te enteras
 * de la conversación en curso media hora tarde, cuando ya terminó. El botón de
 * la cabecera lo dice también, pero lo dice arriba y en pequeño.
 *
 * Desaparece en cuanto entras: dentro de la llamada, contarte que la llamada
 * existe es ruido.
 */
function VozEnCurso({ spaceId }: { spaceId: string }) {
  const dentro = useVoice((s) => s.ocupacion[spaceId]);
  const enSala = useVoice((s) => s.spaceId);
  const estado = useVoice((s) => s.estado);
  const entrar = useVoice((s) => s.entrar);
  if (!dentro?.length || (enSala === spaceId && estado !== "fuera")) return null;

  const quien = quienHabla(dentro.map((p) => p.name || p.identity));

  return (
    <div className="mx-3 mb-2 flex shrink-0 items-center gap-2.5 rounded-lg border border-dashed border-success/30 bg-success/5 px-3 py-2.5 text-[13px] text-muted-foreground">
      <Volume2 className="size-[15px] shrink-0 text-success" />
      <span className="min-w-0 truncate">{quien} talking in this channel.</span>
      <button
        onClick={() => void entrar(spaceId)}
        className="ml-auto shrink-0 font-semibold text-success hover:underline"
      >
        Join
      </button>
    </div>
  );
}
