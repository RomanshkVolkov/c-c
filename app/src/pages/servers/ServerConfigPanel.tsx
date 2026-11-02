import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Copy, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useT } from "@/lib/i18n";
import { api } from "@/lib/api";
import { desde } from "@/lib/desde";
import { lineDiff } from "@/lib/line-diff";
import { useConfirm } from "@/components/ConfirmDialog";
import ServerTemplateDialog from "@/components/servers/ServerTemplateDialog";
import { VarInput, toInput, toLines, varFields } from "@/components/servers/ansible-vars";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import Picker from "@/components/ui/picker";
import { useAuthStore } from "@/store/auth.store";
import { useOrgsStore } from "@/store/orgs.store";
import type { APIResponse } from "@/types/auth";
import type { AnsibleManifest } from "@/types/ansible";
import type { Server } from "@/types/server";
import type { EffectiveConfig, ServerConfigSummary, ServerConfigVersion, ServerTemplate } from "@/types/server-config";

/** Un nombre de secreto como lo acepta cac (`domain.SecretNamePattern`). */
export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,39}$/;
/** Una referencia de 1Password: un ítem o la variable de un Environment. */
export const OP_REF = /^(op:\/\/[^/]+\/[^/]+\/.+|op-env:\/\/[^/]+\/[A-Za-z_][A-Za-z0-9_]{0,63})$/;

export interface RefRow {
  name: string;
  ref: string;
}

/**
 * Lo que se manda al guardar, o por qué no se puede. Puro, para probarlo: un
 * valor pegado en vez de su referencia se para aquí, antes de viajar.
 */
export function configBody(
  templateId: string,
  varsText: string,
  rows: RefRow[],
  note: string,
): { body: { templateId: string; vars: Record<string, unknown>; opRefs: Record<string, string>; note: string } } | { error: "badJson" | "badRefs" } {
  let vars: unknown;
  try {
    vars = JSON.parse(varsText || "{}");
  } catch {
    return { error: "badJson" };
  }
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) return { error: "badJson" };
  const opRefs: Record<string, string> = {};
  for (const r of rows) {
    const name = r.name.trim();
    const ref = r.ref.trim();
    // Una fila sin referencia es un secreto que aún falta (la plantilla lo
    // pide y se enseña vacío): no se guarda, y `missing` lo sigue diciendo.
    if (!ref) continue;
    if (!SECRET_NAME.test(name) || !OP_REF.test(ref) || name in opRefs) return { error: "badRefs" };
    opRefs[name] = ref;
  }
  return { body: { templateId, vars: vars as Record<string, unknown>, opRefs, note: note.trim() } };
}

/** Las filas, más una vacía por cada secreto que pide la plantilla y no está. */
export const withRequired = (rows: RefRow[], requires: string[]): RefRow[] => [
  ...rows,
  ...requires.filter((n) => !rows.some((r) => r.name === n)).map((name) => ({ name, ref: "" })),
];

const rowsOf = (refs: Record<string, string> | undefined): RefRow[] =>
  Object.entries(refs ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, ref]) => ({ name, ref }));

/**
 * JSON con las claves ordenadas: Postgres devuelve un `jsonb` con sus claves
 * en su propio orden, y sin esto una config sin tocar parecería cambiada.
 */
export function stableJson(v: unknown, indent = 2): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sort)
      : x && typeof x === "object"
        ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])]))
        : x;
  return JSON.stringify(sort(v), null, indent);
}

/** Una versión, como texto estable para compararla con otra. */
const asText = (v: Pick<ServerConfigVersion, "templateId" | "vars" | "opRefs"> | null | undefined) =>
  v ? stableJson({ templateId: v.templateId || "", vars: v.vars ?? {}, opRefs: v.opRefs ?? {} }) : "";

/**
 * La configuración de un servidor en cac: con qué plantilla se monta, sus
 * variables y **dónde** está cada secreto en 1Password. Cada guardado es una
 * versión nueva; las viejas se ven, se comparan y se restauran. Lo mismo lo
 * edita un agente por MCP (`set_server_config`), y aquí se ve quién fue.
 */
