import { useState, useEffect, useCallback, useRef } from "react";
import { agentBase, agentJson } from "@/lib/agent";
import type { SwarmService, SwarmNode } from "@/types/swarm";

interface APIResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export function useSwarm(host: string, agentPort: number) {
  const [services, setServices] = useState<SwarmService[]>([]);
  const [nodes, setNodes] = useState<SwarmNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const base = agentBase(host, agentPort);
  // Ignore results that land after the component unmounted or the target
  // changed, so a slow reply can't overwrite fresher state.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [svcRes, nodeRes] = await Promise.all([
        agentJson<APIResponse<SwarmService[]>>(`${base}/api/v1/services`),
        agentJson<APIResponse<SwarmNode[]>>(`${base}/api/v1/nodes`),
      ]);
      if (!alive.current) return;
      if (svcRes.success) setServices(svcRes.data ?? []);
      if (nodeRes.success) setNodes(nodeRes.data ?? []);
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof Error ? e.message : "Failed to connect to agent");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { services, nodes, loading, error, refresh };
}
