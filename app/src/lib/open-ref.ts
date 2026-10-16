import { toast } from "sonner";

import { callIdFromHref, docRefFromHref, recordingIdFromHref, taskIdFromHref } from "@/components/markdown/card-menu";
import { userIdFromHref } from "@/components/markdown/mention-menu";
import { matchRepoBlobUrl } from "@/lib/repo-links";
import { useDocPages } from "@/store/doc-pages.store";
import { useRepoDocs } from "@/store/repo-docs.store";
import { useTasksStore } from "@/store/tasks.store";
import { isDocOwnerKind } from "@/types/task";
import { useRouteRequest } from "@/store/route-request.store";

/**
 * Si la pantalla de ahora ya pinta el documento abierto: Documentación
 * (`/docs`) y Trabajo (`/tasks`). Desde cualquier otra —el chat—, abrirlo en la
 * store no se veía.
 */
function onDocScreen(): boolean {
  const path = typeof window === "undefined" ? "" : window.location.pathname.replace(/\/+$/, "");
  return path.endsWith("/docs") || path.endsWith("/tasks");
}

/**
 * Abre dentro de la app un enlace que sólo significa algo aquí dentro: una
 * tarjeta, un documento (o una página suya), una grabación, una mención.
 *
 * Es el `onInternalLink` de `Markdown`. Devolver true reclama el clic; lo demás
 * sigue por las ramas que `Markdown` ya tiene (adjunto, navegador), así que un
 * enlace corriente sigue portándose como un enlace.
 *
 * Vivía dentro de `ChannelView` y sólo lo usaba el chat: un documento pintaba
 * su markdown sin él, y un enlace a otro documento —lo primero que se escribe en
 * una wiki— se iba al navegador del sistema con una URL que fuera de la app no
 * abre nada.
 */
export function openInternalRef(href: string, opts: { onOpenRecordings?: () => void } = {}): boolean {
  const id = taskIdFromHref(href);
  if (id) {
    useTasksStore
      .getState()
      .openTask(id)
      .catch((e) => toast.error(String(e)));
    return true;
  }
  const ref = docRefFromHref(href);
  if (ref && isDocOwnerKind(ref.kind)) {
    const owner = { kind: ref.kind, id: ref.id };
    // La página primero: fija el nodo, y así abrir el documento no la cierra
    // (ver `useDocPages.enter`). Sin página, se vuelve a la portada, en la
    // pestaña que diga el enlace si dice alguna.
    if (ref.page) useDocPages.getState().openPage(owner, ref.page).catch((e) => toast.error(String(e)));
    else if (ref.tab) useDocPages.getState().requestTab(ref.tab);
    else useDocPages.getState().closePage();
    const actual = useTasksStore.getState().activeDoc;
    if (actual?.kind !== ref.kind || actual?.id !== ref.id) {
      useTasksStore
        .getState()
        .openDoc(ref.kind, ref.id, "")
        .catch((e) => toast.error(String(e)));
    }
    // Y a la pantalla donde se ve, si no se está ya en una.
    if (!onDocScreen()) useRouteRequest.getState().request("/docs");
    return true;
  }
  // Un .md en GitHub de un repo de la org (docs as code): se lee en cac, que
  // tiene su copia. Si no está copiado, `openByUrl` lo manda a GitHub igual.
  if (matchRepoBlobUrl(href)) {
    useRepoDocs.getState().openByUrl(href);
    return true;
  }
  // Una grabación se abre en su pestaña, que es donde está el reproductor. Sin
  // quien la abra se reclama igual: dejarlo caer intentaría abrir
  // «cac:recording/…» como si fuera un fichero.
  if (recordingIdFromHref(href)) {
    opts.onOpenRecordings?.();
    return true;
  }
  // Una llamada terminada: su tarjeta ya está en el canal. Se reclama para
  // que no salga al navegador; abrir su chat llega con el chat de la llamada.
  if (callIdFromHref(href)) return true;
  // Una mención nombra a una persona, no apunta a ningún sitio. Se reclama por
  // lo mismo que la grabación.
  return userIdFromHref(href) !== null;
}
