import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A copyable id, shown short.
 *
 * Ids exist so you can hand one to an agent: the MCP tools take a `listId`, a
 * task id or a folio, and reading a UUID off the screen by hand is where a
 * session goes wrong. Truncated on purpose — the point is to copy it, not to
 * read it.
 *
 * `display` separates the two jobs. A folio reads best as "#97" next to the
 * space it belongs to, but what you want on the clipboard is "portento-97",
 * which is the whole name and the thing the MCP tools resolve. Truncating that
 * to fit would leave "portento" — identical on every ticket the client has.
 */
export default function CopyId({
  id,
  label,
  display,
  className,
}: {
  id: string;
  /** What this id refers to, used in the tooltip: "task", "list", "folio"… */
  label: string;
  /** Shown instead of the id itself; the full id is still what gets copied. */
  display?: string;
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
        "font-mono text-xs text-muted-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      {copied ? <Check className="size-2.5" /> : <Copy className="size-2.5" />}
      {display ?? id.slice(0, 8)}
    </button>
  );
}
