import { describe, expect, it } from "vitest";

import { defaultTarget, detectDatabases, isAgePublicKey } from "@/lib/backups";
import type { SwarmService } from "@/types/swarm";
import type { BackupTarget } from "@/types/backups";

const svc = (name: string, image: string): SwarmService =>
  ({ id: name, name, image, stack: "s", replicas: { running: 1, desired: 1 }, updatedAt: "" }) as unknown as SwarmService;

/**
 * Las bases que se ven por su imagen, con la variable de la imagen oficial.
 * Mutantes: no detectar postgres; detectar una web que se llama «postgres-ui»;
 * volver a ofrecer una que ya se respalda.
 */
describe("las bases de un servidor", () => {
  const services = [
    svc("sqlserver-prod_db", "mcr.microsoft.com/mssql/server:latest@sha256:b139"),
    svc("app_db", "postgres:16-alpine"),
    svc("geo_db", "docker.io/postgis/postgis:16-3.4"),
    svc("web_app", "ghcr.io/dwit/web:abc"),
    svc("admin_ui", "dpage/postgres-ui:1"),
  ];

  it("encuentra SQL Server y Postgres con su credencial", () => {
    expect(detectDatabases(services)).toEqual([
      { serviceName: "sqlserver-prod_db", engine: "mssql", credentialEnv: "MSSQL_SA_PASSWORD" },
      { serviceName: "app_db", engine: "postgres", credentialEnv: "POSTGRES_USER" },
      { serviceName: "geo_db", engine: "postgres", credentialEnv: "POSTGRES_USER" },
    ]);
  });

  it("no vuelve a ofrecer una que ya se respalda", () => {
    const taken = [{ serviceName: "app_db" } as BackupTarget];
    expect(detectDatabases(services, taken).map((d) => d.serviceName)).not.toContain("app_db");
  });

  it("el formulario arranca con lo del plan: diario a las 03:30, 7/4/6, prueba semanal", () => {
    const p = defaultTarget(detectDatabases(services)[0]);
    expect(p).toMatchObject({ engine: "mssql", everyHours: 24, anchorTime: "03:30", keepDays: 7, keepWeekly: 4, keepMonthly: 6, restoreTestEveryDays: 7 });
  });
});

/** La llave pública, la misma forma que en el backend. Mutante: aceptar la privada. */
describe("la llave age", () => {
  it("acepta una pública y rechaza la privada", () => {
    expect(isAgePublicKey("age1uzcuhrh6yezjg96efqkks530nnrtmea9q89m87pawfqdckp8h9yqf9yvjy")).toBe(true);
    expect(isAgePublicKey("AGE-SECRET-KEY-1QQQ")).toBe(false);
    expect(isAgePublicKey("age1short")).toBe(false);
  });
});
