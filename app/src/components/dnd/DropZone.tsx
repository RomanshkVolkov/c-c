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
  blocked,
}: {
  id: string;
  className?: string;
  line?: "top" | "bottom";
  nest?: boolean;
  /**
   * A place the thing being dragged cannot go. Drawn in red rather than hidden:
   * a target that simply stops responding reads as a broken drag, while a red
   * one says "not there" and leaves the person to put it back.
   */
  blocked?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={cn("pointer-events-none absolute inset-x-0 z-10", className)}>
      {isOver && line && (
        <div
          className={cn(
            "absolute inset-x-1 h-0.5 rounded",
            blocked ? "bg-destructive" : "bg-primary",
            line === "top" ? "top-0" : "bottom-0",
          )}
        />
      )}
      {isOver && nest && (
        <div
          className={cn(
            "absolute inset-0 rounded ring-1",
            blocked
              ? "bg-destructive/15 ring-destructive/50"
              : "bg-primary/15 ring-primary/40",
          )}
        />
      )}
    </div>
  );
}
