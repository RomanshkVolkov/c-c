import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { useThemeStore, watchSystemTheme } from "./store/theme.store";
import { useLocaleStore } from "./store/locale.store";
import { initI18n } from "./lib/i18n";

// Apply the theme before the first paint — doing it inside a component would
// flash the light palette for a frame on every launch.
useThemeStore.getState().apply();
watchSystemTheme();

// El idioma, por lo mismo: montar en inglés para saltar al castellano un
// instante después se ve como un parpadeo, y encima con el texto moviéndose.
// `initI18n` lee la preferencia ya rehidratada; `apply` la vuelve a resolver por
// si el arranque fue antes de que el almacenamiento contestara.
initI18n();
useLocaleStore.getState().apply();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
