package handler

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// Las opciones del mapa se leen, y una mal escrita se rechaza diciendo qué se
// acepta: callarse y devolver el mapa entero haría creer que el recorte
// funcionó (22-oct-2026).
//
// Roturas que detecta: aceptar un `since` que no es una fecha; aceptar en
// `only` algo que no existe; perder una de las tres opciones por el camino.
func TestContextOptionsAreReadOrRefused(t *testing.T) {
	opts, err := contextOptions(httptest.NewRequest("GET", "/api/v1/context?spaceId=s&since=2026-10-22T08:00:00Z&only=tree,%20changes&node=n1", nil))
	if err != nil {
		t.Fatal(err)
	}
	if opts.Since == nil || opts.Since.Hour() != 8 || strings.Join(opts.Only, ",") != "tree,changes" || opts.Node != "n1" {
		t.Fatalf("opciones: %+v", opts)
	}
	if _, err := contextOptions(httptest.NewRequest("GET", "/api/v1/context?since=ayer", nil)); err == nil || !strings.Contains(err.Error(), "RFC 3339") {
		t.Fatalf("un since que no es fecha se aceptó: %v", err)
	}
	if _, err := contextOptions(httptest.NewRequest("GET", "/api/v1/context?only=todo", nil)); err == nil || !strings.Contains(err.Error(), "inProgress") {
		t.Fatalf("un only desconocido se aceptó, o el error no dice qué vale: %v", err)
	}
	if opts, err := contextOptions(httptest.NewRequest("GET", "/api/v1/context", nil)); err != nil || opts.Since != nil || len(opts.Only) != 0 || opts.Node != "" {
		t.Fatalf("sin opciones, nada: %+v %v", opts, err)
	}
}
