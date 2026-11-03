import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { useT } from "@/lib/i18n";
import { api } from "@/lib/api";
import { desde } from "@/lib/desde";
import { horaCorta } from "@/lib/fechas";
import { copyText } from "@/lib/clipboard";
import { useConfirm } from "@/components/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAuthStore } from "@/store/auth.store";
import type { APIResponse } from "@/types/auth";
import type { ProvisioningRequest, RiskFlag } from "@/types/server-config";

/** Estados en los que algo puede seguir moviéndose: se refresca solo. */
const LIVE = new Set(["checking", "awaiting_approval", "approved", "running", "verifying"]);

const RISK_VARIANT: Record<ProvisioningRequest["risk"], "secondary" | "default" | "destructive"> = {
  read: "secondary",
  change: "default",
  destructive: "destructive",
};

const FLAG_DOT: Record<RiskFlag["level"], string> = {
  red: "bg-destructive",
  amber: "bg-amber-500",
  info: "bg-muted-foreground",
};

/**
 * Pasado esto, una petición que sigue «ensayando» ya no la ensaya nadie: la
 * app se cerró, se cayó la red o el backend rechazó el ensayo. Un ensayo de
 * etapa tarda unos minutos; quince es holgado.
 */
export const STALE_CHECK_MS = 15 * 60_000;

/** Se quedó sin ensayo: se enseña así y se puede descartar. */
export function isStale(req: Pick<ProvisioningRequest, "status" | "createdAt">, now = Date.now()): boolean {
  return req.status === "checking" && now - new Date(req.createdAt).getTime() > STALE_CHECK_MS;
}

/** De las cerradas, cuántas se ven sin pedirlo: las últimas. */
export const RECENT_CLOSED = 3;

/**
 * Lo que se ve de la bandeja: todas las abiertas (lo que espera algo de
 * alguien) y las últimas cerradas; el resto, tras «Ver las anteriores». Con
 * todas a la vista, las descartadas y rechazadas de un simulacro empujaban el
 * playbook fuera de la pantalla (jose, 2-nov-2026).
 */
export function visibleRequests(all: ProvisioningRequest[], showAll: boolean): { shown: ProvisioningRequest[]; hidden: number } {
  const open = all.filter((r) => LIVE.has(r.status));
  const closed = all.filter((r) => !LIVE.has(r.status));
  const keep = showAll ? closed : closed.slice(0, RECENT_CLOSED);
  const ids = new Set([...open, ...keep].map((r) => r.id));
  return { shown: all.filter((r) => ids.has(r.id)), hidden: closed.length - keep.length };
}

/** El comando con el que se corre una petición autorizada. */
export function grantCommand(serverName: string, id: string): string {
  return `cac provision run --server '${serverName.replace(/'/g, "'\\''")}' --grant ${id}`;
}

/**
 * Lo que hace falta para aprobar, según el protocolo: el nombre del servidor
 * escrito a mano si es destructivo, y reconocer las banderas rojas si las hay.
 * Puro, para probarlo sin pantalla; el backend lo vuelve a exigir.
 */
export function canApprove(req: Pick<ProvisioningRequest, "risk" | "flags">, serverName: string, typed: string, acknowledged: boolean): boolean {
  if (req.risk === "destructive" && typed !== serverName) return false;
  if (req.flags.some((f) => f.level === "red") && !acknowledged) return false;
  return true;
}

function isRequest(x: unknown): x is ProvisioningRequest {
  const r = x as ProvisioningRequest;
  return !!r && typeof r.id === "string" && typeof r.status === "string" && Array.isArray(r.flags);
}

/**
 * La bandeja de peticiones de ejecución de un servidor (decisión 4d28f4ab).
 * Un agente pide; aquí una persona ve el ensayo y sus banderas, y aprueba o
 * rechaza. **Sólo aquí**: el backend no deja decidir con un token. También en
 * un servidor de pruebas: allí es un simulacro, con el mismo protocolo.
 */
