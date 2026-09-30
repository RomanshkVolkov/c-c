export type ServerType = "docker-swarm" | "kubernetes";

export interface Server {
  id: string;
  orgId: string;
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  type: ServerType;
  agentPort: number;
  status: "pending" | "online" | "offline" | "error";
  /**
   * Si el agente tiene identidad (versión 2). Con ella, `status` es su latido
   * y hablarle exige un pase del backend; sin ella, es de los de antes.
   */
  hasAgentToken?: boolean;
  agentTokenPreview?: string;
  agentSeenAt?: string;
}

export interface CreateServerPayload {
  orgId: string;
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  type: ServerType;
  agentPort: number;
}
