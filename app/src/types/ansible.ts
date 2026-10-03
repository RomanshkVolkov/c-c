/** Lo que describe un repo de Ansible: `cac.playbooks.yml`, o lo deducido. Ver ansible.rs. */
export interface AnsibleManifest {
  version: number;
  venv?: string | null;
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
  becomePasswordRef?: string | null;
  vars: VarDef[];
}

export interface VarDef {
  name: string;
  description: string;
  /** `op://…`: se lee en Rust al correr; aquí sólo se enseña la referencia. */
  from?: string | null;
  secret: boolean;
  required: boolean;
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
}