export default function ProvisioningRequests({
  server,
  canDecide,
  onRun,
  refreshKey = 0,
}: {
  server: { id: string; name: string };
  canDecide: boolean;
  /** Correr una autorizada desde aquí (la app, manifiesto v2). Sin él, sólo el comando. */
  onRun?: (req: ProvisioningRequest) => void;
  /** Sube cuando la pestaña ensayó o corrió algo: se relee. */
  refreshKey?: number;
}) {
  const { t } = useT();
  const [requests, setRequests] = useState<ProvisioningRequest[]>([]);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get<APIResponse<unknown>>(`/api/v1/servers/${server.id}/provisioning-requests`, true).catch(() => null);
    const data = res?.data;
    setRequests(Array.isArray(data) ? data.filter(isRequest) : []);
  }, [server.id]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const anyLive = requests.some((r) => LIVE.has(r.status) && !isStale(r));
  useEffect(() => {
    if (!anyLive) return;
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [anyLive, load]);

  if (requests.length === 0) return null;
  const { shown, hidden } = visibleRequests(requests, showAll);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{t("common:provisionRequests.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {shown.map((r) => (
          <RequestRow key={r.id} req={r} server={server} canDecide={canDecide} onRun={onRun} onChanged={() => void load()} />
        ))}
        {(hidden > 0 || showAll) && (
          <Button variant="ghost" size="sm" className="h-7 w-full text-xs" onClick={() => setShowAll((v) => !v)}>
            {showAll ? t("common:provisionRequests.showFewer") : t("common:provisionRequests.showOlder", { count: hidden })}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function RequestRow({
  req,
  server,
  canDecide,
  onRun,
  onChanged,
}: {
  req: ProvisioningRequest;
  server: { id: string; name: string };
  canDecide: boolean;
  onRun?: (req: ProvisioningRequest) => void;
  onChanged: () => void;
}) {
  const { t } = useT();
  const confirm = useConfirm();
  const [showDiff, setShowDiff] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [note, setNote] = useState("");
  const [typed, setTyped] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const red = req.flags.some((f) => f.level === "red");
  const awaiting = req.status === "awaiting_approval";
  const me = useAuthStore((s) => s.session?.id);
  const stale = isStale(req);
  // La descarta quien la pidió (su agente, con su token, también) o un admin;
  // el backend lo vuelve a mirar.
  const canDiscard = stale && (canDecide || (!!me && req.requestedBy === me));
  // Volver a verificar, con la misma regla que descartar. Sólo repite la
  // verificación; la petición la cierra lo que esa diga.
  const canReverify = req.status === "verify_failed" && !!req.verify && (canDecide || (!!me && req.requestedBy === me));

  const discard = async () => {
    const ok = await confirm({
      title: t("common:provisionRequests.discardTitle", { playbook: req.playbook }),
      description: t("common:provisionRequests.discardBody"),
      confirmText: t("common:provisionRequests.discard"),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.post(`/api/v1/servers/${server.id}/provisioning-requests/${req.id}/discard`, {}, true);
      toast.success(t("common:provisionRequests.discarded"));
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reverify = async () => {
    const ok = await confirm({
      title: t("common:provisionRequests.reverifyTitle", { verify: req.verify }),
      description: t("common:provisionRequests.reverifyBody"),
      confirmText: t("common:provisionRequests.reverify"),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.post(`/api/v1/servers/${server.id}/provisioning-requests/${req.id}/reverify`, {}, true);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (approve: boolean) => {
    if (approve) {
      const ok = await confirm({
        title: t("common:provisionRequests.approveTitle", { playbook: req.playbook, server: server.name }),
        description: t("common:provisionRequests.approveBody", { seq: req.configSeq, minutes: 15 }),
        confirmText: t("common:provisionRequests.approve"),
        destructive: req.risk === "destructive",
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await api.post(
        `/api/v1/servers/${server.id}/provisioning-requests/${req.id}/decision`,
        { approve, note: note.trim(), confirmServer: typed, acknowledgeFlags: ack },
        true,
      );
      toast.success(t(approve ? "common:provisionRequests.approved" : "common:provisionRequests.rejected"));
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const check = req.check;
  return (
    <div className="space-y-2 rounded-md border p-2" data-testid={`request-${req.id}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-xs">{req.playbook}</span>
        <Badge variant={RISK_VARIANT[req.risk]}>{t(`common:provisionRequests.risk.${req.risk}`)}</Badge>
        <Badge variant="outline">{stale ? t("common:provisionRequests.staleBadge") : t(`common:provisionRequests.status.${req.status}`)}</Badge>
        {req.autoApproved && <Badge variant="secondary">{t("common:provisionRequests.preAuthorized")}</Badge>}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("common:provisionRequests.askedBy", {
          name: req.requestedByName || "?",
          when: desde(req.createdAt),
          seq: req.configSeq,
        })}
        {req.source === "mcp" && ` · ${t("common:provisionRequests.viaAgent")}`}
      </p>
      {req.reason && <p className="text-xs">{req.reason}</p>}
      {stale && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{t("common:provisionRequests.stale")}</span>
          {canDiscard && (
            <Button variant="outline" size="sm" className="h-6 px-2 text-xs" disabled={busy} onClick={() => void discard()}>
              {t("common:provisionRequests.discard")}
            </Button>
          )}
        </div>
      )}

      {req.flags.length > 0 && (
        <ul className="space-y-0.5">
          {req.flags.map((f, i) => (
            <li key={i} className="flex items-center gap-1.5 text-xs">
              <span className={`size-2 shrink-0 rounded-full ${FLAG_DOT[f.level]}`} aria-hidden />
              <span>{t(`common:provisionRequests.flag.${f.code}`, { defaultValue: f.code })}</span>
              {f.detail && <span className="font-mono text-muted-foreground">{f.detail}</span>}
            </li>
          ))}
        </ul>
      )}

      {check && (
        <div className="space-y-1 text-xs">
          <p className="text-muted-foreground">
            {t("common:provisionRequests.checkSummary", {
              hosts: check.hosts.join(", ") || "—",
              changed: check.changed,
              ok: check.ok,
            })}
          </p>
          {(check.failures ?? []).length > 0 && (
            <ul className="space-y-1" aria-label={t("common:provisionRequests.failures")}>
              {(check.failures ?? []).map((f, i) => (
                <li key={i} className="rounded border border-destructive/40 bg-destructive/5 p-1.5">
                  <p className="font-mono text-[11px]">{f.task || "?"}</p>
                  <p className="break-words text-destructive">{f.message}</p>
                </li>
              ))}
            </ul>
          )}
          {(check.changedTasks ?? []).length > 0 && (
            <ul className="list-inside list-disc">
              {(check.changedTasks ?? []).map((task) => (
                <li key={task}>{task}</li>
              ))}
            </ul>
          )}
          {check.diff && (
            <>
              <Button variant="ghost" size="sm" className="h-6 px-1 text-xs" onClick={() => setShowDiff((v) => !v)}>
                {t(showDiff ? "common:provisionRequests.hideDiff" : "common:provisionRequests.showDiff")}
              </Button>
              {showDiff && <pre className="max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">{check.diff}</pre>}
            </>
          )}
          {check.logTail && (
            <>
              <Button variant="ghost" size="sm" className="h-6 px-1 text-xs" onClick={() => setShowLog((v) => !v)}>
                {t(showLog ? "common:provisionRequests.hideLog" : "common:provisionRequests.showLog")}
              </Button>
              {showLog && <pre className="max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">{check.logTail}</pre>}
            </>
          )}
        </div>
      )}

      {awaiting && canDecide && (
        <div className="space-y-2 border-t pt-2">
          {red && (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              {t("common:provisionRequests.acknowledge")}
            </label>
          )}
          {req.risk === "destructive" && (
            <div className="space-y-1">
              <p className="text-xs">{t("common:provisionRequests.typeServer", { name: server.name })}</p>
              <Input aria-label={t("common:provisionRequests.typeServer", { name: server.name })} value={typed} onChange={(e) => setTyped(e.target.value)} />
            </div>
          )}
          <Input aria-label={t("common:provisionRequests.note")} placeholder={t("common:provisionRequests.note")} value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || !canApprove(req, server.name, typed, ack)} onClick={() => void decide(true)}>
              {t("common:provisionRequests.approve")}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide(false)}>
              {t("common:provisionRequests.reject")}
            </Button>
          </div>
        </div>
      )}
      {awaiting && !canDecide && <p className="text-xs text-muted-foreground">{t("common:provisionRequests.adminDecides")}</p>}

      {req.status === "approved" && (
        <div className="space-y-1 border-t pt-2 text-xs">
          {req.grantExpiresAt && (
            <p className="text-muted-foreground">
              {t("common:provisionRequests.grantUntil", { time: horaCorta(req.grantExpiresAt) })}
            </p>
          )}
          <div className="flex items-center gap-1">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-1 font-mono text-[11px]">{grantCommand(server.name, req.id)}</code>
            {onRun && (
              <Button size="sm" onClick={() => onRun(req)}>
                {t("common:provisionRequests.runNow")}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("common:provisionRequests.copy")}
              onClick={() => void copyText(grantCommand(server.name, req.id)).then(() => toast.success(t("common:provisionRequests.copied")))}
            >
              <Copy className="size-3.5" />
            </Button>
          </div>
        </div>
      )}
      {/* Aplicada, pero su verificación no llegó a arrancar (la app se cerró, o
          la carrera de antes del 2-nov-2026): se corre aquí, sin otra aprobación. */}
      {req.status === "verifying" && req.verify && !req.verifyRunId && onRun && (
        <div className="flex items-center justify-between gap-2 border-t pt-2 text-xs">
          <span className="text-muted-foreground">{t("common:provisionRequests.verifyPending", { verify: req.verify })}</span>
          <Button size="sm" onClick={() => onRun(req)}>
            {t("common:provisionRequests.runVerify")}
          </Button>
        </div>
      )}
      {(req.status === "verify_failed" || req.status === "failed" || req.status === "violated") && req.rollback && (
        <p className="text-xs text-destructive">{t("common:provisionRequests.rollbackHint", { rollback: req.rollback })}</p>
      )}
      {canReverify && (
        <div className="flex items-center justify-between gap-2 border-t pt-2 text-xs">
          <span className="text-muted-foreground">{t("common:provisionRequests.reverifyHint")}</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void reverify()}>
            {t("common:provisionRequests.reverify")}
          </Button>
        </div>
      )}
      {req.decisionNote && <p className="text-xs text-muted-foreground">{t("common:provisionRequests.decisionNote", { name: req.decidedByName ?? "", note: req.decisionNote })}</p>}
    </div>
  );
}
