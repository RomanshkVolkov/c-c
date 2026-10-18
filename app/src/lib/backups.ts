import type { SwarmService } from "@/types/swarm";
import type { BackupEngine, BackupTarget, BackupTargetPayload } from "@/types/backups";

/**
 * Las piezas puras de la pestaña Backups (#166).
 */

export interface DetectedDatabase {
  serviceName: string;
  engine: BackupEngine;
  /** El nombre de la variable de entorno con la credencial, el de la imagen oficial. */
  credentialEnv: string;
}

/**
 * Las bases que se ven entre los servicios, por su imagen. Sólo las oficiales
 * de SQL Server y Postgres (también con registro delante, `docker.io/…`, o
 * las de bitnami); lo demás no se adivina y se puede añadir a mano.
 */
export function detectDatabases(services: SwarmService[], already: BackupTarget[] = []): DetectedDatabase[] {
  const taken = new Set(already.map((t) => t.serviceName));
  const out: DetectedDatabase[] = [];
  for (const s of services) {
    if (taken.has(s.name)) continue;
    const image = s.image.toLowerCase().split("@")[0];
    if (image.includes("mssql/server")) {
      out.push({ serviceName: s.name, engine: "mssql", credentialEnv: "MSSQL_SA_PASSWORD" });
    } else if (/(^|\/)(postgres|postgresql|postgis)(:|$)/.test(image) || image.includes("bitnami/postgresql")) {
      out.push({ serviceName: s.name, engine: "postgres", credentialEnv: "POSTGRES_USER" });
    }
  }
  return out;
}

/** La zona del equipo, para que «a las 03:30» sea la hora que uno espera. */
export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Lo que trae el formulario al abrirlo para una base detectada. */
export function defaultTarget(d: DetectedDatabase | null): BackupTargetPayload {
  return {
    serviceName: d?.serviceName ?? "",
    engine: d?.engine ?? "postgres",
    database: "",
    credentialEnv: d?.credentialEnv ?? "POSTGRES_USER",
    everyHours: 24,
    anchorTime: "03:30",
    timezone: localTimezone(),
    keepDays: 7,
    keepWeekly: 4,
    keepMonthly: 6,
    restoreTestEveryDays: 7,
    enabled: true,
  };
}

/** Lo que se edita de una base que ya existe. */
export function payloadOf(t: BackupTarget): BackupTargetPayload {
  return {
    serviceName: t.serviceName,
    engine: t.engine,
    database: t.database,
    credentialEnv: t.credentialEnv,
    everyHours: t.everyHours,
    anchorTime: t.anchorTime,
    timezone: t.timezone,
    keepDays: t.keepDays,
    keepWeekly: t.keepWeekly,
    keepMonthly: t.keepMonthly,
    restoreTestEveryDays: t.restoreTestEveryDays,
    enabled: t.enabled,
  };
}

/** Una llave pública age, con la misma forma que pide el backend. */
export function isAgePublicKey(s: string): boolean {
  return /^age1[02-9ac-hj-np-z]{58}$/.test(s.trim());
}

/**
 * Cuántos backups se guardan como mucho, para decirlo en el formulario: los
 * días, más una semanal por semana guardada y una mensual por mes.
 */
export function retainedCount(p: Pick<BackupTargetPayload, "everyHours" | "keepDays" | "keepWeekly" | "keepMonthly">): number {
  return Math.ceil((p.keepDays * 24) / p.everyHours) + p.keepWeekly + p.keepMonthly;
}
