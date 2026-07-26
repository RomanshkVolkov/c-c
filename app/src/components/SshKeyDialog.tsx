import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, Check, RefreshCw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface SshKeyItem {
  id: string;
  title: string;
  vault: string;
  vaultName: string;
  fingerprint: string;
  reference: string;
}

/**
 * Binds a server to one SSH key from 1Password.
 *
 * Why this exists: an agent that holds many keys offers them one at a time, and
 * the server aborts at MaxAuthTries (6 by default) with "Too many
 * authentication failures" — usually before reaching the right key. Naming the
 * key pins the attempt to exactly one.
 *
 * Nothing is stored on disk: cac keeps only the 1Password *reference* (in the OS
 * keychain) and, at connect time, stages the key's PUBLIC half in a temp file
 * that is deleted right after. The private key never leaves 1Password.
 */
export default function SshKeyDialog({
  serverId,
  serverName,
  open,
  onOpenChange,
}: {
  serverId: string;
  serverName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [keys, setKeys] = useState<SshKeyItem[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [items, saved] = await Promise.all([
        invoke<SshKeyItem[]>("list_1password_ssh_keys"),
        invoke<string | null>("get_server_ssh_key", { serverId }),
      ]);
      setKeys(items);
      setCurrent(saved);
      setSelected(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const save = async () => {
    setSaving(true);
    try {
      await invoke("set_server_ssh_key", { serverId, reference: selected ?? "" });
      toast.success(selected ? "SSH key linked" : "SSH key unlinked");
      onOpenChange(false);
    } catch (e) {
      toast.error("Could not save", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4" /> SSH key for {serverName}
          </DialogTitle>
          <DialogDescription>
            Pick the 1Password key this server uses. cac stores only the reference —
            the private key never leaves 1Password.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive">{error}</p>
            <Button size="sm" variant="outline" onClick={load}>
              <RefreshCw className="size-3 mr-1" /> Retry
            </Button>
          </div>
        ) : loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            <Loader2 className="inline size-4 animate-spin" /> Reading 1Password…
          </p>
        ) : (
          <div className="max-h-80 space-y-1 overflow-auto">
            <button
              className={cn(
                "flex w-full items-center gap-2 rounded-md border p-2 text-left text-sm hover:bg-accent",
                selected === null && "border-primary bg-accent",
              )}
              onClick={() => setSelected(null)}
            >
              <span className="flex-1">
                Let the agent decide
                <span className="block text-[11px] text-muted-foreground">
                  Default. Fails on servers that cut off after a few key attempts.
                </span>
              </span>
              {selected === null && <Check className="size-4" />}
            </button>

            {keys.map((k) => (
              <button
                key={k.id}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md border p-2 text-left text-sm hover:bg-accent",
                  selected === k.reference && "border-primary bg-accent",
                )}
                onClick={() => setSelected(k.reference)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{k.title}</span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">
                    {k.vaultName} · {k.fingerprint}
                  </span>
                </span>
                {selected === k.reference && <Check className="size-4 shrink-0" />}
              </button>
            ))}

            {keys.length === 0 && (
              <p className="py-4 text-center text-xs text-muted-foreground">
                No SSH keys found in 1Password.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || loading || selected === current}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
