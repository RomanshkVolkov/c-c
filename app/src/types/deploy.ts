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
  /**
   * El fichero del workflow que publica la imagen (`prod.yml`). Con la GitHub
   * App, que termine bien cuenta como el aviso del CI. Vacío = no avisa.
   */
  buildWorkflow?: string;
  /** Si el CI etiqueta la imagen con el sha corto; cac recorta el sha. */
  shortTags?: boolean;
  /** Lo que corre antes de cada deploy, con la imagen nueva. Vacío = nada. */
  migrateCommand?: string;
  /** Qué hace cac cuando el CI avisa: apuntarlo, o además desplegarlo. */
  onCINotify: CINotifyMode;
  /** El principio de la llave del CI, para reconocerla; vacío si no tiene. */
  ciKeyPreview: string;
  currentImage: string;
  previousImage: string;
}

export type CINotifyMode = "record" | "deploy";

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
  shortTags: boolean;
}

/** Una imagen que el CI dijo haber publicado. Ver `domain.ImageBuild`. */
export interface ImageBuild {
  id: string;
  createdAt: string;
  deployableId: string;
  sha: string;
  image: string;
  ref: string;
  actor: string;
  runUrl: string;
  source: "ci" | "github";
}

/** La llave del CI recién acuñada: la única vez que se ve entera. */
export interface CIKey {
  key: string;
  preview: string;
}
