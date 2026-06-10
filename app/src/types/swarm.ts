export interface Stack {
  name: string;
  services: number;
  createdAt: string;
}

export interface ServiceReplicas {
  running: number;
  desired: number;
}

export interface SwarmService {
  id: string;
  name: string;
  image: string;
  stack: string;
  replicas: ServiceReplicas;
  updatedAt: string;
}

export interface SwarmNode {
  id: string;
  hostname: string;
  role: string;
  status: string;
  availability: string;
  engineVersion: string;
}

// Matches swarm-manage's domain.ContainerStats — cumulative counters since
// container start. One row per swarm-managed container running on the server.
export interface ContainerStats {
  containerId: string;
  taskId: string;
  nodeId: string;
  serviceId: string;
  serviceName: string;
  stack: string;
  state: string;
  cpuPercent: number;
  onlineCpus: number;
  memUsage: number;
  memLimit: number;
  netRx: number;
  netTx: number;
  blockRead: number;
  blockWrite: number;
  error?: string;
}
