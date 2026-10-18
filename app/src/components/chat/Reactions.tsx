import { SmilePlus } from "lucide-react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/lib/i18n";
import { REACTION_EMOJIS, type Reaction } from "@/lib/reactions";
import { cn } from "@/lib/utils";

/**
 * Las reacciones de un mensaje: una pastilla por emoji con cuántos y, al pasar
 * el ratón, quiénes. La mía va marcada y pulsarla la quita; pulsar la de otro
 * suma la mía.
 *
 * Sin reacciones no ocupa nada: el botón para poner la primera es
 * `ReactionPicker`, que el mensaje enseña al pasar por encima.
 */
export function Reactions({
  reactions,
  onReact,
  align = "start",
  readOnly = false,
}: {
  reactions?: Reaction[];
  onReact: (emoji: string, on: boolean) => Promise<void>;
  align?: "start" | "end";
  /** Se ven, pero no se ponen: el invitado del chat de la llamada (v1). */
  readOnly?: boolean;
}) {
  const { t } = useT();
  if (!reactions?.length) return null;
  const react = (emoji: string, on: boolean) =>
    onReact(emoji, on).catch(() => toast.error(t("chat:reactFailed")));
  return (
    <div className={cn("mt-1 flex flex-wrap items-center gap-1", align === "end" && "justify-end")}>
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          aria-pressed={r.mine}
          title={r.names.join(", ")}
          aria-label={t("chat:reactionCount", { emoji: r.emoji, count: r.count })}
          disabled={readOnly}
          onClick={() => void react(r.emoji, !r.mine)}
          className={cn(
            "motion-press flex h-6 items-center gap-1 rounded-full border px-2 text-xs tabular-nums transition-colors",
            r.mine
              ? "border-primary/50 bg-primary/10 text-foreground"
              : "border-border bg-muted/40 text-muted-foreground hover:bg-muted",
          )}
        >
          <span aria-hidden>{r.emoji}</span>
          {r.count}
        </button>
      ))}
      {!readOnly && <ReactionPicker reactions={reactions} onReact={react} className="h-6 rounded-full border px-1.5" />}
    </div>
  );
}

/**
 * El botón para poner una reacción, con el juego cerrado (`REACTION_EMOJIS`).
 * Un emoji que ya es mío lo quita: el menú dice lo mismo que las pastillas.
 */
export function ReactionPicker({
  reactions,
  onReact,
  className,
}: {
  reactions?: Reaction[];
  onReact: (emoji: string, on: boolean) => Promise<unknown>;
  className?: string;
}) {
  const { t } = useT();
  const mine = new Set((reactions ?? []).filter((r) => r.mine).map((r) => r.emoji));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("chat:react")}
        title={t("chat:react")}
        className={cn(
          "flex items-center text-muted-foreground hover:bg-accent hover:text-foreground",
          className,
        )}
      >
        <SmilePlus className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="flex min-w-0 gap-0.5 p-1">
        {REACTION_EMOJIS.map((e) => (
          <DropdownMenuItem
            key={e}
            aria-label={e}
            onClick={() => void onReact(e, !mine.has(e))}
            className={cn("justify-center px-1.5 text-base", mine.has(e) && "bg-primary/10")}
          >
            {e}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
