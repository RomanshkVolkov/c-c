export interface K8sGateway {
  name: string;
  namespace: string;
  address: string;
  programmed: boolean;
}

export interface K8sRoute {
  name: string;
  namespace: string;
  gateway: string;
  hostnames: string[];
  links: string[];
  certReady?: boolean | null;
  certExpiry?: string | null;
}

export interface K8sRoutesResponse {
  gateways: K8sGateway[];
  routes: K8sRoute[];
}

export interface K8sNode {
  name: string;
  kubeletVersion: string;
  ready: boolean;
}

export interface K8sWorkload {
  name: string;
  namespace: string;
  ready: number;
  desired: number;
  healthy: boolean;
}

export interface K8sCert {
  name: string;
  namespace: string;
  dnsNames: string[];
  notAfter?: string | null;
  daysLeft?: number | null;
  ready: boolean;
}

export interface K8sDatastore {
  kind: string;
  name: string;
  namespace: string;
  instances: number;
  ready: number;
  phase: string;
  healthy: boolean;
}

export interface K8sHealth {
  nodes: K8sNode[];
  workloads: K8sWorkload[];
  certs: K8sCert[];
  datastores: K8sDatastore[];
}

export type IntegrationAuthMethod = "none" | "basic" | "bearer" | "header";

export interface Integration {
  id: string;
  serverId: string;
  kind: string;
  name: string;
  url: string;
  authMethod: IntegrationAuthMethod;
  hasSecret: boolean;
  hidden: boolean;
  createdAt: string;
}

export interface CreateIntegrationPayload {
  kind: string;
  name: string;
  url: string;
  authMethod?: IntegrationAuthMethod;
  secret?: string;
}

export interface UpdateIntegrationPayload {
  name: string;
  url: string;
  authMethod?: IntegrationAuthMethod;
  hidden?: boolean;
  secret?: string;
}
