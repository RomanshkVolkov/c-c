import { mediaSrc } from "@/lib/media";

/**
 * Abre un PDF adjunto con pdf.js. Lo comparten el visor (`PdfPreview`) y la
 * tarjeta con la primera página (`PdfCard`).
 *
 * Los bytes llegan por `mediaSrc()`: en la app, `cacmedia://`, cuyo manejador
 * en Rust pone la credencial (y CORS: pdf.js descarga con `fetch`); en la web,
 * con un pase de adjuntos en la URL.
 */
export async function openPdf(url: string) {
  const pdfjs = await import("pdfjs-dist");
  // El worker es un fichero aparte; Vite le pone hash y nos da su URL. Sin
  // esto pdf.js intenta adivinar la ruta y falla.
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const src = mediaSrc(url);
  if (!src) throw new Error("no source");
  // La tarea de carga y no el documento: `destroy()` vive ahí y es lo que
  // apaga el hilo del worker. Dejar uno vivo por PDF sería caro y silencioso.
  // Se devuelve **antes** de esperar al documento, para que quien cierre a
  // medias de cargar pueda destruirla.
  return pdfjs.getDocument({ url: src });
}

type PdfDoc = Awaited<ReturnType<typeof openPdf>>["promise"] extends Promise<infer D> ? D : never;

/** Dibuja una página en un canvas al ancho dado (en píxeles CSS), nítida en HiDPI. */
export async function drawPage(
  doc: PdfDoc,
  n: number,
  canvas: HTMLCanvasElement,
  cssWidth: number,
) {
  const page = await doc.getPage(n);
  const dpr = window.devicePixelRatio || 1;
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = `${cssWidth}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
}
