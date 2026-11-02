/** Lo que describe un repo de Ansible: `cac.playbooks.yml`, o lo deducido. Ver ansible.rs. */
export interface AnsibleManifest {
  version: number;
  venv?: string | null;
  /** v1: el inventario del repo. v2: vacío, lo genera la app con la config de cac. */
  inventory: string;
  playbooks: PlaybookDef[];
  /** true = el repo no tiene manifest y esto se dedujo de sus carpetas. */
  discovered: boolean;
}

export interface PlaybookDef {
  id: string;
  file: string;
  name: string;
  description: string;
  hosts?: string | null;
  become: boolean;
  /** v1: la referencia `op://` de la contraseña de sudo. */
  becomePasswordRef?: string | null;
  /** v2: el NOMBRE del secreto de la config del servidor que es la de sudo. */
  becomePasswordFrom?: string | null;
  /** v2: el riesgo, su verificación y su rollback (el protocolo). */
  risk?: string | null;
  verify?: string | null;
  rollback?: string | null;
  vars: VarDef[];
}

export interface VarDef {
  name: string;
  description: string;
  /**
   * v1: `op://…`, que se lee en Rust al correr. v2: el NOMBRE de un secreto de
   * la config del servidor (`CLOUDFLARE_DNS_TOKEN`).
   */
  from?: string | null;
  secret: boolean;
  required: boolean;
  /** v2: con lo que nace una plantilla. */
  default?: unknown;
  /** v2: la forma del valor cuando el default no la dice. Hoy sólo `list`. */
  type?: string | null;
}

export interface AnsibleTools {
  platformSupported: boolean;
  reason: string;
  ansiblePlaybook: string | null;
  op: string | null;
}

export interface InventoryHost {
  name: string;
  groups: string[];
  ansibleHost: string | null;
}

export type AnsibleEvent =
  | { event: "line"; data: { stream: "stdout" | "stderr"; text: string } }
  | { event: "exit"; data: { code: number | null; cancelled: boolean } };

/** Una ejecución, tal como la guarda cac. Nunca lleva valores. */
export interface ProvisioningRun {
  id: string;
  serverId: string;
  kind: "playbook" | "rotate";
  project: string;
  playbook: string;
  target: string;
  varNames: string;
  startedBy: string;
  startedByName?: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  status: "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  summary: string;
  logTail: string;
  /** La versión de la config de cac con la que se lanzó (0 = sin config). */
  configSeq?: number;
  templateId?: string;
  templateSeq?: number;
  /** app | cli (`cac provision` desde una terminal). */
  source?: "app" | "cli";
  /** La foto de lo aplicado: variables y referencias, nunca valores. */
  applied?: { vars: Record<string, unknown>; opRefs: Record<string, string> } | null;
}
