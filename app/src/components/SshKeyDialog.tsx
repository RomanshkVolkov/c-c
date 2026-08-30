import { useT } from "@/lib/i18n";
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

interface SshAgent {
  socket: string;
  label: string;
  keyCount: number;
  /** "ok" · "empty" (answers but holds nothing) · "refused" (socket dead). */
  status: "ok" | "empty" | "refused";
}

interface SshKeyItem {
  /** Full public key line — what gets pinned with ssh -i. */
  publicKey: string;
  /** Agent comment; for 1Password keys this is the item title. */
  title: string;
  fingerprint: string;
  keyType: string;
}

/**
 * Binds a server to one key held by the SSH agent (1Password's, typically).
 *
 * Why this exists: an agent holding many keys offers them one at a time, and the
 * server aborts at MaxAuthTries (6 by default) with "Too many authentication
 * failures" — usually before reaching the right key. Naming the key pins the
 * attempt to exactly one.
 *
 * Deliberately reads the agent rather than the `op` CLI: 1Password's CLI
 * validates the process that launches it and refuses from a GUI app
 * ("connecting to desktop app: connection reset"), while the agent socket works
 * — it's the same one ssh already uses. cac stores only the PUBLIC key (OS
 * keychain); the private half never leaves the agent.
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
  const { t } = useT();
  const [agents, setAgents] = useState<SshAgent[]>([]);
  const [agent, setAgent] = useState<string | null>(null);
  const [keys, setKeys] = useState<SshKeyItem[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    async (socket?: string | null) => {
      setLoading(true);
      setError(null);
      try {
        // Which agents this machine has is a separate question from which keys
        // one holds: a laptop can run 1Password's agent and the system one at
        // the same time, each with different keys.
        const found = await invoke<SshAgent[]>("list_ssh_agents");
        setAgents(found);
        const pick =
          socket ?? found.find((a) => a.status === "ok")?.socket ?? found[0]?.socket ?? null;
        setAgent(pick);

        const [items, saved] = await Promise.all([
          invoke<SshKeyItem[]>("list_agent_ssh_keys", { socket: pick }),
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
    },
    [serverId],
  );

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const save = async () => {
    setSaving(true);
    try {
      await invoke("set_server_ssh_key", { serverId, publicKey: selected ?? "" });
      toast.success(selected ? t("common:misc.sshLinked") : t("common:misc.sshUnlinked"));
      onOpenChange(false);
    } catch (e) {
      toast.error(t("common:misc.errSave"), { description: e instanceof Error ? e.message : String(e) });
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
            {t("common:misc.sshLead")}
            (1Password exposes its vault keys here). The private key never leaves
            the agent — cac only remembers which one to offer.
          </DialogDescription>
        </DialogHeader>

        {agents.length > 1 && (
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("common:misc.agent")}</p>
            <div className="flex flex-wrap gap-1">
              {agents.map((a) => (
                <button
                  key={a.socket}
                  title={a.socket}
                  onClick={() => load(a.socket)}
                  className={cn(
                    "rounded-md border px-2 py-1 text-xs",
                    agent === a.socket ? "border-primary bg-accent" : "hover:bg-accent",
                    a.status === "refused" && "opacity-60",
                  )}
                >
                  {a.label}
                  <span className="ml-1 text-muted-foreground">
                    {a.status === "refused" ? "· not running" : `· ${a.keyCount} keys`}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {error ? (
          <div className="space-y-2">
            {/* The message names the sockets that were tried, so it needs the
                line breaks it was written with. */}
            <p className="whitespace-pre-wrap text-sm text-destructive">{error}</p>
            <Button size="sm" variant="outline" onClick={() => load(agent)}>
              <RefreshCw className="size-3 mr-1" /> Retry
            </Button>
          </div>
        ) : loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            <Loader2 className="inline size-4 animate-spin" /> Reading SSH agent…
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
                {t("common:misc.letAgentDecide")}
                <span className="block text-xs text-muted-foreground">
                  Default. Fails on servers that cut off after a few key attempts.
                </span>
              </span>
              {selected === null && <Check className="size-4" />}
            </button>

            {keys.map((k) => (
              <button
                key={k.fingerprint || k.publicKey}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md border p-2 text-left text-sm hover:bg-accent",
                  selected === k.publicKey && "border-primary bg-accent",
                )}
                onClick={() => setSelected(k.publicKey)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{k.title}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {k.keyType} · {k.fingerprint}
                  </span>
                </span>
                {selected === k.publicKey && <Check className="size-4 shrink-0" />}
              </button>
            ))}

            {keys.length === 0 && (
              <p className="py-4 text-center text-xs text-muted-foreground">
                This agent holds no keys. If it's 1Password, unlock it — a locked
                vault answers but offers nothing.
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
