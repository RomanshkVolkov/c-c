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
