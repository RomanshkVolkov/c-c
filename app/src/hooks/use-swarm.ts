import { useState, useEffect, useCallback } from "react";
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
  const base = `http://${host}:${agentPort}`;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [svcRes, nodeRes] = await Promise.all([
        fetch(`${base}/api/v1/services`).then(r => r.json()) as Promise<APIResponse<SwarmService[]>>,
        fetch(`${base}/api/v1/nodes`).then(r => r.json()) as Promise<APIResponse<SwarmNode[]>>,
      ]);
      if (svcRes.success) setServices(svcRes.data ?? []);
      if (nodeRes.success) setNodes(nodeRes.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect to agent");
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => { refresh(); }, [refresh]);

  return { services, nodes, loading, error, refresh };
}
