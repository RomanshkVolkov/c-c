import { useEffect, useMemo, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  ArrowLeft,
  Activity,
  AlertCircle,
  Pause,
  Play,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatBytes } from "@/lib/utils";
import { useStatsStore } from "@/store/stats.store";
import type { Server } from "@/types/server";
import type { SwarmNode } from "@/types/swarm";

const POLL_INTERVAL_MS = 5000;

interface LocationState {
  server: Server;
  nodes: SwarmNode[];
}

function MemBar({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? (used / limit) * 100 : 0;
  const color =
    pct >= 85
      ? "bg-destructive"
      : pct >= 60
        ? "bg-yellow-500"
        : "bg-green-500";
  return (
    <div className="space-y-1 min-w-[120px]">
      <div className="flex justify-between text-xs font-mono">
        <span>{formatBytes(used)}</span>
        <span className="text-muted-foreground">{formatBytes(limit)}</span>
      </div>
      <div className="h-1.5 w-full bg-muted rounded">
        <div
          className={`h-full rounded ${color}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  );
}

function CPUBar({ pct }: { pct: number }) {
  const color =
    pct >= 75 ? "bg-destructive" : pct >= 40 ? "bg-yellow-500" : "bg-green-500";
  return (
    <div className="space-y-1 min-w-[80px]">
      <div className="text-xs font-mono">{pct.toFixed(1)}%</div>
      <div className="h-1.5 w-full bg-muted rounded">
        <div
          className={`h-full rounded ${color}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const variant =
    state === "running"
      ? "default"
      : state === "exited" || state === "dead"
        ? "destructive"
        : "secondary";
  return <Badge variant={variant}>{state}</Badge>;
}

function timeSince(ts: number | null): string {
  if (!ts) return "never";
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

export default function ServerStats() {
  const navigate = useNavigate();
  const { state } = useLocation();
  const locationState = state as LocationState | null;

  const server = locationState?.server ?? null;
  const nodes = locationState?.nodes ?? [];

  const entry = useStatsStore((s) =>
    server ? s.entries[server.id] : undefined,
  );
  const ensureEntry = useStatsStore((s) => s.ensureEntry);
  const fetchOnce = useStatsStore((s) => s.fetchOnce);
  const setPolling = useStatsStore((s) => s.setPolling);

  const [filter, setFilter] = useState("");

  const nodeNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) m.set(n.id, n.hostname);
    return m;
  }, [nodes]);

  useEffect(() => {
    if (!server) navigate("/dashboard", { replace: true });
  }, [server, navigate]);

  useEffect(() => {
    if (server) ensureEntry(server.id);
  }, [server, ensureEntry]);

  useEffect(() => {
    if (!server) return;
    if (!entry?.polling) return;
    fetchOnce(server.id, server.host, server.agentPort);
    const id = setInterval(() => {
      fetchOnce(server.id, server.host, server.agentPort);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [server, entry?.polling, fetchOnce]);

  if (!server) return null;

  const polling = entry?.polling ?? true;
  const stats = entry?.stats ?? [];
  const loading = entry?.loading ?? false;
  const error = entry?.error ?? null;
  const lastFetchedAt = entry?.lastFetchedAt ?? null;

  const needle = filter.trim().toLowerCase();
  const filtered = needle
    ? stats.filter((s) =>
        `${s.containerId} ${s.serviceName} ${s.stack}`
          .toLowerCase()
          .includes(needle),
      )
    : stats;

  return (
    <div className="h-full bg-background flex flex-col overflow-hidden">
      <header className="shrink-0 border-b px-6 py-3 flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-3 flex-1">
          <Activity className="h-5 w-5 text-muted-foreground" />
          <span className="font-semibold text-lg">Resource monitor</span>
          <span className="text-sm text-muted-foreground">{server.name}</span>
          <span className="font-mono text-xs text-muted-foreground">
            {server.host}:{server.agentPort}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {polling ? "polling 5s" : "paused"} · last: {timeSince(lastFetchedAt)}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchOnce(server.id, server.host, server.agentPort)}
            disabled={loading}
          >
            <RefreshCw
              className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPolling(server.id, !polling)}
          >
            {polling ? (
              <>
                <Pause className="h-4 w-4 mr-1" />
                Pause
              </>
            ) : (
              <>
                <Play className="h-4 w-4 mr-1" />
                Resume
              </>
            )}
          </Button>
        </div>
      </header>

      <main className="flex-1 p-6 overflow-auto space-y-4">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              Containers ({filtered.length}
              {needle && stats.length !== filtered.length
                ? ` of ${stats.length}`
                : ""}
              )
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by container, service or stack..."
                className="pl-9 pr-9"
              />
              {filter && (
                <button
                  type="button"
                  onClick={() => setFilter("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="Clear filter"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {stats.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                {loading
                  ? "Loading..."
                  : "No swarm-managed containers on this node."}
              </p>
            ) : filtered.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No matches for "{filter}".
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Container</TableHead>
                    <TableHead>Service</TableHead>
                    <TableHead>Stack</TableHead>
                    <TableHead>Node</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>CPU</TableHead>
                    <TableHead>Memory</TableHead>
                    <TableHead className="text-right">Net Rx</TableHead>
                    <TableHead className="text-right">Net Tx</TableHead>
                    <TableHead className="text-right">Disk R</TableHead>
                    <TableHead className="text-right">Disk W</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((row) => (
                    <TableRow key={row.containerId}>
                      <TableCell className="font-mono text-xs">
                        {row.error ? (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger>
                                <span className="flex items-center gap-1 text-destructive">
                                  <AlertCircle className="h-3 w-3" />
                                  {row.containerId.slice(0, 12)}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p className="font-mono text-xs max-w-md whitespace-pre-wrap">
                                  {row.error}
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ) : (
                          row.containerId.slice(0, 12)
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {row.serviceName || (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {row.stack ? (
                          <Badge variant="secondary">{row.stack}</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {nodeNameById.get(row.nodeId) ?? row.nodeId.slice(0, 8)}
                      </TableCell>
                      <TableCell>
                        <StateBadge state={row.state} />
                      </TableCell>
                      <TableCell>
                        <CPUBar pct={row.cpuPercent} />
                      </TableCell>
                      <TableCell>
                        <MemBar used={row.memUsage} limit={row.memLimit} />
                      </TableCell>
                      <TableCell className="font-mono text-xs text-right">
                        {formatBytes(row.netRx)}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-right">
                        {formatBytes(row.netTx)}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-right">
                        {formatBytes(row.blockRead)}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-right">
                        {formatBytes(row.blockWrite)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
