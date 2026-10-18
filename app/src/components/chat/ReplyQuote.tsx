import { CornerUpLeft, X } from "lucide-react";
import { toast } from "sonner";

import { useT } from "@/lib/i18n";
import { jumpToMessage, quoteText } from "@/lib/quote";
import { cn } from "@/lib/utils";
import type { MessageQuote } from "@/store/chat.store";

/**
 * La cita encima de una respuesta: de quién era y qué decía, en dos líneas.
 * Pulsarla lleva al mensaje citado, como en WhatsApp.
 *
 * La comparten el canal, los directos y el chat de la llamada: es la misma
 * pregunta —¿a qué contesta esto?— y aprenderla tres veces no tiene sentido.
 */
export function ReplyQuote({ quote, className }: { quote: MessageQuote; className?: string }) {
  const { t } = useT();
  return (
    <button
      type="button"
      onClick={(e) => {
        if (!jumpToMessage(quote.id, e.currentTarget)) toast.message(t("chat:quoteNotLoaded"));
      }}
      className={cn(
        "mb-1 block w-full min-w-0 rounded border-l-2 border-primary/60 bg-muted/60 px-2 py-1 text-left text-xs hover:bg-muted",
        className,
      )}
    >
      {quote.gone ? (
        <span className="italic text-muted-foreground">{t("chat:quoteGone")}</span>
      ) : (
        <>
          <span className="block font-medium text-primary">{quote.authorName || "unknown"}</span>
          <span className="line-clamp-2 break-words text-muted-foreground">{quoteText(quote.body)}</span>
        </>
      )}
    </button>
  );
}

/**
 * Encima del compositor mientras se contesta: a quién y qué, y la X para
 * dejarlo. Sin esto, «Responder» no se ve hasta después de mandar.
 */
export function ReplyingBar({
  authorName,
  body,
  onCancel,
}: {
  authorName: string;
  body: string;
  onCancel: () => void;
}) {
  const { t } = useT();
  return (
    <div className="mb-1 flex items-start gap-2 rounded border-l-2 border-primary/60 bg-muted/60 px-2 py-1 text-xs">
      <CornerUpLeft className="mt-0.5 size-3 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <span className="block font-medium text-primary">{t("chat:replyingTo", { name: authorName })}</span>
        <span className="line-clamp-1 break-words text-muted-foreground">{quoteText(body)}</span>
      </div>
      <button
        type="button"
        onClick={onCancel}
        aria-label={t("chat:cancelReply")}
        className="motion-press shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
