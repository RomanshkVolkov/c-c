import { invoke } from "@tauri-apps/api/core";

import { fileCrash, signature, type Fichado } from "@/lib/file-crash";

/**
 * «No se me oye» convertido en una tarjeta con datos.
 *
 * Existe por un caso real que costó semanas: a alguien no se le oía, él oía a
 * todos perfectamente, y **no se pudo diagnosticar**. Se sabía el síntoma y
 * nada más. Pedirle a la persona que abra ajustes de Windows y lea formatos de
 * muestra no funciona: está en una reunión, frustrada, y para cuando llega a la
 * pestaña correcta la llamada ya terminó.
 *
 * Así que el botón está **dentro de la llamada**, que es el único momento en el
 * que el motor sabe todo lo que hace falta, y es una sola pulsación sin
 * formulario. Un formulario es una barrera justo cuando menos paciencia hay.
 *
 * **No viaja ni un byte de audio.** Van nombres de dispositivo, ritmos,
 * formatos, contadores y el diario del motor — que es texto que escribimos
 * nosotros. Conviene que siga siendo así.
 */

interface Formato {
  dispositivo: string;
  ritmo: number;
  canales: number;
  formato: string;
  ritmoDeLaFuente: number;
  coincide: boolean;
}

interface Reporte {
  sesionViva: boolean;
  yo: string | null;
  silenciado: boolean;
  sordo: boolean;
  camara: boolean;
  compartiendo: boolean;
  publicando: boolean;
  tramasPublicadas: number;
  picoMilesimas: number;
  ultimoFalloCaptura: string | null;
  formatoEntrada: Formato | null;
  micElegido: string | null;
  diario: string[];
}

/**
 * El veredicto, dicho antes que los datos.
 *
 * Es lo que convierte un volcado en un diagnóstico. Las tres causas posibles
 * dan el mismo síntoma visto desde fuera, y los tres contadores las separan;
 * escribir cuál es al principio de la tarjeta ahorra que alguien tenga que
 * volver a razonarlo dentro de seis meses.
 */
function veredicto(r: Reporte): string {
  if (r.formatoEntrada && !r.formatoEntrada.coincide) {
    return `**El ritmo no coincide.** El micrófono va a ${r.formatoEntrada.ritmo} Hz y la fuente publicada espera ${r.formatoEntrada.ritmoDeLaFuente} Hz, y no hay resampleo. Es la causa más probable y no da ningún error.`;
  }
  if (!r.sesionViva) return "No había sesión de voz viva al pulsar el botón.";
  if (!r.publicando) {
    return "**Se dejó de publicar.** El bucle que sube el audio no está corriendo, así que el micrófono puede estar capturando perfectamente y no salir nada.";
  }
  if (r.tramasPublicadas === 0) {
    return "**No se ha publicado ni una trama.** No llegó a subir nada desde que empezó la llamada.";
  }
  if (r.picoMilesimas === 0 && !r.silenciado) {
    return "**Se están publicando ceros.** El micrófono entrega muestras y se suben, pero vienen en silencio — sin estar silenciado en la app.";
  }
  if (r.silenciado) return "El micrófono estaba silenciado en la app al pulsar el botón.";
  return "Sube audio con señal. Si aun así no se le oye, el problema no está en la captura sino más adelante.";
}

/** El cuerpo de la tarjeta. Primero el veredicto, luego lo que lo sostiene. */
function cuerpo(r: Reporte, nota: string): string {
  const f = r.formatoEntrada;
  return [
    veredicto(r),
    "",
    nota ? `> ${nota}\n` : "",
    "## El micrófono",
    "",
    f
      ? [
          `| | |`,
          `|---|---|`,
          `| Dispositivo | ${f.dispositivo} |`,
          `| Ritmo | ${f.ritmo} Hz${f.coincide ? "" : ` ⚠ la fuente espera ${f.ritmoDeLaFuente}`} |`,
          `| Canales | ${f.canales} |`,
          `| Formato | ${f.formato} |`,
        ].join("\n")
      : "No se llegó a abrir ningún micrófono.",
    "",
    "## Lo que está pasando ahora",
    "",
    `| | |`,
    `|---|---|`,
    `| Tramas publicadas | ${r.tramasPublicadas} |`,
    `| Pico de la última | ${r.picoMilesimas} ‰ |`,
    `| Publicando | ${r.publicando ? "sí" : "**no**"} |`,
    `| Silenciado | ${r.silenciado ? "sí" : "no"} |`,
    `| Ensordecido | ${r.sordo ? "sí" : "no"} |`,
    `| Cámara | ${r.camara ? "sí" : "no"} |`,
    `| Compartiendo | ${r.compartiendo ? "sí" : "no"} |`,
    `| Identidad | ${r.yo ?? "—"} |`,
    r.ultimoFalloCaptura ? `| Último fallo | \`${r.ultimoFalloCaptura}\` |` : "",
    "",
    "## El sistema",
    "",
    `\`${navigator.userAgent}\``,
    "",
    "## Diario del motor",
    "",
    "```",
    // Las últimas, no las primeras: lo que pasó justo antes de pulsar es lo que
    // explica el momento, y un diario largo entero no lo lee nadie.
    r.diario.slice(-80).join("\n") || "(vacío)",
    "```",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * Junta, ficha y devuelve qué pasó.
 *
 * La clave de idempotencia lleva el dispositivo y el veredicto: dos personas
 * con el mismo fallo caen en la misma tarjeta, y la misma persona pulsando tres
 * veces seguidas —que es lo que hace alguien frustrado— no abre tres.
 */
export async function reportarAudio(nota = ""): Promise<Fichado> {
  let r: Reporte;
  try {
    r = await invoke<Reporte>("voice_report");
  } catch {
    // Sin motor no hay datos, pero el reporte sigue valiendo: que alguien
    // pulsara el botón ya es la información de que algo iba mal.
    return fileCrash({
      title: "Audio: no se pudo leer el estado del motor de voz",
      description: `Alguien pulsó reportar en una llamada y \`voice_report\` falló.\n\n\`${navigator.userAgent}\``,
      key: signature("voice-report-sin-motor"),
    });
  }
  const f = r.formatoEntrada;
  const titulo = f
    ? `Audio: ${f.ritmo} Hz · ${f.dispositivo}`.slice(0, 120)
    : "Audio: no se abrió el micrófono";
  return fileCrash({
    title: titulo,
    description: cuerpo(r, nota.trim()),
    key: signature(`voice:${f?.dispositivo ?? "?"}:${f?.ritmo ?? 0}:${veredicto(r).slice(0, 40)}`),
  });
}
