import { ENV_REF, envImportRows, envsIn, loadMounts, saveMount } from "@/lib/op-env";
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { CheckCircle2, Copy, Download, FileSearch, KeyRound, Loader2, Plus, RotateCw, Trash2, XCircle } from "lucide-react";
import { SECRETS_ENTRYPOINT_SNIPPET, mergeBuildArgs } from "@/lib/deploy";
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
import Picker from "@/components/ui/picker";
import type { APIResponse } from "@/types/auth";
import type { Server } from "@/types/server";
import type { SwarmService } from "@/types/swarm";

/** Dónde se usa un secret: la app en marcha, el build en el servidor, o los dos. */
type SecretUsage = "runtime" | "build" | "both";

interface SecretRef {
  name: string;
  opRef: string;
  usage?: SecretUsage;
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
/** Una referencia válida: un ítem (`op://`) o un Environment (`op-env://`). */
const isRef = (r: string) => OP_REF.test(r) || ENV_REF.test(r);

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
  // Los Environments de 1Password: cuál importar y dónde está montado en esta
  // máquina (ver `lib/op-env`).
  const [mounts, setMounts] = useState<Record<string, string>>(() => loadMounts());
  const [envName, setEnvName] = useState("");
  const [envPath, setEnvPath] = useState("");
  const [busy, setBusy] = useState<"save" | "check" | "import" | "rotate" | "args" | "capture" | null>(null);
  // Dónde guardar lo que ya corre (la primera vez): la bóveda de lo que ya hay
  // o la de siempre, y un ítem con el repo y el entorno.
  const [captureVault, setCaptureVault] = useState("");
  const [captureTitle, setCaptureTitle] = useState("");
  // Por dónde va una rotación: leer 1Password tarda, y luego el servidor
  // reinicia el servicio. Lo cuenta Rust (`secrets://rotation`).
  const [progress, setProgress] = useState<{ step: "read" | "upload"; done: number; total: number } | null>(null);
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
    const list = (refs?.data ?? []).map((r) => ({ name: r.name, opRef: r.opRef, usage: r.usage ?? "runtime" }));
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
  // Qué le pasa a cada fila, para marcarla y decirlo: un aviso general sin
  // decir cuál obligaba a revisar treinta filas a ojo.
  const badName = (r: SecretRef) => !NAME.test(r.name.trim());
  const badRef = (r: SecretRef) => !isRef(r.opRef.trim());
  const repeatedName = (r: SecretRef) => names.filter((n) => n === r.name.trim()).length > 1;
  const invalid = rows.some((r) => badName(r) || badRef(r));
  const repeated = new Set(names).size !== names.length;
  const problems = rows
    .map((r) => {
      const label = r.name.trim() || t("common:secrets.unnamed");
      if (badName(r)) return t("common:secrets.problemName", { name: label });
      if (repeatedName(r)) return t("common:secrets.problemRepeated", { name: label });
      if (badRef(r)) return t("common:secrets.problemRef", { name: label });
      return null;
    })
    .filter((p, i, all): p is string => !!p && all.indexOf(p) === i);
  const deploysFromCac = deployable.onCINotify === "deploy";

