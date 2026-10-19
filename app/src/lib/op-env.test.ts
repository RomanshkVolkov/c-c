import { afterEach, describe, expect, it } from "vitest";
import { envImportRows, envOf, envsIn, loadMounts, saveMount } from "@/lib/op-env";

afterEach(() => localStorage.clear());

describe("las variables de un Environment de 1Password", () => {
  it("la referencia dice de qué Environment es", () => {
    expect(envOf("op-env://RRHH prod/DATABASE_URL")).toBe("RRHH prod");
    expect(envOf("op://dwit/x/y")).toBeNull();
    expect(envOf("op-env://RRHH prod/")).toBeNull();
    expect(envsIn(["op-env://b/X", "op://v/i/f", "op-env://a/Y", "op-env://b/Z"])).toEqual(["a", "b"]);
  });

  /** Las NEXT_PUBLIC_* van al build: en el servicio en marcha no sirven. */
  it("importar: una fila por variable, las NEXT_PUBLIC_ al build y sin pisar las que ya hay", () => {
    const rows = envImportRows("RRHH prod", ["DATABASE_URL", "NEXT_PUBLIC_APP_URL", "MAIL_HOST", "minusculas"], new Set(["MAIL_HOST"]));
    expect(rows).toEqual([
      { name: "DATABASE_URL", opRef: "op-env://RRHH prod/DATABASE_URL", usage: "runtime" },
      { name: "NEXT_PUBLIC_APP_URL", opRef: "op-env://RRHH prod/NEXT_PUBLIC_APP_URL", usage: "build" },
    ]);
  });

  it("recuerda en esta máquina dónde está montado cada uno", () => {
    expect(loadMounts()).toEqual({});
    saveMount("RRHH prod", "/home/x/rrhh-prod.env");
    saveMount("RRHH dev", "/home/x/rrhh-dev.env");
    expect(loadMounts()).toEqual({ "RRHH prod": "/home/x/rrhh-prod.env", "RRHH dev": "/home/x/rrhh-dev.env" });
  });
});
