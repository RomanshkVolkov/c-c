import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PasswordInput } from "@/components/ui/password-input";

/**
 * Toda contraseña de la app lleva su ojo (pedido por jose, 28-sep-2026).
 *
 * Dos cosas: que el ojo haga lo que dice, y que no nazca otro campo sin él. La
 * segunda es la que importa a la larga — el siguiente formulario se escribirá
 * copiando un `<Input type="password">` de algún sitio, y esta prueba es lo
 * único que se lo va a decir.
 */

afterEach(cleanup);

const input = () => screen.getByPlaceholderText("secreto") as HTMLInputElement;
const eye = () => screen.getByRole("button", { name: /(mostrar|show|ocultar|hide)/i });

describe("el campo de contraseña", () => {
  it("empieza oculta, el ojo la enseña, y otra vez la oculta", () => {
    render(<PasswordInput placeholder="secreto" defaultValue="abc" />);
    expect(input().type).toBe("password");
    expect(eye().getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(eye());
    expect(input().type).toBe("text");
    expect(eye().getAttribute("aria-pressed")).toBe("true");
    expect(input().value).toBe("abc");

    fireEvent.click(eye());
    expect(input().type).toBe("password");
  });

  it("pulsar el ojo dentro de un formulario no lo envía", () => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <PasswordInput placeholder="secreto" />
      </form>,
    );
    fireEvent.click(eye());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // El login lo registra con react-hook-form, que necesita el `<input>` real.
  it("el ref llega al input", () => {
    const ref = createRef<HTMLInputElement>();
    render(<PasswordInput placeholder="secreto" ref={ref} />);
    expect(ref.current).toBe(input());
  });
});

describe("la puerta", () => {
  it("no hay un type=password a pelo fuera de PasswordInput", () => {
    const src = join(process.cwd(), "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk(src);
    // Si el recorrido no encontrara nada, la prueba pasaría sin mirar.
    expect(files.length).toBeGreaterThan(50);

    const offenders = files
      .filter((f) => !f.endsWith("password-input.tsx"))
      .filter((f) => /type=\{?\s*["']password["']/.test(readFileSync(f, "utf8")))
      .map((f) => relative(src, f));
    expect(offenders).toEqual([]);
  });
});
