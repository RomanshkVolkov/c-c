package service

import (
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// Expandir una reunión en las veces concretas que toca, para el calendario.
//
// Vive en el servidor y no en la app a propósito: dos implementaciones de la
// misma regla —cada una con sus dos cambios de hora al año— acaban discrepando,
// y se nota de la peor forma posible, con el calendario diciendo una cosa y el
// timbre haciendo otra. La prueba que cierra esto es la última: lo que pinta el
// calendario y lo que dispara el reloj salen de la misma función.

func TestLaDiariaLlenaLaSemana(t *testing.T) {
	loc := mx(t)
	desde := time.Date(2026, 3, 2, 0, 0, 0, 0, loc)
	got := occurrencesBetween(diaria("America/Mexico_City"), desde, desde.AddDate(0, 0, 7), loc, 50)
	if len(got) != 7 {
		t.Errorf("siete días son siete reuniones, fueron %d", len(got))
	}
}

func TestLaSemanalSoloSusDias(t *testing.T) {
	loc := mx(t)
	m := domain.MeetingReminder{
		WallTime: "09:00", Freq: domain.MeetingFreqWeekly, Interval: 1, Weekdays: "1,3",
	}
	desde := time.Date(2026, 3, 2, 0, 0, 0, 0, loc) // un lunes
	got := occurrencesBetween(m, desde, desde.AddDate(0, 0, 14), loc, 50)
	if len(got) != 4 {
		t.Errorf("dos semanas de lunes y miércoles son cuatro, fueron %d", len(got))
	}
	for _, c := range got {
		if d := c.In(loc).Weekday(); d != time.Monday && d != time.Wednesday {
			t.Errorf("cayó en %s, que no es lunes ni miércoles", d)
		}
	}
}

// La ventana es medio abierta por arriba: nada después de `hasta`.
func TestNadaFueraDeLaVentana(t *testing.T) {
	loc := mx(t)
	desde := time.Date(2026, 3, 2, 0, 0, 0, 0, loc)
	hasta := desde.AddDate(0, 0, 3)
	for _, c := range occurrencesBetween(diaria("America/Mexico_City"), desde, hasta, loc, 50) {
		if c.Before(desde) || c.After(hasta) {
			t.Errorf("%s se salió de la ventana", pared(c, loc))
		}
	}
}

// El tope no es decoración: sin él, una regla que devolviera siempre el mismo
// instante colgaría el proceso entero al pintar un calendario.
func TestElTopeCortaAunqueQuepanMas(t *testing.T) {
	loc := mx(t)
	desde := time.Date(2026, 3, 2, 0, 0, 0, 0, loc)
	got := occurrencesBetween(diaria("America/Mexico_City"), desde, desde.AddDate(0, 1, 0), loc, 5)
	if len(got) != 5 {
		t.Errorf("el tope era cinco, salieron %d", len(got))
	}
}

// Una regla imposible no devuelve nada, y sobre todo **no gira**: la semanal
// sin días no puede llegar nunca.
func TestUnaReglaImposibleNoDevuelveNada(t *testing.T) {
	loc := mx(t)
	m := domain.MeetingReminder{WallTime: "09:00", Freq: domain.MeetingFreqWeekly, Interval: 1}
	if got := occurrencesBetween(m, time.Now(), time.Now().AddDate(0, 1, 0), loc, 50); len(got) != 0 {
		t.Errorf("no hay ninguna que pintar, salieron %d", len(got))
	}
}

// Salen en orden y sin repetirse: un calendario con dos veces el mismo día
// haría dudar de si la reunión es una o dos.
func TestVienenEnOrdenYSinRepetir(t *testing.T) {
	loc := mx(t)
	desde := time.Date(2026, 3, 2, 0, 0, 0, 0, loc)
	got := occurrencesBetween(diaria("America/Mexico_City"), desde, desde.AddDate(0, 0, 10), loc, 50)
	for i := 1; i < len(got); i++ {
		if !got[i].After(got[i-1]) {
			t.Fatalf("%s no va después de %s", pared(got[i], loc), pared(got[i-1], loc))
		}
	}
}

// El cambio de hora, también en el calendario: las diez ocurrencias siguen
// siendo a las nueve locales aunque uno de esos días dure veintitrés horas.
func TestElCalendarioTambienRespetaElCambioDeHora(t *testing.T) {
	loc := ny(t)
	m := domain.MeetingReminder{WallTime: "09:00", Freq: domain.MeetingFreqDaily, Interval: 1}
	desde := time.Date(2026, 3, 5, 0, 0, 0, 0, loc) // el cambio es el 8
	got := occurrencesBetween(m, desde, desde.AddDate(0, 0, 6), loc, 50)
	if len(got) == 0 {
		t.Fatal("no salió ninguna")
	}
	for _, c := range got {
		if h, mnt := c.In(loc).Hour(), c.In(loc).Minute(); h != 9 || mnt != 0 {
			t.Errorf("%s no es a las nueve locales", pared(c, loc))
		}
	}
}

// La que cierra el círculo: lo que el calendario pinta como «la próxima» es
// exactamente lo que el reloj va a disparar. Si alguien reimplementa una de las
// dos, esto se cae.
func TestLoQuePintaElCalendarioEsLoQueVaASonar(t *testing.T) {
	loc := mx(t)
	m := domain.MeetingReminder{
		WallTime: "09:00", Freq: domain.MeetingFreqWeekly, Interval: 1, Weekdays: "2,4",
	}
	ahora := time.Date(2026, 3, 2, 12, 0, 0, 0, loc)

	agenda := occurrencesBetween(m, ahora, ahora.AddDate(0, 0, 30), loc, 50)
	proxima, err := nextOccurrence(m, ahora, loc)
	if err != nil {
		t.Fatal(err)
	}
	if len(agenda) == 0 || !agenda[0].Equal(proxima) {
		t.Errorf("el calendario dice %v y el reloj %s", agenda, pared(proxima, loc))
	}
}
