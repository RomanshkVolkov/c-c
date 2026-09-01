import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * El veredicto de un reporte de audio.
 *
 * Es lo único de esta pieza que merece prueba, y es donde está todo el valor:
 * las tres causas posibles de «no se me oye» **dan el mismo síntoma visto desde
 * fuera**, y lo que las separa son tres contadores. Si el veredicto se equivoca,
 * la tarjeta manda a quien la lea al sitio contrario — que es peor que no tener
 * tarjeta, porque encima parece que ya está diagnosticado.
 *
 * El caso real que dio origen a esto costó semanas por no tener ninguno de
 * estos números.
 */

const invoke = vi.fn<(...a: unknown[]) => unknown>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
type Ficha = { title: string; description: string; key: string };
const fileCrash = vi.fn<(o: Ficha) => Promise<string>>(() => Promise.resolve("done"));
vi.mock("@/lib/file-crash", () => ({
  fileCrash: (o: Ficha) => fileCrash(o),
  signature: (s: string) => s,
}));

/** La última ficha que se mandó. */
function ultima(): Ficha {
  const calls = fileCrash.mock.calls;
  return calls[calls.length - 1][0];
}

const SANO = {
  sesionViva: true, yo: "ana", silenciado: false, sordo: false,
  camara: false, compartiendo: false, publicando: true,
  tramasPublicadas: 5000, picoMilesimas: 320, ultimoFalloCaptura: null,
  micElegido: null, diario: ["00:00:01 · micro: «Auriculares» a 48000 Hz"],
  formatoEntrada: {
    dispositivo: "Auriculares", ritmo: 48000, canales: 1,
    formato: "F32", ritmoDeLaFuente: 48000, coincide: true,
  },
};

/** El cuerpo de la tarjeta que se habría fichado. */
async function cuerpoDe(cambios: Record<string, unknown>) {
  const { recogerAudio, enviarAudio } = await import("@/lib/voice-report");
  invoke.mockResolvedValueOnce({ ...SANO, ...cambios });
  // Recoger y enviar van separados desde que el botón pregunta antes de
  // fichar. Se prueban juntos porque lo que importa es lo que acaba en la
  // tarjeta, que es lo mismo por los dos caminos.
  const borrador = await recogerAudio();
  await enviarAudio(borrador);
  return { ...ultima(), veredicto: borrador.veredicto };
}

describe("el veredicto", () => {
  beforeEach(() => {
    invoke.mockReset();
    fileCrash.mockClear();
  });

  // El caso que originó todo esto: el dispositivo va a 44100 y la fuente
  // publicada se creó a 48000, sin resampleo. Nadie te oye y no hay ni un error.
  it("el desajuste de ritmo manda sobre todo lo demás", async () => {
    const { description } = await cuerpoDe({
      formatoEntrada: { ...SANO.formatoEntrada, ritmo: 44100, coincide: false },
    });
    expect(description).toContain("El ritmo no coincide");
    expect(description).toContain("44100");
    expect(description).toContain("48000");
  });

  // Se dijo antes: es lo primero de la tarjeta aunque todo lo demás esté bien,
  // porque explica el síntoma entero y las otras señales parecen sanas.
  it("y lo dice aunque los contadores parezcan sanos", async () => {
    const { description } = await cuerpoDe({
      formatoEntrada: { ...SANO.formatoEntrada, ritmo: 44100, coincide: false },
      tramasPublicadas: 9000,
      picoMilesimas: 400,
    });
    expect(description.split("\n")[0]).toContain("El ritmo no coincide");
  });

  it("distingue «dejó de publicar» de «no captura»", async () => {
    const parado = await cuerpoDe({ publicando: false });
    expect(parado.description).toContain("dejó de publicar");

    const mudo = await cuerpoDe({ tramasPublicadas: 0 });
    expect(mudo.description).toContain("ni una trama");
  });

  // El fallo más engañoso: todo parece perfecto y se están subiendo ceros.
  it("caza el silencio publicado", async () => {
    const { description } = await cuerpoDe({ picoMilesimas: 0 });
    expect(description).toContain("ceros");
  });

  // Y no lo confunde con estar silenciado a propósito, que se ve igual en los
  // contadores y no es un fallo.
  it("pero no si lo que pasa es que te silenciaste", async () => {
    const { description } = await cuerpoDe({ picoMilesimas: 0, silenciado: true });
    expect(description).not.toContain("ceros");
    expect(description).toContain("silenciado");
  });

  it("y cuando todo está bien, lo dice en vez de inventar una causa", async () => {
    const { description } = await cuerpoDe({});
    expect(description).toContain("Sube audio con señal");
  });

  // Alguien frustrado pulsa tres veces. Tres tarjetas iguales son ruido.
  it("dos personas con el mismo fallo caen en la misma tarjeta", async () => {
    const roto = { formatoEntrada: { ...SANO.formatoEntrada, ritmo: 44100, coincide: false } };
    await cuerpoDe(roto);
    const primera = ultima().key;
    await cuerpoDe(roto);
    const segunda = ultima().key;
    expect(segunda).toBe(primera);
  });

  // Distinto fallo, distinta tarjeta: agrupar dos causas bajo una sola esconde
  // la segunda hasta que alguien la abre.
  it("y dos fallos distintos no se agrupan", async () => {
    await cuerpoDe({ formatoEntrada: { ...SANO.formatoEntrada, ritmo: 44100, coincide: false } });
    const ritmo = ultima().key;
    await cuerpoDe({ publicando: false });
    const parado = ultima().key;
    expect(parado).not.toBe(ritmo);
  });

  // No se manda audio. Nunca. Va texto que escribimos nosotros.
  it("no viaja nada que no sea texto nuestro", async () => {
    const { description } = await cuerpoDe({});
    expect(description).toContain("Diario del motor");
    expect(description).not.toMatch(/base64|data:audio|blob:/i);
  });

  // Sin motor, el reporte sigue valiendo: que alguien lo pulsara ya es un dato.
  it("si el motor no contesta, se puede fichar igualmente", async () => {
    const { recogerAudio, enviarAudio } = await import("@/lib/voice-report");
    invoke.mockRejectedValueOnce(new Error("sin motor"));
    const borrador = await recogerAudio();
    expect(borrador.sinMotor).toBe(true);
    await expect(enviarAudio(borrador)).resolves.toBe("done");
  });

  /**
   * El veredicto está **antes** de mandar nada.
   *
   * Es lo que convierte el diálogo en algo útil por sí solo: quien lo abre y lee
   * «estabas silenciado» lo arregla y cierra sin fichar. Si esto se rompiera,
   * volveríamos a un botón que sólo sirve para crear tarjetas.
   */
  it("se puede leer el diagnóstico sin fichar nada", async () => {
    const { recogerAudio } = await import("@/lib/voice-report");
    invoke.mockResolvedValueOnce({ ...SANO, silenciado: true, picoMilesimas: 0 });
    const borrador = await recogerAudio();
    expect(borrador.veredicto).toContain("silenciado");
    expect(fileCrash).not.toHaveBeenCalled();
  });
});
