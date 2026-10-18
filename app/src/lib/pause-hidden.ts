/**
 * Con la ventana oculta no se anima nada (ver `html.app-hidden` en
 * index.css): un brillo de carga, un punto que late o un aspa que gira siguen
 * gastando procesador aunque nadie los vea, y en un portátil eso es batería.
 */
export function installPauseWhenHidden(doc: Document = document) {
  const sync = () => doc.documentElement.classList.toggle("app-hidden", doc.visibilityState === "hidden");
  sync();
  doc.addEventListener("visibilitychange", sync);
  return () => doc.removeEventListener("visibilitychange", sync);
}
