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
  /**
   * El comando del servidor que recibe los secrets por stdin (`CLAVE=valor`
   * por línea), p. ej. `sudo -n /usr/local/bin/rotate-secrets dev`. Con él,
   * rotar usa ese comando en vez de la rotación propia de cac, y se puede
   * rotar aunque el despliegue lo haga el CI. Vacío = la de cac.
   */
  rotateCommand?: string;
  /** Qué hace cac cuando el CI avisa: apuntarlo, o además desplegarlo. */
  onCINotify: CINotifyMode;
  /** La rama que despliega este servicio; vacía = cualquiera. Vale para el CI y para el build. */
  branch?: string;
  /** El servidor construye la imagen desde el commit al recibir el push (agente v6). */
  buildOnHost?: boolean;
  /** El Dockerfile, relativo a la carpeta del build; vacío = `Dockerfile`. */
  dockerfile?: string;
  /** La carpeta del repo desde la que se construye; vacía = la raíz. */
  buildContext?: string;
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

/** Un commit de la rama del servicio, para elegir qué desplegar. Ver `service.RepoCommit`. */
export interface RepoCommit {
  sha: string;
  /** Sólo su primera línea. */
  message: string;
  author: string;
  date: string;
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
