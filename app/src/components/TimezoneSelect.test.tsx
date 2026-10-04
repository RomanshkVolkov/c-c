import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * El selector de zona: arriba la del equipo y la tuya, y una zona guardada que
 * esta plataforma no lista sigue apareciendo —si no, el desplegable enseñaría
 * otra y guardar la cambiaría sin querer—.
 */

const { default: TimezoneSelect } = await import("./TimezoneSelect");
const { myZone } = await import("@/lib/timezones");

afterEach(cleanup);

describe("el selector de zona", () => {
  it("sugiere la del equipo y la tuya primero, y devuelve la elegida", () => {
    const onChange = vi.fn();
    render(<TimezoneSelect ariaLabel="zona" value="America/Cancun" teamZone="America/Cancun" onChange={onChange} />);
    const select = screen.getByLabelText("zona") as HTMLSelectElement;
    const suggested = Array.from(select.querySelectorAll("optgroup")[0].querySelectorAll("option")).map((o) => o.value);
    expect(suggested[0]).toBe("America/Cancun");
    expect(suggested).toContain(myZone());
    fireEvent.change(select, { target: { value: "Europe/Madrid" } });
    expect(onChange).toHaveBeenCalledWith("Europe/Madrid");
  });

  it("una zona guardada que no está en la lista no se pierde", () => {
    render(<TimezoneSelect ariaLabel="zona" value="Mars/Olympus" onChange={() => {}} />);
    expect((screen.getByLabelText("zona") as HTMLSelectElement).value).toBe("Mars/Olympus");
  });

  it("con allowEmpty se puede dejar sin decidir", () => {
    render(<TimezoneSelect ariaLabel="zona" value="" allowEmpty onChange={() => {}} />);
    expect((screen.getByLabelText("zona") as HTMLSelectElement).value).toBe("");
  });
});
