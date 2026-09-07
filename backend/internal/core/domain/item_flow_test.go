package domain

import "testing"

// Dos máquinas, y cuál gobierna cada ficha.
//
// La estricta protege lo que un cliente ve. La interna es un tablero corriente.
// Confundirlas tiene consecuencias en las dos direcciones: aplicar la estricta a
// una tarea interna dejó el check de las subtareas sin hacer nada —Open → Done no
// existe— y aplicar la interna a un ticket de cliente le dejaría saltar de
// recién recibido a resuelto sin que nadie lo tocara.
func TestQueMaquinaGobierna(t *testing.T) {
	proyecto := "proj-1"

	t.Run("una tarea levantada aquí es interna", func(t *testing.T) {
		var i Item
		if got := i.Flow(); got != FlowInternal {
			t.Fatalf("%q", got)
		}
	})

	t.Run("una atada a un canal de cliente, no", func(t *testing.T) {
		i := Item{ProjectID: proyecto}
		if got := i.Flow(); got != FlowClient {
			t.Fatalf("%q", got)
		}
	})

	// El caso que separa «tiene canal» de «lo ve el cliente»: una nota interna en
	// una lista de cliente sigue siendo asunto nuestro, y se mueve como tal.
	t.Run("marcada como interna, aunque esté en una lista de cliente", func(t *testing.T) {
		i := Item{ProjectID: proyecto, Visibility: VisibilityInternal}
		if got := i.Flow(); got != FlowInternal {
			t.Fatalf("%q", got)
		}
	})
}

func TestTransicionesPorFlujo(t *testing.T) {
	// El fallo que dio origen a esto: marcar una subtarea abierta como hecha.
	t.Run("una tarea interna va de Open a Done", func(t *testing.T) {
		if !CanTransition(FlowInternal, ReportPending, ReportResolved) {
			t.Fatal("el check de las subtareas hace exactamente esto")
		}
	})

	t.Run("y un ticket de cliente no", func(t *testing.T) {
		if CanTransition(FlowClient, ReportPending, ReportResolved) {
			t.Fatal("un ticket recién recibido no puede salir resuelto sin tocarlo")
		}
	})

	/**
	 * Cerrado es terminal para un cliente y no para nosotros.
	 *
	 * Reabrir algo que ya se le comunicó como cerrado es una promesa rota. Cerrar
	 * una tarea interna por error y no poder deshacerlo sería un fallo, no una
	 * garantía.
	 */
	t.Run("cerrado se reabre en interno, y no en cliente", func(t *testing.T) {
		if !CanTransition(FlowInternal, ReportClosed, ReportPending) {
			t.Fatal("cerrar por error tiene que tener vuelta atrás")
		}
		if CanTransition(FlowClient, ReportClosed, ReportPending) {
			t.Fatal("cerrado es lo que se le dijo al cliente")
		}
	})

	// Quedarse donde se está no es moverse. Sin esto, soltar una tarjeta en su
	// propia columna se rechazaría.
	t.Run("no moverse siempre vale", func(t *testing.T) {
		for _, f := range []ItemFlow{FlowClient, FlowInternal} {
			if !CanTransition(f, ReportClosed, ReportClosed) {
				t.Fatalf("%q: quedarse quieto se rechazó", f)
			}
		}
	})

	// Los dos vocabularios conviven mientras haya apps instaladas viejas: «open»
	// es `pending` y «done» es `resolved`.
	t.Run("los alias viejos se pliegan igual", func(t *testing.T) {
		if !CanTransition(FlowInternal, "open", "done") {
			t.Fatal("una app anterior al renombrado manda estos nombres")
		}
	})

	t.Run("el flujo desconocido cae en el estricto", func(t *testing.T) {
		// Proteger de más nunca pierde datos de nadie; proteger de menos sí.
		if CanTransition(ItemFlow("vete a saber"), ReportPending, ReportResolved) {
			t.Fatal("ante la duda, la máquina que protege al cliente")
		}
	})
}

// Una subtarea nunca la gobierna la máquina del cliente.
//
// El servicio le borra el proyecto al crearla —para no gastar un folio del
// cliente en una línea de checklist— y de eso depende algo que no se ve desde
// aquí: el check de «hecho» del panel salta directo de Open a Done, que sólo es
// legal en el flujo interno.
//
// Se fija aquí porque el día que alguien deje de borrar ese proyecto, ese botón
// volverá a no hacer nada y a no decir por qué. Es el fallo del que sale todo
// esto, y no dejó rastro en ninguna prueba la primera vez.
func TestUnaSubtareaEsInterna(t *testing.T) {
	padre := Item{ProjectID: "proj-1"}
	if padre.Flow() != FlowClient {
		t.Fatal("el padre sí lo ve el cliente; si no, la prueba no prueba nada")
	}

	// Como la crea `CreateTask` cuando llega con `parentID`: sin proyecto.
	sub := Item{ProjectID: "", ParentID: &padre.ID}
	if got := sub.Flow(); got != FlowInternal {
		t.Fatalf("una subtarea con la máquina del cliente deja el check muerto: %q", got)
	}
	if !CanTransition(sub.Flow(), ReportPending, ReportResolved) {
		t.Fatal("marcar hecha una subtarea abierta es exactamente esto")
	}
}
