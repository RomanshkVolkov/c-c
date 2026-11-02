import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AnsiToHtml from "ansi-to-html";
import { Channel, invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { FolderOpen, ListOrdered, Loader2, Play, Square } from "lucide-react";
import { useT } from "@/lib/i18n";
import { api } from "@/lib/api";
import { desde } from "@/lib/desde";
import { finalStatus, logTail, playRecap } from "@/lib/ansible";
import { prefsOf, useProvisionStore } from "@/store/provision.store";
import { useConfirm } from "@/components/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import type { APIResponse } from "@/types/auth";
import type { AnsibleEvent, AnsibleManifest, AnsibleTools, InventoryHost, ProvisioningRun } from "@/types/ansible";
import type { EffectiveConfig, PlanGaps, ProvisioningRequest, StartedRun } from "@/types/server-config";
import { useServerContext } from "./ServerLayout";
import ServerConfigPanel, { stableJson } from "./ServerConfigPanel";
import ProvisioningRequests from "@/components/servers/ProvisioningRequests";
import { useOrgsStore } from "@/store/orgs.store";
import { useAuthStore } from "@/store/auth.store";
import Picker from "@/components/ui/picker";

const NADA: never[] = [];

/**
 * La ejecución que corre en **esta** carga de la página. Fuera del componente
 * a propósito: cambiar de pestaña lo desmonta, y una marca dentro volvería a
 * cero y haría pasar por huérfana una ejecución viva. Sólo una recarga la
 * pierde, que es justo cuando la ejecución sí se queda sin nadie.
 */
export const live: { backendRunId: string | null } = { backendRunId: null };

/** Cómo acabó algo que se lanzó: su estado, su código y su salida (tachada). */
type Ended = { status: "succeeded" | "failed" | "cancelled"; code: number | null; lines: string[] };

const projectName = (dir: string) => dir.split("/").filter(Boolean).pop() ?? "";

const VARIANTE: Record<ProvisioningRun["status"], "default" | "secondary" | "destructive" | "outline"> = {
  running: "secondary",
  succeeded: "default",
  failed: "destructive",
  cancelled: "outline",
  interrupted: "outline",
};

/** Las variables extra escritas a mano, una `nombre=valor` por línea. */
export function parseExtraVars(text: string): { vars: { name: string; value: string }[]; bad: string[] } {
  const vars: { name: string; value: string }[] = [];
  const bad: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf("=");
    const name = i > 0 ? line.slice(0, i).trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) bad.push(line);
    else vars.push({ name, value: line.slice(i + 1) });
  }
  return { vars, bad };
}

/**
 * Aplicar un playbook de Ansible a este servidor, desde esta máquina.
 *
 * Corre aquí y no en cac: las llaves ssh las da el agente de 1Password y los
 * secretos se leen con `op` en Rust, sin pasar por la pantalla. cac apunta
 * quién lo corrió, contra qué, con qué variables (sólo los nombres) y cómo
 * acabó, para que el resto del equipo lo vea.
 */
