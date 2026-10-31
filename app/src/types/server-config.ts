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