export default function ServerConfigPanel({
  server,
  manifest,
  effective,
  onChanged,
}: {
  server: Pick<Server, "id" | "orgId" | "name"> & Partial<Pick<Server, "host" | "sshPort">>;
  manifest: AnsibleManifest | null;
  effective: EffectiveConfig | null;
  onChanged: () => void;
}) {
  const { t } = useT();
  const confirm = useConfirm();
  const orgs = useOrgsStore((s) => s.orgs);
  const superadmin = useAuthStore((s) => !!s.session?.superadmin);
  const canEdit = superadmin || orgs.find((o) => o.id === server.orgId)?.role === "admin";

  const [summary, setSummary] = useState<ServerConfigSummary | null>(null);
  const [templates, setTemplates] = useState<ServerTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [varsText, setVarsText] = useState("{}");
  const [rows, setRows] = useState<RefRow[]>([]);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [checks, setChecks] = useState<Record<string, string | true>>({});
  const [open, setOpen] = useState<number | null>(null);
  const [dialog, setDialog] = useState<"new" | "edit" | null>(null);
  const [source, setSource] = useState("");
  const [servers, setServers] = useState<Server[]>([]);

  const load = useCallback(async () => {
    const [cfg, tpls, all] = await Promise.all([
      api.get<APIResponse<ServerConfigSummary>>(`/api/v1/servers/${server.id}/config`, true).catch(() => null),
      api.get<APIResponse<ServerTemplate[]>>(`/api/v1/organizations/${server.orgId}/server-templates`, true).catch(() => null),
      api.get<APIResponse<Server[]>>("/api/v1/servers/", true).catch(() => null),
    ]);
    setServers(Array.isArray(all?.data) ? all.data : []);
    const d = cfg?.data;
    const s: ServerConfigSummary =
      d && typeof d === "object" && !Array.isArray(d) && Array.isArray(d.versions) ? d : { current: null, versions: [] };
    setSummary(s);
    setTemplates(Array.isArray(tpls?.data) ? tpls.data : []);
    setTemplateId(s.current?.templateId ?? "");
    setVarsText(stableJson(s.current?.vars ?? {}));
    const tpl = (Array.isArray(tpls?.data) ? tpls.data : []).find((x) => x.id === s.current?.templateId);
    setRows(withRequired(rowsOf(s.current?.opRefs), tpl?.current?.requires ?? []));
    setNote("");
    setChecks({});
  }, [server.id, server.orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const draft = configBody(templateId, varsText, rows, note);
  const current = summary?.current ?? null;
  const empty = { templateId: "", vars: {}, opRefs: {} };
  const dirty = "body" in draft && asText(draft.body) !== asText(current ?? empty);
  const template = templates.find((x) => x.id === templateId) ?? null;
  // Con la plantilla y el manifiesto, las variables salen como formulario:
  // lo de este servidor, y lo heredado que se puede cambiar sólo aquí.
  const fields = useMemo(
    () => (manifest?.version === 2 && template?.current ? varFields(manifest, template.current.playbooks) : null),
    [manifest, template],
  );
  let vars: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(varsText || "{}");
    vars = v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    vars = null;
  }
  const setVar = (name: string, v: unknown) => {
    if (!vars) return;
    const next = { ...vars };
    if (v === undefined) delete next[name];
    else next[name] = v;
    setVarsText(stableJson(next));
  };
  // Lo que se sabe ya del servidor registrado: se ofrece, no se impone.
  const suggestions: Record<string, unknown> = { public_ip: server.host, ssh_port: server.sshPort };
  const secretInfo = new Map((fields?.secrets ?? []).map((x) => [x.name, x]));
  const required = new Set(template?.current?.requires ?? []);
  const pickTemplate = (id: string) => {
    setTemplateId(id);
    const tpl = templates.find((x) => x.id === id);
    setRows(withRequired(rows, tpl?.current?.requires ?? []));
  };
  const others = useMemo(() => servers.filter((s) => s.id !== server.id && s.orgId === server.orgId), [servers, server]);

  const put = async (body: Record<string, unknown>) => {
    setSaving(true);
    try {
      await api.put<APIResponse<ServerConfigVersion>>(`/api/v1/servers/${server.id}/config`, body, true);
      toast.success(t("common:serverConfig.saved"));
      await load();
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    if ("body" in draft) void put(draft.body);
  };

  const restore = async (v: ServerConfigVersion) => {
    const ok = await confirm({
      title: t("common:serverConfig.restoreTitle", { seq: v.seq }),
      description: t("common:serverConfig.restoreBody", { seq: v.seq }),
      confirmText: t("common:serverConfig.restore"),
    });
    if (ok)
      void put({
        templateId: v.templateId,
        templateSeq: v.templateSeq,
        vars: v.vars,
        opRefs: v.opRefs,
        note: t("common:serverConfig.restoredNote", { seq: v.seq }),
      });
  };

  const copyFrom = async () => {
    const src = others.find((s) => s.id === source);
    if (!src) return;
    const ok = await confirm({
      title: t("common:serverConfig.copyTitle", { from: src.name }),
      description: t("common:serverConfig.copyBody", { from: src.name }),
      confirmText: t("common:serverConfig.copy"),
    });
    if (ok) void put({ basedOnServerId: src.id, note: t("common:serverConfig.copiedNote", { from: src.name }) });
  };

  const check = async () => {
    const refs = rows.map((r) => r.ref.trim()).filter((r) => OP_REF.test(r));
    const out: Record<string, string | true> = {};
    for (const r of refs) {
      const [c] = await invoke<{ opRef: string; ok: boolean; error: string }[]>("check_op_refs", { refs: [r], envFiles: null }).catch(() => [
        { opRef: r, ok: false, error: "?" },
      ]);
      out[r] = c?.ok ? true : (c?.error ?? "?");
    }
    setChecks(out);
  };

  const versions = summary?.versions ?? [];
  const nameOf = (id: string) => servers.find((s) => s.id === id)?.name ?? id.slice(0, 8);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">
          {t("common:serverConfig.title")}
          {current && <span className="ml-2 text-xs font-normal text-muted-foreground">v{current.seq}</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">{t("common:serverConfig.lead")}</p>

        <div className="space-y-1">
          <Label className="text-xs">{t("common:serverConfig.template")}</Label>
          <div className="flex gap-2">
            <Picker
              aria-label={t("common:serverConfig.template")}
              value={templateId}
              onChange={pickTemplate}
              options={[{ value: "", label: t("common:serverConfig.noTemplate") }, ...templates.map((x) => ({ value: x.id, label: x.name }))]}
              className="flex-1"
              disabled={!canEdit}
            />
            {canEdit && (
              <>
                <Button variant="outline" size="sm" onClick={() => setDialog("new")} aria-label={t("common:serverConfig.newTemplate")}>
                  <Plus className="size-4" />
                </Button>
                {template && (
                  <Button variant="outline" size="sm" onClick={() => setDialog("edit")}>
                    {t("common:serverConfig.edit")}
                  </Button>
                )}
              </>
            )}
          </div>
          {template?.current && (
            <p className="font-mono text-xs text-muted-foreground">
              {template.current.playbooks.join(" → ")} · v{template.current.seq}
            </p>
          )}
        </div>

        {fields && vars && fields.perServer.length > 0 && (
          <section className="space-y-2">
            <div>
              <p className="text-xs font-medium">{t("common:serverConfig.thisServer")}</p>
              <p className="text-[11px] text-muted-foreground">{t("common:serverConfig.thisServerLead")}</p>
            </div>
            {fields.perServer.map((f) => {
              const hint = suggestions[f.name];
              return (
                <div key={f.name} className="space-y-0.5">
                  <VarInput idPrefix="cfg" field={f} value={vars?.[f.name]} onChange={(v) => setVar(f.name, v)} readOnly={!canEdit} />
                  {canEdit && hint !== undefined && hint !== "" && vars?.[f.name] === undefined && (
                    <Button type="button" variant="link" size="sm" className="h-auto p-0 text-[11px]" onClick={() => setVar(f.name, hint)}>
                      {t("common:serverConfig.useFromServer", { value: toInput(hint) })}
                    </Button>
                  )}
                </div>
              );
            })}
          </section>
        )}

        {fields && vars && fields.shared.length > 0 && (
          <details className="space-y-2 rounded-md border p-2">
            <summary className="cursor-pointer text-xs font-medium">
              {t("common:serverConfig.inherited", { count: fields.shared.length })}
            </summary>
            <p className="pt-1 text-[11px] text-muted-foreground">{t("common:serverConfig.inheritedLead")}</p>
            <div className="space-y-2 pt-1">
              {fields.shared.map((f) => (
                <VarInput
                  key={f.name}
                  idPrefix="cfg"
                  field={f}
                  value={vars?.[f.name]}
                  placeholder={(f.list ? toLines : toInput)(template?.current?.vars?.[f.name] ?? f.default)}
                  onChange={(v) => setVar(f.name, v)}
                  readOnly={!canEdit}
                />
              ))}
            </div>
          </details>
        )}

        <details className="rounded-md border p-2" open={!fields || !vars}>
          <summary className="cursor-pointer text-xs font-medium">{t("common:serverConfig.asJson")}</summary>
          <div className="space-y-1 pt-2">
            <Label htmlFor="cfg-vars" className="text-xs">{t("common:serverConfig.vars")}</Label>
            <Textarea id="cfg-vars" className="min-h-32 font-mono text-xs" value={varsText} onChange={(e) => setVarsText(e.target.value)} readOnly={!canEdit} />
            {"error" in draft && draft.error === "badJson" && <p className="text-xs text-destructive">{t("common:serverConfig.badJson")}</p>}
            <p className="text-xs text-muted-foreground">{t("common:serverConfig.noSecretsInVars")}</p>
          </div>
        </details>

        <div className="space-y-1">
          <p className="text-xs font-medium">{t("common:serverConfig.secrets")}</p>
          <p className="text-[11px] text-muted-foreground">{t("common:serverConfig.secretsPanelLead")}</p>
          {rows.map((r, i) => (
            <div key={i} className="space-y-0.5">
            <div className="flex gap-1">
              {required.has(r.name) ? (
                <span className="flex w-40 shrink-0 items-center truncate font-mono text-xs" title={r.name}>
                  {r.name}
                </span>
              ) : (
              <Input
                aria-label={t("common:serverConfig.secretName")}
                className="w-40 font-mono text-xs"
                value={r.name}
                placeholder="OPS_PASSWORD"
                readOnly={!canEdit}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              )}
              <Input
                aria-label={t("common:serverConfig.secretRef")}
                className="flex-1 font-mono text-xs"
                value={r.ref}
                placeholder="op://vault/item/field"
                readOnly={!canEdit}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, ref: e.target.value } : x)))}
              />
              {checks[r.ref.trim()] !== undefined && (
                <Badge variant={checks[r.ref.trim()] === true ? "default" : "destructive"} title={checks[r.ref.trim()] === true ? "" : String(checks[r.ref.trim()])}>
                  {checks[r.ref.trim()] === true ? "✓" : "✗"}
                </Badge>
              )}
              {canEdit && (
                <Button variant="ghost" size="sm" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={t("common:serverConfig.remove")}>
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
            {required.has(r.name) && (
              <p className="text-[11px] text-muted-foreground">
                {secretInfo.get(r.name)?.description || (secretInfo.get(r.name)?.sudo ? t("common:serverConfig.sudoSecret") : "")}
                {template?.current?.perServer?.includes(r.name) ? ` ${t("common:serverConfig.ownHint")}` : ""}
              </p>
            )}
            </div>
          ))}
          {"error" in draft && draft.error === "badRefs" && <p className="text-xs text-destructive">{t("common:serverConfig.badRefs")}</p>}
          {effective && effective.missing.length > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{t("common:serverConfig.missing", { names: effective.missing.join(", ") })}</p>
          )}
          <div className="flex gap-2">
            {canEdit && (
              <Button variant="outline" size="sm" onClick={() => setRows([...rows, { name: "", ref: "" }])}>
                <Plus className="mr-1 size-4" />
                {t("common:serverConfig.addSecret")}
              </Button>
            )}
            {rows.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => void check()}>
                {t("common:serverConfig.check")}
              </Button>
            )}
          </div>
        </div>

        {canEdit && (
          <div className="space-y-2">
            <Input aria-label={t("common:serverConfig.note")} placeholder={t("common:serverConfig.note")} value={note} onChange={(e) => setNote(e.target.value)} />
            <Button className="w-full" disabled={saving || "error" in draft || !dirty} onClick={save}>
              {t("common:serverConfig.saveVersion")}
            </Button>
          </div>
        )}

        {canEdit && others.length > 0 && (
          <div className="flex gap-2">
            <Picker
              aria-label={t("common:serverConfig.basedOn")}
              value={source}
              onChange={setSource}
              options={[{ value: "", label: t("common:serverConfig.basedOn") }, ...others.map((s) => ({ value: s.id, label: s.name }))]}
              className="flex-1"
            />
            <Button variant="outline" size="sm" disabled={!source || saving} onClick={() => void copyFrom()}>
              <Copy className="mr-1 size-4" />
              {t("common:serverConfig.copy")}
            </Button>
          </div>
        )}

        {versions.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("common:serverConfig.versions")}</p>
            <ul className="divide-y rounded-md border">
              {versions.map((v, i) => {
                const prev = versions[i + 1];
                return (
                  <li key={v.id} className="space-y-1 px-2 py-1.5 text-xs">
                    <div className="flex items-center gap-2">
                      <button type="button" className="font-mono hover:underline" onClick={() => setOpen(open === v.seq ? null : v.seq)}>
                        v{v.seq}
                      </button>
                      {v.source === "mcp" && <Badge variant="outline">{t("common:serverConfig.viaAgent")}</Badge>}
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {[v.createdByName, desde(v.createdAt), v.note || (v.basedOn ? t("common:serverConfig.copiedNote", { from: nameOf(v.basedOn.serverId) }) : "")]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      {canEdit && i > 0 && (
                        <Button variant="ghost" size="sm" onClick={() => void restore(v)} aria-label={t("common:serverConfig.restore")}>
                          <RotateCcw className="size-3.5" />
                        </Button>
                      )}
                    </div>
                    {open === v.seq && (
                      <pre className="max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">
                        {lineDiff(asText(prev), asText(v)).map((row, k) =>
                          row.kind === "skip" ? (
                            <div key={k} className="text-muted-foreground">⋯ {row.count}</div>
                          ) : (
                            <div
                              key={k}
                              className={row.kind === "add" ? "text-emerald-600 dark:text-emerald-400" : row.kind === "del" ? "text-red-600 line-through dark:text-red-400" : ""}
                            >
                              {row.kind === "add" ? "+ " : row.kind === "del" ? "- " : "  "}
                              {row.text}
                            </div>
                          ),
                        )}
                      </pre>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>
      <ServerTemplateDialog
        open={dialog !== null}
        onOpenChange={(o) => !o && setDialog(null)}
        orgId={server.orgId}
        manifest={manifest?.version === 2 ? manifest : null}
        template={dialog === "edit" ? template : null}
        onSaved={(id) => {
          void load().then(() => {
            if (id) setTemplateId(id);
          });
        }}
      />
    </Card>
  );
}
