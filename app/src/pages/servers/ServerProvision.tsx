import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AnsiToHtml from "ansi-to-html";
import { Channel, invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { FolderOpen, Loader2, Play, Square } from "lucide-react";
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
import { useServerContext } from "./ServerLayout";

const NADA: never[] = [];

/**
 * La ejecución que corre en **esta** carga de la página. Fuera del componente
 * a propósito: cambiar de pestaña lo desmonta, y una marca dentro volvería a
 * cero y haría pasar por huérfana una ejecución viva. Sólo una recarga la
 * pierde, que es justo cuando la ejecución sí se queda sin nadie.
 */
export const live: { runId: string | null } = { runId: null };

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
  const { setPrefs, start, push, finished, loadHistory, closeOrphan } = useProvisionStore.getState();

  const [tools, setTools] = useState<AnsibleTools | null>(null);
  const [manifest, setManifest] = useState<AnsibleManifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [hosts, setHosts] = useState<InventoryHost[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState("");
  const [becomePw, setBecomePw] = useState("");
  const [starting, setStarting] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const converter = useMemo(() => new AnsiToHtml({ escapeXML: true }), []);

  // Algo que quedó a medias de antes (la app se cerró o se recargó).
  useEffect(() => {
    const f = useProvisionStore.getState().inFlight;
    if (f && f.runId !== live.runId) void closeOrphan().then(() => loadHistory(server.id));
  }, [server.id, closeOrphan, loadHistory]);

  useEffect(() => {
    void loadHistory(server.id).catch(() => {});
  }, [server.id, loadHistory]);

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

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);

  const playbook = manifest?.playbooks.find((p) => p.id === prefs.playbookId) ?? manifest?.playbooks[0];
  const groups = useMemo(() => [...new Set(hosts.flatMap((h) => h.groups))].sort(), [hosts]);
  const extraParsed = parseExtraVars(extra);
  const missing = (playbook?.vars ?? []).filter((v) => v.required && !v.from && !values[v.name]?.trim());
  const needsBecomePw = !!playbook?.become && !playbook.becomePasswordRef;
  const busy = !!inFlight || starting;
  const canRun =
    !!playbook && !!tools?.ansiblePlaybook && !busy && missing.length === 0 && extraParsed.bad.length === 0 && (!needsBecomePw || !!becomePw);

  const pickFolder = async () => {
    const dir = await openDialog({ directory: true, multiple: false, defaultPath: prefs.projectDir || undefined }).catch(() => null);
    if (typeof dir === "string") setPrefs(server.id, { projectDir: dir, playbookId: "" });
  };

  const run = async () => {
    if (!playbook || !manifest) return;
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
      const res = await api.post<APIResponse<ProvisioningRun>>(
        `/api/v1/servers/${server.id}/provisioning-runs`,
        { kind: "playbook", project: prefs.projectDir.split("/").filter(Boolean).pop() ?? "", playbook: playbook.file, target: prefs.limit, varNames },
        true,
      );
      if (!res?.success || !res.data) throw new Error(res?.error ?? "provisioning-runs");
      const backendRunId = res.data.id;

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
        live.runId = null;
        const all = useProvisionStore.getState().lines;
        const status = finalStatus(ev.data.code, ev.data.cancelled);
        finished();
        void api
          .patch(
            `/api/v1/servers/${server.id}/provisioning-runs/${backendRunId}`,
            { status, exitCode: ev.data.code, summary: playRecap(all), logTail: logTail(all) },
            true,
          )
          .catch(() => {})
          .finally(() => void loadHistory(server.id));
        if (status === "succeeded") toast.success(t("common:provision.done"));
        else if (status === "failed") toast.error(t("common:provision.failed", { code: ev.data.code ?? "?" }));
      };

      const runId = await invoke<string>("ansible_run", {
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
      }).catch(async (e) => {
        clearInterval(timer);
        await api
          .patch(`/api/v1/servers/${server.id}/provisioning-runs/${backendRunId}`, { status: "failed", summary: String(e), logTail: "" }, true)
          .catch(() => {});
        void loadHistory(server.id);
        throw e;
      });
      live.runId = runId;
      start({ serverId: server.id, runId, backendRunId });
      // La contraseña de sudo no se queda en pantalla más de lo necesario.
      setBecomePw("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const cancel = () => {
    if (inFlight) void invoke("ansible_cancel", { runId: inFlight.runId }).catch(() => {});
  };

  return (
    <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <div className="space-y-4">
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
              <select
                aria-label={t("common:provision.playbook")}
                className="h-9 w-full rounded-md border bg-background px-2"
                value={playbook.id}
                onChange={(e) => {
                  setPrefs(server.id, { playbookId: e.target.value });
                  setValues({});
                }}
              >
                {manifest.playbooks.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {playbook.description && <p className="text-xs text-muted-foreground">{playbook.description}</p>}

              <div className="space-y-1">
                <Label htmlFor="prov-limit" className="text-xs">{t("common:provision.target")}</Label>
                <select
                  id="prov-limit"
                  className="h-9 w-full rounded-md border bg-background px-2"
                  value={prefs.limit}
                  onChange={(e) => setPrefs(server.id, { limit: e.target.value })}
                >
                  <option value="">{t("common:provision.allHosts")}{playbook.hosts ? ` (${playbook.hosts})` : ""}</option>
                  {groups.map((g) => (
                    <option key={`g:${g}`} value={g}>
                      {t("common:provision.group", { name: g })}
                    </option>
                  ))}
                  {hosts.map((h) => (
                    <option key={`h:${h.name}`} value={h.name}>
                      {h.name}
                      {h.ansibleHost ? ` → ${h.ansibleHost}` : ""}
                    </option>
                  ))}
                </select>
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

              <div className="flex gap-2">
                <Button className="flex-1" disabled={!canRun} onClick={() => void run()}>
                  {busy ? <Loader2 className="mr-1 size-4 animate-spin" /> : <Play className="mr-1 size-4" />}
                  {busy ? t("common:provision.running") : t("common:provision.run")}
                </Button>
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
      </div>

      <div className="min-w-0 space-y-4">
        <pre className="max-h-[28rem] min-h-40 overflow-auto rounded-md bg-zinc-900 p-3 font-mono text-xs whitespace-pre text-zinc-100">
          {lines.length === 0 ? (
            <span className="text-zinc-400">{t("common:provision.noOutput")}</span>
          ) : (
            lines.map((l, i) => <div key={i} dangerouslySetInnerHTML={{ __html: converter.toHtml(l) }} />)
          )}
          <div ref={bottom} />
        </pre>

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
                    <span className="flex-1" />
                    <span className="text-xs text-muted-foreground">
                      {[r.startedByName, desde(r.startedAt)].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                  {r.summary && <pre className="overflow-x-auto font-mono text-[11px] text-muted-foreground">{r.summary}</pre>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
