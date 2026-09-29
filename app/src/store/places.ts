import { useAuthStore } from "@/store/auth.store";
import { useDMStore } from "@/store/dm.store";
import { useOrgsStore } from "@/store/orgs.store";
import { placeOf, usePlacesStore } from "@/store/places.store";
import { useTasksStore } from "@/store/tasks.store";

/**
 * Volver a lo que tenías abierto en esta org: su lista y su documento. Lo
 * llama `alCambiarDeOrg` después de cerrar lo de la org anterior. Si la lista
 * ya no existe, `fetchTree` la descarta al llegar el árbol, como siempre.
 */
export function restoreTasksPlace(orgId: string | null) {
  const p = placeOf(orgId);
  const t = useTasksStore.getState();
  if (p.listId) void t.selectList(p.listId).catch(() => {});
  else useTasksStore.setState({ activeListId: null });
  // Después de la lista: seleccionarla cierra el documento. Y no si hay una
  // tarea abierta: es la que te trajo aquí —un enlace a una tarea de esta org—,
  // y abrir un documento la cerraría.
  if (p.doc && !useTasksStore.getState().openTaskId)
    void t.openDoc(p.doc.kind, p.doc.id, p.doc.name).catch(() => {});
}

let instalado = false;

/**
 * Escucha lo que se abre y lo apunta. Se llama una vez al arrancar, desde
 * `main.tsx`.
 *
 * Borrar es la parte delicada: al cambiar de org, `org-switch` **cierra** lo de
 * la anterior, y eso no es «ya no quiero volver ahí». Sólo se borra lo que se
 * cierra estando en su propia org, que es cerrarlo a propósito.
 */
export function installPlaces() {
  if (instalado) return;
  instalado = true;
  const { remember } = usePlacesStore.getState();
  const actual = () => useOrgsStore.getState().currentOrgId;

  useTasksStore.subscribe((s, prev) => {
    const org = actual();
    // La lista es siempre del árbol en pantalla, o sea de la org actual.
    if (org && s.activeListId !== prev.activeListId) remember(org, { listId: s.activeListId ?? undefined });

    // El documento, cuando ya se sabe de quién es: `openDoc` lo sella primero
    // con la org de la pantalla y luego con la que diga el servidor.
    const d = s.activeDoc;
    const cargado = !s.loadingDoc && (prev.loadingDoc || d !== prev.activeDoc);
    if (d && d.orgId && cargado) remember(d.orgId, { doc: { kind: d.kind, id: d.id, name: d.name } });
    const cerrado = prev.activeDoc && !d;
    if (cerrado && prev.activeDoc!.orgId === org) remember(org!, { doc: undefined });
  });

  useDMStore.subscribe((s, prev) => {
    const org = actual();
    if (s.conversationId && s.conversationOrgId && s.conversationId !== prev.conversationId)
      remember(s.conversationOrgId, { dm: s.conversationId });
    const cerrado = prev.conversationId && !s.conversationId;
    if (cerrado && prev.conversationOrgId && prev.conversationOrgId === org)
      remember(prev.conversationOrgId, { dm: undefined });
  });

  // Otra persona en este equipo no hereda dónde estabas tú.
  useAuthStore.subscribe((s, prev) => {
    if (prev.accessToken && !s.accessToken) usePlacesStore.setState({ byOrg: {} });
  });
}
