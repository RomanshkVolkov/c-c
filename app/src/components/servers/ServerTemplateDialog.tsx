import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { APIResponse } from "@/types/auth";
import type { AnsibleManifest } from "@/types/ansible";
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
 * Crear una plantilla de servidor, o guardar una versión nueva de una. Una
 * plantilla es una secuencia de playbooks del manifiesto, las variables que
 * comparten y los **nombres** de los secretos que un servidor tiene que traer.
 * Nunca un valor: cac rechaza un secreto como variable.
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
  const [varsText, setVarsText] = useState("{}");
  const [perServer, setPerServer] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const cur = template?.current;
    setName(template?.name ?? "");
    setDescription(template?.description ?? "");
    setPicked(new Set(cur?.playbooks ?? []));
    setVarsText(JSON.stringify(cur?.vars ?? {}, null, 2));
    setPerServer(new Set(cur?.perServer ?? []));
    setNote("");
  }, [open, template]);

  const playbookIds = manifest ? orderedPlaybooks(manifest, picked) : [...picked];
  const derived = useMemo(
    () => (manifest ? templateFromManifest(manifest, playbookIds) : { vars: {}, requires: template?.current?.requires ?? [], perServer: [] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [manifest, playbookIds.join(",")],
  );
  const requires = manifest ? derived.requires : (template?.current?.requires ?? []);
  let vars: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(varsText);
    vars = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    vars = null;
  }
  const canSave = !saving && playbookIds.length > 0 && vars !== null && (!!template || name.trim().length > 0);

  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  const fillDefaults = () => {
    if (!manifest) return;
    const { vars: defaults, perServer: ps } = templateFromManifest(manifest, playbookIds);
    // Lo escrito se queda; sólo se añade lo que falta.
    setVarsText(JSON.stringify({ ...defaults, ...(vars ?? {}) }, null, 2));
    if (perServer.size === 0) setPerServer(new Set(ps));
  };

  const save = async () => {
    if (!vars) return;
    setSaving(true);
    const body = {
      playbooks: playbookIds,
      vars,
      requires,
      perServer: [...perServer].filter((p) => requires.includes(p)),
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

  const allIds = manifest ? manifest.playbooks.map((p) => ({ id: p.id, name: p.name })) : playbookIds.map((id) => ({ id, name: id }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{template ? t("common:serverConfig.editTemplate", { name: template.name }) : t("common:serverConfig.newTemplate")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {!template && (
            <>
              <div className="space-y-1">
                <Label htmlFor="tpl-name">{t("common:serverConfig.templateName")}</Label>
                <Input id="tpl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Swarm + Traefik" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="tpl-desc">{t("common:serverConfig.templateDescription")}</Label>
                <Input id="tpl-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>
            </>
          )}
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("common:serverConfig.templatePlaybooks")}</p>
            {!manifest && <p className="text-xs text-muted-foreground">{t("common:serverConfig.pickFolderForPlaybooks")}</p>}
            <ul className="space-y-1">
              {allIds.map((p) => (
                <li key={p.id}>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} disabled={!manifest} />
                    <span className="font-mono text-xs">{p.id}</span>
                    <span className="text-xs text-muted-foreground">{p.name}</span>
                  </label>
                </li>
              ))}
            </ul>
            {playbookIds.length > 0 && <p className="font-mono text-xs text-muted-foreground">{playbookIds.join(" → ")}</p>}
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor="tpl-vars">{t("common:serverConfig.vars")}</Label>
              {manifest && (
                <Button type="button" variant="ghost" size="sm" onClick={fillDefaults} disabled={playbookIds.length === 0}>
                  {t("common:serverConfig.fillDefaults")}
                </Button>
              )}
            </div>
            <Textarea id="tpl-vars" className="min-h-40 font-mono text-xs" value={varsText} onChange={(e) => setVarsText(e.target.value)} />
            {vars === null && <p className="text-xs text-destructive">{t("common:serverConfig.badJson")}</p>}
            <p className="text-xs text-muted-foreground">{t("common:serverConfig.noSecretsInVars")}</p>
          </div>
          {requires.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium">{t("common:serverConfig.requires")}</p>
              <ul className="space-y-1">
                {requires.map((r) => (
                  <li key={r}>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={perServer.has(r)}
                        onChange={() => {
                          const next = new Set(perServer);
                          if (next.has(r)) next.delete(r);
                          else next.add(r);
                          setPerServer(next);
                        }}
                      />
                      <span className="font-mono text-xs">{r}</span>
                      <span className="text-xs text-muted-foreground">{t("common:serverConfig.perServer")}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
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
            {t("common:serverConfig.saveVersion")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
