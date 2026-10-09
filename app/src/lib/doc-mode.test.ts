import { describe, expect, it } from "vitest";

import { docsRoute } from "@/lib/doc-mode";

describe("¿se está viendo documentación?", () => {
  const doc = { orgId: "org-1" };

  it("con un documento abierto en /tasks o /docs, sí, y en esa pantalla", () => {
    expect(docsRoute(doc, "org-1", "/tasks")).toBe("/tasks");
    expect(docsRoute(doc, "org-1", "/docs")).toBe("/docs");
  });

  it("sin documento, o en otra pantalla, no", () => {
    expect(docsRoute(null, "org-1", "/tasks")).toBeNull();
    expect(docsRoute(doc, "org-1", "/my-work")).toBeNull();
    expect(docsRoute(doc, "org-1", "/tasksx")).toBeNull();
  });

  // Está persistido y puede venir de otra org (ver `org-switch`).
  it("un documento de otra org no cuenta", () => {
    expect(docsRoute(doc, "org-2", "/tasks")).toBeNull();
    expect(docsRoute(doc, null, "/tasks")).toBeNull();
  });
});
