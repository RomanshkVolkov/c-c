import { useState } from "react";
import { X } from "lucide-react";

import CallChat from "@/components/voice/CallChat";
import VoiceChat from "@/components/voice/VoiceChat";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

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
  spaceId,
  spaceName,
  onClose,
}: {
  sessionId: string | null;
  spaceId: string | null;
  spaceName: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>(sessionId ? "call" : "channel");
  const shown: Tab = tab === "call" && !sessionId ? "channel" : tab === "channel" && !spaceId ? "call" : tab;
  const tabs: { id: Tab; label: string }[] = [];
  if (sessionId) tabs.push({ id: "call", label: t("chat:callChat") });
  if (spaceId) tabs.push({ id: "channel", label: t("common:last.channelChat") });

  return (
    <aside className="flex w-85 shrink-0 flex-col overflow-hidden rounded-xl border bg-card/95 backdrop-blur">
      <header className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
        <div role="tablist" className="flex min-w-0 items-center gap-1">
          {tabs.map((tb) => (
            <button
              key={tb.id}
              type="button"
              role="tab"
              aria-selected={shown === tb.id}
              onClick={() => setTab(tb.id)}
              className={cn(
                "rounded-md px-2 py-1 text-[13px]",
                shown === tb.id ? "bg-accent font-semibold text-foreground" : "text-muted-foreground hover:text-foreground",
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
          className="ml-auto grid size-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-[15px]" />
        </button>
      </header>
      {shown === "call" && sessionId ? (
        <CallChat sessionId={sessionId} />
      ) : spaceId ? (
        <VoiceChat spaceId={spaceId} spaceName={spaceName} />
      ) : null}
    </aside>
  );
}
