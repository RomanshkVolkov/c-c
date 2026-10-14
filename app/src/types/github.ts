/** Una instalación de la GitHub App atada a esta org. Ver `domain.GitHubInstallation`. */
export interface GitHubInstallation {
  id: string;
  installationId: number;
  accountLogin: string;
  orgId: string;
}

/** Un repo de una instalación. `spaceId` vacío = no enlazado: no comenta nada. */
export interface GitHubRepo {
  id: string;
  installationId: number;
  repoId: number;
  fullName: string;
  orgId: string;
  spaceId: string;
  bareRefs: boolean;
  /** Si sus .md salen en Documentación, bajo su espacio. */
  showDocs: boolean;
  /** De qué rama salen, cuándo se copiaron y cómo salió («ok», «truncated», «error»; vacío: nunca). */
  docsBranch: string;
  docsSyncedAt: string | null;
  docsState: "" | RepoDocsState;
}

export type RepoDocsState = "ok" | "truncated" | "error";

/** Un .md del repo en el listado del panel, sin cuerpo. Ver `domain.RepoDocEntry`. */
export interface RepoDocEntry {
  id: string;
  path: string;
  title: string;
}

/** Los .md de un repo atado a un espacio. Ver `domain.RepoDocsGroup`. */
export interface RepoDocsGroup {
  repoId: number;
  fullName: string;
  branch: string;
  state: "" | RepoDocsState;
  syncedAt: string | null;
  files: RepoDocEntry[];
}

/** Un .md del repo, con su cuerpo. Ver `domain.RepoDocResponse`. */
export interface RepoDoc {
  id: string;
  orgId: string;
  repoId: number;
  path: string;
  title: string;
  body?: string;
  tooLarge: boolean;
  fullName: string;
  branch: string;
  spaceId: string;
  htmlUrl: string;
  syncedAt: string | null;
}

export interface GitHubStatus {
  /** Si el servidor tiene la App puesta. Sin ella no hay nada que conectar. */
  configured: boolean;
  installations: GitHubInstallation[];
  repos: GitHubRepo[];
}
