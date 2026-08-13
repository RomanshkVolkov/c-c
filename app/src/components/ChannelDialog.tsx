import { useEffect, useState } from "react";
import { Eye, KeyRound, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import OriginsEditor, { cleanOrigins } from "@/components/OriginsEditor";
import RevealedSecrets, { type Once } from "@/components/RevealedSecrets";
import { useConfirm } from "@/components/ConfirmDialog";
import { useTasksStore, type ChannelOwner } from "@/store/tasks.store";
import { useReportsStore } from "@/store/reports.store";
import type { ReportProject } from "@/types/report";

/**
 * The channel a space or list belongs to: how work from outside gets in, managed
 * where the work lives.
 *
 * Two separate things happen here, and keeping them apart matters. *Binding*
 * says which client a node belongs to. *Configuring* changes how that client's
 * channel behaves — its credential, where its events go, who may post. Before
 * this dialog you could do neither from the tree: the settings lived on a
 * reports screen that is being retired, and the binding could only be set by
 * calling the API by hand.
 *
 * Most of the text here exists to say what a control is about to cost. A select
 * that silently redirects a client's incoming reports, or a rotate button that
 * cuts off their integration mid-sentence, are both one click either way — the
 * difference has to be in what you were told before you clicked.
 */
export default function ChannelDialog({
  kind,
  id,
  name,
  inheritedFrom,
  open,
  onOpenChange,
}: {
  kind: ChannelOwner;
  id: string;
  name: string;
  /** Space this list takes its channel from, when it has none of its own. */
  inheritedFrom?: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const confirm = useConfirm();
  const projects = useReportsStore((s) => s.projects);
  const fetchProjects = useReportsStore((s) => s.fetchProjects);
  const { bindNode, fetchChannel, createChannel, updateChannel, rotateChannelKey } =
    useTasksStore.getState();

  const [loading, setLoading] = useState(true);
  const [channel, setChannel] = useState<ReportProject | null>(null);
  const [bindTo, setBindTo] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState<{ title: string; secrets: Once[] } | null>(null);

  // Editable copy of the channel's rules. The webhook secret is deliberately
  // absent: the server never returns it, and a placeholder would make "leave it
  // alone" look like "here it is".
  const [perHour, setPerHour] = useState("");
  const [perReporter, setPerReporter] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [origins, setOrigins] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setRevealed(null);
    setWebhookSecret("");
    void fetchProjects();
    fetchChannel(kind, id)
      .then((c) => {
        setChannel(c);
        setBindTo(c?.id ?? "");
        setPerHour(String(c?.rateLimitPerHour ?? ""));
        setPerReporter(String(c?.rateLimitPerReporterPerHour ?? ""));
        setWebhookUrl(c?.webhookUrl ?? "");
        setOrigins(c?.allowedOrigins ?? []);
      })
      .catch((e) => toast.error("Couldn't read the channel", { description: String(e) }))
      .finally(() => setLoading(false));
  }, [open, kind, id, fetchChannel, fetchProjects]);

  // A list showing a channel it inherited hasn't been bound to anything itself,
  // so "none" is already its state and clearing it changes nothing visible.
  const inherited = kind === "list" && Boolean(inheritedFrom) && bindTo === channel?.id;

  const bind = async () => {
    setSaving(true);
    try {
      await bindNode(kind, id, name, bindTo);
      const c = await fetchChannel(kind, id);
      setChannel(c);
      toast.success(bindTo ? "Bound to the channel" : "Unbound");
    } catch (e) {
      toast.error("Couldn't change the binding", { description: String(e) });
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await updateChannel(kind, id, {
        name: channel?.name ?? name,
        allowedOrigins: cleanOrigins(origins),
        rateLimitPerHour: Number(perHour) || undefined,
        rateLimitPerReporterPerHour: perReporter === "" ? undefined : Number(perReporter),
        webhookUrl,
        // Passed as typed; the store drops it when empty, so a secret nobody
        // touched can't be cleared from here or from anywhere else.
        webhookSecret,
      });
      setWebhookSecret("");
      toast.success("Channel updated");
    } catch (e) {
      toast.error("Couldn't update the channel", { description: String(e) });
    } finally {
      setSaving(false);
    }
  };

  const open_ = async () => {
    setSaving(true);
    try {
      const out = await createChannel(id, { platform: "app" });
      if (!out) return;
      setChannel(out.project);
      setBindTo(out.project.id);
      setRevealed({
        title: out.project.name,
        secrets: [{ name: "ingest_key", label: "Ingest key", value: out.ingestKey }],
      });
    } catch (e) {
      toast.error("Couldn't open the channel", { description: String(e) });
    } finally {
      setSaving(false);
    }
  };

  const rotate = async () => {
    const ok = await confirm({
      title: `Rotate the key for ${channel?.name}?`,
      description:
        "Anything still using the old key stops working the moment you confirm — their widget, " +
        "their server, whatever posts reports. Nothing warns them.",
      confirmText: "Rotate",
      destructive: true,
    });
    if (!ok) return;
    setSaving(true);
    try {
      const key = await rotateChannelKey(kind, id);
      setRevealed({
        title: channel?.name ?? name,
        secrets: [{ name: "ingest_key", label: "New ingest key", value: key }],
      });
    } catch (e) {
      toast.error("Couldn't rotate the key", { description: String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="size-4" /> Channel · {name}
          </DialogTitle>
          <DialogDescription>
            How work from a client reaches this {kind}, and what they can see of it.
          </DialogDescription>
        </DialogHeader>

        {revealed ? (
          <RevealedSecrets
            title={revealed.title}
            secrets={revealed.secrets}
            onDone={() => setRevealed(null)}
          />
        ) : loading ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Reading…
          </p>
        ) : (
          <div className="space-y-5">
            {/* ── Which client this belongs to ── */}
            <section className="space-y-2">
              <Label>Belongs to</Label>
              <div className="flex items-center gap-2">
                <Select value={bindTo || "none"} onValueChange={(v) => setBindTo(v && v !== "none" ? v : "")}>
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="No client" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No client — internal work</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" onClick={bind} disabled={saving}>
                  Save
                </Button>
              </div>

              {inherited && (
                <p className="text-xs text-muted-foreground">
                  Inherited from <span className="font-medium">{inheritedFrom}</span>. Picking a
                  client here overrides it for this list only.
                </p>
              )}

              {/* The consequence people don't expect from a dropdown. */}
              {kind === "list" && bindTo && (
                <p className="text-xs text-muted-foreground">
                  Reports from this client will land in this list, and work created here will be
                  visible to them unless marked internal.
                </p>
              )}
              {kind === "space" && bindTo && (
                <p className="text-xs text-muted-foreground">
                  Every list under this space inherits the client, so work created in any of them
                  is visible to them by default.
                </p>
              )}
            </section>

            {/* ── The channel's own rules ── */}
            {!channel ? (
              kind === "space" ? (
                <section className="space-y-2 rounded-md border border-dashed p-3">
                  <p className="text-sm">
                    No channel yet. Opening one gives you a key a client's app or widget posts
                    reports with.
                  </p>
                  <Button size="sm" onClick={open_} disabled={saving}>
                    <KeyRound className="mr-1 size-3" /> Open a channel
                  </Button>
                </section>
              ) : (
                <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  This list reaches no channel. Bind it to one above, or open a channel on the
                  space it belongs to — a list inherits, it doesn't own.
                </p>
              )
            ) : (
              <>
                <section className="space-y-3 border-t pt-4">
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-medium">{channel.name}</h4>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{channel.slug}</code>
                  </div>
                  {/* The slug is half of every folio a client quotes, which is why
                      it isn't editable here. */}
                  <p className="text-xs text-muted-foreground">
                    Reports are named <code>{channel.slug}-7</code>, so the slug can't change.
                  </p>

                  {channel.platform === "web" && (
                    <p className="flex items-start gap-1.5 rounded-md bg-warning/10 p-2 text-xs text-warning">
                      <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                      This key ships inside the browser widget, so treat it as public. It can only
                      file reports — it can't read or triage them, by design.
                    </p>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs">Reports per hour</Label>
                      <Input
                        type="number"
                        value={perHour}
                        onChange={(e) => setPerHour(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Per person, per hour</Label>
                      <Input
                        type="number"
                        value={perReporter}
                        onChange={(e) => setPerReporter(e.target.value)}
                      />
                    </div>
                  </div>

                  {channel.platform === "web" && (
                    <OriginsEditor value={origins} onChange={setOrigins} />
                  )}

                  <div className="space-y-1">
                    <Label className="text-xs">Webhook URL</Label>
                    <Input
                      value={webhookUrl}
                      onChange={(e) => setWebhookUrl(e.target.value)}
                      placeholder="https://…"
                    />
                    <p className="text-xs text-muted-foreground">
                      Where their app hears about new reports and replies. Clearing this stops
                      those events — and nothing on their side can tell that they stopped.
                    </p>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">
                      Webhook signing secret
                      {channel.webhookConfigured && (
                        <span className="ml-1 text-muted-foreground">· one is set</span>
                      )}
                    </Label>
                    <Input
                      value={webhookSecret}
                      onChange={(e) => setWebhookSecret(e.target.value)}
                      placeholder="Leave empty to keep the current one"
                    />
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <Button size="sm" onClick={save} disabled={saving}>
                      Save changes
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      onClick={rotate}
                      disabled={saving}
                    >
                      <RefreshCw className="mr-1 size-3" /> Rotate key
                    </Button>
                  </div>
                </section>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
