import hooks from "eslint-plugin-react-hooks";
import tsparser from "@typescript-eslint/parser";

/**
 * Sólo `react-hooks`, y a propósito.
 *
 * Este proyecto no tenía linter, y eso costó dos pantallazos: el de Canales
 * (#48, que llegó a la gente) y uno en `AppLayout` que todavía no había
 * estrenado nadie — el alta de cualquier persona nueva tiraba la aplicación al
 * cambiar la contraseña obligatoria. Los dos son la misma regla, que es la más
 * estándar de React.
 *
 * El resto de eslint se queda fuera **por ahora**. Este repositorio ya tiene su
 * criterio de estilo escrito y discutido; meterlo entero de golpe convierte una
 * red de seguridad en una pelea de formato, y entonces alguien la apaga. Se
 * añade lo que se demuestre que hace falta, no lo que venga por defecto.
 *
 * `exhaustive-deps` como aviso y no como error: hay sitios donde faltar una
 * dependencia es deliberado y está razonado en un comentario —el cajón de
 * tareas y `DocView` explican por qué— y convertirlos en error obligaría a
 * silenciarlos uno a uno el primer día.
 */
export default [
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": hooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
