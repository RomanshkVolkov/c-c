import type { Deployment } from "@/types/deploy";

/**
 * La actividad de CI de una org (R9): los runs de GitHub Actions de sus repos
 * y los deploys de cac, mezclados por tiempo. Ver `domain/activity.go`.
 */

/** Cómo va un run. GitHub manda tres webhooks por intento, y los tres son la misma fila. */
export type RunStatus = "requested" | "queued" | "in_progress" | "waiting" | "pending" | "completed";

/** Cómo acabó. Sólo tiene valor con `completed`. */
export type RunConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "neutral"
  | "stale"
  | "startup_failure"
  | "";

/** Un intento de una ejecución de GitHub Actions. Ver `domain.WorkflowRun`. */
export interface WorkflowRun {
  id: string;
  orgId: string;
  repoId: number;
  repoFullName: string;
  runId: number;
  runAttempt: number;
  runNumber: number;
  workflowName: string;
  /** `.github/workflows/prod.yml`: es lo que casa con el workflow de build de un servicio. */
  path: string;
  event: string;
  status: RunStatus;
  conclusion: RunConclusion;
  headSha: string;
  headBranch: string;
  commitTitle: string;
  actor: string;
  htmlUrl: string;
  /** El `created_at` del run en GitHub: lo que ordena el feed, y no se mueve. */
  occurredAt: string;
  runStartedAt?: string;
  eventUpdatedAt?: string;
}

/** Un deploy tal como lo enseña la actividad: con el servicio al que pertenece. */
export interface ActivityDeployment extends Deployment {
  orgId: string;
  deployableName: string;
  deployableEnv: string;
  /** El run que lo disparó, si vino de la GitHub App. */
  workflowRunId?: string;
}

/** Una línea del feed: o es un run o es un deploy. `at` es por lo que van ordenadas. */
export type ActivityEntry =
  | { kind: "run"; at: string; run: WorkflowRun; deployments?: ActivityDeployment[] }
  | { kind: "deployment"; at: string; deployment: ActivityDeployment };

export interface ActivityPage {
  items: ActivityEntry[];
  hasMore: boolean;
}

/** Qué parte de la actividad se pide. Vacío = toda la org. */
export interface ActivityFilter {
  repo?: string;
  deployableId?: string;
}
