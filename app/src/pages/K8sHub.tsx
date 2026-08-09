import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  RefreshCw,
  ExternalLink,
  Globe,
  ShieldCheck,
  ShieldAlert,
  Server as ServerIcon,
  Boxes,
  Database,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import IntegrationsSection from "@/components/IntegrationsSection";
import { useOrgsStore } from "@/store/orgs.store";
import { useAuthStore } from "@/store/auth.store";
import { roleAtLeast } from "@/types/organization";
import type { APIResponse } from "@/types/auth";
import type { Server } from "@/types/server";
import type { K8sHealth, K8sRoutesResponse } from "@/types/k8s";

export default function K8sHub({ server }: { server: Server }) {
  const navigate = useNavigate();
  const orgs = useOrgsStore((s) => s.orgs);
  const superadmin = useAuthStore((s) => !!s.session?.superadmin);
  const role = orgs.find((o) => o.id === server.orgId)?.role;
  const canAdmin = superadmin || role === "admin";
  const canReveal = superadmin || (!!role && roleAtLeast(role, "member"));
  const [routes, setRoutes] = useState<K8sRoutesResponse | null>(null);
  const [health, setHealth] = useState<K8sHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, h] = await Promise.all([
        api.get<APIResponse<K8sRoutesResponse>>(`/api/v1/servers/${server.id}/k8s/routes`),
        api.get<APIResponse<K8sHealth>>(`/api/v1/servers/${server.id}/k8s/health`),
      ]);
      if (!r.success || !h.success) throw new Error(r.error ?? h.error ?? "Failed");
      setRoutes(r.data ?? null);
      setHealth(h.data ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [server.id]);

  useEffect(() => {
    load();
  }, [load]);

  const open = async (url: string) => {
    try {
      await openUrl(url);
    } catch {
      window.open(url, "_blank");
    }
  };

  return (
    <div className="h-full bg-background flex flex-col overflow-hidden">
      <header className="shrink-0 border-b px-6 py-3 flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate("/dashboard")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="font-semibold text-lg">{server.name}</span>
        <Badge variant="secondary">kubernetes</Badge>
        <span className="font-mono text-sm text-muted-foreground">{server.host}</span>
        <Button variant="outline" size="sm" className="ml-auto" onClick={load} disabled={loading}>
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </header>

      <div className="flex-1 overflow-auto p-6 space-y-6 max-w-5xl mx-auto w-full">
        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive flex items-center gap-2">
            <AlertCircle className="size-4" /> {error}
          </div>
        )}
        {loading && !routes && !health ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" /> Reading cluster…
          </p>
        ) : (
          <>
            <IntegrationsSection serverId={server.id} canAdmin={canAdmin} canReveal={canReveal} />

            {/* Gateways */}
            {routes && routes.gateways.length > 0 && (
              <Section title="Gateways" icon={<Globe className="size-4" />}>
                <div className="grid gap-2 sm:grid-cols-2">
                  {routes.gateways.map((g) => (
                    <div
                      key={`${g.namespace}/${g.name}`}
                      className={cn(
                        "rounded-lg border p-3 text-sm",
                        !g.programmed && "border-destructive/50 bg-destructive/5",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{g.name}</span>
                        <span className="text-xs text-muted-foreground">{g.namespace}</span>
                        <Badge
                          variant={g.programmed ? "default" : "destructive"}
                          className="ml-auto text-[0.625rem]"
                        >
                          {g.programmed ? "programmed" : "not programmed"}
                        </Badge>
                      </div>
                      <p className="mt-1 font-mono text-xs text-muted-foreground">
                        {g.address || "— no address —"}
                      </p>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Routes directory */}
            {routes && (
              <Section title={`Routes (${routes.routes.length})`} icon={<ExternalLink className="size-4" />}>
                <div className="grid gap-2 sm:grid-cols-2">
                  {routes.routes.flatMap((r) =>
                    r.hostnames.map((host, i) => (
                      <button
                        key={`${r.namespace}/${r.name}/${host}`}
                        onClick={() => open(r.links[i] ?? `https://${host}`)}
                        className="group flex items-center gap-2 rounded-lg border p-3 text-left text-sm hover:border-primary hover:bg-accent/40"
                      >
                        <Globe className="size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{host}</div>
                          <div className="truncate text-[0.6875rem] text-muted-foreground">
                            {r.name} · {r.gateway || "no gateway"}
                          </div>
                        </div>
                        <CertBadge ready={r.certReady} expiry={r.certExpiry} />
                        <ExternalLink className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
                      </button>
                    )),
                  )}
                </div>
              </Section>
            )}

            {/* Health */}
            {health && (
              <Section title="Cluster health" icon={<ServerIcon className="size-4" />}>
                <div className="flex flex-wrap gap-2">
                  {health.nodes.map((n) => (
                    <Badge key={n.name} variant={n.ready ? "default" : "destructive"} className="gap-1">
                      <ServerIcon className="size-3" /> {n.name} · {n.kubeletVersion}
                    </Badge>
                  ))}
                </div>

                {health.datastores.length > 0 && (
                  <div className="mt-3 space-y-1.5">
                    {health.datastores.map((d) => (
                      <div
                        key={`${d.namespace}/${d.name}`}
                        className={cn(
                          "flex items-center gap-2 rounded-lg border p-2.5 text-sm",
                          !d.healthy && "border-destructive/50 bg-destructive/5",
                        )}
                      >
                        <Database className="size-4 shrink-0 text-muted-foreground" />
                        <span className="font-medium">{d.name}</span>
                        <span className="text-xs text-muted-foreground">{d.namespace}</span>
                        <span className="ml-auto text-xs">
                          {d.ready}/{d.instances} ready
                        </span>
                        {!d.healthy && (
                          <span className="max-w-[45%] truncate text-xs text-destructive" title={d.phase}>
                            {d.phase}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            )}

            {/* Workloads (only the unhealthy stand out) */}
            {health && health.workloads.length > 0 && (
              <Section title="Workloads" icon={<Boxes className="size-4" />}>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {[...health.workloads]
                    .sort((a, b) => Number(a.healthy) - Number(b.healthy))
                    .map((w) => (
                      <div
                        key={`${w.namespace}/${w.name}`}
                        className={cn(
                          "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs",
                          !w.healthy && "border-destructive/50 bg-destructive/5",
                        )}
                      >
                        <span className="truncate font-medium">{w.name}</span>
                        <span className="text-muted-foreground">{w.namespace}</span>
                        <span className={cn("ml-auto", !w.healthy && "text-destructive")}>
                          {w.ready}/{w.desired}
                        </span>
                      </div>
                    ))}
                </div>
              </Section>
            )}

            {/* Certificates */}
            {health && health.certs.length > 0 && (
              <Section title="Certificates" icon={<ShieldCheck className="size-4" />}>
                <div className="space-y-1.5">
                  {health.certs.map((c) => {
                    const warn = !c.ready || (c.daysLeft != null && c.daysLeft < 21);
                    return (
                      <div
                        key={`${c.namespace}/${c.name}`}
                        className={cn(
                          "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs",
                          warn && "border-destructive/50 bg-destructive/5",
                        )}
                      >
                        {warn ? (
                          <ShieldAlert className="size-3.5 shrink-0 text-destructive" />
                        ) : (
                          <ShieldCheck className="size-3.5 shrink-0 text-success" />
                        )}
                        <span className="font-medium">{c.name}</span>
                        <span className="truncate text-muted-foreground">
                          {c.dnsNames?.join(", ")}
                        </span>
                        {c.daysLeft != null && (
                          <span className={cn("ml-auto", warn && "text-destructive")}>
                            {c.daysLeft}d
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        {icon} {title}
      </h2>
      {children}
    </section>
  );
}

function CertBadge({ ready, expiry }: { ready?: boolean | null; expiry?: string | null }) {
  if (ready == null) return null;
  const days = expiry ? Math.floor((Date.parse(expiry) - Date.now()) / 86400000) : null;
  const warn = !ready || (days != null && days < 21);
  return (
    <span title={expiry ?? undefined}>
      {warn ? (
        <ShieldAlert className="size-3.5 text-destructive" />
      ) : (
        <ShieldCheck className="size-3.5 text-success" />
      )}
    </span>
  );
}
