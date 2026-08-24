package service

import (
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// A quién le llega el aviso de una reunión.
//
// Se guardan las exclusiones y no los invitados, así que el reparto es una
// resta. Es aritmética pura y se prueba sin base de datos, que aquí no es un
// detalle: el CI no levanta Postgres, y este es el cálculo que decide si a
// alguien que pidió no recibir una reunión le suena igual.

func TestPorDefectoLaReunionEsDeTodos(t *testing.T) {
	todos := []string{"u-ana", "u-bea", "u-caro"}
	if got := destinatarios(todos, nil); len(got) != 3 {
		t.Errorf("sin exclusiones le llega a los tres, llegó a %v", got)
	}
}

// La razón de guardar exclusiones: quien entra mañana en la organización queda
// convocado sin que nadie tenga que acordarse de añadirlo a la reunión de los
// lunes.
func TestQuienEntraNuevoQuedaConvocadoSolo(t *testing.T) {
	excluidos := []string{"u-bea"}
	conElNuevo := []string{"u-ana", "u-bea", "u-caro", "u-nuevo"}
	got := destinatarios(conElNuevo, excluidos)
	if !tiene(got, "u-nuevo") {
		t.Errorf("el nuevo tenía que entrar solo: %v", got)
	}
}

func TestQuienSeQuitoNoRecibe(t *testing.T) {
	got := destinatarios([]string{"u-ana", "u-bea"}, []string{"u-bea"})
	if tiene(got, "u-bea") {
		t.Errorf("bea se quitó de esta reunión: %v", got)
	}
	if !tiene(got, "u-ana") {
		t.Errorf("y ana no: %v", got)
	}
}

// Un id repetido en la lista de miembros no puede convertirse en dos timbres.
func TestNadieRecibeElAvisoDosVeces(t *testing.T) {
	got := destinatarios([]string{"u-ana", "u-ana", ""}, nil)
	if len(got) != 1 {
		t.Errorf("una sola vez y sin vacíos: %v", got)
	}
}

func TestUnaReunionSinNadieNoRepartaNada(t *testing.T) {
	got := destinatarios([]string{"u-ana", "u-bea"}, []string{"u-ana", "u-bea"})
	if len(got) != 0 {
		t.Errorf("excluidos todos, no queda nadie: %v", got)
	}
}

func tiene(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// ─── El interruptor de la campana ───────────────────────────────────────────

// Sin su propio caso en `Allows`, un recordatorio caería en el `return true` del
// final —pensado para clases nuevas y sueltas— y sería el único aviso
// **recurrente** de la app que no se puede callar.
func TestLasReunionesSePuedenSilenciar(t *testing.T) {
	p := domain.DefaultPrefs("u-ana")
	if !p.Allows("meeting:reminder") {
		t.Error("por defecto avisan: nadie ha pedido lo contrario")
	}

	p.MeetingsQuiet = true
	if p.Allows("meeting:reminder") {
		t.Error("pidió no recibirlas y siguen llegando")
	}
}

// Y silenciarlas no puede callar otra cosa por el camino.
func TestSilenciarLasReunionesNoTocaLoDemas(t *testing.T) {
	p := domain.DefaultPrefs("u-ana")
	p.MeetingsQuiet = true
	for _, clase := range []string{"dm:message", "chat:mention", "task:comment", "report:new"} {
		if !p.Allows(clase) {
			t.Errorf("%s no tiene nada que ver con las reuniones", clase)
		}
	}
}
