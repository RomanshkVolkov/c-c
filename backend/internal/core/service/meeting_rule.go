package service

import (
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// Cuándo toca la próxima vez.
//
// Todo este fichero es aritmética sobre una regla y un instante: ni base de
// datos, ni repositorios, ni red. A propósito, y por un motivo concreto — el CI
// no levanta Postgres, así que una prueba que lo necesitara **se saltaría**, y
// la parte más delicada de esta función (los dos cambios de hora al año) se
// quedaría sin vigilar justo donde nadie mira.

var (
	ErrBadWallTime = errors.New("the time of day must look like 09:00")
	ErrBadTimezone = errors.New("unknown time zone")
	ErrBadFreq     = errors.New("a meeting repeats daily, weekly or monthly")
	ErrNoWeekdays  = errors.New("a weekly meeting needs at least one weekday")
)

// horaDePared parte "15:04" en sus dos números.
func horaDePared(s string) (hora, minuto int, err error) {
	t, err := time.Parse("15:04", s)
	if err != nil {
		return 0, 0, ErrBadWallTime
	}
	return t.Hour(), t.Minute(), nil
}

// diasDeLaSemana lee "1,3,5" como el conjunto {lunes, miércoles, viernes}.
//
// Tolera espacios y basura: lo que no sea un número del 0 al 6 se ignora en vez
// de reventar. Un día de más en la cadena no puede impedir que suene la reunión.
func diasDeLaSemana(s string) map[time.Weekday]bool {
	dias := map[time.Weekday]bool{}
	for _, trozo := range strings.Split(s, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(trozo))
		if err != nil || n < 0 || n > 6 {
			continue
		}
		dias[time.Weekday(n)] = true
	}
	return dias
}

// ultimoDiaDelMes: cuántos días tiene el mes de esa fecha.
func ultimoDiaDelMes(anio int, mes time.Month, loc *time.Location) int {
	// El día 0 del mes siguiente es el último de éste, y `time.Date` normaliza
	// diciembre → enero sin ayuda.
	return time.Date(anio, mes+1, 0, 0, 0, 0, 0, loc).Day()
}

// semanaDe devuelve el lunes de la semana de esa fecha, para poder contar
// semanas entre dos fechas sin que el día de la semana estorbe.
func semanaDe(t time.Time) time.Time {
	desplazamiento := (int(t.Weekday()) + 6) % 7 // domingo=0 → 6, lunes=1 → 0
	return time.Date(t.Year(), t.Month(), t.Day()-desplazamiento, 0, 0, 0, 0, t.Location())
}

// tocaEstaSemana decide si una regla cada N semanas cae en la semana de `dia`.
//
// Sin ancla, todas las semanas tocan: es lo que significa `Interval` 1, y es lo
// razonable cuando alguien pide «cada dos semanas» sin decir desde cuándo.
func tocaEstaSemana(m domain.MeetingReminder, dia time.Time, loc *time.Location) bool {
	if m.Interval <= 1 || m.Anchor == "" {
		return true
	}
	ancla, err := time.ParseInLocation("2006-01-02", m.Anchor, loc)
	if err != nil {
		return true
	}
	semanas := int(semanaDe(dia).Sub(semanaDe(ancla)).Hours() / 24 / 7)
	if semanas < 0 {
		semanas = -semanas
	}
	return semanas%m.Interval == 0
}

// tocaEsteMes hace lo mismo para «cada N meses».
func tocaEsteMes(m domain.MeetingReminder, dia time.Time, loc *time.Location) bool {
	if m.Interval <= 1 || m.Anchor == "" {
		return true
	}
	ancla, err := time.ParseInLocation("2006-01-02", m.Anchor, loc)
	if err != nil {
		return true
	}
	meses := (dia.Year()-ancla.Year())*12 + int(dia.Month()) - int(ancla.Month())
	if meses < 0 {
		meses = -meses
	}
	return meses%m.Interval == 0
}

// enLaZona construye «tal hora de pared, tal día, en esa zona», y arregla el
// día del año en que esa hora no existe.
//
// Dos veces al año una hora de pared es rara. La ambigua —la que ocurre dos
// veces al atrasar el reloj— la resuelve Go por la primera pasada, que es lo
// que hace todo el mundo y está bien. La que **no existe** —al adelantar, el
// reloj salta de las 02:00 a las 03:00— Go la mueve *hacia atrás*: pedir las
// 02:30 devuelve el mismo instante que las 01:30. Comprobado, no supuesto.
//
// Eso no vale aquí por dos motivos: la reunión sonaría una hora antes de lo que
// pone en su ficha, y dos reuniones a horas distintas —01:30 y 02:30— acabarían
// sonando a la vez. Los calendarios corren estos eventos **hacia adelante**, y
// es lo que espera quien la creó: si el reloj se salta tu hora, la reunión pasa
// en cuanto el reloj vuelve a existir.
//
// El desfase se mide comparando la hora que pedimos con la que salió, las dos
// como fechas ingenuas, para que cruzar la medianoche —hay zonas que saltan a
// las 00:00— no descoloque la resta.
func enLaZona(anio int, mes time.Month, dia, hora, minuto int, loc *time.Location) time.Time {
	cuando := time.Date(anio, mes, dia, hora, minuto, 0, 0, loc)

	real := cuando.In(loc)
	pedida := time.Date(anio, mes, dia, hora, minuto, 0, 0, time.UTC)
	salida := time.Date(real.Year(), real.Month(), real.Day(), real.Hour(), real.Minute(), 0, 0, time.UTC)
	if desfase := pedida.Sub(salida); desfase != 0 {
		cuando = cuando.Add(desfase)
	}
	return cuando
}

