import { describe, expect, it } from "vitest";

/**
 * Dates on a card, in the two words that change what you do next.
 *
 * `2026-08-16` needs arithmetic before it means anything; "today" and
 * "yesterday" do not. And overdue is a different colour, so the difference is
 * visible without reading.
 */

const { cuando } = await import("@/components/tasks/TaskCardMini");

const dias = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString();
};

describe("el vencimiento en palabras", () => {
  it("hoy y ayer se dicen, no se calculan", () => {
    expect(cuando(dias(0)).texto).toBe("today");
    expect(cuando(dias(-1)).texto).toBe("yesterday");
  });

  it("hoy ya cuenta como vencida: es la fecha que cambia lo que haces ahora", () => {
    expect(cuando(dias(0)).vencida).toBe(true);
    expect(cuando(dias(-3)).vencida).toBe(true);
  });

  it("mañana todavía no", () => {
    expect(cuando(dias(1)).vencida).toBe(false);
    expect(cuando(dias(1)).texto).toBe("tomorrow");
  });

  it("sin fecha no inventa una", () => {
    expect(cuando(null).texto).toBe("");
    expect(cuando(undefined).vencida).toBe(false);
  });
});
