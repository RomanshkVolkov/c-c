import { useEffect, useMemo, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  ArrowLeft,
  Activity,
  AlertCircle,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
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

type SortKey =
  | "container"
  | "service"
  | "stack"
  | "state"
  | "cpu"
  | "mem"
  | "netRx"
  | "netTx"
  | "diskR"
  | "diskW";

type SortDir = "asc" | "desc";

const RUNNING_STATES = new Set(["running"]);

function SortableHead({
  label,
  sortKey,
  active,
  dir,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey | null;
  dir: SortDir;
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
}) {
  const isActive = active === sortKey;
  const Icon = isActive ? (dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={`flex items-center gap-1 select-none hover:text-foreground transition-colors ${
        align === "right" ? "ml-auto" : ""
      } ${isActive ? "text-foreground" : "text-muted-foreground"}`}
    >
      {label}
      <Icon className="h-3 w-3" />
    </button>
  );
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

function CPUBar({ pct, cores }: { pct: number; cores: number }) {
  // pct is docker-style: 100% per saturated core. Scale the bar against host max
  // (cores * 100) so a value of 200% on a 4-core host renders as 50% filled.
  const max = Math.max(100, cores * 100);
  const ratio = max > 0 ? (pct / max) * 100 : 0;
  const color =
    ratio >= 75 ? "bg-destructive" : ratio >= 40 ? "bg-yellow-500" : "bg-green-500";
  return (
    <div className="space-y-1 min-w-[80px]">
      <div className="text-xs font-mono">{pct.toFixed(1)}%</div>
      <div className="h-1.5 w-full bg-muted rounded">
        <div
          className={`h-full rounded ${color}`}
          style={{ width: `${Math.min(100, ratio)}%` }}
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
  const [showStopped, setShowStopped] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("cpu");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const handleSort = (k: SortKey) => {
    if (k === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(k);
      setSortDir(k === "container" || k === "service" || k === "stack" || k === "state" ? "asc" : "desc");
    }
  };

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

  const visible = showStopped
    ? stats
    : stats.filter((s) => RUNNING_STATES.has(s.state));
  const hiddenStopped = stats.length - visible.length;

  const searchFiltered = needle
    ? visible.filter((s) =>
        `${s.containerId} ${s.serviceName} ${s.stack}`
          .toLowerCase()
          .includes(needle),
      )
    : visible;

  const cmp = (a: number | string, b: number | string) => {
    if (a < b) return sortDir === "asc" ? -1 : 1;
    if (a > b) return sortDir === "asc" ? 1 : -1;
    return 0;
  };
  const filtered = [...searchFiltered].sort((a, b) => {
    switch (sortKey) {
      case "container":
        return cmp(a.containerId, b.containerId);
      case "service":
        return cmp(a.serviceName, b.serviceName);
      case "stack":
        return cmp(a.stack, b.stack);
      case "state":
        return cmp(a.state, b.state);
      case "cpu":
        return cmp(a.cpuPercent, b.cpuPercent);
      case "mem":
        return cmp(a.memUsage, b.memUsage);
      case "netRx":
        return cmp(a.netRx, b.netRx);
      case "netTx":
        return cmp(a.netTx, b.netTx);
      case "diskR":
        return cmp(a.blockRead, b.blockRead);
      case "diskW":
        return cmp(a.blockWrite, b.blockWrite);
    }
  });

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
            <CardTitle className="text-sm font-medium flex items-center justify-between">
              <span>
                Containers ({filtered.length} of {stats.length})
              </span>
              <label className="flex items-center gap-2 text-xs font-normal text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={showStopped}
                  onChange={(e) => setShowStopped(e.target.checked)}
                />
                Show stopped
              </label>
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

            {!showStopped && hiddenStopped > 0 && (
              <button
                type="button"
                onClick={() => setShowStopped(true)}
                className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
              >
                {hiddenStopped} stopped container{hiddenStopped > 1 ? "s" : ""} hidden — show
              </button>
            )}

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
                    <TableHead>
                      <SortableHead label="Container" sortKey="container" active={sortKey} dir={sortDir} onSort={handleSort} />
                    </TableHead>
                    <TableHead>
                      <SortableHead label="Service" sortKey="service" active={sortKey} dir={sortDir} onSort={handleSort} />
                    </TableHead>
                    <TableHead>
                      <SortableHead label="Stack" sortKey="stack" active={sortKey} dir={sortDir} onSort={handleSort} />
                    </TableHead>
                    <TableHead>Node</TableHead>
                    <TableHead>
                      <SortableHead label="State" sortKey="state" active={sortKey} dir={sortDir} onSort={handleSort} />
                    </TableHead>
                    <TableHead>
                      <SortableHead label="CPU" sortKey="cpu" active={sortKey} dir={sortDir} onSort={handleSort} />
                    </TableHead>
                    <TableHead>
                      <SortableHead label="Memory" sortKey="mem" active={sortKey} dir={sortDir} onSort={handleSort} />
                    </TableHead>
                    <TableHead className="text-right">
                      <SortableHead label="Net Rx" sortKey="netRx" active={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                    </TableHead>
                    <TableHead className="text-right">
                      <SortableHead label="Net Tx" sortKey="netTx" active={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                    </TableHead>
                    <TableHead className="text-right">
                      <SortableHead label="Disk R" sortKey="diskR" active={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                    </TableHead>
                    <TableHead className="text-right">
                      <SortableHead label="Disk W" sortKey="diskW" active={sortKey} dir={sortDir} onSort={handleSort} align="right" />
                    </TableHead>
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
                        <CPUBar pct={row.cpuPercent} cores={row.onlineCpus} />
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
