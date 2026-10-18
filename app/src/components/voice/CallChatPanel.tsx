import TabIndicator from "@/components/ui/tab-indicator";
import { useSlidingIndicator } from "@/lib/use-sliding-indicator";
import { useState } from "react";
import { X } from "lucide-react";

import CallChat from "@/components/voice/CallChat";
import VoiceChat from "@/components/voice/VoiceChat";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { GuestChatPass } from "@/store/call-chat.store";

type Tab = "call" | "channel";

/**
 * El panel de chat de la llamada, con dos pestañas: «Llamada» (lo que se queda
 * con la llamada) y «Canal» (el hilo del canal). Ver `VoiceChat` para el
 * porqué.
 *
 * Sin llamada guardada (`sessionId` nulo: el servidor no la abrió, o una app
 * recargada a media llamada) queda sólo «Canal», que es como era. Sin canal
 * (una reunión suelta) queda sólo «Llamada». Empieza en «Llamada»: es la de la
 * gente que está contigo.
 */
export default function CallChatPanel({
  sessionId,
  guest = null,
  spaceId,
  spaceName,
  onClose,
}: {
  sessionId: string | null;
  /** El invitado: entra al chat de la llamada con su enlace y su pase. */
  guest?: GuestChatPass | null;
  spaceId: string | null;
  spaceName: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const hasCall = !!sessionId || !!guest;
  const [tab, setTab] = useState<Tab>(hasCall ? "call" : "channel");
  const shown: Tab = tab === "call" && !hasCall ? "channel" : tab === "channel" && !spaceId ? "call" : tab;
  const tabBar = useSlidingIndicator<HTMLDivElement>(shown);
  const tabs: { id: Tab; label: string }[] = [];
  if (hasCall) tabs.push({ id: "call", label: t("chat:callChat") });
  if (spaceId) tabs.push({ id: "channel", label: t("common:last.channelChat") });

  return (
    <aside className="flex w-85 shrink-0 flex-col overflow-hidden rounded-xl border bg-card/95 backdrop-blur">
      <header className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
        <div ref={tabBar.ref} role="tablist" className="relative flex min-w-0 items-center gap-1">
          <TabIndicator rect={tabBar.rect} first={tabBar.first} variant="pill" />
          {tabs.map((tb) => (
            <button
              key={tb.id}
              type="button"
              role="tab"
              aria-selected={shown === tb.id}
              onClick={() => setTab(tb.id)}
              className={cn(
                "motion-press relative rounded-md px-2 py-1 text-[13px]",
                shown === tb.id
                  ? cn("font-semibold text-foreground", !tabBar.rect && "bg-accent")
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tb.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common:last.hideChat")}
          className="motion-press ml-auto grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-[15px]" />
        </button>
      </header>
      {shown === "call" && hasCall ? (
        <CallChat sessionId={sessionId} guest={guest} />
      ) : spaceId ? (
        <VoiceChat spaceId={spaceId} spaceName={spaceName} />
      ) : null}
    </aside>
  );
}
