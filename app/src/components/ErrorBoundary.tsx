import i18next from "i18next";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { fileCrash, rutaActual, signature, type Fichado } from "@/lib/file-crash";

/**
 * What the app does when a render throws.
 *
 * Until now: nothing. React unmounted the whole tree and left the window
 * showing its own background, so a crash looked like "the screen went blue" —
 * no message, no trace, nothing to search for. Two separate bugs were diagnosed
 * from that single symptom, both times by guessing from a screenshot.
 *
 * So this does two things. It says what broke, and it **files the crash as a
 * card on cac's own board**, because a bug nobody wrote down is a bug that gets
 * rediscovered.
 */

/**
 * El nombre estable de un pantallazo: el mensaje más el primer marco.
 *
 * React vuelve a dibujar tras un error y una persona pulsa recargar más de una
 * vez, así que sin esto una pantalla rota levantaría una tarjeta por intento.
 */
function firmaDe(error: Error): string {
  const frame = (error.stack ?? "").split("\n")[1]?.trim() ?? "";
  return signature(`${error.name}: ${error.message} @ ${frame}`);
}

interface State {
  error: Error | null;
  filed: Fichado;
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, filed: "no" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Console first and unconditionally: whatever happens to the card, the
    // trace should be somewhere a developer can reach it.
    console.error("cac: render crashed", error, info.componentStack);
    void this.file(error, info);
  }

  private async file(error: Error, info: ErrorInfo) {
    this.setState({ filed: "filing" });
    this.setState({
      filed: await fileCrash({
        // El cuerpo del reporte va **en inglés y a secas**: no lo lee quien
        // sufrió el fallo sino quien lo arregla, y el tablero ya está en inglés
        // por contrato. Traducirlo partiría los reportes en dos idiomas según
        // quién tuviera la app en qué, que es justo lo que no se quiere al
        // buscar un fallo repetido.
        title: `Crash: ${error.message}`,
        description: [
          `**${error.name}: ${error.message}**`,
          "",
          `Route: \`${rutaActual()}\``,
          "",
          "```",
          (error.stack ?? "no stack").split("\n").slice(0, 12).join("\n"),
          "```",
          "",
          "Components:",
          "```",
          (info.componentStack ?? "").split("\n").slice(0, 12).join("\n").trim(),
          "```",
        ].join("\n"),
        key: firmaDe(error),
      }),
    });
  }

  render() {
    const { error, filed } = this.state;
    if (!error) return this.props.children;

    // `i18next.t` y no el hook: esto es un componente de clase —tiene que
    // serlo, `componentDidCatch` no existe en función— así que no hay hook que
    // valga. La pérdida es que esta pantalla no se repinta si cambias de idioma
    // mientras la miras, y eso da igual: es una pantalla de la que se sale
    // recargando.
    const t = i18next.t;

    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background p-6">
        <div className="max-w-lg space-y-3">
          <h1 className="text-lg font-medium">{t("common:crash.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("common:crash.lead")}
          </p>
          <pre className="max-h-40 overflow-auto rounded border bg-muted/40 p-2 text-xs">
            {error.name}: {error.message}
          </pre>
          <p className="text-xs text-muted-foreground">
            {filed === "done"
              ? t("common:crash.filed")
              : filed === "failed"
                ? t("common:crash.failed")
                : filed === "filing"
                  ? t("common:crash.filing")
                  : t("common:crash.noSession")}
          </p>
          <div className="flex gap-2 pt-1">
            <button
              className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
              onClick={() => window.location.reload()}
            >
              {t("common:crash.reload")}
            </button>
            <button
              className="rounded border px-3 py-1.5 text-sm"
              onClick={() => this.setState({ error: null, filed: "no" })}
            >
              {t("common:crash.carryOn")}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
