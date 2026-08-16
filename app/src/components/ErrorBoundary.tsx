import { Component, type ErrorInfo, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/store/auth.store";

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
 * Command and control → App → tasks. Checked before hardcoding: the list has no
 * channel, so nothing filed here reaches a client — which matters, since a
 * stack trace is exactly the sort of thing that must not.
 */
const CRASH_LIST = "ca0bfd49-0909-43eb-8135-bc8ecd0f282c";

/**
 * A stable name for one crash.
 *
 * The message plus the first frame, hashed. React re-renders after an error and
 * a person will click reload more than once, so without this a single broken
 * screen would file a card per attempt. The server takes it as an idempotency
 * key: the same crash is one card, however many times it happens.
 */
function signature(error: Error): string {
  const frame = (error.stack ?? "").split("\n")[1]?.trim() ?? "";
  const text = `${error.name}: ${error.message} @ ${frame}`;
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `crash-${(h >>> 0).toString(16)}`;
}

interface State {
  error: Error | null;
  filed: "no" | "filing" | "done" | "failed";
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
    // Signed out there is no token to file with, and in dev this would litter
    // the real board with crashes somebody is in the middle of causing.
    if (!useAuthStore.getState().accessToken || import.meta.env.DEV) return;

    this.setState({ filed: "filing" });
    try {
      await api.post(
        `/api/v1/task-lists/${CRASH_LIST}/tasks`,
        {
          title: `Pantallazo: ${error.message}`.slice(0, 200),
          description: [
            `**${error.name}: ${error.message}**`,
            "",
            `Ruta: \`${window.location.hash || window.location.pathname}\``,
            "",
            "```",
            (error.stack ?? "sin stack").split("\n").slice(0, 12).join("\n"),
            "```",
            "",
            "Componentes:",
            "```",
            (info.componentStack ?? "").split("\n").slice(0, 12).join("\n").trim(),
            "```",
          ].join("\n"),
          priority: "high",
          // Belt and braces. The list has no channel so everything in it is
          // internal anyway; saying so means a later binding can't quietly turn
          // crash reports into something a client reads.
          visibility: "internal",
          idempotencyKey: signature(error),
        },
        true,
      );
      this.setState({ filed: "done" });
    } catch {
      // Reporting a crash must never cause one. The screen below already tells
      // the person what happened; the card is a bonus, not the mechanism.
      this.setState({ filed: "failed" });
    }
  }

  render() {
    const { error, filed } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background p-6">
        <div className="max-w-lg space-y-3">
          <h1 className="text-lg font-medium">Algo se rompió en esta pantalla</h1>
          <p className="text-sm text-muted-foreground">
            No es culpa de lo que estabas haciendo. La app dejó de dibujar y esto es lo
            que dijo:
          </p>
          <pre className="max-h-40 overflow-auto rounded border bg-muted/40 p-2 text-xs">
            {error.name}: {error.message}
          </pre>
          <p className="text-xs text-muted-foreground">
            {filed === "done"
              ? "Ya quedó anotado como tarjeta en cac — no hace falta que lo reportes."
              : filed === "failed"
                ? "No se pudo anotar la tarjeta, así que este texto es el único registro: cópialo."
                : filed === "filing"
                  ? "Anotándolo en cac…"
                  : "No se anotó en cac (sin sesión)."}
          </p>
          <div className="flex gap-2 pt-1">
            <button
              className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
              onClick={() => window.location.reload()}
            >
              Recargar
            </button>
            <button
              className="rounded border px-3 py-1.5 text-sm"
              onClick={() => this.setState({ error: null, filed: "no" })}
            >
              Intentar seguir
            </button>
          </div>
        </div>
      </div>
    );
  }
}
