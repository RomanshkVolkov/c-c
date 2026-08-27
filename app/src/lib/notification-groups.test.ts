import { describe, expect, it } from "vitest";
import {
  groupInbox,
  groupKeyOf,
  summarize,
  type NotificationGroup,
} from "@/lib/notification-groups";
import type { InboxItem } from "@/store/inbox.store";

/**
 * Plegar la campana: una fila por conversación.
 *
 * Todo esto es aritmética sobre una lista, así que se prueba sin montar el
 * panel — que es donde estarían las dos terceras partes del ruido y ninguna de
 * las decisiones.
 *
 * Las tres pruebas que sostienen el diseño entero: la reunión que no debe caer
 * en el grupo del canal, el aviso sin clave que no debe fundirse con los otros,
 * y el directo cuyo texto no puede asomar en la campana.
 */

const item = (extra: Partial<InboxItem> & { id: string }): InboxItem => ({
  orgId: "o",
  kind: "chat:message",
  title: "#portento",
  body: "Ana: hola",
  link: "/chat?space=s1",
  createdAt: "2026-08-27T10:00:00Z",
  ...extra,
});

/** Un grupo suelto, para probar `summarize` sin pasar por `groupInbox`. */
const grupo = (items: InboxItem[]): NotificationGroup => ({
  key: "k",
  items,
  alone: items.length === 1,
});

describe("de qué conversación es cada aviso", () => {
  it("un mensaje de canal se agrupa por su sala", () => {
    expect(groupKeyOf({ kind: "chat:message", link: "/chat?space=s1" })).toBe("space:s1");
  });

  // Una mención es del mismo sitio que un mensaje: el mismo grupo.
  it("y una mención en ese canal, también", () => {
    expect(groupKeyOf({ kind: "chat:mention", link: "/chat?space=s1" })).toBe("space:s1");
  });

  it("un directo, por su conversación", () => {
    expect(groupKeyOf({ kind: "dm:message", link: "/dm?c=c7" })).toBe("dm:c7");
  });

  it("los comentarios y el reporte, por su ficha", () => {
    expect(groupKeyOf({ kind: "task:comment", link: "/tasks?task=t3" })).toBe("item:t3");
    expect(groupKeyOf({ kind: "report:new", link: "/tasks?task=t3" })).toBe("item:t3");
  });

  // El formato viejo de la pantalla de reportes sigue vivo en filas de meses.
  it("y el enlace antiguo de reportes también", () => {
    expect(groupKeyOf({ kind: "report:new", link: "/reports?open=r9" })).toBe("item:r9");
  });

  // La prueba titular. Si la familia saliera del enlace en vez del `kind`,
  // «empieza la daily» acabaría dentro del grupo de mensajes de esa sala.
  it("una reunión NO es del grupo del canal, aunque comparta el enlace", () => {
    const canal = groupKeyOf({ kind: "chat:message", link: "/chat?space=s1" });
    const reunion = groupKeyOf({ kind: "meeting:reminder", link: "/chat?space=s1" });
    expect(reunion).not.toBe(canal);
    expect(reunion).toBe("");
  });

  // La clave del servidor manda: el día que un enlace cambie de forma, la
  // columna sigue siendo verdad y la deducción no.
  it("lo que diga el servidor gana a lo deducido", () => {
    expect(
      groupKeyOf({ kind: "chat:message", link: "/chat?space=s1", groupKey: "space:otra" }),
    ).toBe("space:otra");
  });

  it("y sin enlace reconocible no se inventa nada", () => {
    expect(groupKeyOf({ kind: "chat:message", link: "" })).toBe("");
    expect(groupKeyOf({ kind: "algo:raro", link: "/x/1" })).toBe("");
  });
});

