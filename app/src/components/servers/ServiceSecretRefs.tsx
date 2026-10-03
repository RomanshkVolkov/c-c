import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { CheckCircle2, Download, KeyRound, Loader2, Plus, RotateCw, Trash2, XCircle } from "lucide-react";
import { useT } from "@/lib/i18n";
import { api } from "@/lib/api";
import { desde } from "@/lib/desde";
import { phraseFor } from "@/lib/server-errors";
import { useConfirm } from "@/components/ConfirmDialog";
import { useOrgsStore } from "@/store/orgs.store";
import { useAuthStore } from "@/store/auth.store";
import { useDeploymentsStore } from "@/store/deployments.store";
import { roleAtLeast } from "@/types/organization";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { APIResponse } from "@/types/auth";
import type { Server } from "@/types/server";
import type { SwarmService } from "@/types/swarm";

interface SecretRef {
  name: string;
  opRef: string;
}

interface Rotation {
  id: string;
  createdAt: string;
  names: string;
  status: "succeeded" | "failed";
  error: string;
  startedByName?: string;
}

interface RotationResult {
  items: { name: string; secret: string; changed: boolean }[];
  updated: boolean;
}

const NADA: never[] = [];

/** Una etiqueta de 1Password como nombre de secret: mayúsculas y guiones bajos. */
export function labelToName(label: string): string {
  return label
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^([0-9])/, "_$1")
    .slice(0, 40);
}

const NAME = /^[A-Z_][A-Z0-9_]{0,39}$/;
const OP_REF = /^op:\/\/[^/]+\/[^/]+\/.+$/;

/**
 * Los secrets de un servicio, por referencia a 1Password.
 *
 * Aquí sólo se dice **de dónde** sale cada uno. Rotar los lee en esta máquina
 * (Rust, `op read`), los lleva al servidor por ssh como secrets de Docker
 * —ficheros en `/run/secrets/<NOMBRE>`— y reinicia el servicio con ellos. A cac
 * sólo llegan los nombres.
 *
 * Sólo en un servicio que despliega cac: el `stack deploy` de un CI volvería a
 * poner los secrets de su stack y tiraría estos sin avisar.
 */
