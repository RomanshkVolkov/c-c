import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { tocaLaCampana } from "@/hooks/use-report-events";
import { useBackupsStore } from "@/store/backups.store";
import type { Backup } from "@/types/backups";

/**
 * Los eventos de los backups (#166), dados de alta en los sitios que pide un
 * evento nuevo (ver `meeting-evento.test.ts`).
 * Mutantes: releer la campana con cada backup (también los buenos); no
 * atender `backup:status`; olvidarlos en el transporte del navegador.
 */
const fuente = () => readFileSync(join(process.cwd(), "src/hooks/use-report-events.ts"), "utf-8");

describe("los eventos de los backups", () => {
  it("sólo un backup fallido relee la campana", () => {
    expect(tocaLaCampana("backup:status", JSON.stringify({ status: "failed" }))).toBe(true);
    expect(tocaLaCampana("backup:status", JSON.stringify({ status: "succeeded" }))).toBe(false);
    expect(tocaLaCampana("backup:log", JSON.stringify({ lines: [] }))).toBe(false);
  });

  it("el repartidor los lleva a la pestaña", () => {
    const f = fuente();
    expect(f).toContain("useBackupsStore.getState().onStatus(");
    expect(f).toContain("useBackupsStore.getState().onLog(");
  });

  it("y el transporte de navegador los escucha", () => {
    const lista = fuente().slice(fuente().indexOf("for (const kind of ["));
    const items = lista.slice(0, lista.indexOf("]"));
    expect(items).toContain('"backup:status"');
    expect(items).toContain('"backup:log"');
  });

  it("un estado nuevo entra arriba del historial y uno conocido se actualiza", () => {
    const b = (id: string, status: Backup["status"]) => ({ id, targetId: "t1", status }) as Backup;
    useBackupsStore.setState({ history: { t1: [b("a", "succeeded")] } });
    useBackupsStore.getState().onStatus(b("b", "queued"));
    useBackupsStore.getState().onStatus(b("b", "running"));
    expect(useBackupsStore.getState().history.t1.map((x) => `${x.id}:${x.status}`)).toEqual(["b:running", "a:succeeded"]);
  });
});