describe("plegar la lista", () => {
  it("junta lo del mismo canal en una fila", () => {
    const g = groupInbox([item({ id: "a" }), item({ id: "b" })]);
    expect(g).toHaveLength(1);
    expect(g[0].items).toHaveLength(2);
    expect(g[0].alone).toBe(false);
  });

  // Lo viejo —sin columna— con lo nuevo, en el mismo grupo. Es lo que hace que
  // el histórico se pliegue sin migrar nada.
  it("lo que trae clave y lo que no, si son del mismo sitio", () => {
    const g = groupInbox([item({ id: "a", groupKey: "space:s1" } as never), item({ id: "b" })]);
    expect(g).toHaveLength(1);
  });

  // La segunda prueba titular: la clave vacía no es una clave. Sin esto, todo
  // lo inagrupable acabaría en un solo montón sin sentido.
  it("dos avisos sin clave se quedan cada uno por su lado", () => {
    const g = groupInbox([
      item({ id: "a", kind: "meeting:reminder" }),
      item({ id: "b", kind: "meeting:reminder" }),
    ]);
    expect(g).toHaveLength(2);
    expect(g.every((x) => x.alone)).toBe(true);
  });

  it("una sola va sola, y se sabe", () => {
    expect(groupInbox([item({ id: "a" })])[0].alone).toBe(true);
  });

  // Por lo más reciente, nunca por tamaño: un canal charlatán y viejo se
  // plantaría arriba del todo para siempre.
  it("el grupo con lo más nuevo va primero, aunque sea el más pequeño", () => {
    const g = groupInbox([
      item({ id: "a", createdAt: "2026-08-27T09:00:00Z" }),
      item({ id: "b", createdAt: "2026-08-27T09:30:00Z" }),
      item({ id: "c", link: "/dm?c=c7", kind: "dm:message", createdAt: "2026-08-27T11:00:00Z" }),
    ]);
    expect(g[0].key).toBe("dm:c7");
    expect(g[0].items).toHaveLength(1);
    expect(g[1].items).toHaveLength(2);
  });

  it("una lista vacía no revienta", () => {
    expect(groupInbox([])).toEqual([]);
  });
});

describe("cómo se lee un grupo plegado", () => {
  it("en un canal, el nombre y el último mensaje", () => {
    const s = summarize(grupo([item({ id: "a" }), item({ id: "b" })]));
    expect(s.title).toBe("#portento");
    expect(s.detail).toBe("Ana: hola");
    expect(s.count).toBe(2);
  });

  // El envoltorio de la mención no es el nombre del canal.
  it("una mención no renombra el canal", () => {
    const s = summarize(
      grupo([item({ id: "a", kind: "chat:mention", title: "Mentioned in #portento" })]),
    );
    expect(s.title).toBe("#portento");
  });

  it("y se ve que dentro te nombraron, sin abrir", () => {
    const s = summarize(grupo([item({ id: "a", kind: "chat:mention" }), item({ id: "b" })]));
    expect(s.mention).toBe(true);
    expect(summarize(grupo([item({ id: "b" })])).mention).toBe(false);
  });

  // La tercera prueba titular. El servidor manda el cuerpo vacío a propósito
  // —lo lee quien pase por detrás— y la cabecera no puede destaparlo.
  it("en un directo se cuenta, no se enseña el texto", () => {
    const s = summarize(
      grupo([
        item({ id: "a", kind: "dm:message", title: "Ana te escribió", body: "el secreto" }),
        item({ id: "b", kind: "dm:message", title: "Ana te escribió", body: "otro secreto" }),
      ]),
    );
    expect(s.title).toBe("Ana");
    expect(s.detail).toBe("2 new messages");
    expect(s.detail).not.toContain("secreto");
  });

  it("y uno solo lo dice en singular", () => {
    const s = summarize(grupo([item({ id: "a", kind: "dm:message", title: "Ana te escribió" })]));
    expect(s.detail).toBe("New message");
  });

  // En tareas los papeles se invierten: el rótulo es la tarea, no «New reply».
  it("en una tarea, el nombre es la tarea y el detalle lo que pasó", () => {
    const s = summarize(
      grupo([
        item({
          id: "a",
          kind: "task:comment",
          title: "Bea replied",
          body: "Arreglar el login",
          link: "/tasks?task=t3",
        }),
      ]),
    );
    expect(s.title).toBe("Arreglar el login");
    expect(s.detail).toBe("Bea replied");
  });

  // Va donde ocurrió lo último, no lo primero que se guardó.
  it("lleva al sitio del más reciente", () => {
    const s = summarize(
      grupo([
        item({ id: "viejo", createdAt: "2026-08-27T09:00:00Z", link: "/chat?space=s1&m=1" }),
        item({ id: "nuevo", createdAt: "2026-08-27T11:00:00Z", link: "/chat?space=s1&m=2" }),
      ]),
    );
    expect(s.link).toBe("/chat?space=s1&m=2");
  });

  // El chip dice «aquí dentro hay algo que no escribió una persona». Esconderlo
  // porque además escribió un humano lo volvería un chip en el que no se puede
  // confiar.
  it("avisa si algo de dentro lo escribió un agente", () => {
    expect(summarize(grupo([item({ id: "a", via: "mcp" }), item({ id: "b" })])).agent).toBe(true);
    expect(summarize(grupo([item({ id: "b" })])).agent).toBe(false);
  });

  it("una fila sola no lleva contador", () => {
    expect(summarize(grupo([item({ id: "a" })])).count).toBe(0);
  });
});
