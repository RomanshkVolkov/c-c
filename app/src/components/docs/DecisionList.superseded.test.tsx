import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { Decision } from "@/types/task";

/**
 * Una decisión que cambió no se borra: queda tachada y dice cuál la sustituyó,
 * y la nueva dice a cuál deja sin efecto (22-oct-2026). Sin esto, dos
 * decisiones contrarias se leían igual de vigentes.
 */
vi.mock("@/store/tasks.store", () => ({ useTasksStore: () => vi.fn() }));

const { default: DecisionList } = await import("@/components/docs/DecisionList");

const decision = (extra: Partial<Decision>): Decision => ({
  id: "d", docId: "doc", title: "x", body: "", authorId: "u", decidedAt: "2026-10-22T08:00:00Z", origin: "doc",
  ...extra,
});

afterEach(cleanup);

describe("una decisión sustituida", () => {
  it("queda marcada y nombra a la que la sustituyó, y la nueva a la vieja", () => {
    render(
      <DecisionList
        decisions={[
          decision({ id: "d2", title: "Las releases se juntan", supersedesId: "d1" }),
          decision({ id: "d1", title: "Una release por arreglo", supersededById: "d2" }),
        ]}
      />,
    );
    const vieja = screen.getByText("Una release por arreglo").closest("article")!;
    expect(vieja.getAttribute("data-superseded")).toBe("true");
    expect(vieja.textContent).toMatch(/superseded by|la sustituye/i);
    expect(vieja.textContent).toContain("Las releases se juntan");
    const nueva = screen.getByText("Las releases se juntan").closest("article")!;
    expect(nueva.getAttribute("data-superseded")).toBeNull();
    expect(nueva.textContent).toMatch(/supersedes|sustituye a/i);
    expect(nueva.textContent).toContain("Una release por arreglo");
  });

  it("una vigente sin historia no dice nada de eso", () => {
    render(<DecisionList decisions={[decision({ id: "d3", title: "Sola" })]} />);
    const sola = screen.getByText("Sola").closest("article")!;
    expect(sola.getAttribute("data-superseded")).toBeNull();
    expect(sola.textContent).not.toMatch(/supersede|sustituye/i);
  });
});
