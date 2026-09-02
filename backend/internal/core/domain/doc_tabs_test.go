package domain

import "testing"

// Las cuatro secciones, siempre y en orden.
//
// Es la regla del documento y no un detalle de la base: una pestaña vacía se
// pinta en gris y **no se oculta**, porque su ausencia dice algo del proyecto —
// que no tiene runbook es un dato sobre el proyecto.
//
// Se prueba aquí y no en el repositorio porque las pruebas de repositorio se
// saltan sin base de datos, y en integración continua no hay ninguna.
func TestSiempreSalenLasCuatroSecciones(t *testing.T) {
	tabs := ResolveDocTabs("doc-1", nil)
	if len(tabs) != 4 {
		t.Fatalf("sin nada guardado salieron %d secciones", len(tabs))
	}
	for i, k := range DocTabKeys {
		if tabs[i].Key != k {
			t.Errorf("en la posición %d se esperaba %q y salió %q", i, k, tabs[i].Key)
		}
		if tabs[i].DocID != "doc-1" {
			t.Errorf("la sección %q salió sin documento", k)
		}
	}
}

// El orden es el del diseño, no el que devuelva la consulta.
func TestElOrdenNoDependeDeLaBase(t *testing.T) {
	alreves := []DocTab{
		{DocID: "d", Key: DocLinks, Body: "enlaces"},
		{DocID: "d", Key: DocOverview, Body: "resumen"},
	}
	tabs := ResolveDocTabs("d", alreves)
	if tabs[0].Key != DocOverview || tabs[3].Key != DocLinks {
		t.Fatalf("el orden salió %q…%q", tabs[0].Key, tabs[3].Key)
	}
	if tabs[0].Body != "resumen" || tabs[3].Body != "enlaces" {
		t.Fatal("se reordenaron las claves pero no su contenido")
	}
}

// Lo guardado se conserva entero: rellenar los huecos no puede pisar lo que hay.
func TestRellenarNoPisaLoQueYaEstaba(t *testing.T) {
	tabs := ResolveDocTabs("d", []DocTab{
		{DocID: "d", Key: DocRunbook, Body: "1. levantar", UpdatedBy: "u-ana"},
	})
	var runbook DocTab
	for _, tb := range tabs {
		if tb.Key == DocRunbook {
			runbook = tb
		}
	}
	if runbook.Body != "1. levantar" || runbook.UpdatedBy != "u-ana" {
		t.Fatalf("el runbook llegó como %+v", runbook)
	}
	// Y las otras tres siguen vacías, no heredan nada.
	for _, tb := range tabs {
		if tb.Key != DocRunbook && tb.Body != "" {
			t.Errorf("%q salió con contenido ajeno: %q", tb.Key, tb.Body)
		}
	}
}

// Una ruta no puede inventarse una sección.
func TestSoloValenLasCuatroClaves(t *testing.T) {
	for _, k := range []string{"overview", "runbook", "decisions", "links"} {
		if !IsDocTabKey(k) {
			t.Errorf("%q debería valer", k)
		}
	}
	for _, k := range []string{"", "OVERVIEW", "notas", "body", "overview "} {
		if IsDocTabKey(k) {
			t.Errorf("%q no debería valer", k)
		}
	}
}
