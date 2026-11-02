/**
 * Lo que ya mordió (`domain.Incident` en el backend): qué falló, en qué
 * servidor o área, el commit que lo arregla y la prueba que lo guarda.
 */
export type IncidentStatus = "open" | "fixed";

export interface IncidentServerRef {
  id: string;
  name: string;
}

/** Sin cuerpo: lo que traen las listas. */
export interface IncidentSummary {
  id: string;
  title: string;
  status: IncidentStatus;
  servers: IncidentServerRef[];
  areas: string[];
  recordedAt: string;
  fixedAt?: string;
}

export interface IncidentCommit {
  sha: string;
  repo?: string;
  title?: string;
  url?: string;
}

/** Entero, como lo da `GET /api/v1/incidents/{id}`. */
export interface Incident extends Omit<IncidentSummary, "recordedAt"> {
  body: string;
  createdAt: string;
  commits: IncidentCommit[];
  guards: string[];
  originTaskId?: string;
  originRef?: string;
  originTitle?: string;
  authorName?: string;
  via?: string;
  supersededById?: string;
}

export interface IncidentList {
  incidents: IncidentSummary[];
  truncated?: boolean;
}
