/**
 * La configuración de un servidor en cac (backend `domain/server_config.go`).
 * Versionada: guardar crea una versión nueva. Los secretos van **por
 * referencia** de 1Password (`opRefs`: NOMBRE → op://…); nunca un valor.
 */

export interface ServerConfigVersion {
  id: string;
  serverId: string;
  seq: number;
  templateId: string;
  templateSeq: number;
  vars: Record<string, unknown>;
  opRefs: Record<string, string>;
  createdBy: string;
  createdByName?: string;
  source: "app" | "mcp";
  note: string;
  basedOn?: { serverId: string; seq: number } | null;
  createdAt: string;
}

export interface ServerConfigSummary {
  current: ServerConfigVersion | null;
  versions: ServerConfigVersion[];
}

export interface EffectiveConfig {
  serverId: string;
  configSeq: number;
  templateId?: string;
  templateName?: string;
  templateSeq?: number;
  playbooks: string[];
  vars: Record<string, unknown>;
  opRefs: Record<string, string>;
  requires: string[];
  perServer: string[];
  missing: string[];
  connection: { name: string; host: string; sshPort: number; sshUser: string };
}

export interface ServerTemplateVersion {
  id: string;
  templateId: string;
  seq: number;
  playbooks: string[];
  vars: Record<string, unknown>;
  requires: string[];
  perServer: string[];
  createdByName?: string;
  source: "app" | "mcp";
  note: string;
  createdAt: string;
}

export interface ServerTemplate {
  id: string;
  orgId: string;
  name: string;
  description: string;
  current: ServerTemplateVersion | null;
}

/** Lo que le falta a la config para correr un playbook (Rust `PlanGaps`). */
export interface PlanGaps {
  vars: string[];
  secrets: string[];
}

/** Lo que devuelve `ansible_run_with_config`. */
export interface StartedRun {
  runId: string;
  varNames: string[];
  target: string;
}

/**
 * Una petición de ejecución (backend `domain/provisioning_request.go`): un
 * agente pide aplicar un playbook, su ensayo se evalúa, y lo que no es una
 * lectura limpia lo aprueba una persona aquí. Decisión 4d28f4ab.
 */
export type ProvisioningRisk = "read" | "change" | "destructive";

export type ProvisioningRequestStatus =
  | "discarded"
  | "checking"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "running"
  | "verifying"
  | "succeeded"
  | "failed"
  | "verify_failed"
  | "violated"
  | "expired";

export interface RiskFlag {
  code: string;
  level: "red" | "amber" | "info";
  detail?: string;
}

export interface ProvisioningCheck {
  hosts: string[];
  ok: number;
  changed: number;
  unreachable: number;
  failed: number;
  changedTasks: string[] | null;
  paths: string[] | null;
  diff: string;
  exitCode: number;
  /** Qué falló y por qué (desde el 2-nov-2026; antes, ausente). */
  failures?: ProvisioningFailure[] | null;
  /** El final de la salida, ya tachada. */
  logTail?: string;
}

export interface ProvisioningFailure {
  host: string;
  task: string;
  message: string;
}

export interface ProvisioningRequest {
  id: string;
  serverId: string;
  playbook: string;
  project: string;
  risk: ProvisioningRisk;
  verify?: string;
  rollback?: string;
  configSeq: number;
  reason: string;
  requestedBy: string;
  requestedByName: string;
  source: "mcp" | "app";
  status: ProvisioningRequestStatus;
  check?: ProvisioningCheck | null;
  flags: RiskFlag[];
  checkedAt?: string;
  decidedByName?: string;
  decidedAt?: string;
  decisionNote?: string;
  autoApproved: boolean;
  grantExpiresAt?: string;
  /** La ejecución del playbook y la de su verificación, cuando arrancaron. */
  runId?: string;
  verifyRunId?: string;
  createdAt: string;
}
