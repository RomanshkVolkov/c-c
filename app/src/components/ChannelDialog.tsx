import { Trans } from "react-i18next";

import { useT } from "@/lib/i18n";
import { useEffect, useMemo, useState } from "react";
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
import { rutaDeLista } from "@/lib/bandeja";
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
  const { t } = useT();
  const confirm = useConfirm();
  const projects = useTasksStore((s) => s.channels);
  const fetchProjects = useTasksStore((s) => s.fetchChannels);
  const { bindNode, fetchChannel, createChannel, updateChannel, rotateChannelKey, setChannelInbox } =
    useTasksStore.getState();
  const tree = useTasksStore((s) => s.tree);

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
  /** La integración libre elegida en el desplegable, aún sin apuntar. */
  const [libreElegida, setLibreElegida] = useState("");

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
      .catch((e) => toast.error(t("channel:errRead"), { description: String(e) }))
      .finally(() => setLoading(false));
  }, [open, kind, id, fetchChannel, fetchProjects]);

  // A list showing a channel it inherited hasn't been bound to anything itself,
  // so "none" is already its state and clearing it changes nothing visible.
  const inherited = kind === "list" && Boolean(inheritedFrom) && bindTo === channel?.id;

  // El nombre de la lista donde caen hoy, con su ruta: «Boaty · web · Tasks».
  // Un id crudo no le dice nada a nadie, y es lo que se estaba enseñando.
  const bandeja = useMemo(() => {
    if (!channel?.listId) return null;
    // Puede estar en otra organización o haberse borrado; decirlo es mejor que
    // enseñar un uuid, que es lo que se enseñaba.
    return rutaDeLista(tree, channel.listId) ?? t("channel:outsideOrg");
  }, [channel, tree]);

  /**
   * El cliente al que está atado, cuando no sale en el desplegable.
   *
   * `channels` está recortado a la organización de la pestaña, así que un nodo
   * atado a la de otra —o a una recién borrada— dejaba el `Select` sin opción
   * que casar y pintaba «No client», que es justo lo contrario de lo que pasa.
   */
  const ajeno = channel && !projects.some((p) => p.id === channel.id) ? channel : null;

  /**
   * Quién entrega en esta lista, y quién no entrega en ningún sitio.
   *
   * Son las dos preguntas que no se podían responder: mirando una lista no
   * había forma de saber si algún cliente descargaba ahí, y una integración
   * recién creada no tenía bandeja sin que nadie lo dijera —todo lo que
   * mandara se perdía—. «Libre» es exactamente eso: sin bandeja, no «sin usar».
   */
  const aquiCaen = useMemo(
    () => (kind === "list" ? projects.filter((p) => p.listId === id) : []),
    [kind, id, projects],
  );
  const libres = useMemo(() => projects.filter((p) => !p.listId), [projects]);

  const apuntarAqui = async () => {
    if (!libreElegida) return;
    setSaving(true);
    try {
      await setChannelInbox(libreElegida, id);
      setLibreElegida("");
      setChannel(await fetchChannel(kind, id));
      toast.success(t("channel:okPointed"));
    } catch (e) {
      toast.error(t("channel:errPoint"), { description: String(e) });
    } finally {
      setSaving(false);
    }
  };

  const moverBandeja = async () => {
    if (!channel) return;
    setSaving(true);
    try {
      await setChannelInbox(channel.id, id);
      setChannel(await fetchChannel(kind, id));
      toast.success(t("channel:okMoved"));
    } catch (e) {
      toast.error(t("channel:errMove"), { description: String(e) });
    } finally {
      setSaving(false);
    }
  };

  const bind = async () => {
    setSaving(true);
    try {
      await bindNode(kind, id, name, bindTo);
      const c = await fetchChannel(kind, id);
      setChannel(c);
      toast.success(bindTo ? t("channel:okBound") : t("channel:okUnbound"));
    } catch (e) {
      toast.error(t("channel:errBind"), { description: String(e) });
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
      toast.success(t("channel:okUpdated"));
    } catch (e) {
      toast.error(t("channel:errUpdate"), { description: String(e) });
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
        secrets: [{ name: "ingest_key", label: t("channel:ingestKey"), value: out.ingestKey }],
      });
    } catch (e) {
      toast.error(t("channel:errOpen"), { description: String(e) });
    } finally {
      setSaving(false);
    }
  };

  const rotate = async () => {
    const ok = await confirm({
      title: t("channel:rotateTitle", { name: channel?.name }),
      description: t("channel:rotateWarning"),
      confirmText: t("channel:rotateConfirm"),
      destructive: true,
    });
    if (!ok) return;
    setSaving(true);
    try {
      const key = await rotateChannelKey(kind, id);
      setRevealed({
        title: channel?.name ?? name,
        secrets: [{ name: "ingest_key", label: t("channel:newIngestKey"), value: key }],
      });
    } catch (e) {
      toast.error(t("channel:errRotate"), { description: String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="size-4" /> {t("channel:title", { name })}
          </DialogTitle>
          <DialogDescription>
            {t("channel:subtitle", { kind })}
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
            <Loader2 className="size-4 animate-spin" /> {t("channel:reading")}
          </p>
        ) : (
          <div className="space-y-5">
            {/* ── Which client this belongs to ── */}
            <section className="space-y-2">
              <Label>{t("channel:belongsTo")}</Label>
              <div className="flex items-center gap-2">
                <Select value={bindTo || "none"} onValueChange={(v) => setBindTo(v && v !== "none" ? v : "")}>
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder={t("channel:noClient")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("channel:noClientInternal")}</SelectItem>
                    {ajeno && (
                      <SelectItem value={ajeno.id}>{t("channel:otherOrg", { name: ajeno.name })}</SelectItem>
                    )}
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" onClick={bind} disabled={saving}>
                  {t("channel:save")}
                </Button>
              </div>

              {inherited && (
                <p className="text-xs text-muted-foreground">
                  <Trans
                    t={t}
                    i18nKey="channel:inherited"
                    values={{ from: inheritedFrom }}
                    components={{ 1: <span className="font-medium" /> }}
                  />
                </p>
              )}

              {/* Lo que la gente no espera de un desplegable.
                  Antes esta frase decía que los reportes del cliente caerían en
                  esta lista, y **era falsa**: pertenecer a un cliente y recibir
                  sus reportes son dos cosas distintas, y la segunda vive en el
                  canal. Confundirlas es lo que hacía imposible entender por qué
                  los reportes aparecían en otro sitio. */}
              {kind === "list" && bindTo && (
                <p className="text-xs text-muted-foreground">
                  <Trans t={t} i18nKey="channel:listVisible" components={{ 1: <em /> }} />
                </p>
              )}
              {kind === "space" && bindTo && (
                <p className="text-xs text-muted-foreground">
                  {t("channel:spaceInherits")}
                </p>
              )}
            </section>

            {/* ── Qué cae aquí ──
                En una lista la pregunta es al revés que en una integración: no
                «dónde acaba lo suyo» sino «qué llega a esto que estoy mirando».
                Contestarla aquí es lo que faltaba: se abría este diálogo en la
                lista de un cliente y no se sabía si sus reportes caían dentro. */}
            {kind === "list" && (
              <section className="space-y-2 border-t pt-4">
                <Label>{t("channel:arrivesHere")}</Label>
                {aquiCaen.length > 0 ? (
                  <p className="text-sm">
                    <span className="font-medium">
                      {aquiCaen.map((c) => c.name).join(", ")}
                    </span>{" "}
                    <span className="text-muted-foreground">
                      {/* El verbo concuerda con cuántas integraciones entregan, y
                          eso no es una ese pegada: en castellano «entrega» y
                          «entregan» cambian por dentro. Lo decide el catálogo. */}
                      {t("channel:delivers", { count: aquiCaen.length })}
                    </span>
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("channel:nothingDelivers")}
                  </p>
                )}

                {/* La integración de este cliente entrega en otra parte. Es el
                    caso que desconcierta: la lista es suya y sus reportes
                    aparecen en un sitio distinto. */}
                {channel && channel.listId !== id && (
                  <div className="space-y-2 rounded-md border border-dashed p-3">
                    <p className="text-sm">
                      <span className="font-medium">{channel.name}</span>{" "}
                      {bandeja ? (
                        <>
                          {t("channel:deliversInto")}{" "}
                          <span className="font-medium">{bandeja}</span>.
                        </>
                      ) : (
                        <span className="text-warning">
                          {t("channel:deliversNowhere")}
                        </span>
                      )}
                    </p>
                    <Button size="sm" variant="outline" onClick={moverBandeja} disabled={saving}>
                      {t("channel:sendHereInstead")}
                    </Button>
                  </div>
                )}

                {/* Y las que no entregan en ningún sitio, que es lo que le pasa
                    a una recién creada. Sólo las libres: redirigir la de otro
                    cliente desde aquí sería quitarle su bandeja sin abrir la
                    suya, y eso se hace donde se ve lo que se está quitando. */}
                {libres.length > 0 && (
                  <div className="flex items-center gap-2">
                    <Select value={libreElegida} onValueChange={(v) => setLibreElegida(v ?? "")}>
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder={t("channel:noInboxYet")} />
                      </SelectTrigger>
                      <SelectContent>
                        {libres.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button size="sm" onClick={apuntarAqui} disabled={saving || !libreElegida}>
                      {t("channel:pointItHere")}
                    </Button>
                  </div>
                )}

                {/* Lo que cuesta, antes de pulsar: los reportes que ya están no
                    se mueven, así que el histórico se queda partido en dos. */}
                {(libres.length > 0 || (channel && channel.listId !== id)) && (
                  <p className="text-xs text-muted-foreground">
                    {t("channel:fromNowOn")}
                  </p>
                )}
              </section>
            )}

            {/* En un espacio no hay bandeja que enseñar —no recibe nada— pero sí
                hace falta decir dónde se pone, o se busca aquí y no está. */}
            {kind === "space" && channel && (
              <section className="space-y-1 border-t pt-4">
                <Label>{t("channel:arriveIn")}</Label>
                <p className="text-sm">
                  {bandeja ? (
                    <span className="font-medium">{bandeja}</span>
                  ) : (
                    <span className="text-warning">
                      {t("channel:nowhereLost", { name: channel.name })}
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("channel:spaceIsNotInbox")}
                </p>
              </section>
            )}

            {/* ── The channel's own rules ── */}
            {!channel ? (
              kind === "space" ? (
                <section className="space-y-2 rounded-md border border-dashed p-3">
                  <p className="text-sm">
                    {t("channel:noChannelYet")}
                  </p>
                  <Button size="sm" onClick={open_} disabled={saving}>
                    <KeyRound className="mr-1 size-3" /> {t("channel:openChannel")}
                  </Button>
                </section>
              ) : (
                <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  {t("channel:listReachesNone")}
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
                    <Trans
                      t={t}
                      i18nKey="channel:slugFixed"
                      values={{ example: `${channel.slug}-7` }}
                      components={{ 1: <code /> }}
                    />
                  </p>

                  {channel.platform === "web" && (
                    <p className="flex items-start gap-1.5 rounded-md bg-warning/10 p-2 text-xs text-warning">
                      <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                      {t("channel:widgetKeyPublic")}
                    </p>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs">{t("channel:perHour")}</Label>
                      <Input
                        type="number"
                        value={perHour}
                        onChange={(e) => setPerHour(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t("channel:perReporter")}</Label>
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
                    <Label className="text-xs">{t("channel:webhookUrl")}</Label>
                    <Input
                      value={webhookUrl}
                      onChange={(e) => setWebhookUrl(e.target.value)}
                      placeholder="https://…"
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("channel:webhookHelp")}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">
                      {t("channel:webhookSecret")}
                      {channel.webhookConfigured && (
                        <span className="ml-1 text-muted-foreground">
                          {t("channel:webhookSecretSet")}
                        </span>
                      )}
                    </Label>
                    <Input
                      value={webhookSecret}
                      onChange={(e) => setWebhookSecret(e.target.value)}
                      placeholder={t("channel:webhookSecretKeep")}
                    />
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <Button size="sm" onClick={save} disabled={saving}>
                      {t("channel:saveChanges")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      onClick={rotate}
                      disabled={saving}
                    >
                      <RefreshCw className="mr-1 size-3" /> {t("channel:rotateKey")}
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
