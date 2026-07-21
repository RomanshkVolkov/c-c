export type Locale = "es" | "en";

export interface Strings {
  launch: string;
  title: string;
  titlePlaceholder: string;
  descPlaceholder: string;
  emailPlaceholder: string;
  attach: string;
  imagesAttached: string; // prefixed with a count
  whatSent: string;
  ctxPage: string;
  ctxErrors: string; // "{e} errores, {c} logs de consola"
  ctxNet: string; // "{n} requests fallidos, {v} navegaciones"
  ctxShots: string; // "Tus capturas"
  none: string;
  cancel: string;
  send: string;
  sending: string;
  thanks: string;
}

const es: Strings = {
  launch: "Reportar un problema",
  title: "Reportar un problema",
  titlePlaceholder: "¿Qué salió mal?",
  descPlaceholder: "Pasos, lo que esperabas vs. lo que pasó…",
  emailPlaceholder: "Tu email (opcional, para darte seguimiento)",
  attach: "Adjuntar capturas (o pega una imagen)",
  imagesAttached: "imagen(es) adjunta(s)",
  whatSent: "¿Qué se enviará?",
  ctxPage: "URL de la página, navegador y tamaño de pantalla",
  ctxErrors: "{e} error(es) de JS, {c} log(s) de consola",
  ctxNet: "{n} request(s) fallido(s), {v} navegación(es)",
  ctxShots: "Tus capturas",
  none: "ninguna",
  cancel: "Cancelar",
  send: "Enviar reporte",
  sending: "Enviando…",
  thanks: "¡Gracias! Tu reporte se envió.",
};

const en: Strings = {
  launch: "Report a problem",
  title: "Report a problem",
  titlePlaceholder: "What went wrong?",
  descPlaceholder: "Steps, expected vs. actual…",
  emailPlaceholder: "Your email (optional, for updates)",
  attach: "Attach screenshots (or paste an image)",
  imagesAttached: "image(s) attached",
  whatSent: "What will be sent?",
  ctxPage: "Page URL, browser and screen size",
  ctxErrors: "{e} JS error(s), {c} console log(s)",
  ctxNet: "{n} failed request(s), {v} navigation(s)",
  ctxShots: "Your screenshots",
  none: "none",
  cancel: "Cancel",
  send: "Send report",
  sending: "Sending…",
  thanks: "Thanks — your report was sent.",
};

const TABLE: Record<Locale, Strings> = { es, en };

/** Spanish is the default for now (guz-studio's clients are ES-first). */
export function getStrings(locale?: Locale): Strings {
  return TABLE[locale ?? "es"] ?? es;
}

export function fmt(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}
