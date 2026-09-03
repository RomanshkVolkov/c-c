package domain

import (
	"testing"
	"time"
)

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

// La frescura de un documento.
//
// Es la regla que decide si sale el aviso ámbar, y sale de una resta: si la
// resta se hiciera desde el campo equivocado, el aviso saltaría en el momento
// equivocado — que es la única forma de que un aviso deje de servir.
func TestDocIsStale(t *testing.T) {
	ahora := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	hace := func(d time.Duration) *time.Time { x := ahora.Add(-d); return &x }

	t.Run("revisado ayer no está viejo", func(t *testing.T) {
		if DocIsStale(hace(24*time.Hour), ahora.Add(-400*24*time.Hour), ahora) {
			t.Fatal("una revisión de ayer manda sobre un texto de hace un año")
		}
	})

	// El caso que hace útil el campo: se corrige una errata y el documento
	// parece fresco sin que nadie haya comprobado que los pasos funcionan.
	t.Run("editado ayer pero sin revisar desde hace un año sí está viejo", func(t *testing.T) {
		if !DocIsStale(hace(400*24*time.Hour), ahora.Add(-24*time.Hour), ahora) {
			t.Fatal("editar no es revisar")
		}
	})

	t.Run("escrito ayer y nunca revisado no está viejo", func(t *testing.T) {
		if DocIsStale(nil, ahora.Add(-24*time.Hour), ahora) {
			t.Fatal("teñir de ámbar algo escrito ayer enseña a ignorar el color")
		}
	})

	t.Run("escrito hace un año y nunca revisado sí está viejo", func(t *testing.T) {
		if !DocIsStale(nil, ahora.Add(-400*24*time.Hour), ahora) {
			t.Fatal("sin revisión se cuenta desde que se escribió")
		}
	})

	// Un documento que todavía no se ha guardado nunca llega con la fecha cero.
	// Sin esta rama, la resta contra el año 1 lo declararía viejo de nacimiento.
	t.Run("sin ninguna fecha no está viejo", func(t *testing.T) {
		if DocIsStale(nil, time.Time{}, ahora) {
			t.Fatal("un documento vacío no es un documento sin revisar")
		}
	})

	t.Run("justo en el umbral ya está viejo", func(t *testing.T) {
		if !DocIsStale(hace(DocStaleAfter), ahora.Add(-time.Hour), ahora) {
			t.Fatal("noventa días clavados cuentan")
		}
		if DocIsStale(hace(DocStaleAfter-time.Minute), ahora.Add(-time.Hour), ahora) {
			t.Fatal("un minuto antes, todavía no")
		}
	})
}

// Cuándo un guardado se funde con la entrada anterior.
//
// Es lo que decide si el historial se puede leer. El autoguardado dispara cada
// pocos segundos: sin fusionar, una tarde de escritura deja trescientas
// entradas idénticas y nadie encuentra el punto al que quería volver.
func TestDocVersionMerges(t *testing.T) {
	ahora := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	entrada := func(autor string, cuando time.Time) *DocVersion {
		v := &DocVersion{AuthorID: autor}
		v.CreatedAt = cuando
		return v
	}

	t.Run("la misma persona escribiendo seguido se funde", func(t *testing.T) {
		if !DocVersionMerges(entrada("ana", ahora.Add(-time.Minute)), "ana", ahora) {
			t.Fatal("una sesión de escritura es una entrada, no cien")
		}
	})

	// Agrupar a dos autores borraría de quién fue cada cambio, que es la mitad
	// de para qué sirve el historial.
	t.Run("otra persona nunca se funde, por cerca que esté", func(t *testing.T) {
		if DocVersionMerges(entrada("bea", ahora.Add(-time.Second)), "ana", ahora) {
			t.Fatal("dos autores son dos cambios")
		}
	})

	t.Run("pasada la ventana ya es otro cambio", func(t *testing.T) {
		if DocVersionMerges(entrada("ana", ahora.Add(-DocVersionMerge)), "ana", ahora) {
			t.Fatal("diez minutos clavados ya no son la misma sesión")
		}
		if !DocVersionMerges(entrada("ana", ahora.Add(-DocVersionMerge+time.Second)), "ana", ahora) {
			t.Fatal("un segundo antes, todavía sí")
		}
	})

	// La primera edición de una sección no tiene con qué fundirse.
	t.Run("sin entrada previa no se funde", func(t *testing.T) {
		if DocVersionMerges(nil, "ana", ahora) {
			t.Fatal("no hay nada anterior que reescribir")
		}
	})
}

// Que una decisión traiga con qué volver.
//
// El origen es lo único que separa un registro de decisiones de una lista de
// frases sueltas: dentro de tres meses, lo que hace que alguien se fíe de una
// entrada es poder abrir la discusión que la produjo. Un origen que dice «task»
// y no trae tarea es un enlace que no lleva a ninguna parte, o sea, ninguno.
func TestDecisionIsAddressed(t *testing.T) {
	t.Run("de una tarea, con su tarea", func(t *testing.T) {
		if !DecisionIsAddressed(DecisionRequest{Origin: "task", OriginTaskID: "t1"}) {
			t.Fatal("hay a dónde volver")
		}
	})

	t.Run("de una tarea sin tarea, no", func(t *testing.T) {
		if DecisionIsAddressed(DecisionRequest{Origin: "task"}) {
			t.Fatal("un enlace de vuelta a ninguna parte no es un origen")
		}
	})

	t.Run("de un mensaje, con su mensaje", func(t *testing.T) {
		if !DecisionIsAddressed(DecisionRequest{Origin: "message", OriginMessageID: "m1"}) {
			t.Fatal("hay a dónde volver")
		}
		if DecisionIsAddressed(DecisionRequest{Origin: "message", OriginChannelID: "c1"}) {
			t.Fatal("el canal solo no encuentra el mensaje")
		}
	})

	// «Se decidió aquí» también es una procedencia, y no la ausencia de una:
	// dice que no salió de ninguna discusión previa, que es un dato.
	t.Run("escrita en la propia pestaña se basta", func(t *testing.T) {
		if !DecisionIsAddressed(DecisionRequest{Origin: "doc"}) {
			t.Fatal("escribirla ahí es su origen")
		}
	})

	// Sin esto, un origen inventado pasaría por bueno y la entrada quedaría en
	// un registro del que no se puede borrar nada.
	t.Run("un origen que no existe no vale", func(t *testing.T) {
		if DecisionIsAddressed(DecisionRequest{Origin: "email", OriginTaskID: "t1"}) {
			t.Fatal("sólo hay tres orígenes")
		}
		if DecisionIsAddressed(DecisionRequest{}) {
			t.Fatal("sin origen tampoco")
		}
	})
}