  const save = async () => {
    setBusy("save");
    try {
      const res = await api.put<APIResponse<SecretRef[]>>(
        `${base}/secret-refs`,
        { refs: rows.map((r) => ({ name: r.name.trim(), opRef: r.opRef.trim(), usage: r.usage ?? "runtime" })) },
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
      const out = await invoke<{ opRef: string; ok: boolean; error: string }[]>("check_op_refs", {
        refs: rows.map((r) => r.opRef.trim()),
        envFiles: mounts,
      });
      setChecks(Object.fromEntries(out.map((c) => [c.opRef, c.ok ? true : c.error])));
    } finally {
      setBusy(null);
    }
  };

  // Los `ARG` del Dockerfile del servicio (en su rama), cruzados con la
  // lista: uno que ya está como secret de la app pasa a «los dos»; uno que
  // falta se añade como «el build», sin referencia, para ponérsela. Es lo que
  // antes se hacía a ojo con el Dockerfile abierto al lado.
  const readBuildArgs = async () => {
    setBusy("args");
    try {
      const res = await api.get<APIResponse<string[]>>(`${base}/build-args`, true);
      if (!res?.success) throw new Error(res?.error ?? "build-args");
      const args = res.data ?? [];
      const { rows: next, added, promoted } = mergeBuildArgs(rows, args);
      setRows(next);
      toast.success(t("common:secrets.argsMerged", { count: args.length, added, promoted }));
    } catch (e) {
      toast.error(phraseFor(e instanceof Error ? e.message : String(e), t("common:secrets.argsFailed")));
    } finally {
      setBusy(null);
    }
  };

  // La primera vez: lo que el CI dejó como variables de entorno del servicio,
  // a un ítem nuevo de 1Password con un campo por variable. Rust lo lee por
  // ssh y se lo da a `op`; aquí sólo vuelven los nombres.
  const vaultGuess = captureVault || rows.find((r) => r.opRef.startsWith("op://"))?.opRef.split("/")[2] || "";
  const titleGuess =
    captureTitle || [deployable?.repoFullName.split("/")[1] || service.name, deployable?.environment].filter(Boolean).join(" ");
  const capture = async () => {
    const vault = vaultGuess.trim();
    const title = titleGuess.trim();
    const ok = await confirm({
      title: t("common:secrets.captureTitle", { service: service.name }),
      description: t("common:secrets.captureBody", { service: service.name, server: server.name, item: `op://${vault}/${title}` }),
      confirmText: t("common:secrets.capture"),
    });
    if (!ok) return;
    setBusy("capture");
    try {
      const out = await invoke<{ item: string; names: string[] }>("capture_service_env", {
        target: { serverId: server.id, host: server.host, sshPort: server.sshPort, sshUser: server.sshUser },
        service: service.name,
        vault,
        title,
      });
      const have = new Set(rows.map((r) => r.name.trim()));
      const more = out.names
        .filter((n) => !have.has(n))
        .map((n) => ({ name: n, opRef: `${out.item}/${n}`, usage: "runtime" as const }));
      setRows([...rows, ...more]);
      toast.success(t("common:secrets.captured", { count: out.names.length, item: out.item }));
    } catch (e) {
      toast.error(t("common:secrets.captureFailed"), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const importItem = async () => {
    setBusy("import");
    try {
      const fields = await invoke<{ label: string; opRef: string }[]>("op_item_fields", { item: item.trim() });
      const have = new Set(rows.map((r) => r.name));
      const more = fields
        .map((f) => ({ name: labelToName(f.label), opRef: f.opRef, usage: "runtime" as const }))
        .filter((r) => NAME.test(r.name) && !have.has(r.name));
      setRows([...rows, ...more]);
      setItem("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  // Un Environment de 1Password, del `.env` que 1Password monta en esta
  // máquina: sólo los nombres de sus variables, que pasan a ser filas.
  const importEnv = async () => {
    const env = envName.trim();
    const path = envPath.trim();
    setBusy("import");
    try {
      const names = await invoke<string[]>("env_file_names", { path });
      setMounts(saveMount(env, path));
      const more = envImportRows(env, names, new Set(rows.map((r) => r.name.trim())));
      setRows([...rows, ...more]);
      toast.success(t("common:secrets.envImported", { count: more.length, env }));
    } catch (e) {
      toast.error(t("common:secrets.envFailed"), { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };
  // Los Environments que usan los secrets y no están montados en esta máquina:
  // sin la ruta, ni probar ni rotar pueden leerlos.
  const unmounted = envsIn(rows.map((r) => r.opRef)).filter((e) => !mounts[e]);

  const rotate = async () => {
    const ok = await confirm({
      title: t("common:secrets.rotateTitle", { service: service.name }),
      description: t("common:secrets.rotateBody", { names: saved.map((r) => r.name).join(", "), server: server.name }),
      confirmText: t("common:secrets.rotate"),
    });
    if (!ok) return;
    setBusy("rotate");
    setResult(null);
    setProgress({ step: "read", done: 0, total: saved.length });
    const namesToRotate = saved.map((r) => r.name);
    // Fuera del escritorio (y en las pruebas) no hay eventos de Rust: la
    // rotación va igual, sin el progreso.
    const unlisten = await import("@tauri-apps/api/event")
      .then(({ listen }) => listen<{ step: "read" | "upload"; done: number; total: number }>("secrets://rotation", (e) => setProgress(e.payload)))
      .catch(() => () => {});
    try {
      const out = await invoke<RotationResult>("rotate_service_secrets", {
        target: { serverId: server.id, host: server.host, sshPort: server.sshPort, sshUser: server.sshUser },
        service: service.name,
        refs: saved,
        envFiles: mounts,
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
      unlisten();
      setProgress(null);
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
        {/* Cómo los lee la app: los secrets llegan como ficheros, y casi todo
            espera variables de entorno. */}
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            {t("common:secrets.bridgeTitle")}
          </summary>
          <p className="mt-1 text-muted-foreground">{t("common:secrets.bridgeLead")}</p>
          <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px]">{SECRETS_ENTRYPOINT_SNIPPET}</pre>
          <Button
            variant="outline"
            size="sm"
            className="mt-1 h-7 text-xs"
            onClick={() =>
              void navigator.clipboard
                .writeText(SECRETS_ENTRYPOINT_SNIPPET)
                .then(() => toast.success(t("common:secrets.bridgeCopied")))
                .catch(() => {})
            }
          >
            <Copy className="mr-1 size-3" /> {t("common:secrets.bridgeCopy")}
          </Button>
        </details>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {rows.length === 0 && <p className="text-muted-foreground">{t("common:secrets.empty")}</p>}
        {rows.map((r, i) => {
          const c = checks[r.opRef.trim()];
          return (
            <div key={i} className="flex items-center gap-2">
              <Input
                aria-label={t("common:secrets.name")}
                aria-invalid={badName(r) || repeatedName(r) || undefined}
                className={`w-48 font-mono text-xs ${badName(r) || repeatedName(r) ? "border-destructive" : ""}`}
                placeholder="DATABASE_URL"
                value={r.name}
                disabled={!canEdit}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              <Input
                aria-label={t("common:secrets.ref")}
                aria-invalid={badRef(r) || undefined}
                className={`flex-1 font-mono text-xs ${badRef(r) ? "border-destructive" : ""}`}
                placeholder="op://vault/item/field"
                value={r.opRef}
                disabled={!canEdit}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, opRef: e.target.value } : x)))}
              />
              {/* Un build arg (`build`) no se cuelga del servicio en marcha:
                  sólo lo monta el job que construye. `DATABASE_URL` de un Next
                  con prerender suele ser de los dos. */}
              <Picker
                aria-label={t("common:secrets.usage")}
                value={r.usage ?? "runtime"}
                disabled={!canEdit}
                onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, usage: v as SecretUsage } : x)))}
                options={[
                  { value: "runtime", label: t("common:secrets.usageRuntime") },
                  { value: "build", label: t("common:secrets.usageBuild") },
                  { value: "both", label: t("common:secrets.usageBoth") },
                ]}
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

        {unmounted.map((env) => (
          <MountRow key={env} env={env} onMount={(path) => setMounts(saveMount(env, path))} />
        ))}

        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setRows([...rows, { name: "", opRef: "", usage: "runtime" }])}>
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
            {/* Las variables de un Environment de 1Password, del `.env` que
                1Password monta en esta máquina (en su app: el Environment →
                Destinos → «Fichero .env local»). */}
            <div className="flex w-full flex-wrap items-center gap-2">
              <Input
                aria-label={t("common:secrets.envName")}
                className="h-8 w-40 text-xs"
                placeholder={t("common:secrets.envName")}
                value={envName}
                onChange={(e) => {
                  setEnvName(e.target.value);
                  if (!envPath && mounts[e.target.value.trim()]) setEnvPath(mounts[e.target.value.trim()]);
                }}
              />
              <Input
                aria-label={t("common:secrets.envPath")}
                className="h-8 min-w-48 flex-1 font-mono text-xs"
                placeholder="~/.config/1password/rrhh-prod.env"
                value={envPath}
                onChange={(e) => setEnvPath(e.target.value)}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={!envName.trim() || !envPath.trim() || busy !== null}
                onClick={() => void importEnv()}
              >
                <Download className="mr-1 size-3.5" /> {t("common:secrets.envImport")}
              </Button>
            </div>
            {deployable.buildOnHost && (
              <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void readBuildArgs()}>
                {busy === "args" ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <FileSearch className="mr-1 size-3.5" />}
                {t("common:secrets.readArgs")}
              </Button>
            )}
          </div>
        )}

        {canEdit && (
          <details className="rounded-md border p-2 text-xs">
            <summary className="cursor-pointer font-medium">{t("common:secrets.captureSummary")}</summary>
            <p className="mt-1 text-muted-foreground">{t("common:secrets.captureLead")}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Input
                aria-label={t("common:secrets.captureVault")}
                className="h-8 w-40 font-mono text-xs"
                placeholder={t("common:secrets.captureVault")}
                value={vaultGuess}
                onChange={(e) => setCaptureVault(e.target.value)}
              />
              <Input
                aria-label={t("common:secrets.captureItem")}
                className="h-8 min-w-48 flex-1 font-mono text-xs"
                placeholder={t("common:secrets.captureItem")}
                value={titleGuess}
                onChange={(e) => setCaptureTitle(e.target.value)}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null || !vaultGuess.trim() || !titleGuess.trim()}
                onClick={() => void capture()}
              >
                {busy === "capture" ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Download className="mr-1 size-3.5" />}
                {t("common:secrets.capture")}
              </Button>
            </div>
          </details>
        )}

        {(invalid || repeated) && rows.length > 0 && (
          <div className="text-xs text-destructive">
            <p>{t("common:secrets.invalid")}</p>
            <ul className="mt-1 list-disc pl-4">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}

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
          {busy === "rotate" && progress && (
            <span className="text-xs text-muted-foreground" role="status">
              {progress.step === "read"
                ? t("common:secrets.progressRead", { done: progress.done, total: progress.total })
                : t("common:secrets.progressUpload", { service: service.name })}
            </span>
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

/**
 * Un Environment que usan los secrets y no está montado en esta máquina: se
 * dice, y se pone aquí mismo dónde está su `.env`. Sin eso, probar y rotar no
 * pueden leerlo.
 */
function MountRow({ env, onMount }: { env: string; onMount: (path: string) => void }) {
  const { t } = useT();
  const [path, setPath] = useState("");
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
      <span className="text-warning">{t("common:secrets.envNotMounted", { env })}</span>
      <Input
        aria-label={t("common:secrets.envPath")}
        className="h-7 min-w-48 flex-1 font-mono text-xs"
        placeholder="~/.config/1password/rrhh-prod.env"
        value={path}
        onChange={(e) => setPath(e.target.value)}
      />
      <Button size="xs" variant="outline" disabled={!path.trim()} onClick={() => onMount(path.trim())}>
        {t("common:secrets.envMount")}
      </Button>
    </div>
  );
}
