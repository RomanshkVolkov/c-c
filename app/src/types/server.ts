export type ServerType = "docker-swarm" | "kubernetes";

export interface Server {
  id: string;
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  type: ServerType;
  agentPort: number;
  status: "pending" | "online" | "offline" | "error";
}

export interface CreateServerPayload {
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  type: ServerType;
  agentPort: number;
  sshPrivateKey: string;
}
