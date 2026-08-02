import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * OriginsEditor edits a list of allowed CORS origins as individual rows (add /
 * remove), instead of a freeform textarea. Empty rows are allowed while editing
 * and filtered out by the caller on save.
 */
export default function OriginsEditor({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const rows = value.length ? value : [""];

  const setAt = (i: number, v: string) => {
    const next = [...rows];
    next[i] = v;
    onChange(next);
  };
  const removeAt = (i: number) => onChange(rows.filter((_, j) => j !== i));
  const add = () => onChange([...rows, ""]);

  return (
    <div className="space-y-1.5">
      <Label>Allowed origins (empty = allow any)</Label>
      {/* Spelled out because the rule bites the case nobody pictures: once one
          origin is listed, a request that sends no Origin header at all — a
          curl replaying the key someone read out of the widget — is refused
          too, not waved through for lacking a browser. Only shown for browser
          projects; a native one is exempt from this entirely. */}
      <p className="text-[11px] text-muted-foreground">
        List one and it becomes the only way in: requests from another origin, and
        requests that send no origin at all, are both refused. Leave it empty to
        accept the widget from anywhere.
      </p>
      <div className="space-y-2">
        {rows.map((origin, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={origin}
              onChange={(e) => setAt(i, e.target.value)}
              placeholder="https://app.cliente.mx"
              className="font-mono text-xs"
            />
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="shrink-0 text-muted-foreground"
              onClick={() => removeAt(i)}
              aria-label="Remove origin"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
      <Button type="button" size="sm" variant="ghost" className="gap-1 text-xs" onClick={add}>
        <Plus className="h-3.5 w-3.5" /> Add origin
      </Button>
    </div>
  );
}

/** Trim + drop blanks; the shape the API expects. */
export function cleanOrigins(list: string[]): string[] {
  return list.map((s) => s.trim()).filter(Boolean);
}
