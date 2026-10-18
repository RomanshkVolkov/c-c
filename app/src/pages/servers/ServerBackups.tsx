import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Archive, Download, FlaskConical, KeyRound, Pencil, Play, Plus, Trash2 } from "lucide-react";

import { useConfirm } from "@/components/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Picker from "@/components/ui/picker";
import { HelpTip } from "@/components/ui/help-tip";
import { defaultTarget, detectDatabases, isAgePublicKey, payloadOf, retainedCount, type DetectedDatabase } from "@/lib/backups";
import { desde } from "@/lib/desde";
import { fechaYHora } from "@/lib/fechas";
import { useT } from "@/lib/i18n";
import { phraseFor } from "@/lib/server-errors";
import { formatBytes } from "@/lib/utils";
import { isTauri } from "@/lib/platform";
import { useServerContext } from "@/pages/servers/ServerLayout";
import { useBackupsStore } from "@/store/backups.store";
import type { Backup, BackupStatus, BackupTarget, BackupTargetPayload } from "@/types/backups";

/**
 * «Backups» (#166): las bases de este servidor que se respaldan, su historial
 * y las llaves para las que se cifran.
 *
 * El backup lo hace el agente dentro del contenedor de la base, lo cifra con
 * age y lo sube al bucket con Object Lock: aquí se configura y se mira. Lo
 * que se descarga va **cifrado**; se abre con la llave privada, que no está en
 * cac.
 */
const VARIANT: Record<BackupStatus, "default" | "secondary" | "destructive" | "outline"> = {
  queued: "outline",
  running: "secondary",
  succeeded: "default",
  failed: "destructive",
};

const EMPTY_TARGETS: BackupTarget[] = [];
const EMPTY_HISTORY: Backup[] = [];

