import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * El desplegable de la app con la forma de un `<select>` (el nativo, en
 * WebKitGTK, abría un menú blanco que se salía de la ventana). Mutantes: no
 * avisar del cambio; perder el «ninguno» (`""`); pintar el valor en vez de su
 * etiqueta; perder los grupos.
 */
const { default: Picker } = await import("./picker");
const { pick } = await import("@/test-pick");

afterEach(cleanup);

const OPCIONES = [
  { value: "", label: "Nadie" },
  { value: "u-ana", label: "@ana" },
];
const GRUPOS = [{ label: "Portento", options: [{ value: "l-1", label: "Dashboard · tasks" }] }];

describe("el desplegable de la app", () => {
  it("enseña la etiqueta, no el valor, y avisa al elegir", async () => {
    const onChange = vi.fn();
    render(<Picker aria-label="responsable" value="u-ana" onChange={onChange} options={OPCIONES} groups={GRUPOS} />);
    const boton = screen.getByRole("combobox", { name: "responsable" });
    expect(boton.textContent).toContain("@ana");
    expect(boton.textContent).not.toContain("u-ana");
    fireEvent.click(boton);
    expect(await screen.findByText("Portento")).toBeTruthy();
    fireEvent.keyDown(boton, { key: "Escape" });
    await pick(boton, "Dashboard · tasks");
    expect(onChange).toHaveBeenCalledWith("l-1");
  });

  it("«ninguno» es la cadena vacía, igual que en un select", async () => {
    const onChange = vi.fn();
    render(<Picker aria-label="responsable" value="" onChange={onChange} options={OPCIONES} />);
    const boton = screen.getByRole("combobox", { name: "responsable" });
    expect(boton.textContent).toContain("Nadie");
    await pick(boton, "@ana");
    expect(onChange).toHaveBeenCalledWith("u-ana");
    await pick(boton, "Nadie");
    expect(onChange).toHaveBeenLastCalledWith("");
  });
});
