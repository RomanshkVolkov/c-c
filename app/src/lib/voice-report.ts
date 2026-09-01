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
 * que el motor sabe todo lo que hace falta.
 *
 * Pero **pregunta antes de mandar**, y la primera versión no lo hacía. El
 * razonamiento de entonces era «un formulario es una barrera justo cuando menos
 * paciencia hay», y confundía dos cosas: no pedirte que rellenes nada, que está
 * bien, con no preguntarte nada, que no. Esto **crea una tarjeta en un tablero
 * compartido** y manda el nombre de tu micrófono y el diario de tu máquina; las
 * dos cosas se confirman, y se enseñan antes.
 *
 * Y el diálogo resultó valer por sí solo: el veredicto se calcula **antes** de
 * mandar nada, así que quien lo abre y lee «estabas silenciado» lo arregla y
 * cierra sin fichar. La mitad de los reportes que no hacen falta se evitan ahí.
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

/** Lo que se va a mandar, antes de mandarlo. */
export interface Borrador {
  titulo: string;
  /** La frase de arriba, la que contesta «¿qué me pasa?». */
  veredicto: string;
  /** El markdown entero, para que se pueda leer antes de aceptar. */
  cuerpo: string;
  clave: string;
  /** Si el motor no contestó. Se puede mandar igualmente. */
  sinMotor: boolean;
}

/**
 * Recoge y arma el borrador. **No manda nada.**
 *
 * Separado de `enviar` a propósito: es lo que permite enseñarlo antes, y es lo
 * que hace que el veredicto sirva aunque nunca se llegue a fichar.
 */
export async function recogerAudio(nota = ""): Promise<Borrador> {
  let r: Reporte;
  try {
    r = await invoke<Reporte>("voice_report");
  } catch {
    // Sin motor no hay datos, pero el reporte sigue valiendo: que alguien
    // llegara hasta aquí ya es la información de que algo iba mal.
    return {
      titulo: "Audio: no se pudo leer el estado del motor de voz",
      veredicto: "No se pudo leer el estado del motor de voz.",
      cuerpo: `Alguien abrió el reporte en una llamada y \`voice_report\` falló.\n\n\`${navigator.userAgent}\``,
      clave: signature("voice-report-sin-motor"),
      sinMotor: true,
    };
  }
  const f = r.formatoEntrada;
  return {
    titulo: f
      ? `Audio: ${f.ritmo} Hz · ${f.dispositivo}`.slice(0, 120)
      : "Audio: no se abrió el micrófono",
    veredicto: veredicto(r),
    cuerpo: cuerpo(r, nota.trim()),
    // La clave lleva el dispositivo y el veredicto: dos personas con el mismo
    // fallo caen en la misma tarjeta, y la misma persona mandándolo tres veces
    // —que es lo que hace alguien frustrado— no abre tres.
    clave: signature(`voice:${f?.dispositivo ?? "?"}:${f?.ritmo ?? 0}:${veredicto(r).slice(0, 40)}`),
    sinMotor: false,
  };
}

/** Y esto sí ficha, con lo que ya se enseñó. */
export function enviarAudio(b: Borrador): Promise<Fichado> {
  return fileCrash({ title: b.titulo, description: b.cuerpo, key: b.clave });
}
