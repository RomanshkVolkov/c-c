import { useEffect, useMemo, useState } from "react";
import { Hash, Loader2, Share2, User } from "lucide-react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { docHref } from "@/components/markdown/card-menu";
import { fecha } from "@/lib/fechas";
import { useT, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chat.store";
import { useDMStore } from "@/store/dm.store";
import { useTasksStore } from "@/store/tasks.store";
import type { Doc, DocTabKey } from "@/types/task";

/**
 * Mandar un documento a una conversación.
 *
 * Por defecto **la sección**, no el documento entero. Lo que se pega en un chat
 * es la respuesta a algo concreto que alguien acaba de preguntar; mandar un
 * documento de cuatro pestañas le devuelve la pregunta convertida en tarea de
 * búsqueda. El conmutador está para cuando de verdad quieres decir «léetelo
 * todo», que es la excepción.
 *
 * Se manda como mensaje normal por el canal o el directo, no por una ruta
 * propia: así hereda tal cual los no leídos, los avisos y el hilo. Una ruta de
 * «compartir» en el servidor tendría que reimplementar las tres.
 */

const ROTULOS: Record<DocTabKey, MessageKey> = {
  overview: "work:docs.overview",
  runbook: "work:docs.runbook",
  decisions: "work:docs.decisions",
  links: "work:docs.links",
};

export default function ShareDoc({
  doc,
  nombre,
  tab,
}: {
  doc: Doc;
  nombre: string;
  tab: DocTabKey;
}) {
  const { t } = useT();
  const [abierto, setAbierto] = useState(false);
  const [todo, setTodo] = useState(false);
  const [filtro, setFiltro] = useState("");
  const [enviando, setEnviando] = useState(false);

  const tree = useTasksStore((s) => s.tree);
  const conversations = useDMStore((s) => s.conversations);
  const fetchConversations = useDMStore((s) => s.fetchConversations);
  const postChat = useChatStore((s) => s.post);
  const postDM = useDMStore((s) => s.post);

  useEffect(() => {
    if (abierto) fetchConversations().catch(() => {});
  }, [abierto, fetchConversations]);

  // Canales y directos mezclados en una lista: quien va a compartir piensa en
  // «a quién se lo mando», no en por qué tubería viaja.
  const destinos = useMemo(() => {
    const q = filtro.trim().toLowerCase();
    const canales = tree.map((s) => ({
      key: `c:${s.id}`,
      kind: "channel" as const,
      id: s.id,
      label: s.name,
    }));
    const directos = conversations.map((c) => ({
      key: `d:${c.conversationId}`,
      kind: "dm" as const,
      id: c.conversationId,
      label: c.username,
    }));
    return [...canales, ...directos].filter((d) => !q || d.label.toLowerCase().includes(q));
  }, [tree, conversations, filtro]);

  // El enlace interno que abre el documento dentro de la app.
  const enlace = docHref(doc.ownerKind, doc.ownerId, todo ? undefined : tab);
  const titulo = todo ? nombre : `${nombre} · ${t(ROTULOS[tab])}`;
  const frescura = doc.reviewedAt
    ? t("work:docs.reviewedOn", { date: fecha(doc.reviewedAt) })
    : t("work:docs.neverReviewed");
  const mensaje = `📄 **[${titulo}](${enlace})**\n${frescura}`;

  const mandar = async (d: (typeof destinos)[number]) => {
    setEnviando(true);
    try {
      if (d.kind === "channel") await postChat(d.id, mensaje);
      else await postDM(d.id, mensaje);
      toast.success(t("work:docs.shared", { where: d.label }));
      setAbierto(false);
    } catch (e) {
      toast.error(t("work:docs.errShare"), { description: String(e) });
    } finally {
      setEnviando(false);
    }
  };

  return (
    // Sobre el menú desplegable y no un popover propio: este proyecto no tiene
    // primitiva de popover, y traer una para esto sería una dependencia nueva
    // por una caja de 340px.
    <DropdownMenu open={abierto} onOpenChange={setAbierto}>
      <DropdownMenuTrigger
        render={
          <Button size="sm" variant="ghost" className="h-6 gap-1.5 text-xs">
            <Share2 className="size-3" />
            {t("work:docs.share")}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-[340px] p-2">
        <div className="mb-2 flex rounded-md border p-0.5 text-xs">
          {[false, true].map((v) => (
            <button
              key={String(v)}
              onClick={() => setTodo(v)}
              className={cn(
                "flex-1 rounded px-2 py-1",
                todo === v ? "bg-accent text-foreground" : "text-muted-foreground",
              )}
            >
              {v ? t("work:docs.wholeDoc") : t("work:docs.thisSection")}
            </button>
          ))}
        </div>

        {/* Cómo aterriza, tal cual. Compartir a ciegas es cómo se acaba pegando
            un enlace roto en el canal de un cliente. */}
        <div className="mb-2 rounded-md border bg-muted/40 px-2 py-1.5 text-xs">
          <span className="block font-medium">📄 {titulo}</span>
          <span className="block text-muted-foreground">{frescura}</span>
        </div>

        <Input
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
          placeholder={t("work:docs.whereTo")}
          className="mb-1 h-7 text-xs"
        />
        <div className="max-h-56 overflow-auto">
          {destinos.map((d) => (
            <button
              key={d.key}
              disabled={enviando}
              onClick={() => void mandar(d)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent disabled:opacity-50"
            >
              {d.kind === "channel" ? <Hash className="size-3" /> : <User className="size-3" />}
              <span className="truncate">{d.label}</span>
            </button>
          ))}
          {destinos.length === 0 && (
            <p className="px-2 py-3 text-xs text-muted-foreground">{t("work:docs.noWhere")}</p>
          )}
        </div>
        {enviando && (
          <p className="flex items-center gap-1.5 px-2 pt-1 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> {t("work:docs.save_guardando")}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
