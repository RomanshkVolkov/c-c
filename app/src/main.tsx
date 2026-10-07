import { registerServiceWorker } from "./lib/push";
import { isWebBuild } from "./lib/platform";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { useThemeStore, watchSystemTheme } from "./store/theme.store";
import { useLocaleStore } from "./store/locale.store";
import { initI18n } from "./lib/i18n";
import { installOrgSwitch } from "./store/org-switch";
import { installPlaces } from "./store/places";
import { guardWindowAgainstFileDrops } from "./lib/dropped";
import { closeOrphanTerminals } from "./store/terminal.store";

// Apply the theme before the first paint — doing it inside a component would
// flash the light palette for a frame on every launch.
useThemeStore.getState().apply();
watchSystemTheme();

// El idioma, por lo mismo: montar en inglés para saltar al castellano un
// instante después se ve como un parpadeo, y encima con el texto moviéndose.
// `initI18n` lee la preferencia ya rehidratada; `apply` la vuelve a resolver por
// si el arranque fue antes de que el almacenamiento contestara.
initI18n(useLocaleStore.getState().resolved);
useLocaleStore.getState().apply();

// Antes de montar nada: el primer cambio de org puede ser el de `fetchOrgs`
// al arrancar, si la org guardada ya no es tuya.
installOrgSwitch();
installPlaces();
// Un fichero soltado fuera de una zona no abre la ventana en él.
guardWindowAgainstFileDrops();
void closeOrphanTerminals();
// La versión web registra su service worker: es lo que recibe la campana con
// la app cerrada (W2). En el escritorio no hay.
if (isWebBuild) void registerServiceWorker();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
