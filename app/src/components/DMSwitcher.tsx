import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Search } from "lucide-react";
import { useDMStore } from "@/store/dm.store";
import PresenceDot from "@/components/PresenceDot";
import { usePeopleStore } from "@/store/people.store";
import { useOrgsStore } from "@/store/orgs.store";
import { useAuthStore } from "@/store/auth.store";

/**
 * Who to talk to: the conversations you already have, and the colleagues you
 * don't yet.
 *
 * One list rather than two screens, because "message Ana" is the same intent
 * whether or not a thread exists — the server treats opening as idempotent for
 * exactly that reason, so naming somebody twice never makes a second thread.
 *
 * Only people of the organization on screen appear, and that is enforced on the
 * server as well: the search refuses an organization you don't belong to, and
 * opening a conversation re-checks that you actually share it.
 */
export default function DMSwitcher({ onPicked }: { onPicked: () => void }) {
  const conversations = useDMStore((s) => s.conversations);
  const fetchConversations = useDMStore((s) => s.fetchConversations);
  const openConversation = useDMStore((s) => s.open);
  const openWith = useDMStore((s) => s.openWith);
  // Selected as a stable slice rather than through `current()`: a selector must
  // return the same reference when nothing changed, and a derived array never
  // does. `byOrg[orgId]` is that reference — the `?? []` happens out here.
  const orgId = useOrgsStore((s) => s.currentOrgId);
  const people = usePeopleStore((s) => (orgId ? s.byOrg[orgId] : undefined)) ?? [];
  const fetchPeople = usePeopleStore((s) => s.fetchPeople);

  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  // Depende de `orgId`. Antes dependía sólo de las dos acciones, que en zustand
  // nunca cambian de identidad: al cambiar de organización no se volvía a pedir
  // nada, y la única forma de ver a los colegas de la nueva era recargar la app
  // a mano. Ese era el «click derecho y reload» del reporte.
  const previa = useRef<string | null>(null);
  useEffect(() => {
    if (!orgId) return;
    fetchConversations().catch(() => {});
    fetchPeople(orgId).catch(() => {});
    // Y el hilo abierto se cierra, porque pertenece a la organización que
    // acabas de dejar. Sólo cuando de verdad cambió: volver a esta pantalla
    // desde otra remonta el componente, y cerrar el hilo ahí sería perder de
    // vista una conversación que nadie pidió cerrar.
    if (previa.current && previa.current !== orgId) {
      useDMStore.setState({ conversationId: null, messages: [] });
    }
    previa.current = orgId;
  }, [orgId, fetchConversations, fetchPeople]);

  const term = q.trim().toLowerCase();
  // Sólo las de esta organización. El endpoint devuelve las de todas —una
  // consulta por organización para pintar una lista sería absurdo—, así que
  // quedarse con las de aquí es trabajo de esta pantalla, y no hacerlo mezclaba
  // en la misma columna gente de dos clientes distintos.
  const delOrg = conversations.filter((c) => c.orgId === orgId);
  const threads = delOrg.filter((c) => !term || c.username.toLowerCase().includes(term));
  // Somebody you already have a thread with belongs in the first list, not
  // twice: the row that carries their unread count is the useful one.
  //
  // Del mismo `delOrg` y no de todas: con un hilo abierto con alguien en otra
  // organización, mirarlo entero lo escondía también de aquí — ni arriba, por
  // no ser de esta org, ni abajo, por «ya tener hilo».
  const withThread = new Set(delOrg.map((c) => c.userId));
  // Yourself is left out here rather than by the endpoint. The list answers
  // "who is in this organization", and you are — but opening a conversation
  // with yourself is refused at the door, so offering it would be proposing
  // something impossible. The assignee picker, which reads the same list, needs
  // you in it: assigning work to yourself is the commonest assignment there is.
  const yo = useAuthStore((s) => s.session?.id);
  const fresh = people.filter(
    (p) =>
      p.id !== yo &&
      !withThread.has(p.id) &&
      (!term || p.username.toLowerCase().includes(term)),
  );

  const start = async (userId: string) => {
    if (!orgId || busy) return;
    setBusy(true);
    try {
      await openWith(orgId, userId);
      onPicked();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-h-64 shrink-0 overflow-y-auto border-b bg-muted/20 p-2">
      <div className="mb-2 flex items-center gap-1.5 rounded border bg-background px-2">
        <Search className="size-3 shrink-0 text-muted-foreground" />
        <input
          className="h-7 w-full bg-transparent text-xs outline-none"
          placeholder="Find somebody"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        {busy && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
      </div>

      {threads.length > 0 && (
        <ul className="mb-2 space-y-0.5">
          {threads.map((c) => (
            <li key={c.conversationId}>
              <button
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent"
                onClick={() => {
                  openConversation(c.conversationId)
                    .then(onPicked)
                    .catch((e) => toast.error(String(e)));
                }}
              >
                <PresenceDot lastSeenAt={c.lastSeenAt} />
                <span className="truncate">{c.username}</span>
                {c.unread > 0 && (
                  <span className="ml-auto rounded-full bg-primary px-1 text-[10px] font-medium leading-4 text-primary-foreground">
                    {c.unread > 99 ? "99+" : c.unread}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {fresh.length > 0 && (
        <>
          <p className="px-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            Start a conversation
          </p>
          <ul className="space-y-0.5">
            {fresh.map((p) => (
              <li key={p.id}>
                <button
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent"
                  onClick={() => start(p.id)}
                >
                  <PresenceDot lastSeenAt={p.lastSeenAt} />
                  <span className="truncate">{p.username}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {threads.length === 0 && fresh.length === 0 && (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          Nobody else in this organization yet.
        </p>
      )}
    </div>
  );
}
