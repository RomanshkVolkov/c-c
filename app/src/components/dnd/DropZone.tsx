import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";

/**
 * One drop target overlaying part of a row. `line` draws an insertion bar for
 * a reorder; `nest` tints the row to say "this becomes a subpage".
 */
export default function DropZone({
  id,
  className,
  line,
  nest,
}: {
  id: string;
  className?: string;
  line?: "top" | "bottom";
  nest?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={cn("pointer-events-none absolute inset-x-0 z-10", className)}>
      {isOver && line && (
        <div
          className={cn(
            "absolute inset-x-1 h-0.5 rounded bg-primary",
            line === "top" ? "top-0" : "bottom-0",
          )}
        />
      )}
      {isOver && nest && <div className="absolute inset-0 rounded bg-primary/15 ring-1 ring-primary/40" />}
    </div>
  );
}
