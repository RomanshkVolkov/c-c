import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import Picker from "@/components/ui/picker";
import { VarInput, varFields } from "@/components/servers/ansible-vars";
import type { APIResponse } from "@/types/auth";
import type { AnsibleManifest, PlaybookDef } from "@/types/ansible";
import type { ServerTemplate } from "@/types/server-config";

/**
 * Lo que una plantilla pide de los playbooks elegidos del manifiesto v2: sus
 * defaults (las variables no secretas con `default`), los secretos que exige
 * (`from` y la contraseña de sudo) y cuáles son de cada máquina (la de sudo).
 * Puro, para probarlo sin pantalla.
 */
export function templateFromManifest(manifest: AnsibleManifest, playbookIds: string[]) {
  const chosen = manifest.playbooks.filter((p) => playbookIds.includes(p.id));
  const vars: Record<string, unknown> = {};
  const requires = new Set<string>();
  const perServer = new Set<string>();
  for (const p of chosen) {
    for (const v of p.vars) {
      if (v.from) requires.add(v.from);
      else if (!v.secret && v.default !== undefined && v.default !== null && !(v.name in vars)) vars[v.name] = v.default;
    }
    if (p.become && p.becomePasswordFrom) {
      requires.add(p.becomePasswordFrom);
      perServer.add(p.becomePasswordFrom);
    }
  }
  return { vars, requires: [...requires].sort(), perServer: [...perServer].sort() };
}

/** Los playbooks elegidos, en el orden del manifiesto: el de las etapas. */
export function orderedPlaybooks(manifest: AnsibleManifest, picked: Set<string>): string[] {
  return manifest.playbooks.map((p) => p.id).filter((id) => picked.has(id));
}

/**
 * Las etapas que se pueden poner en una plantilla: lo que monta algo
 * (`change`). Una verificación corre sola después de su etapa y un
 * desmontaje se pide aparte; meterlos en la secuencia los correría como una
 * etapa más. Un manifiesto sin riesgos declarados enseña todo.
 */
export function stagePlaybooks(manifest: AnsibleManifest): PlaybookDef[] {
  const declared = manifest.playbooks.some((p) => p.risk);
  return manifest.playbooks.filter((p) => !declared || p.risk === "change");
}

/**
 * Crear una plantilla de servidor, o guardar una versión nueva de una. Una
 * plantilla es una secuencia de etapas del manifiesto, los valores que
 * comparten y los **nombres** de los secretos que un servidor tiene que traer.
 * Nunca un valor: cac rechaza un secreto como variable.
 *
 * Se rellena sola: al elegir las etapas salen sus variables con su default y
 * su descripción, y los secretos con lo que son. Sólo se toca lo que se quiere
 * cambiar.
 */