export default function ServerProvision() {
  const { t } = useT();
  const confirm = useConfirm();
  const { server } = useServerContext();
  const prefs = useProvisionStore((s) => prefsOf(s, server.id));
  const inFlight = useProvisionStore((s) => s.inFlight);
  const lines = useProvisionStore((s) => s.lines);
  const history = useProvisionStore((s) => s.history[server.id] ?? NADA);
  const { setPrefs, start, attach, push, finished, loadHistory, closeOrphan } = useProvisionStore.getState();
  // Aprobar una petición es de admin, como guardar la config (el backend lo
  // vuelve a exigir, y además en persona).
  const isAdmin = useOrgsStore((s) => s.orgs.find((o) => o.id === server.orgId)?.role === "admin");
  const superadmin = useAuthStore((s) => !!s.session?.superadmin);

  const [tools, setTools] = useState<AnsibleTools | null>(null);
  const [manifest, setManifest] = useState<AnsibleManifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [hosts, setHosts] = useState<InventoryHost[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState("");
  const [becomePw, setBecomePw] = useState("");
  const [starting, setStarting] = useState(false);
  const [effective, setEffective] = useState<EffectiveConfig | null>(null);
  const [gaps, setGaps] = useState<PlanGaps | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  // Sube para que la bandeja relea tras un ensayo o una ejecución.
  const [requestsKey, setRequestsKey] = useState(0);
  const log = useRef<HTMLPreElement>(null);
  // Si quien mira está al final de la salida, la salida le sigue; si subió a
  // leer algo, se queda donde está.
  const following = useRef(true);
  const converter = useMemo(() => new AnsiToHtml({ escapeXML: true }), []);

  // Algo que quedó a medias de antes (la app se cerró o se recargó).
  useEffect(() => {
    const f = useProvisionStore.getState().inFlight;
    if (f && f.backendRunId !== live.backendRunId) void closeOrphan().then(() => loadHistory(server.id));
  }, [server.id, closeOrphan, loadHistory]);

  useEffect(() => {
    void loadHistory(server.id).catch(() => {});
  }, [server.id, loadHistory]);

  // La config del servidor en cac, ya combinada con su plantilla: con lo que
  // corre un manifiesto v2.
  const loadEffective = useCallback(async () => {
    const res = await api.get<APIResponse<EffectiveConfig>>(`/api/v1/servers/${server.id}/config/effective`, true).catch(() => null);
    // Un backend de antes de la config en cac no tiene la ruta: sin efectiva.
    const d = res?.data;
    setEffective(d && typeof d === "object" && !Array.isArray(d) && "connection" in d ? d : null);
  }, [server.id]);

  useEffect(() => {
    void loadEffective();
  }, [loadEffective]);

  const loadProject = useCallback(async (dir: string) => {
    setManifest(null);
    setManifestError(null);
    setHosts([]);
    if (!dir) return;
    try {
      const m = await invoke<AnsibleManifest>("ansible_manifest", { projectDir: dir });
      setManifest(m);
      setTools(await invoke<AnsibleTools>("ansible_tools", { projectDir: dir, venv: m.venv ?? null }));
      if (m.inventory) {
        setHosts(
          await invoke<InventoryHost[]>("ansible_inventory", { projectDir: dir, inventory: m.inventory, venv: m.venv ?? null }).catch(
            () => [],
          ),
        );
      }
    } catch (e) {
      setManifestError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadProject(prefs.projectDir);
  }, [prefs.projectDir, loadProject]);

  // Sólo se desplaza el cuadro de la salida. Con `scrollIntoView` se
  // desplazaba también la página para enseñarlo, y durante una ejecución cada
  // línea te subía arriba (jose, 2-nov-2026).
  useEffect(() => {
    const el = log.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const playbook = manifest?.playbooks.find((p) => p.id === prefs.playbookId) ?? manifest?.playbooks[0];
  const v2 = manifest?.version === 2;

  // Qué le falta a la config para este playbook. Lo calcula Rust, con la
  // misma receta con la que correrá.
  useEffect(() => {
    setGaps(null);
    if (!v2 || !playbook || !effective) return;
    let alive = true;
    invoke<PlanGaps>("ansible_plan_gaps", { projectDir: prefs.projectDir, playbookId: playbook.id, effective })
      .then((g) => alive && setGaps(g))
      .catch(() => alive && setGaps(null));
    return () => {
      alive = false;
    };
  }, [v2, playbook, effective, prefs.projectDir]);
  const groups = useMemo(() => [...new Set(hosts.flatMap((h) => h.groups))].sort(), [hosts]);
  const extraParsed = parseExtraVars(extra);
  const missing = (playbook?.vars ?? []).filter((v) => v.required && !v.from && !values[v.name]?.trim());
  const needsBecomePw = !!playbook?.become && !playbook.becomePasswordRef;
  const busy = !!inFlight || starting;
  const canRun = v2
    ? !!playbook && !!tools?.ansiblePlaybook && !busy && !!effective && !!gaps && gaps.vars.length === 0 && gaps.secrets.length === 0
    : !!playbook && !!tools?.ansiblePlaybook && !busy && missing.length === 0 && extraParsed.bad.length === 0 && (!needsBecomePw || !!becomePw);

  const pickFolder = async () => {
    // Sin carpeta recordada, la de casa: sin `defaultPath`, GTK abre en el
    // directorio del proceso, que en la AppImage es su montaje en /tmp.
    const start = prefs.projectDir || (await homeDir().catch(() => undefined));
    const dir = await openDialog({ directory: true, multiple: false, defaultPath: start }).catch(() => null);
    if (typeof dir === "string") setPrefs(server.id, { projectDir: dir, playbookId: "" });
  };

  /**
   * Una ejecución, de principio a fin: se abre en cac, se lanza en Rust, se va
   * pintando la salida y se cierra en cac al acabar. Contesta en cuanto Rust
   * la lanzó (o falló al lanzarla); `ended` dice cómo acabó.
   *
   * «En marcha» se apunta **antes** de lanzar: un playbook que falla en el
   * acto avisa de que acabó antes de que Rust conteste, y apuntarlo después lo
   * dejaba «aplicando» para siempre y borraba la salida que ya había llegado.
   */
  const execute = async (
    startBody: Record<string, unknown> | null,
    launch: (channel: Channel<AnsibleEvent>) => Promise<string>,
  ): Promise<{ ended: Promise<Ended> }> => {
    // Sin cuerpo es un ensayo: no cambia nada, así que no se abre ejecución
    // en cac (lo que queda es la petición con su ensayo).
    let backendRunId = "";
    if (startBody) {
      const res = await api.post<APIResponse<ProvisioningRun>>(`/api/v1/servers/${server.id}/provisioning-runs`, startBody, true);
      if (!res?.success || !res.data) throw new Error(res?.error ?? "provisioning-runs");
      backendRunId = res.data.id;
    }
    live.backendRunId = backendRunId;
    start({ serverId: server.id, runId: "", backendRunId });

    let settle: (e: Ended) => void = () => {};
    const ended = new Promise<Ended>((r) => (settle = r));
    const channel = new Channel<AnsibleEvent>();
    let buffer: string[] = [];
    const flush = () => {
      if (buffer.length) push(buffer);
      buffer = [];
    };
    const timer = setInterval(flush, 150);
    channel.onmessage = (ev) => {
      if (ev.event === "line") {
        buffer.push(ev.data.text);
        return;
      }
      clearInterval(timer);
      flush();
      live.backendRunId = null;
      const all = useProvisionStore.getState().lines;
      const status = finalStatus(ev.data.code, ev.data.cancelled);
      finished();
      if (!backendRunId) {
        settle({ status, code: ev.data.code, lines: all });
        return;
      }
      if (status === "succeeded") toast.success(t("common:provision.done"));
      else if (status === "failed") toast.error(t("common:provision.failed", { code: ev.data.code ?? "?" }));
      // `ended` espera a que cac haya cerrado la ejecución: cerrarla es lo que
      // pasa la petición a «verificando», y la verificación que arranca justo
      // después la necesita ahí. Contestando antes, las dos peticiones se
      // cruzaban, la verificación llegaba primero (409) y la petición se
      // quedaba «verificando» sin verificación (jose, 2-nov-2026, swarm y k8s).
      void api
        .patch(
          `/api/v1/servers/${server.id}/provisioning-runs/${backendRunId}`,
          { status, exitCode: ev.data.code, summary: playRecap(all), logTail: logTail(all) },
          true,
        )
        .catch(() => {})
        .finally(() => {
          void loadHistory(server.id);
          settle({ status, code: ev.data.code, lines: all });
        });
    };

    const runId = await launch(channel).catch(async (e) => {
      clearInterval(timer);
      live.backendRunId = null;
      finished();
      if (backendRunId) {
        await api
          .patch(`/api/v1/servers/${server.id}/provisioning-runs/${backendRunId}`, { status: "failed", summary: String(e), logTail: "" }, true)
          .catch(() => {});
        void loadHistory(server.id);
      }
      throw e;
    });
    attach(backendRunId, runId);
    return { ended };
  };

  const run = async () => {
    if (!playbook || !manifest) return;
    if (v2) return rehearse([playbook.id]);
    const varNames = [...playbook.vars.map((v) => v.name), ...extraParsed.vars.map((v) => v.name)];
    const ok = await confirm({
      title: t("common:provision.confirmTitle", { playbook: playbook.name, server: server.name }),
      description: t("common:provision.confirmBody", {
        file: playbook.file,
        target: prefs.limit || t("common:provision.allHosts"),
        vars: varNames.length ? varNames.join(", ") : "—",
      }),
      confirmText: t("common:provision.run"),
    });
    if (!ok) return;

    setStarting(true);
    try {
      await execute(
        { kind: "playbook", project: projectName(prefs.projectDir), playbook: playbook.file, target: prefs.limit, varNames },
        (channel) =>
          invoke<string>("ansible_run", {
            spec: {
              projectDir: prefs.projectDir,
              venv: manifest.venv ?? null,
              playbook: playbook.file,
              inventory: manifest.inventory,
              limit: prefs.limit || null,
              vars: [
                ...playbook.vars.map((v) => ({ name: v.name, from: v.from ?? null, value: v.from ? null : values[v.name] ?? null, secret: v.secret })),
                ...extraParsed.vars.map((v) => ({ name: v.name, value: v.value, from: null, secret: false })),
              ],
              becomePassword: needsBecomePw ? becomePw : null,
              becomePasswordRef: playbook.becomePasswordRef ?? null,
            },
            onEvent: channel,
          }),
      );
      // La contraseña de sudo no se queda en pantalla más de lo necesario.
      setBecomePw("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  /**
   * Manifiesto v2: el protocolo, también en persona (jose, 1-nov: «un
   * simulacro siempre»). Aplicar es **ensayar y pedir**: por cada playbook se
   * abre una petición, se corre su ensayo (`--check --diff`, no cambia nada)
   * y cac lo evalúa con sus banderas. Lo aprueba un admin en la bandeja, y se
   * corre con `runGrant`. Es el mismo camino que `cac provision request`.
   *
   * La plantilla se ensaya en orden y para en el primer ensayo que falla: el
   * de una etapa puede fallar porque la anterior aún no está aplicada, y eso
   * también se dice.
   */
  const rehearse = async (ids: string[]) => {
    if (!manifest || !effective || ids.length === 0) return;
    const names = ids.map((id) => manifest.playbooks.find((p) => p.id === id)?.name ?? id);
    const ok = await confirm({
      title: t("common:provision.rehearseTitle", { playbook: names.join(" → "), server: server.name }),
      description: t("common:provision.rehearseBody", { seq: effective.configSeq, files: ids.join(" → ") }),
      confirmText: t("common:provision.rehearse"),
    });
    if (!ok) return;
    setStarting(true);
    try {
      for (const id of ids) {
        const pb = manifest.playbooks.find((p) => p.id === id);
        if (!pb) throw new Error(id);
        if (!pb.risk) throw new Error(t("common:provision.noRisk", { id }));
        const res = await api.post<APIResponse<ProvisioningRequest>>(
          `/api/v1/servers/${server.id}/provisioning-requests`,
          {
            playbook: id,
            project: projectName(prefs.projectDir),
            risk: pb.risk,
            verify: pb.verify ?? "",
            rollback: pb.rollback ?? "",
            configSeq: effective.configSeq,
            reason: "",
          },
          true,
        );
        if (!res?.success || !res.data) throw new Error(res?.error ?? "provisioning-requests");
        const checkPath = `/api/v1/servers/${server.id}/provisioning-requests/${res.data.id}/check`;
        const { ended } = await execute(null, (channel) =>
          invoke<StartedRun>("ansible_run_with_config", {
            projectDir: prefs.projectDir,
            playbookId: id,
            effective,
            check: true,
            onEvent: channel,
          }).then((r) => r.runId),
        ).catch(async (e) => {
          // El ensayo no llegó a arrancar (un secreto que no se lee, Ansible
          // que no está): la petición ya está abierta y, sin su ensayo, se
          // quedaba «ensayando» hasta caducar. Se cierra como ensayo fallido,
          // con el porqué, y no se puede aprobar sin reconocerlo.
          const report = await invoke<unknown>("ansible_check_report", { lines: [String(e instanceof Error ? e.message : e)], exitCode: -1 }).catch(() => null);
          if (report) await api.put(checkPath, report, true).catch(() => {});
          throw e;
        });
        const { status, code, lines: out } = await ended;
        if (status === "cancelled") throw new Error(t("common:provision.rehearseCancelled"));
        const report = await invoke<unknown>("ansible_check_report", { lines: out, exitCode: code ?? -1 });
        await api.put(checkPath, report, true);
        setRequestsKey((k) => k + 1);
        if (code !== 0) break;
      }
      toast.success(t("common:provision.rehearsed"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
      setRequestsKey((k) => k + 1);
    }
  };

  /**
   * Corre una petición autorizada: gasta la autorización (el backend comprueba
   * playbook, versión y caducidad) y, si acaba bien, corre su verificación. El
   * riesgo aprobado tiene que seguir siendo el del manifiesto; si cambió, se
   * pide otra vez (como `cac provision run --grant`).
   */
  const runGrant = async (req: ProvisioningRequest) => {
    if (!manifest) return;
    const pb = manifest.playbooks.find((p) => p.id === req.playbook);
    if (!pb || pb.risk !== req.risk) {
      toast.error(t("common:provision.riskChanged", { playbook: req.playbook }));
      return;
    }
    const ok = await confirm({
      title: t("common:provision.confirmTitle", {
        playbook: req.status === "verifying" ? (manifest.playbooks.find((p) => p.id === req.verify)?.name ?? req.verify) : pb.name,
        server: server.name,
      }),
      description:
        req.status === "verifying"
          ? t("common:provision.confirmVerifyOnly", { playbook: pb.name })
          : t("common:provision.confirmGrant", { seq: req.configSeq, verify: req.verify || "—" }),
      confirmText: t("common:provision.run"),
      destructive: req.risk === "destructive",
    });
    if (!ok) return;
    setStarting(true);
    try {
      const eff = await api.get<APIResponse<EffectiveConfig>>(`/api/v1/servers/${server.id}/config/effective?seq=${req.configSeq}`, true);
      const at = eff?.data;
      if (!at) throw new Error(eff?.error ?? "config/effective");
      const one = async (id: string) => {
        const p = manifest.playbooks.find((x) => x.id === id);
        const varNames = [...new Set([...(p?.vars ?? []).map((v) => v.name), ...Object.keys(at.vars)])].sort();
        const { ended } = await execute(
          {
            kind: "playbook",
            project: projectName(prefs.projectDir),
            // Con autorización, el backend la casa por el id del playbook.
            playbook: id,
            target: at.connection.name,
            varNames,
            configSeq: req.configSeq,
            requestId: req.id,
          },
          (channel) =>
            invoke<StartedRun>("ansible_run_with_config", {
              projectDir: prefs.projectDir,
              playbookId: id,
              effective: at,
              check: false,
              onEvent: channel,
            }).then((r) => r.runId),
        );
        return (await ended).status;
      };
      // Una que se quedó «verificando» sin verificación sólo corre la
      // verificación: el playbook ya se aplicó.
      if (req.status === "verifying") {
        if (req.verify) await one(req.verify);
        return;
      }
      const status = await one(req.playbook);
      if (status === "succeeded" && req.risk !== "read" && req.verify) await one(req.verify);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
      setRequestsKey((k) => k + 1);
    }
  };

  // Si Rust ya no la tiene (acabó, o nunca llegó a arrancar), no hay nada que
  // parar: se suelta aquí, que es lo único que quedaba colgado.
  const cancel = () => {
    if (!inFlight) return;
    const release = () => {
      live.backendRunId = null;
      finished();
    };
    if (!inFlight.runId) return release();
    void invoke("ansible_cancel", { runId: inFlight.runId }).catch(release);
  };

  return (
    <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <div className="space-y-4">
        {/* La carpeta primero: la plantilla, la config y los playbooks se leen de ella. */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">{t("common:provision.project")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex gap-2">
              <Input
                aria-label={t("common:provision.project")}
                className="font-mono text-xs"
                placeholder="~/projects/ansible/contabo"
                value={prefs.projectDir}
                onChange={(e) => setPrefs(server.id, { projectDir: e.target.value })}
              />
              <Button variant="outline" size="sm" onClick={() => void pickFolder()} aria-label={t("common:provision.pick")}>
                <FolderOpen className="size-4" />
              </Button>
            </div>
            {tools && !tools.platformSupported && <p className="text-destructive">{tools.reason}</p>}
            {tools?.platformSupported && !tools.ansiblePlaybook && <p className="text-destructive">{t("common:provision.noAnsible")}</p>}
            {manifestError && <p className="text-destructive">{manifestError}</p>}
            {manifest?.discovered && <p className="text-xs text-muted-foreground">{t("common:provision.noManifest")}</p>}
          </CardContent>
        </Card>
        {manifest && manifest.playbooks.length > 0 && playbook && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">{t("common:provision.playbook")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Picker
                aria-label={t("common:provision.playbook")}
                value={playbook.id}
                onChange={(v) => {
                  setPrefs(server.id, { playbookId: v });
                  setValues({});
                }}
                options={manifest.playbooks.map((p) => ({ value: p.id, label: p.name }))}
                className="w-full"
              />
              {playbook.description && <p className="text-xs text-muted-foreground">{playbook.description}</p>}

              {v2 ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    {effective && effective.configSeq > 0
                      ? t("common:provision.withConfig", { seq: effective.configSeq, host: `${effective.connection.sshUser}@${effective.connection.host}:${effective.connection.sshPort}` })
                      : t("common:provision.noConfig")}
                  </p>
                  {gaps && gaps.vars.length > 0 && (
                    <p className="text-xs text-destructive">{t("common:provision.missingVars", { names: gaps.vars.join(", ") })}</p>
                  )}
                  {gaps && gaps.secrets.length > 0 && (
                    <p className="text-xs text-destructive">{t("common:provision.missingSecrets", { names: gaps.secrets.join(", ") })}</p>
                  )}
                </div>
              ) : (
              <>
              <div className="space-y-1">
                <Label htmlFor="prov-limit" className="text-xs">{t("common:provision.target")}</Label>
                <Picker
                  id="prov-limit"
                  aria-label={t("common:provision.target")}
                  value={prefs.limit}
                  onChange={(v) => setPrefs(server.id, { limit: v })}
                  options={[
                    { value: "", label: `${t("common:provision.allHosts")}${playbook.hosts ? ` (${playbook.hosts})` : ""}` },
                    ...groups.map((g) => ({ value: g, label: t("common:provision.group", { name: g }) })),
                    ...hosts.map((h) => ({ value: h.name, label: `${h.name}${h.ansibleHost ? ` → ${h.ansibleHost}` : ""}` })),
                  ]}
                  className="w-full"
                />
              </div>

              {playbook.vars.map((v) => (
                <div key={v.name} className="space-y-1">
                  <Label htmlFor={`var-${v.name}`} className="font-mono text-xs">
                    {v.name}
                    {v.required && !v.from ? " *" : ""}
                  </Label>
                  {v.from ? (
                    <p className="truncate rounded-md border bg-muted px-2 py-1.5 font-mono text-xs text-muted-foreground" title={v.from}>
                      {t("common:provision.fromOp", { ref: v.from })}
                    </p>
                  ) : v.secret ? (
                    <PasswordInput id={`var-${v.name}`} value={values[v.name] ?? ""} onChange={(e) => setValues({ ...values, [v.name]: e.target.value })} />
                  ) : (
                    <Input id={`var-${v.name}`} value={values[v.name] ?? ""} onChange={(e) => setValues({ ...values, [v.name]: e.target.value })} />
                  )}
                  {v.description && <p className="text-xs text-muted-foreground">{v.description}</p>}
                </div>
              ))}

              {needsBecomePw && (
                <div className="space-y-1">
                  <Label htmlFor="prov-become" className="text-xs">{t("common:provision.becomePassword")}</Label>
                  <PasswordInput id="prov-become" value={becomePw} onChange={(e) => setBecomePw(e.target.value)} autoComplete="off" />
                </div>
              )}
              {playbook.become && playbook.becomePasswordRef && (
                <p className="text-xs text-muted-foreground">{t("common:provision.becomeFromOp", { ref: playbook.becomePasswordRef })}</p>
              )}

              <div className="space-y-1">
                <Label htmlFor="prov-extra" className="text-xs">{t("common:provision.extraVars")}</Label>
                <textarea
                  id="prov-extra"
                  className="min-h-16 w-full rounded-md border bg-background p-2 font-mono text-xs"
                  placeholder="nombre=valor"
                  value={extra}
                  onChange={(e) => setExtra(e.target.value)}
                />
                {extraParsed.bad.length > 0 && (
                  <p className="text-xs text-destructive">{t("common:provision.badVars", { lines: extraParsed.bad.join(", ") })}</p>
                )}
              </div>
              </>
              )}

              <div className="flex flex-wrap gap-2">
                <Button className="min-w-32 flex-1" disabled={!canRun} onClick={() => void run()}>
                  {busy ? <Loader2 className="mr-1 size-4 animate-spin" /> : <Play className="mr-1 size-4" />}
                  {busy ? t("common:provision.running") : t(v2 ? "common:provision.rehearse" : "common:provision.run")}
                </Button>
                {v2 && effective && effective.playbooks.length > 1 && (
                  <Button
                    variant="outline"
                    disabled={!tools?.ansiblePlaybook || busy || effective.missing.length > 0}
                    onClick={() => void rehearse(effective.playbooks)}
                    title={effective.playbooks.join(" → ")}
                  >
                    <ListOrdered className="mr-1 size-4" />
                    {t("common:provision.rehearseTemplate")}
                  </Button>
                )}
                {inFlight?.serverId === server.id && (
                  <Button variant="destructive" onClick={cancel}>
                    <Square className="mr-1 size-4" />
                    {t("common:provision.cancel")}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{t("common:provision.redactionNote")}</p>
            </CardContent>
          </Card>
        )}
        <ServerConfigPanel server={server} manifest={manifest} effective={effective} onChanged={() => void loadEffective()} />
      </div>

      <div className="min-w-0 space-y-4">
        {/* La salida se queda a la vista mientras se baja por la bandeja y el
            historial. */}
        <pre
          ref={log}
          aria-label={t("common:provision.output")}
          onScroll={(e) => {
            const el = e.currentTarget;
            following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className="z-10 max-h-[28rem] min-h-40 overflow-auto rounded-md bg-zinc-900 p-3 font-mono text-xs whitespace-pre text-zinc-100 lg:sticky lg:top-0"
        >
          {lines.length === 0 ? (
            <span className="text-zinc-400">{t("common:provision.noOutput")}</span>
          ) : (
            lines.map((l, i) => <div key={i} dangerouslySetInnerHTML={{ __html: converter.toHtml(l) }} />)
          )}
        </pre>

        <ProvisioningRequests
          server={server}
          canDecide={isAdmin || superadmin}
          refreshKey={requestsKey}
          onRun={v2 && tools?.ansiblePlaybook && !busy ? (r) => void runGrant(r) : undefined}
        />


        <div className="space-y-1">
          <p className="text-sm font-medium">{t("common:provision.history")}</p>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("common:provision.noHistory")}</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {history.map((r) => (
                <li key={r.id} className="space-y-1 px-3 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge variant={VARIANTE[r.status] ?? "outline"}>{t(`common:provision.status.${r.status}`)}</Badge>
                    <span className="font-mono text-xs">{r.playbook}</span>
                    {r.target && <span className="text-xs text-muted-foreground">→ {r.target}</span>}
                    {!!r.configSeq && (
                      <button type="button" className="text-xs text-muted-foreground hover:underline" onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>
                        {t("common:provision.configVersion", { seq: r.configSeq })}
                      </button>
                    )}
                    {r.source === "cli" && <Badge variant="outline">{t("common:provision.fromTerminal")}</Badge>}
                    <span className="flex-1" />
                    <span className="text-xs text-muted-foreground">
                      {[r.startedByName, desde(r.startedAt)].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                  {r.summary && <pre className="overflow-x-auto font-mono text-[11px] text-muted-foreground">{r.summary}</pre>}
                  {openRun === r.id && r.applied && (
                    <pre className="max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-[11px]" aria-label={t("common:provision.applied")}>
                      {stableJson(r.applied)}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
