import { useMemo } from "react";

import { channelUnreadIn, dmUnreadIn } from "@/lib/unread";
import { useChatStore } from "@/store/chat.store";
import { useDMStore } from "@/store/dm.store";
import { useOrgsStore } from "@/store/orgs.store";
import { useTasksStore } from "@/store/tasks.store";

/**
 * Cuántos sin leer hay en canales y en directos, **sólo de la org en
 * pantalla** (ver `lib/unread.ts`). Lo leen la barra lateral, el menú inferior
 * del móvil y su selector «Canales | Directos»: los tres tienen que dar el
 * mismo número.
 */
export function useCommsUnread(): { channels: number; dms: number } {
  const currentOrgId = useOrgsStore((s) => s.currentOrgId);
  const tree = useTasksStore((s) => s.tree);
  const espacios = useMemo(() => new Set(tree.map((sp) => sp.id)), [tree]);
  const channels = useChatStore((s) => channelUnreadIn(s.unreadBySpace, espacios));
  const dms = useDMStore((s) => dmUnreadIn(s.conversations, currentOrgId));
  return { channels, dms };
}