export default function ServerTemplateDialog({
  open,
  onOpenChange,
  orgId,
  manifest,
  template,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  manifest: AnsibleManifest | null;
  /** Sin ella, se crea una. */
  template?: ServerTemplate | null;
  onSaved: (templateId: string) => void;
}) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Lo que se cambió de los defaults (y, al editar, lo que ya tenía).
  const [values, setValues] = useState<Record<string, unknown>>({});
  // null = lo que diga el manifiesto (la de sudo, de cada servidor).
  const [perServer, setPerServer] = useState<Set<string> | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const cur = template?.current;
    setName(template?.name ?? "");
    setDescription(template?.description ?? "");
    setPicked(new Set(cur?.playbooks ?? []));
    setValues({ ...(cur?.vars ?? {}) });
    setPerServer(cur ? new Set(cur.perServer ?? []) : null);
    setNote("");
  }, [open, template]);

  const playbookIds = manifest ? orderedPlaybooks(manifest, picked) : [...picked];
  const fields = useMemo(
    () => (manifest ? varFields(manifest, playbookIds) : { shared: [], perServer: [], secrets: [] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [manifest, playbookIds.join(",")],
  );
  const requires = manifest ? fields.secrets.map((s) => s.name) : (template?.current?.requires ?? []);
  const own = perServer ?? new Set(fields.secrets.filter((s) => s.sudo).map((s) => s.name));

  // Lo que se guarda: cada variable de las etapas con su valor (el default si
  // no se tocó), más lo que ya tenía la plantilla y no sale en el formulario.
  const shown = new Set([...fields.shared, ...fields.perServer].map((f) => f.name));
  const vars: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) if (!shown.has(k) && v !== undefined) vars[k] = v;
  for (const f of fields.shared) {
    const v = f.name in values ? values[f.name] : f.default;
    if (v !== undefined) vars[f.name] = v;
  }
  const canSave = !saving && playbookIds.length > 0 && (!!template || name.trim().length > 0);

  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  const save = async () => {
    setSaving(true);
    const body = {
      playbooks: playbookIds,
      vars,
      requires,
      perServer: [...own].filter((p) => requires.includes(p)).sort(),
      note: note.trim(),
    };
    try {
      if (template) {
        await api.put<APIResponse<unknown>>(`/api/v1/organizations/${orgId}/server-templates/${template.id}`, body, true);
        onSaved(template.id);
      } else {
        const res = await api.post<APIResponse<ServerTemplate>>(
          `/api/v1/organizations/${orgId}/server-templates/`,
          { ...body, name: name.trim(), description: description.trim() },
          true,
        );
        onSaved(res?.data?.id ?? "");
      }
      toast.success(t("common:serverConfig.templateSaved"));
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const stages = manifest ? stagePlaybooks(manifest) : playbookIds.map((id) => ({ id, name: id, description: "" }) as PlaybookDef);
  const nameOf = (id?: string | null) => (id ? (manifest?.playbooks.find((p) => p.id === id)?.name ?? id) : "");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{template ? t("common:serverConfig.editTemplate", { name: template.name }) : t("common:serverConfig.newTemplate")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5 text-sm">
          <p className="text-xs text-muted-foreground">{t("common:serverConfig.templateLead")}</p>
          {!template && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="tpl-name">{t("common:serverConfig.templateName")}</Label>
                <Input id="tpl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Swarm + Traefik" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="tpl-desc">{t("common:serverConfig.templateDescription")}</Label>
                <Input id="tpl-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>
            </div>
          )}

          <section className="space-y-2">
            <div>
              <p className="text-sm font-medium">{t("common:serverConfig.stepStages")}</p>
              <p className="text-xs text-muted-foreground">{t("common:serverConfig.stagesLead")}</p>
            </div>
            {!manifest && <p className="text-xs text-destructive">{t("common:serverConfig.pickFolderForPlaybooks")}</p>}
            <ul className="space-y-1.5">
              {stages.map((p) => (
                <li key={p.id}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-md border p-2 has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                    <input className="mt-0.5" type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} disabled={!manifest} />
                    <span className="min-w-0 space-y-0.5">
                      <span className="block text-sm">{p.name}</span>
                      {p.description && <span className="block text-xs text-muted-foreground">{p.description}</span>}
                      {(p.verify || p.rollback) && (
                        <span className="block text-[11px] text-muted-foreground">
                          {[
                            p.verify && t("common:serverConfig.verifiedBy", { name: nameOf(p.verify) }),
                            p.rollback &&
                              (p.rollback === "manual"
                                ? t("common:serverConfig.rollbackManual")
                                : t("common:serverConfig.undoneBy", { name: nameOf(p.rollback) })),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {playbookIds.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("common:serverConfig.runsInOrder")} <span className="font-mono">{playbookIds.join(" → ")}</span>
              </p>
            )}
          </section>

          {playbookIds.length > 0 && fields.shared.length > 0 && (
            <section className="space-y-2">
              <div>
                <p className="text-sm font-medium">{t("common:serverConfig.stepShared")}</p>
                <p className="text-xs text-muted-foreground">{t("common:serverConfig.sharedLead")}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {fields.shared.map((f) => (
                  <VarInput
                    key={f.name}
                    idPrefix="tpl"
                    field={f}
                    value={f.name in values ? values[f.name] : f.default}
                    onChange={(v) => setValues({ ...values, [f.name]: v })}
                  />
                ))}
              </div>
            </section>
          )}

          {playbookIds.length > 0 && fields.perServer.length > 0 && (
            <section className="space-y-1">
              <p className="text-sm font-medium">{t("common:serverConfig.stepPerServer")}</p>
              <p className="text-xs text-muted-foreground">{t("common:serverConfig.perServerLead")}</p>
              <ul className="space-y-0.5 text-xs">
                {fields.perServer.map((f) => (
                  <li key={f.name}>
                    <span className="font-mono">{f.name}</span>
                    {f.description && <span className="text-muted-foreground"> — {f.description}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {requires.length > 0 && (
            <section className="space-y-2">
              <div>
                <p className="text-sm font-medium">{t("common:serverConfig.stepSecrets")}</p>
                <p className="text-xs text-muted-foreground">{t("common:serverConfig.secretsLead")}</p>
              </div>
              <ul className="space-y-2">
                {(manifest ? fields.secrets : requires.map((r) => ({ name: r, description: "", sudo: false }))).map((s) => (
                  <li key={s.name} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                    <span className="min-w-0 flex-1 space-y-0.5">
                      <span className="block font-mono text-xs">{s.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {s.description || (s.sudo ? t("common:serverConfig.sudoSecret") : "")}
                      </span>
                    </span>
                    <Picker
                      aria-label={t("common:serverConfig.secretScope", { name: s.name })}
                      value={own.has(s.name) ? "own" : "shared"}
                      onChange={(v) => {
                        const next = new Set(own);
                        if (v === "own") next.add(s.name);
                        else next.delete(s.name);
                        setPerServer(next);
                      }}
                      options={[
                        { value: "own", label: t("common:serverConfig.secretOwn") },
                        { value: "shared", label: t("common:serverConfig.secretShared") },
                      ]}
                      className="w-56"
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="space-y-1">
            <Label htmlFor="tpl-note">{t("common:serverConfig.note")}</Label>
            <Input id="tpl-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:serverConfig.cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={!canSave}>
            {template ? t("common:serverConfig.saveVersion") : t("common:serverConfig.createTemplate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
