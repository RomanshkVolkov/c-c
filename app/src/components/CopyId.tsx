import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A copyable id, shown short.
 *
 * Ids exist so you can hand one to an agent: the MCP tools take a `listId` or a
 * task id, and reading a UUID off the screen by hand is where a session goes
 * wrong. Truncated on purpose — the point is to copy it, not to read it.
 */
export default function CopyId({
  id,
  label,
  className,
}: {
  id: string;
  /** What this id refers to, used in the tooltip: "task", "list"… */
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard denied: the id is still on screen to select by hand.
    }
  };

  return (
    <button
      onClick={copy}
      title={`Copy ${label} id — ${id}`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5",
        "font-mono text-[0.625rem] text-muted-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      {copied ? <Check className="size-2.5" /> : <Copy className="size-2.5" />}
      {id.slice(0, 8)}
    </button>
  );
}
