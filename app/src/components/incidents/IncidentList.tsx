import { useEffect, useState } from "react";
import { Bot, CircleAlert, CircleCheck, GitCommit, ShieldCheck } from "lucide-react";

import Markdown from "@/components/markdown/Markdown";
import { Badge } from "@/components/ui/badge";
import DisclosureChevron from "@/components/ui/disclosure-chevron";
import { api } from "@/lib/api";
import { fecha } from "@/lib/fechas";
import { useT } from "@/lib/i18n";
import type { APIResponse } from "@/types/auth";
import type { Incident, IncidentList as IncidentListData, IncidentSummary } from "@/types/incident";

/**
 * Lo que ya mordió aquí: los incidentes de un nodo (bajo «Trampas que ya han
 * mordido» de su overview) o de un servidor (en su pantalla).
 *
 * Sólo lectura a propósito: se apuntan con el MCP (`record_incident`), que es
 * donde está el agente que acaba de tropezar. Lo abierto va primero —es lo que
 * todavía puede morder—, y cada uno se despliega con su porqué, sus commits y
 * la prueba que lo guarda (command-and-control-289).
 *
 * Un fallo al pedirlos deja la sección sin pintar: es un extra del documento,
 * no algo que tenga que tumbarlo.
 */
export default function IncidentList({
  node,
  serverId,
  emptyHint = false,
  heading = false,
  className,
}: {
  /** El id del espacio, carpeta o lista del que cuelgan. */
  node?: string;
  /** O los de un servidor. */
  serverId?: string;
  /** Con nada que enseñar, decirlo (la pantalla del servidor) o callar (un overview). */
  emptyHint?: boolean;
  /** Su título encima, sólo si hay algo que enseñar (en un overview). */
  heading?: boolean;
  className?: string;
}) {
  const { t } = useT();
  const [items, setItems] = useState<IncidentSummary[] | null>(null);

  useEffect(() => {
    let alive = true;
    const path = serverId
      ? `/api/v1/servers/${encodeURIComponent(serverId)}/incidents`
      : node
        ? `/api/v1/incidents/?node=${encodeURIComponent(node)}`
        : null;
    if (!path) return;
    // Por una promesa propia: una llamada que revienta en el acto (o un `api`
    // de prueba que no contesta nada) acaba en el `catch`, no tumba el doc.
    void Promise.resolve()
      .then(() => api.get<APIResponse<IncidentListData>>(path, true))
      .then((res) => alive && setItems(res?.success ? (res.data?.incidents ?? []) : []))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [node, serverId]);

  if (!items) return null;
  if (items.length === 0) {
    return emptyHint ? <p className="text-sm text-muted-foreground">{t("work:incidents.none")}</p> : null;
  }
  return (
    <section aria-label={t("work:incidents.title")} className={`space-y-2 ${className ?? ""}`}>
      {heading && <h2 className="mb-2 text-lg font-semibold">{t("work:incidents.title")}</h2>}
      {items.map((i) => (
        <IncidentRow key={i.id} item={i} />
      ))}
    </section>
  );
}

function IncidentRow({ item }: { item: IncidentSummary }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Incident | null>(null);
  const isOpen = item.status === "open";

  const toggle = () => {
    setOpen((v) => !v);
    if (!detail) {
      void Promise.resolve()
        .then(() => api.get<APIResponse<Incident>>(`/api/v1/incidents/${encodeURIComponent(item.id)}`, true))
        .then((res) => res?.success && res.data && setDetail(res.data))
        .catch(() => {});
    }
  };

  return (
    <article data-status={item.status} className="rounded-md border px-3 py-2">
      <button onClick={toggle} aria-expanded={open} className="flex w-full items-start gap-2 text-left">
        <DisclosureChevron open={open} className="mt-0.5 size-4 shrink-0" />
        {isOpen ? (
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
        ) : (
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
        )}
        <span className="min-w-0 flex-1">
          <span className="font-medium">{item.title}</span>
          <span className="mt-1 flex flex-wrap items-center gap-1">
            <Badge variant={isOpen ? "destructive" : "secondary"}>
              {isOpen ? t("work:incidents.open") : t("work:incidents.fixed")}
            </Badge>
            {item.servers.map((s) => (
              <Badge key={s.id} variant="outline">
                {s.name}
              </Badge>
            ))}
            {item.areas.map((a) => (
              <Badge key={a} variant="outline" className="font-mono">
                {a}
              </Badge>
            ))}
            <span className="text-xs text-muted-foreground">{fecha(item.fixedAt ?? item.recordedAt)}</span>
          </span>
        </span>
      </button>
      {open && detail && (
        <div className="mt-2 space-y-2 pl-6 text-sm">
          {detail.body && (
            <div className="prose-doc">
              <Markdown>{detail.body}</Markdown>
            </div>
          )}
          {detail.commits.length > 0 && (
            <ul className="space-y-1">
              {detail.commits.map((c) => (
                <li key={c.sha} className="flex items-center gap-1.5 text-xs">
                  <GitCommit className="size-3 shrink-0" />
                  {c.url ? (
                    <a href={c.url} target="_blank" rel="noreferrer" className="font-mono underline">
                      {c.sha.slice(0, 7)}
                    </a>
                  ) : (
                    <code>{c.sha.slice(0, 7)}</code>
                  )}
                  {c.title && <span className="truncate text-muted-foreground">{c.title}</span>}
                </li>
              ))}
            </ul>
          )}
          {detail.guards.length > 0 && (
            <ul className="space-y-1">
              {detail.guards.map((g) => (
                <li key={g} className="flex items-center gap-1.5 text-xs">
                  <ShieldCheck className="size-3 shrink-0" />
                  <code className="break-all">{g}</code>
                </li>
              ))}
            </ul>
          )}
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {detail.via === "mcp" && <Bot className="size-3" />}
            {t("work:incidents.recordedBy", { who: detail.authorName || "?", when: fecha(detail.createdAt) })}
            {detail.originRef && ` · ${t("work:incidents.fromTask", { ref: detail.originRef })}`}
          </p>
        </div>
      )}
    </article>
  );
}