export default function ServerBackups() {
  const { t } = useT();
  const { server, swarm } = useServerContext();
  const confirm = useConfirm();
  const store = useBackupsStore;
  const status = useBackupsStore((s) => s.status[server.id]);
  const targets = useBackupsStore((s) => s.targets[server.id]) ?? EMPTY_TARGETS;
  const recipients = useBackupsStore((s) => s.recipients[server.id]);
  const [editing, setEditing] = useState<{ id?: string; payload: BackupTargetPayload } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    store.getState().load(server.id).catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [server.id, store]);

  const detected = useMemo(() => detectDatabases(swarm.services, targets), [swarm.services, targets]);

  const withError = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(phraseFor(msg, msg));
    }
  };

  const open = (d: DetectedDatabase | null) => setEditing({ payload: defaultTarget(d) });

  if (loadError) {
    return <p className="mx-auto max-w-4xl text-sm text-destructive">{phraseFor(loadError, loadError)}</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-4xl shrink-0 items-center gap-3 pb-3">
        <Archive className="size-5 text-muted-foreground" />
        <h1 className="flex-1 text-lg font-semibold">{t("common:backups.title")}</h1>
        <Button size="sm" onClick={() => open(detected[0] ?? null)} disabled={!status?.enabled || !status?.hasRecipients}>
          <Plus className="size-4" /> {t("common:backups.add")}
        </Button>
      </header>

      <div className="mx-auto min-h-0 w-full max-w-4xl flex-1 space-y-4 overflow-y-auto">
        <p className="text-sm text-muted-foreground">{t("common:backups.lead")}</p>

        {status && !status.enabled && <Notice tone="warn">{t("common:backups.disabled")}</Notice>}
        {status?.enabled && !status.agentReady && (
          <Notice tone="warn">{t("common:backups.agentOld", { version: status.agentVersion, min: status.minAgent })}</Notice>
        )}

        <Recipients serverId={server.id} onError={withError} />

        {status?.hasRecipients && detected.length > 0 && (
          <section className="space-y-2 rounded-md border p-3">
            <h2 className="text-sm font-medium">{t("common:backups.detected")}</h2>
            <ul className="space-y-1">
              {detected.map((d) => (
                <li key={d.serviceName} className="flex items-center gap-2 text-sm">
                  <Badge variant="outline">{t(`common:backups.engine.${d.engine}`)}</Badge>
                  <span className="flex-1 font-mono text-xs">{d.serviceName}</span>
                  <Button size="sm" variant="ghost" onClick={() => open(d)}>
                    {t("common:backups.configure")}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {targets.length === 0 && recipients !== undefined && (
          <p className="text-sm text-muted-foreground">{t("common:backups.empty")}</p>
        )}

        {targets.map((tg) => (
          <TargetCard
            key={tg.id}
            serverId={server.id}
            target={tg}
            onEdit={() => setEditing({ id: tg.id, payload: payloadOf(tg) })}
            onDelete={async () => {
              const ok = await confirm({
                title: t("common:backups.deleteTitle", { db: tg.database }),
                description: t("common:backups.deleteBody"),
                confirmText: t("common:backups.delete"),
                destructive: true,
              });
              if (ok) await withError(() => store.getState().deleteTarget(server.id, tg.id));
            }}
            onError={withError}
          />
        ))}
      </div>

      {editing && (
        <TargetDialog
          everyHours={status?.everyHours ?? [24]}
          services={swarm.services.map((s) => s.name)}
          initial={editing.payload}
          isNew={!editing.id}
          onClose={() => setEditing(null)}
          onSave={(p) =>
            withError(async () => {
              await store.getState().saveTarget(server.id, p, editing.id);
              setEditing(null);
              toast.success(t("common:backups.saved"));
            })
          }
        />
      )}
    </div>
  );
}

function Notice({ tone, children }: { tone: "warn"; children: React.ReactNode }) {
  return (
    <p className={tone === "warn" ? "rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm" : ""}>{children}</p>
  );
}

/** Las llaves públicas para las que se cifran los backups de la organización. */
function Recipients({ serverId, onError }: { serverId: string; onError: (fn: () => Promise<unknown>) => Promise<void> }) {
  const { t } = useT();
  const confirm = useConfirm();
  const recipients = useBackupsStore((s) => s.recipients[serverId]);
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [creating, setCreating] = useState(false);
  const valid = isAgePublicKey(key) && label.trim() !== "";

  return (
    <section className="space-y-2 rounded-md border p-3">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <KeyRound className="size-4 text-muted-foreground" /> {t("common:backups.recipients")}
      </h2>
      <p className="text-xs text-muted-foreground">{t("common:backups.recipientsLead")}</p>
      <ul className="space-y-1">
        {(recipients ?? []).map((r) => (
          <li key={r.id} className="flex items-center gap-2 text-sm">
            <span className="font-medium">{r.label}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{r.publicKey}</span>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("common:backups.removeKey")}
              onClick={async () => {
                const ok = await confirm({
                  title: t("common:backups.removeKeyTitle", { label: r.label }),
                  description: t("common:backups.removeKeyBody"),
                  confirmText: t("common:backups.removeKey"),
                  destructive: true,
                });
                if (ok) await onError(() => useBackupsStore.getState().deleteRecipient(serverId, r.id));
              }}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-40 space-y-1">
          <Label htmlFor="bk-label">{t("common:backups.keyLabel")}</Label>
          <Input id="bk-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="jose" />
        </div>
        <div className="min-w-64 flex-1 space-y-1">
          <Label htmlFor="bk-key">{t("common:backups.keyValue")}</Label>
          <Input id="bk-key" className="font-mono text-xs" value={key} onChange={(e) => setKey(e.target.value)} placeholder="age1…" />
        </div>
        <Button
          size="sm"
          disabled={!valid}
          onClick={() =>
            onError(async () => {
              await useBackupsStore.getState().addRecipient(serverId, label.trim(), key.trim());
              setLabel("");
              setKey("");
            })
          }
        >
          {t("common:backups.addKey")}
        </Button>
      </div>
      {key.trim() !== "" && !isAgePublicKey(key) && <p className="text-xs text-destructive">{t("common:backups.keyInvalid")}</p>}
      <p className="text-xs text-muted-foreground">{t("common:backups.keyHelp")}</p>
      {isTauri && (
        <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
          <KeyRound className="size-3.5" /> {t("common:backups.createInOp")}
        </Button>
      )}
      {creating && <CreateKeyDialog serverId={serverId} onClose={() => setCreating(false)} onError={onError} />}
    </section>
  );
}

interface OpVault {
  /** La URL de la cuenta: lo que pide `op --account`. */
  account: string;
  email: string;
  vault: string;
}

/**
 * Crear la llave de los backups directamente en 1Password (#166). La genera
 * la app de escritorio en memoria y la guarda con `op`: la privada no pasa ni
 * por el disco ni por esta página. Aquí sólo vuelve la pública, que se
 * registra con un nombre que dice dónde vive la privada.
 */
function CreateKeyDialog({
  serverId,
  onClose,
  onError,
}: {
  serverId: string;
  onClose: () => void;
  onError: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useT();
  const [vaults, setVaults] = useState<OpVault[] | null>(null);
  const [place, setPlace] = useState("");
  const [title, setTitle] = useState("cac backups – llave age");
  const [busy, setBusy] = useState(false);
  const keyOf = (v: OpVault) => `${v.account}|${v.vault}`;

  useEffect(() => {
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<OpVault[]>("op_list_vaults"))
      .then((v) => {
        setVaults(v);
        if (v.length) setPlace(keyOf(v[0]));
      })
      .catch(() => setVaults([]));
  }, []);

  const chosen = vaults?.find((v) => keyOf(v) === place);

  const create = () =>
    onError(async () => {
      if (!chosen) return;
      setBusy(true);
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const r = await invoke<{ item: string; publicKey: string }>("create_backup_key", {
          account: chosen.account,
          vault: chosen.vault,
          title: title.trim(),
        });
        await useBackupsStore.getState().addRecipient(serverId, `${title.trim()} (1Password · ${chosen.vault})`, r.publicKey);
        toast.success(t("common:backups.created", { item: r.item }));
        onClose();
      } finally {
        setBusy(false);
      }
    });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("common:backups.createTitle")}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t("common:backups.createLead")}</p>
        {vaults !== null && vaults.length === 0 ? (
          <p className="text-sm text-destructive">{t("common:backups.opUnavailable")}</p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>{t("common:backups.vault")}</Label>
              <Picker
                value={place}
                onChange={setPlace}
                options={(vaults ?? []).map((v) => ({ value: keyOf(v), label: `${v.vault} · ${v.email}` }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bk-item">{t("common:backups.itemTitle")}</Label>
              <Input id="bk-item" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common:action.cancel")}
          </Button>
          <Button disabled={!chosen || !title.trim() || title.includes("/") || busy} onClick={() => void create()}>
            {t("common:backups.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TargetCard({
  serverId,
  target,
  onEdit,
  onDelete,
  onError,
}: {
  serverId: string;
  target: BackupTarget;
  onEdit: () => void;
  onDelete: () => void;
  onError: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useT();
  const confirm = useConfirm();
  const history = useBackupsStore((s) => s.history[target.id]) ?? EMPTY_HISTORY;
  const logs = useBackupsStore((s) => s.logs);
  const [open, setOpen] = useState<string | null>(null);
  const live = history.some((b) => b.status === "queued" || b.status === "running");

  useEffect(() => {
    useBackupsStore.getState().loadHistory(serverId, target.id).catch(() => {});
  }, [serverId, target.id]);

  useEffect(() => {
    if (open && logs[open] === undefined) useBackupsStore.getState().loadLog(serverId, open).catch(() => {});
  }, [open, logs, serverId]);

  const download = async (b: Backup) => {
    const ok = await confirm({
      title: t("common:backups.downloadTitle"),
      description: t("common:backups.downloadBody"),
      confirmText: t("common:backups.download"),
    });
    if (!ok) return;
    await onError(async () => {
      const url = await useBackupsStore.getState().downloadUrl(serverId, b.id);
      window.open(url, "_blank", "noopener");
    });
  };

  return (
    <section className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{t(`common:backups.engine.${target.engine}`)}</Badge>
        <span className="font-mono text-sm">{target.database}</span>
        <span className="font-mono text-xs text-muted-foreground">{target.serviceName}</span>
        {!target.enabled && <Badge variant="secondary">{t("common:backups.paused")}</Badge>}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" disabled={live} onClick={() => onError(() => useBackupsStore.getState().runNow(serverId, target.id))}>
          <Play className="size-3.5" /> {t("common:backups.runNow")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={live || !target.lastSuccessAt}
          onClick={() => onError(() => useBackupsStore.getState().testNow(serverId, target.id))}
        >
          <FlaskConical className="size-3.5" /> {t("common:backups.testNow")}
        </Button>
        <Button size="sm" variant="ghost" aria-label={t("common:backups.edit")} onClick={onEdit}>
          <Pencil className="size-3.5" />
        </Button>
        <Button size="sm" variant="ghost" aria-label={t("common:backups.delete")} onClick={onDelete}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
        <div>
          <dt>{t("common:backups.schedule")}</dt>
          <dd className="text-foreground">{t("common:backups.scheduleValue", { hours: target.everyHours, at: target.anchorTime, tz: target.timezone })}</dd>
        </div>
        <div>
          <dt>{t("common:backups.next")}</dt>
          <dd className="text-foreground">{target.nextRunAt ? fechaYHora(target.nextRunAt) : "—"}</dd>
        </div>
        <div>
          <dt>{t("common:backups.lastGood")}</dt>
          <dd className="text-foreground">{desde(target.lastSuccessAt)}</dd>
        </div>
        <div>
          <dt>{t("common:backups.lastTest")}</dt>
          <dd className={target.lastRestoreTestOk === false ? "text-destructive" : "text-foreground"}>
            {target.lastRestoreTestAt
              ? t(target.lastRestoreTestOk ? "common:backups.testOk" : "common:backups.testFailed", { when: desde(target.lastRestoreTestAt) })
              : "—"}
          </dd>
        </div>
      </dl>
      {history.length > 0 && (
        <ul className="max-h-64 divide-y overflow-y-auto rounded-md border">
          {history.map((b) => (
            <li key={b.id} className="space-y-1 px-2 py-1.5 text-sm">
              <div className="flex items-center gap-2">
                <Badge variant={VARIANT[b.status]}>{t(`common:backups.status.${b.status}`)}</Badge>
                <span className="text-xs">{t(`common:backups.kind.${b.kind}`)}</span>
                {b.retentionClass && <span className="text-xs text-muted-foreground">{t(`common:backups.class.${b.retentionClass}`)}</span>}
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {desde(b.createdAt)}
                  {b.sizeBytes > 0 ? ` · ${formatBytes(b.sizeBytes)}` : ""}
                  {b.error ? ` · ${phraseFor(b.error, b.error)}` : ""}
                </span>
                <Button size="sm" variant="ghost" onClick={() => setOpen(open === b.id ? null : b.id)}>
                  {t("common:backups.log")}
                </Button>
                {b.status === "succeeded" && b.kind !== "restore_test" && !b.purgedAt && (
                  <Button size="sm" variant="ghost" aria-label={t("common:backups.download")} onClick={() => void download(b)}>
                    <Download className="size-3.5" />
                  </Button>
                )}
              </div>
              {open === b.id && (
                <pre className="max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap">
                  {logs[b.id] ?? "…"}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Una etiqueta con su «?»: qué es el campo y un ejemplo. */
function FieldLabel({ field, htmlFor }: { field: HelpField; htmlFor?: string }) {
  const { t } = useT();
  const label = t(`common:backups.${field.label}`);
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      <HelpTip label={t("common:backups.help.aria", { field: label })} example={t(`common:backups.help.${field.key}.example`)} exampleLabel={t("common:backups.help.example")}>
        {t(`common:backups.help.${field.key}.text`)}
      </HelpTip>
    </div>
  );
}

type HelpField = { key: HelpKey; label: LabelKey };
type HelpKey = "engine" | "service" | "database" | "credentialEnv" | "every" | "at" | "timezone" | "keepDays" | "keepWeekly" | "keepMonthly" | "restoreEvery";
type LabelKey = "engineLabel" | "service" | "database" | "credentialEnv" | "every" | "at" | "timezone" | "keepDays" | "keepWeekly" | "keepMonthly" | "restoreEvery";
const F = (key: HelpKey, label: LabelKey = key as LabelKey): HelpField => ({ key, label });

function TargetDialog({
  everyHours,
  services,
  initial,
  isNew,
  onClose,
  onSave,
}: {
  everyHours: number[];
  services: string[];
  initial: BackupTargetPayload;
  isNew: boolean;
  onClose: () => void;
  onSave: (p: BackupTargetPayload) => Promise<void>;
}) {
  const { t } = useT();
  const [p, setP] = useState(initial);
  const set = <K extends keyof BackupTargetPayload>(k: K, v: BackupTargetPayload[K]) => setP((x) => ({ ...x, [k]: v }));
  const num = (k: "keepDays" | "keepWeekly" | "keepMonthly" | "restoreTestEveryDays") => (
    <Input type="number" min={0} value={p[k]} onChange={(e) => set(k, Number(e.target.value))} />
  );
  const ready = p.serviceName && p.database.trim() && p.credentialEnv.trim();

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t(isNew ? "common:backups.addTitle" : "common:backups.editTitle")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <FieldLabel field={F("engine", "engineLabel")} />
            <Picker
              value={p.engine}
              onChange={(v) => {
                set("engine", v as BackupTargetPayload["engine"]);
                set("credentialEnv", v === "mssql" ? "MSSQL_SA_PASSWORD" : "POSTGRES_USER");
              }}
              options={[
                { value: "mssql", label: t("common:backups.engine.mssql") },
                { value: "postgres", label: t("common:backups.engine.postgres") },
              ]}
            />
          </div>
          <div className="space-y-1">
            <FieldLabel field={F("service")} />
            <Picker value={p.serviceName} onChange={(v) => set("serviceName", v)} options={services.map((s) => ({ value: s, label: s }))} />
          </div>
          <div className="space-y-1">
            <FieldLabel field={F("database")} htmlFor="bk-db" />
            <Input id="bk-db" value={p.database} onChange={(e) => set("database", e.target.value)} placeholder="boaty" />
            <p className="text-xs text-muted-foreground">{t("common:backups.databaseHint")}</p>
          </div>
          <div className="space-y-1">
            <FieldLabel field={F("credentialEnv")} htmlFor="bk-env" />
            <Input id="bk-env" className="font-mono" value={p.credentialEnv} onChange={(e) => set("credentialEnv", e.target.value)} />
            <p className="text-xs text-muted-foreground">{t("common:backups.credentialEnvHint")}</p>
          </div>
          <div className="space-y-1">
            <FieldLabel field={F("every")} />
            <Picker
              value={String(p.everyHours)}
              onChange={(v) => set("everyHours", Number(v))}
              options={everyHours.map((h) => ({ value: String(h), label: t("common:backups.everyValue", { hours: h }) }))}
            />
          </div>
          <div className="space-y-1">
            <FieldLabel field={F("at")} htmlFor="bk-at" />
            <Input id="bk-at" type="time" value={p.anchorTime} onChange={(e) => set("anchorTime", e.target.value)} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <FieldLabel field={F("timezone")} htmlFor="bk-tz" />
            <Input id="bk-tz" value={p.timezone} onChange={(e) => set("timezone", e.target.value)} />
          </div>
          <div className="space-y-1">
            <FieldLabel field={F("keepDays")} />
            {num("keepDays")}
          </div>
          <div className="space-y-1">
            <FieldLabel field={F("keepWeekly")} />
            {num("keepWeekly")}
          </div>
          <div className="space-y-1">
            <FieldLabel field={F("keepMonthly")} />
            {num("keepMonthly")}
          </div>
          <div className="space-y-1">
            <FieldLabel field={F("restoreEvery")} />
            {num("restoreTestEveryDays")}
          </div>
          <div className="flex items-center gap-2 text-sm sm:col-span-2">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={p.enabled} onChange={(e) => set("enabled", e.target.checked)} />
              {t("common:backups.enabled")}
            </label>
            <HelpTip label={t("common:backups.help.aria", { field: t("common:backups.enabled") })}>{t("common:backups.help.enabled.text")}</HelpTip>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t("common:backups.retained", { n: retainedCount(p) })}</p>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common:action.cancel")}
          </Button>
          <Button disabled={!ready} onClick={() => void onSave(p)}>
            {t("common:backups.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
