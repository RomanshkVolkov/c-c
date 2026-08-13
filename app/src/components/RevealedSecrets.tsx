import { useEffect, useState } from "react";
import { Check, Copy, Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Showing a secret exactly once, in the one place that knows how.
//
// Lifted out of the report projects dialog unchanged, because a channel is now
// configured from the task tree as well and "this can't be retrieved later"
// deserves one implementation rather than two that drift. The second copy is
// always the one that forgets the warning banner.

/** One secret the server will never show again. */
export interface Once {
  name: string; // also the 1Password field name
  label: string;
  value: string;
}

/** One account+vault pair `op` reported as writable. */
interface OpVault {
  account: string; // sign-in URL — what `op --account` takes
  email: string;
  vault: string;
}

const keyOf = (p: OpVault) => `${p.account}//${p.vault}`;
const labelOf = (p: OpVault) => `${p.vault} · ${p.email}`;

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Everything created with the project that can't be read back: the ingest key
 * (cac stores only a hash) and the webhook secret (never returned).
 *
 * Offering 1Password here rather than "copy and paste it somewhere" is the
 * point — this is the one moment the values exist outside the server, and what
 * people otherwise do is leave them in a scratch file.
 */
export default function RevealedSecrets({
  title,
  secrets,
  onDone,
}: {
  title: string;
  secrets: Once[];
  onDone: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [places, setPlaces] = useState<OpVault[] | null>(null);
  const [placeKey, setPlaceKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [refs, setRefs] = useState<[string, string][] | null>(null);

  // Ask 1Password where it can write. An empty list (no CLI, not signed in,
  // integration off) simply hides the offer — the copy buttons above still work.
  useEffect(() => {
    if (!inTauri) return;
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<OpVault[]>("op_list_vaults"))
      .then((v) => {
        setPlaces(v);
        if (v.length) setPlaceKey(keyOf(v[0]));
      })
      .catch(() => setPlaces([]));
  }, []);

  const copy = async (s: Once) => {
    await navigator.clipboard.writeText(s.value);
    setCopied(s.name);
    toast.success(`${s.label} copied`);
  };

  const saveToOnePassword = async () => {
    const place = (places ?? []).find((p) => keyOf(p) === placeKey);
    if (!place) return;
    setSaving(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const out = await invoke<[string, string][]>("op_item_create", {
        title: `cac · ${title}`,
        account: place.account,
        vault: place.vault,
        fields: secrets.map((s) => [s.name, s.value]),
      });
      setRefs(out);
      toast.success("Saved to 1Password");
    } catch (e) {
      toast.error("Could not save to 1Password", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 space-y-3">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">
          Shown once — these can't be retrieved later, only rotated or replaced.
        </p>
      </div>

      {secrets.map((s) => (
        <div key={s.name} className="space-y-1">
          <Label className="text-xs">{s.label}</Label>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-background px-2 py-1.5 text-xs font-mono break-all">
              {s.value}
            </code>
            <Button size="icon" variant="outline" onClick={() => copy(s)}>
              {copied === s.name ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      ))}

      {refs ? (
        <div className="space-y-1 rounded border bg-background/60 p-2">
          <p className="text-xs font-medium">Saved. Use these references in your deploy config:</p>
          {refs.map(([name, reference]) => (
            <code key={name} className="block text-xs font-mono break-all">
              {reference}
            </code>
          ))}
        </div>
      ) : (
        inTauri &&
        places !== null &&
        places.length > 0 && (
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Save in</Label>
              {/* A list, not a text box: the old default was "Private", which
                  only exists in some accounts — a business one usually has
                  "Employee" and named vaults, so typing it failed at save time. */}
              <Select
                items={Object.fromEntries(places.map((p) => [keyOf(p), labelOf(p)]))}
                value={placeKey}
                onValueChange={(v) => v && setPlaceKey(v)}
              >
                <SelectTrigger size="sm" className="h-8 min-w-56 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {places.map((p) => (
                    <SelectItem key={keyOf(p)} value={keyOf(p)}>
                      {labelOf(p)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button size="sm" variant="secondary" onClick={saveToOnePassword} disabled={saving}>
              <Lock className="h-3.5 w-3.5" /> {saving ? "Saving…" : "Save to 1Password"}
            </Button>
          </div>
        )
      )}

      <Button size="sm" variant="secondary" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

