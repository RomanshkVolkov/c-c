import { describe, expect, it } from "vitest";
import { cardHref, docHref, docRefFromHref, taskIdFromHref } from "./card-menu";

// Citing a card is the reason this chat exists instead of a Slack channel, and
// the whole mechanism is one link: written by the picker, read back by the
// renderer. If the two ever disagree, a citation renders as a dead link that
// navigates the app away from itself — the failure is silent and looks like the
// chat "just doesn't do that".

describe("a citation survives the round trip", () => {
  it("reads back the id the picker wrote", () => {
    const id = "8474cb83-1c2f-4a54-9c1e-3a2b6d0e5f11";
    expect(taskIdFromHref(cardHref(id))).toBe(id);
  });

  it("stays relative, so it resolves against whichever backend the app points at", () => {
    expect(cardHref("abc").startsWith("/")).toBe(true);
  });
});

describe("what must not be claimed as a citation", () => {
  it("ignores an ordinary link somebody pasted", () => {
    // Claiming this would swallow the click and never open the browser.
    expect(taskIdFromHref("https://example.com/docs")).toBeNull();
  });

  it("ignores a link to the board itself", () => {
    expect(taskIdFromHref("/tasks")).toBeNull();
  });

  it("ignores /tasks with some other query", () => {
    expect(taskIdFromHref("/tasks?list=abc")).toBeNull();
  });

  it("ignores an empty task id rather than opening a drawer for nothing", () => {
    expect(taskIdFromHref("/tasks?task=")).toBeNull();
  });

  it("does not match a path that merely ends in the word tasks", () => {
    // `/api/v1/mytasks?task=x` is not ours. Matching on `includes` would take it.
    expect(taskIdFromHref("/api/v1/mytasks?task=x")).toBeNull();
  });

  it("does not match an external host that happens to have /tasks", () => {
    expect(taskIdFromHref("https://evil.example.com/tasks?task=abc")).toBeNull();
  });
});

/**
 * El enlace a un documento compartido.
 *
 * Se escribe dentro de un mensaje, así que lo lee el mismo renderizador que
 * cualquier otro enlace pegado en el chat. Dos formas de romperlo, y las dos son
 * silenciosas: reclamar enlaces que no son nuestros —y sacar a la gente del
 * navegador para enseñarle una pantalla vacía—, o no reconocer los propios y
 * abrir la app fuera de la app.
 */
describe("el enlace a un documento", () => {
  it("va y vuelve", () => {
    expect(docRefFromHref(docHref("list", "l1"))).toEqual({
      kind: "list",
      id: "l1",
      tab: undefined,
    });
  });

  it("la sección viaja con él", () => {
    expect(docRefFromHref(docHref("space", "s1", "runbook"))).toEqual({
      kind: "space",
      id: "s1",
      tab: "runbook",
    });
  });

  /**
   * El fallo que ya se cometió una vez con las tarjetas.
   *
   * El segundo caso es el que de verdad lo comprueba: con un solo parámetro, un
   * prefijo laxo falla igualmente por casualidad —lo que queda tras recortar no
   * parsea—, y la prueba pasaría con el error dentro. Con dos parámetros sí
   * parsea, y entonces un enlace externo perfectamente bueno deja de abrir el
   * navegador y abre una pantalla vacía.
   */
  it("un enlace externo no es nuestro", () => {
    expect(docRefFromHref("https://ejemplo.com/tasks?doc=list:l1")).toBeNull();
    expect(docRefFromHref("https://ejemplo.com/tasks?a=1&doc=list:l1")).toBeNull();
    expect(taskIdFromHref("https://ejemplo.com/tasks?a=1&task=t1")).toBeNull();
  });

  it("una cita de tarjeta no es un documento, ni al revés", () => {
    expect(docRefFromHref(cardHref("t1"))).toBeNull();
    expect(taskIdFromHref(docHref("list", "l1"))).toBeNull();
  });

  // Un `doc` a medias llega si alguien edita el mensaje a mano. Mejor no
  // reconocerlo que llamar a una ruta con la mitad de los datos.
  it("un identificador a medias no vale", () => {
    expect(docRefFromHref("/tasks?doc=list")).toBeNull();
    expect(docRefFromHref("/tasks?doc=:l1")).toBeNull();
    expect(docRefFromHref("/tasks?doc=")).toBeNull();
  });
});
