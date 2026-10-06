package handler

import (
	"mime"
	"net/http"
	"strings"
)

// inlineSafe son los tipos que se pueden enseñar dentro del navegador sin que
// ejecuten nada: imágenes de mapa de bits, PDF, y vídeo y audio corrientes.
// Fuera quedan HTML, SVG (que lleva scripts) y cualquier cosa que alguien diga
// que es otra cosa.
var inlineSafe = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true, "image/avif": true,
	"application/pdf": true,
	"video/mp4":       true, "video/webm": true, "audio/mpeg": true, "audio/ogg": true, "audio/wav": true, "audio/webm": true,
}

// setFileHeaders pone las cabeceras de un adjunto que se sirve desde el mismo
// origen que la app (barrido de seguridad, 6-oct-2026).
//
// El tipo con el que se guardó lo dijo el navegador de quien lo subió. Si un
// HTML o un SVG pasaba el filtro del servicio de imágenes, se servía `inline`
// desde cac.guz-studio.dev y ejecutaba en el origen de la versión web, con su
// sesión al alcance. Ahora:
//   - `nosniff` siempre, para que el navegador no adivine otro tipo;
//   - sólo lo de `inlineSafe` se enseña en el navegador; lo demás se descarga y
//     se declara `application/octet-stream`;
//   - una imagen abierta sola va con `sandbox`, que le quita origen y scripts.
//     El PDF no, porque el visor del navegador no abre dentro de un sandbox.
func setFileHeaders(w http.ResponseWriter, contentType, fileName string) {
	// ParseMediaType ya lo devuelve en minúsculas.
	ct, _, _ := mime.ParseMediaType(strings.TrimSpace(contentType))
	name := strings.NewReplacer("\"", "", "\r", "", "\n", "").Replace(fileName)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if !inlineSafe[ct] {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", "attachment; filename=\""+name+"\"")
		return
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Disposition", "inline; filename=\""+name+"\"")
	if strings.HasPrefix(ct, "image/") {
		w.Header().Set("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
	}
}
