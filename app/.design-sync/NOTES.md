# Notas de sincronización del sistema de diseño

Cosas que costaron un intento y que la próxima corrida debería saber.

- **`app` es una aplicación, no una librería.** `package.json` es `private`, sin
  `main`/`module`/`exports`, y no hay `dist/` de componentes. El conversor
  sintetiza la entrada desde `src/` si no se le da una, y entonces arrastra
  páginas y stores enteras. Por eso hay una entrada explícita en
  `ds-entry.ts` — que además responde a "¿qué *es* el sistema de diseño?":
  las primitivas de `src/components/ui`, no las pantallas. Añadir una primitiva
  es añadir una línea ahí.

- **La app compila con `noEmit`, así que no hay `.d.ts` en ninguna parte.** Sin
  ellos el conversor encuentra **cero componentes**: la lista sale del árbol de
  declaraciones, no del código. `tsconfig.dts.json` las emite sólo para el
  sistema de diseño, a `types/` (ignorado por git), y `package.json` gana un
  campo `types` que las apunta. Nada de eso cambia cómo se compila la app.
  **Hay que regenerarlas cuando cambie una primitiva**, antes del build:
  `npx tsc -p .design-sync/tsconfig.dts.json`.

- **El CSS fuente NO sirve.** `src/index.css` hace `@import "tailwindcss"`, que
  Tailwind resuelve al compilar. Copiado tal cual, los diseños se renderizan
  **sin una sola utilidad** — todo sin estilos. `cssEntry` apunta al CSS ya
  compilado en `dist/assets/`. Ojo: ese nombre lleva un hash, así que **cambia
  en cada build de la app** y hay que actualizar `cssEntry` cuando pase.

- **Las fuentes viajan aparte.** El CSS compilado referencia los `.woff2` como
  `/assets/…`, fuera del bundle; sin `extraFonts` las reglas `@font-face` se
  envían apuntando a ficheros que no existen y los diseños caen a la tipografía
  del sistema. Los cinco están listados en `extraFonts` y tienen el mismo
  problema de hash que el CSS.

## Riesgos para la próxima sincronización

- **Los nombres con hash de `cssEntry` y `extraFonts` se quedan obsoletos** en
  cuanto se reconstruya la app. Es el fallo más probable, y es silencioso: el
  build no se queja de un `cssEntry` inexistente hasta la validación.
- **Las declaraciones en `types/` no se regeneran solas.** Si se añade una
  primitiva y no se corre `tsc -p .design-sync/tsconfig.dts.json`, el componente
  se empaqueta pero no aparece en la lista.
- **93 de 98 componentes muestran la tarjeta mínima.** Funcionan todos, pero el
  agente de diseño los ve sin ejemplo de uso. Las previews que se escriban a
  mano viven en `.design-sync/previews/` y se conservan entre corridas.
- **Falta la cabecera de convenciones** (`readmeHeader`). Sin ella el agente no
  conoce el vocabulario de clases ni los tokens, y se los inventa.