export default function ServiceSecretRefs({ server, service }: { server: Server; service: SwarmService }) {
  const { t } = useT();
  const confirm = useConfirm();
  const deployables = useDeploymentsStore((s) => s.deployables[server.id] ?? NADA);
  const loadDeployables = useDeploymentsStore((s) => s.loadDeployables);
  const deployable = deployables.find((d) => d.serviceName === service.name);
  const orgs = useOrgsStore((s) => s.orgs);
  const superadmin = useAuthStore((s) => !!s.session?.superadmin);
  const role = orgs.find((o) => o.id === server.orgId)?.role;
  const canEdit = superadmin || role === "admin";
  const canRotate = superadmin || (!!role && roleAtLeast(role, "member"));

  const [saved, setSaved] = useState<SecretRef[]>([]);
  const [rows, setRows] = useState<SecretRef[]>([]);
  const [rotations, setRotations] = useState<Rotation[]>([]);
  const [checks, setChecks] = useState<Record<string, string | true>>({});
  const [item, setItem] = useState("");
  const [busy, setBusy] = useState<"save" | "check" | "import" | "rotate" | null>(null);
  const [result, setResult] = useState<RotationResult | null>(null);

  const base = deployable ? `/api/v1/servers/${server.id}/deployables/${deployable.id}` : "";

  useEffect(() => {
    void loadDeployables(server.id).catch(() => {});
  }, [server.id, loadDeployables]);

  const load = useCallback(async () => {
    if (!base) return;
    const [refs, rots] = await Promise.all([
      api.get<APIResponse<SecretRef[]>>(`${base}/secret-refs`, true).catch(() => null),
      api.get<APIResponse<Rotation[]>>(`${base}/secret-rotations`, true).catch(() => null),
    ]);
    const list = (refs?.data ?? []).map((r) => ({ name: r.name, opRef: r.opRef }));
    setSaved(list);
    setRows(list);
    setRotations(rots?.data ?? []);
  }, [base]);

  useEffect(() => {
    setResult(null);
    setChecks({});
    void load();
  }, [load]);

  if (!deployable) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <KeyRound className="size-4" /> {t("common:secrets.title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t("common:secrets.notRegistered")}</p>
        </CardContent>
      </Card>
    );
  }

  const dirty = JSON.stringify(rows) !== JSON.stringify(saved);
  const names = rows.map((r) => r.name.trim());
  const invalid = rows.some((r) => !NAME.test(r.name.trim()) || !OP_REF.test(r.opRef.trim()));
  const repeated = new Set(names).size !== names.length;
  const deploysFromCac = deployable.onCINotify === "deploy";

  const save = async () => {
    setBusy("save");
    try {
      const res = await api.put<APIResponse<SecretRef[]>>(
        `${base}/secret-refs`,
        { refs: rows.map((r) => ({ name: r.name.trim(), opRef: r.opRef.trim() })) },
        true,
      );
      if (!res?.success) throw new Error(res?.error ?? "secret-refs");
      await load();
    } catch (e) {
      toast.error(phraseFor(e instanceof Error ? e.message : String(e), t("common:secrets.saveFailed")));
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setBusy("check");
    try {
      const out = await invoke<{ opRef: string; ok: boolean; error: string }[]>("check_op_refs", { refs: rows.map((r) => r.opRef.trim()) });
      setChecks(Object.fromEntries(out.map((c) => [c.opRef, c.ok ? true : c.error])));
    } finally {
      setBusy(null);
    }
  };

  const importItem = async () => {
    setBusy("import");
    try {
      const fields = await invoke<{ label: string; opRef: string }[]>("op_item_fields", { item: item.trim() });
      const have = new Set(rows.map((r) => r.name));
      const more = fields.map((f) => ({ name: labelToName(f.label), opRef: f.opRef })).filter((r) => NAME.test(r.name) && !have.has(r.name));
      setRows([...rows, ...more]);
      setItem("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const rotate = async () => {
    const ok = await confirm({
      title: t("common:secrets.rotateTitle", { service: service.name }),
      description: t("common:secrets.rotateBody", { names: saved.map((r) => r.name).join(", "), server: server.name }),
      confirmText: t("common:secrets.rotate"),
    });
    if (!ok) return;
    setBusy("rotate");
    setResult(null);
    const namesToRotate = saved.map((r) => r.name);
    try {
      const out = await invoke<RotationResult>("rotate_service_secrets", {
        target: { serverId: server.id, host: server.host, sshPort: server.sshPort, sshUser: server.sshUser },
        service: service.name,
        refs: saved,
      });
      setResult(out);
      await api
        .post(
          `${base}/secret-rotations`,
          { names: namesToRotate, versions: Object.fromEntries(out.items.map((i) => [i.name, i.secret])), status: "succeeded" },
          true,
        )
        .catch(() => {});
      toast.success(out.updated ? t("common:secrets.rotated") : t("common:secrets.unchanged"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await api.post(`${base}/secret-rotations`, { names: namesToRotate, versions: {}, status: "failed", error: msg }, true).catch(() => {});
      toast.error(t("common:secrets.rotateFailed"), { description: msg });
    } finally {
      setBusy(null);
      void load();
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="size-4" /> {t("common:secrets.title")}
        </CardTitle>
        <p className="text-xs text-muted-foreground">{t("common:secrets.lead")}</p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {rows.length === 0 && <p className="text-muted-foreground">{t("common:secrets.empty")}</p>}
        {rows.map((r, i) => {
          const c = checks[r.opRef.trim()];
          return (
            <div key={i} className="flex items-center gap-2">
              <Input
                aria-label={t("common:secrets.name")}
                className="w-48 font-mono text-xs"
                placeholder="DATABASE_URL"
                value={r.name}
                disabled={!canEdit}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              <Input
                aria-label={t("common:secrets.ref")}
                className="flex-1 font-mono text-xs"
                placeholder="op://vault/item/field"
                value={r.opRef}
                disabled={!canEdit}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, opRef: e.target.value } : x)))}
              />
              {c === true && <CheckCircle2 className="size-4 text-success" aria-label={t("common:secrets.resolves")} />}
              {typeof c === "string" && (
                <span title={c}>
                  <XCircle className="size-4 text-destructive" aria-label={t("common:secrets.doesNotResolve")} />
                </span>
              )}
              {canEdit && (
                <Button variant="ghost" size="sm" aria-label={t("common:secrets.remove")} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
          );
        })}

        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setRows([...rows, { name: "", opRef: "" }])}>
              <Plus className="mr-1 size-3.5" /> {t("common:secrets.add")}
            </Button>
            <Input
              aria-label={t("common:secrets.importItem")}
              className="h-8 min-w-48 flex-1 font-mono text-xs"
              placeholder="op://dwit/Web RRHH"
              value={item}
              onChange={(e) => setItem(e.target.value)}
            />
            <Button variant="outline" size="sm" disabled={!item.trim().startsWith("op://") || busy !== null} onClick={() => void importItem()}>
              <Download className="mr-1 size-3.5" /> {t("common:secrets.import")}
            </Button>
          </div>
        )}

        {(invalid || repeated) && rows.length > 0 && <p className="text-xs text-destructive">{t("common:secrets.invalid")}</p>}

        <div className="flex flex-wrap items-center gap-2">
          {canEdit && (
            <Button size="sm" disabled={!dirty || invalid || repeated || busy !== null} onClick={() => void save()}>
              {t("common:secrets.save")}
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={rows.length === 0 || busy !== null} onClick={() => void check()}>
            {busy === "check" && <Loader2 className="mr-1 size-3.5 animate-spin" />}
            {t("common:secrets.check")}
          </Button>
          <span className="flex-1" />
          {canRotate && (
            <Button
              variant="outline"
              size="sm"
              disabled={!deploysFromCac || dirty || saved.length === 0 || busy !== null}
              onClick={() => void rotate()}
            >
              {busy === "rotate" ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <RotateCw className="mr-1 size-3.5" />}
              {t("common:secrets.rotate")}
            </Button>
          )}
        </div>
        {!deploysFromCac && <p className="text-xs text-muted-foreground">{t("common:secrets.needsDeploy")}</p>}
        {dirty && deploysFromCac && <p className="text-xs text-muted-foreground">{t("common:secrets.saveFirst")}</p>}

        {result && (
          <ul className="rounded-md border p-2 font-mono text-xs">
            {result.items.map((i) => (
              <li key={i.name}>
                {i.name} → {i.secret} {i.changed ? `(${t("common:secrets.changed")})` : `(${t("common:secrets.same")})`}
              </li>
            ))}
          </ul>
        )}

        {rotations.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("common:secrets.history")}</p>
            <ul className="divide-y rounded-md border">
              {rotations.map((r) => (
                <li key={r.id} className="flex items-center gap-2 px-2 py-1 text-xs">
                  <Badge variant={r.status === "succeeded" ? "default" : "destructive"}>{t(`common:secrets.status.${r.status}`)}</Badge>
                  <span className="min-w-0 flex-1 truncate font-mono" title={r.error || r.names}>
                    {r.names.split(",").join(", ")}
                  </span>
                  <span className="text-muted-foreground">{[r.startedByName, desde(r.createdAt)].filter(Boolean).join(" · ")}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
