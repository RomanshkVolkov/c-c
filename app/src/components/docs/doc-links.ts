import i18next from "i18next";

import { docHref } from "@/components/markdown/card-menu";
import type { DocLinkRef } from "@/components/markdown/page-menu";
import { api } from "@/lib/api";
import type { MessageKey } from "@/lib/i18n";
import { useDocPages } from "@/store/doc-pages.store";
import { useOrgsStore } from "@/store/orgs.store";
import { useTasksStore } from "@/store/tasks.store";
import type { APIResponse } from "@/types/auth";
import type { DocPageTreeItem } from "@/types/task";

/**
 * De dónde saca `[[` lo que ofrece.
 *
 * Primero las páginas del documento abierto, que ya están en memoria y son las
 * que más se enlazan (la hermana, la madre). Después, a partir de dos letras,
 * la documentación de toda la organización por la búsqueda (`/search`): quien
 * escribe en una wiki no tiene por qué saber en qué nodo vive cada página.
 *
 * Si la búsqueda falla o tarda, se queda con las de aquí: un menú que no
 * contesta es peor que uno que contesta con menos.
 */

/** Sin mayúsculas ni acentos: «configuracion» encuentra «Configuración». */
function plano(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function ruta(tree: DocPageTreeItem[], p: DocPageTreeItem, nodo: string): string {
  const madres: string[] = [];
  const porId = new Map(tree.map((x) => [x.id, x]));
  for (let m = p.parentId ? porId.get(p.parentId) : undefined; m; m = m.parentId ? porId.get(m.parentId) : undefined) {
    madres.unshift(m.title || i18next.t("work:docs.untitled"));
  }
  return [nodo, ...madres].filter(Boolean).join(" › ");
}

interface SearchHit {
  title: string;
  where?: string;
  link: string;
  tab?: string;
}

export async function docLinks(query: string): Promise<DocLinkRef[]> {
  const { owner, tree, activePageId } = useDocPages.getState();
  const nodo = useTasksStore.getState().activeDoc?.name ?? "";
  const q = plano(query.trim());

  const aqui: DocLinkRef[] = owner
    ? tree
        .filter((p) => p.id !== activePageId && (!q || plano(p.title).includes(q)))
        .map((p) => ({
          href: docHref(owner.kind, owner.id, undefined, p.id),
          title: p.title || i18next.t("work:docs.untitled"),
          where: ruta(tree, p, nodo),
        }))
    : [];
  if (q.length < 2) return aqui;

  let fuera: DocLinkRef[] = [];
  try {
    const orgId = useOrgsStore.getState().currentOrgId;
    const org = orgId ? `orgId=${orgId}&` : "";
    const res = await api.get<APIResponse<{ docs?: SearchHit[] }>>(
      `/api/v1/search/?${org}q=${encodeURIComponent(query.trim())}`,
      true,
    );
    fuera = (res.data?.docs ?? []).map((h) =>
      h.tab
        ? // Una pestaña de una portada: el nodo y el nombre de la pestaña.
          { href: h.link, title: `${h.title} · ${i18next.t(`work:docs.${h.tab}` as MessageKey)}` }
        : { href: h.link, title: h.title, where: h.where },
    );
  } catch {
    // Ver arriba: sin la búsqueda, lo de aquí.
  }
  const vistos = new Set(aqui.map((x) => x.href));
  return [...aqui, ...fuera.filter((x) => !vistos.has(x.href))];
}
