# Datos de zonas horarias para el ICU del WebKit de Linux

La AppImage lleva su propio WebKitGTK con ICU 70 (de Ubuntu 22.04), cuyas zonas
son de 2021: cree que México sigue con horario de verano, que se quitó en
octubre de 2022, y la app pintaba las horas una de más entre abril y octubre
(medido el 18-oct-2026). ICU deja cambiar **sólo los datos de zonas** con
`ICU_TIMEZONE_FILES_DIR`; `main.rs` apunta ahí antes de abrir la webview.

Ficheros de `unicode-org/icu-data`, `tzdata/icunew/2026e/44/le/` (formato 44,
el que lee ICU desde la 4.4). Para actualizarlos, bajar los cuatro `.res` de la
versión nueva y cambiar `ICU_TZDATA_VERSION` en `src/icu_tz.rs`.
