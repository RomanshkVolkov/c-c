/** Un servicio de Swarm que cac sabe desplegar. Ver `domain.Deployable`. */
export interface Deployable {
  id: string;
  orgId: string;
  serverId: string;
  name: string;
  stack: string;
  serviceName: string;
  /** El repositorio de imágenes, sin tag (`ghcr.io/owner/repo`). */
  imageRepo: string;
  environment: string;
  repoFullName: string;
  onCINotify: "record" | "deploy";
  currentImage: string;
  previousImage: string;
}

export type DeployStatus = "queued" | "running" | "succeeded" | "failed" | "rolled_back";

/** Un despliegue. `log` sólo viene al pedir uno. */
export interface Deployment {
  id: string;
  createdAt: string;
  deployableId: string;
  serverId: string;
  image: string;
  finalImage: string;
  previousImage: string;
  requestedBy: "user" | "ci" | "github";
  requestedByUserId: string;
  requestedByName?: string;
  status: DeployStatus;
  error: string;
  startedAt?: string;
  finishedAt?: string;
  rollbackOfId: string;
  log?: string;
}

export interface CreateDeployablePayload {
  name: string;
  stack: string;
  serviceName: string;
  imageRepo: string;
  environment: string;
}
