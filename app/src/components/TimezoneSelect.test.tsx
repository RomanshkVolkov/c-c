import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * El selector de zona: arriba la del equipo y la tuya, y una zona guardada que
 * esta plataforma no lista sigue apareciendo —si no, el desplegable enseñaría
 * otra y guardar la cambiaría sin querer—.
 */

const { default: TimezoneSelect } = await import("./TimezoneSelect");
const { myZone, zoneLabel } = await import("@/lib/timezones");
const { pick } = await import("@/test-pick");

afterEach(cleanup);

describe("el selector de zona", () => {
  it("sugiere la del equipo y la tuya primero, y devuelve la elegida", async () => {
    const onChange = vi.fn();
    render(<TimezoneSelect ariaLabel="zona" value="America/Cancun" teamZone="America/Cancun" onChange={onChange} />);
    const boton = screen.getByRole("combobox", { name: "zona" });
    fireEvent.click(boton);
    const opciones = (await screen.findAllByRole("option")).map((o) => o.textContent ?? "");
    expect(opciones[0]).toContain(zoneLabel("America/Cancun"));
    expect(opciones.slice(0, 2).some((o) => o.includes(zoneLabel(myZone())))).toBe(true);
    fireEvent.keyDown(boton, { key: "Escape" });
    await pick(boton, zoneLabel("Europe/Madrid"));
    expect(onChange).toHaveBeenCalledWith("Europe/Madrid");
  });

  it("una zona guardada que no está en la lista no se pierde", () => {
    render(<TimezoneSelect ariaLabel="zona" value="Mars/Olympus" onChange={() => {}} />);
    expect(screen.getByRole("combobox", { name: "zona" }).textContent).toContain("Mars/Olympus");
  });

  it("con allowEmpty se puede dejar sin decidir", () => {
    render(<TimezoneSelect ariaLabel="zona" value="" allowEmpty onChange={() => {}} />);
    expect(screen.getByRole("combobox", { name: "zona" }).textContent).toMatch(/Sin decidir|Not set/);
  });
});
