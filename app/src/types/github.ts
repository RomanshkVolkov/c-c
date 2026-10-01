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
}

export interface GitHubStatus {
  /** Si el servidor tiene la App puesta. Sin ella no hay nada que conectar. */
  configured: boolean;
  installations: GitHubInstallation[];
  repos: GitHubRepo[];
}
