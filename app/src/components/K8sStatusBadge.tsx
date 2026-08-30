import i18next from "i18next";
import { useT } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import type { APIResponse } from "@/types/auth";
import type { K8sHealth } from "@/types/k8s";

type State =
  | { kind: "loading" }
  | { kind: "healthy"; detail: string }
  | { kind: "issues"; count: number; detail: string }
  | { kind: "down"; detail: string }
  | { kind: "unknown"; detail: string };

/**
 * Live status for a kubernetes server.
 *
 * The stored `status` column tracks the swarm-manage agent lifecycle ("pending"
 * until an agent is deployed), which never applies to a cluster — it would sit
 * at "pending" forever and assert something false. Cluster state comes from the
 * read-only hub endpoint instead (cached server-side).
 *
 * A node that isn't Ready means the cluster itself is down; a Deployment below
 * its desired replicas does NOT — on a single-node cluster, anything asking for
 * 2 replicas is permanently short, so treating that as red would make the badge
 * always red and therefore useless. Those are reported as a count instead, with
 * the specifics on the hub page.
 */
export default function K8sStatusBadge({ serverId }: { serverId: string }) {
  const { t } = useT();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    api
      .get<APIResponse<K8sHealth>>(`/api/v1/servers/${serverId}/k8s/health`)
      .then((res) => {
        if (!alive) return;
        if (!res.success || !res.data) throw new Error(res.error ?? "unavailable");
        const { nodes, workloads, datastores } = res.data;

        const downNodes = nodes.filter((n) => !n.ready);
        if (downNodes.length > 0) {
          setState({
            kind: "down",
            detail: `Not ready: ${downNodes.map((n) => n.name).join(", ")}`,
          });
          return;
        }

        const issues = [
          ...workloads.filter((w) => !w.healthy).map((w) => `${w.namespace}/${w.name} ${w.ready}/${w.desired}`),
          ...datastores.filter((d) => !d.healthy).map((d) => `${d.namespace}/${d.name} (${d.phase})`),
        ];
        setState(
          issues.length === 0
            ? {
                kind: "healthy",
                // `i18next.t` y no el hook: esto corre dentro de un efecto que
                // consulta el clúster, no al pintar.
                detail: i18next.t("common:count.nodesReady", { count: nodes.length }),
              }
            : { kind: "issues", count: issues.length, detail: issues.join("\n") },
        );
      })
      .catch((e: unknown) => {
        if (alive) {
          setState({ kind: "unknown", detail: e instanceof Error ? e.message : String(e) });
        }
      });
    return () => {
      alive = false;
    };
  }, [serverId]);

  switch (state.kind) {
    case "loading":
      return <span className="text-xs text-muted-foreground">checking…</span>;
    case "down":
      return (
        <Badge variant="destructive" title={state.detail}>
          cluster down
        </Badge>
      );
    case "issues":
      return (
        <Badge variant="secondary" title={state.detail}>
          {t("common:count.issues", { count: state.count })}
        </Badge>
      );
    case "unknown":
      return (
        <Badge variant="outline" title={state.detail}>
          unknown
        </Badge>
      );
    default:
      return <Badge title={state.detail}>healthy</Badge>;
  }
}
