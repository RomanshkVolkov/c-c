import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { useThemeStore, watchSystemTheme } from "./store/theme.store";

// Apply the theme before the first paint — doing it inside a component would
// flash the light palette for a frame on every launch.
useThemeStore.getState().apply();
watchSystemTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
