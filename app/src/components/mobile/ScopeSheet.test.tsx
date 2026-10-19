import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ScopeSheet from "@/components/mobile/ScopeSheet";

afterEach(cleanup);

const groups = Array.from({ length: 12 }, (_, i) => ({
  label: `Espacio ${i}`,
  options: [{ value: `space:${i}`, label: "Todo el espacio", kind: "space" as const, id: String(i), name: `Espacio ${i}` }],
}));

/**
 * La hoja cabe en la pantalla y la lista se desliza por dentro. La hoja base
 * pone `h-auto` a las de abajo con un selector que pisaba un `h-[75dvh]`
 * suelto: la hoja crecía con la lista y se salía (18-oct-2026). El mutante
 * que mata: volver al alto sin `data-[side=bottom]:`.
 */
describe("la hoja de dónde mirar", () => {
  it("tiene su alto y la lista se desliza dentro", async () => {
    render(<ScopeSheet open onOpenChange={() => {}} groups={groups} value="" onPick={() => {}} />);
    const sheet = await screen.findByRole("dialog");
    expect(sheet.className).toContain("data-[side=bottom]:h-[75dvh]");
    expect(sheet.className).not.toContain("data-[side=bottom]:h-auto");
    const list = screen.getByText("Espacio 0").closest("section")!.parentElement!;
    expect(list.className).toContain("min-h-0");
    expect(list.className).toContain("overflow-y-auto");
  });
});