// nextOccurrence: el primer instante **estrictamente posterior** a `after` en el
// que toca esta reunión, en UTC.
//
// Estrictamente posterior y no «igual o posterior» por una razón práctica: el
// disparador llama a esto con el `now` del momento en que acaba de sonar, y con
// `>=` volvería a devolver la misma ocurrencia y sonaría en bucle.
//
// La búsqueda entera ocurre en **hora de pared dentro de `loc`**, y la
// conversión a UTC es lo último que pasa. Eso es lo que hace que la reunión de
// las 9:00 siga siendo a las 9:00 cuando cambia el horario de verano, aunque el
// instante UTC sea otro. Las dos horas raras del cambio las resuelve `enLaZona`.
func nextOccurrence(m domain.MeetingReminder, after time.Time, loc *time.Location) (time.Time, error) {
	hora, minuto, err := horaDePared(m.WallTime)
	if err != nil {
		return time.Time{}, err
	}

	desde := after.In(loc)
	// Un tope defensivo, no una cota real: lo más lejos que puede estar la
	// próxima ocurrencia es una regla mensual cada N meses. Sin él, una regla
	// imposible —un día de la semana que no está en el conjunto— giraría para
	// siempre dentro del disparador.
	const maxDias = 800

	switch m.Freq {
	case domain.MeetingFreqDaily:
		// Nada que comprobar por día: todos valen.
	case domain.MeetingFreqWeekly:
		if len(diasDeLaSemana(m.Weekdays)) == 0 {
			return time.Time{}, ErrNoWeekdays
		}
	case domain.MeetingFreqMonthly:
		// El día del mes se recorta más abajo.
	default:
		return time.Time{}, ErrBadFreq
	}

	dias := diasDeLaSemana(m.Weekdays)
	for i := 0; i < maxDias; i++ {
		dia := desde.AddDate(0, 0, i)

		switch m.Freq {
		case domain.MeetingFreqWeekly:
			if !dias[dia.Weekday()] || !tocaEstaSemana(m, dia, loc) {
				continue
			}
		case domain.MeetingFreqMonthly:
			pedido := m.MonthDay
			if pedido <= 0 {
				pedido = 1
			}
			// «El 31» en un mes de 30 es el último día: recortar y no saltarse el
			// mes, que es lo que espera quien pide «el último día del mes».
			ultimo := ultimoDiaDelMes(dia.Year(), dia.Month(), loc)
			if pedido > ultimo {
				pedido = ultimo
			}
			if dia.Day() != pedido || !tocaEsteMes(m, dia, loc) {
				continue
			}
		}

		// La hora de pared de ese día, en su zona. Aquí es donde el DST deja de
		// ser un problema: se pide «las 9:00 del día 27» y `loc` responde qué
		// instante es eso.
		cuando := enLaZona(dia.Year(), dia.Month(), dia.Day(), hora, minuto, loc)
		if cuando.After(after) {
			return cuando.UTC(), nil
		}
	}
	return time.Time{}, ErrBadFreq
}

// occurrencesBetween: todas las veces que toca entre dos instantes.
//
// Existe para pintar el calendario, y vive **aquí** y no en la app por una
// razón concreta: expandir las repeticiones en el frontend obligaría a escribir
// una segunda implementación de la misma regla, con sus dos cambios de hora al
// año. Dos implementaciones acaban discrepando, y la forma en que se nota es la
// peor posible — el calendario dice martes, el timbre suena el miércoles, y
// nadie sabe cuál de los dos miente.
//
// `max` es un tope defensivo: sin él, una regla que devolviera siempre el mismo
// instante giraría para siempre.
func occurrencesBetween(m domain.MeetingReminder, desde, hasta time.Time, loc *time.Location, max int) []time.Time {
	out := []time.Time{}
	cursor := desde
	for len(out) < max {
		siguiente, err := nextOccurrence(m, cursor, loc)
		if err != nil || siguiente.After(hasta) {
			break
		}
		out = append(out, siguiente)
		cursor = siguiente
	}
	return out
}

// vencida dice si una ocurrencia que ya pasó todavía merece sonar.
//
// Dentro de la gracia, sí: el disparador mira cada treinta segundos y llegar
// unos segundos tarde es normal. Fuera de ella, no — y esto importa más de lo
// que parece. Si un pod estuvo caído tres horas, al volver se encontraría con
// reuniones vencidas de la madrugada; hacerlas sonar a las nueve avisaría de
// algo que ya pasó, a gente que no puede hacer nada al respecto. Se recalcula
// en silencio y se espera a la siguiente.
func vencida(nextFireAt, now time.Time, gracia time.Duration) bool {
	if nextFireAt.After(now) {
		return false
	}
	return now.Sub(nextFireAt) <= gracia
}
