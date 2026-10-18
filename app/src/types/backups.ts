/** Los backups de bases de un servidor (#166). Casa con `domain/backup.go`. */

export type BackupEngine = "mssql" | "postgres";
export type BackupStatus = "queued" | "running" | "succeeded" | "failed";
export type BackupKind = "scheduled" | "manual" | "restore_test";
export type RetentionClass = "regular" | "weekly" | "monthly" | "";

export interface BackupTarget {
  id: string;
  orgId: string;
  serverId: string;
  serviceName: string;
  engine: BackupEngine;
  database: string;
  credentialEnv: string;
  everyHours: number;
  anchorTime: string;
  timezone: string;
  keepDays: number;
  keepWeekly: number;
  keepMonthly: number;
  restoreTestEveryDays: number;
  enabled: boolean;
  nextRunAt?: string;
  lastSuccessAt?: string;
  nextRestoreTestAt?: string;
  lastRestoreTestAt?: string;
  lastRestoreTestOk?: boolean;
}

export interface Backup {
  id: string;
  createdAt: string;
  targetId: string;
  kind: BackupKind;
  status: BackupStatus;
  retentionClass: RetentionClass;
  sizeBytes: number;
  sha256?: string;
  retainUntil?: string;
  log?: string;
  error: string;
  startedAt?: string;
  finishedAt?: string;
  purgedAt?: string;
}

export interface BackupRecipient {
  id: string;
  label: string;
  publicKey: string;
}

export interface BackupsStatus {
  enabled: boolean;
  agentReady: boolean;
  agentVersion: number;
  minAgent: number;
  hasRecipients: boolean;
  everyHours: number[];
}

export type BackupTargetPayload = Omit<
  BackupTarget,
  "id" | "orgId" | "serverId" | "nextRunAt" | "lastSuccessAt" | "nextRestoreTestAt" | "lastRestoreTestAt" | "lastRestoreTestOk"
>;

export interface BackupLogEvent {
  backupId: string;
  targetId: string;
  lines: string[];
}
