import { useEffect } from "react";

import { useAuthStore } from "@/store/auth.store";
import { useChatStore } from "@/store/chat.store";
import { useInboxStore } from "@/store/inbox.store";
import { useOrgsStore } from "@/store/orgs.store";
import { useTasksStore } from "@/store/tasks.store";

/**
 * Lo que la navegación necesita tener cargado desde que entras: el árbol de
 * espacios, el índice de documentos, lo no leído de los canales y la bandeja.
 *
 * Lo pedía `SpacesNavigator` al montarse, y funcionaba porque el árbol estaba
 * siempre en pantalla. Con un panel por módulo ya no: en Documentación o en
 * Comunicación el árbol no está montado, y los dos leen de él (los canales
 * **son** los espacios). Así que lo pide el sidebar, que sí está siempre —en
 * el móvil también, aunque sus hijos no se pinten—, y se vuelve a pedir al
 * cambiar de org: los espacios son de una, y un árbol viejo es el trabajo de
 * otro.
 */
export function useNavData() {
  const authed = useAuthStore((s) => !!s.accessToken);
  const currentOrgId = useOrgsStore((s) => s.currentOrgId);
  const fetchTree = useTasksStore((s) => s.fetchTree);
  const fetchDocIndex = useTasksStore((s) => s.fetchDocIndex);
  const fetchUnread = useChatStore((s) => s.fetchUnread);
  // From the server, not from what this session happened to witness. That is
  // the whole point: the badge means "since you last read it" rather than
  // "since you last launched me".
  const loadInbox = useInboxStore((s) => s.load);

  useEffect(() => {
    if (!authed) return;
    fetchTree();
    fetchDocIndex();
    fetchUnread().catch(() => {});
    loadInbox(currentOrgId).catch(() => {});
  }, [authed, currentOrgId, fetchTree, fetchDocIndex, fetchUnread, loadInbox]);
}
