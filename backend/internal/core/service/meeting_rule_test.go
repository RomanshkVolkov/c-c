package service

import (
	"testing"
	"time"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// La próxima ocurrencia de una reunión periódica.
//
// Sin base de datos a propósito: es aritmética sobre una regla, y el CI no
// levanta Postgres — una prueba que lo necesitara se saltaría justo aquí, que es
// la parte donde un error no se ve hasta que a alguien se le mueve la reunión.
//
// Las dos pruebas que justifican el diseño entero son las del cambio de hora.
// Si alguien «optimiza» esto guardando la ocurrencia en UTC y sumándole siete
// días, todo lo demás sigue pasando y esas dos se caen.

func mx(t *testing.T) *time.Location  { return zona(t, "America/Mexico_City") }
func ny(t *testing.T) *time.Location  { return zona(t, "America/New_York") }
func mad(t *testing.T) *time.Location { return zona(t, "Europe/Madrid") }

func zona(t *testing.T, nombre string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(nombre)
	if err != nil {
		t.Fatalf("sin la base de zonas horarias no hay nada que probar: %v", err)
	}
	return loc
}

/** Una reunión diaria a las 09:00. */
func diaria(tz string) domain.MeetingReminder {
	return domain.MeetingReminder{
		WallTime: "09:00", Timezone: tz, Freq: domain.MeetingFreqDaily, Interval: 1,
	}
}

// Ayuda a leer los fallos: la hora de pared en la zona, no el instante UTC.
func pared(t time.Time, loc *time.Location) string {
	return t.In(loc).Format("2006-01-02 15:04 MST")
}

func TestLaDiariaEsHoySiTodaviaNoHaSonado(t *testing.T) {
	loc := mx(t)
	ahora := time.Date(2026, 3, 10, 7, 0, 0, 0, loc) // 07:00, antes de las nueve
	got, err := nextOccurrence(diaria("America/Mexico_City"), ahora, loc)
	if err != nil {
		t.Fatal(err)
	}
	if q := pared(got, loc); q != "2026-03-10 09:00 CST" {
		t.Errorf("tenía que ser hoy a las nueve, fue %s", q)
	}
}

func TestLaDiariaEsMananaSiYaSono(t *testing.T) {
	loc := mx(t)
	ahora := time.Date(2026, 3, 10, 9, 30, 0, 0, loc)
	got, _ := nextOccurrence(diaria("America/Mexico_City"), ahora, loc)
	if q := pared(got, loc); q != "2026-03-11 09:00 CST" {
		t.Errorf("tenía que ser mañana, fue %s", q)
	}
}

// La frontera exacta. Con «igual o posterior» el disparador se llamaría a sí
// mismo: acaba de sonar a las 09:00, pregunta por la próxima, le contestan que
// las 09:00, y suena otra vez.
func TestJustoALaHoraLaProximaEsManana(t *testing.T) {
	loc := mx(t)
	enPunto := time.Date(2026, 3, 10, 9, 0, 0, 0, loc)
	got, _ := nextOccurrence(diaria("America/Mexico_City"), enPunto, loc)
	if q := pared(got, loc); q != "2026-03-11 09:00 CST" {
		t.Errorf("sonando en punto, la próxima es mañana; fue %s", q)
	}
}

func TestLaSemanalSaltaElFinDeSemana(t *testing.T) {
	loc := mx(t)
	m := domain.MeetingReminder{
		WallTime: "09:00", Freq: domain.MeetingFreqWeekly, Interval: 1,
		Weekdays: "1,3,5", // lunes, miércoles y viernes
	}
	viernes := time.Date(2026, 3, 13, 10, 0, 0, 0, loc) // viernes, ya pasada
	got, _ := nextOccurrence(m, viernes, loc)
	if q := pared(got, loc); q != "2026-03-16 09:00 CST" { // el lunes
		t.Errorf("del viernes se salta al lunes, fue %s", q)
	}
}

func TestLaSemanalSinDiasNoEsUnaRegla(t *testing.T) {
	loc := mx(t)
	m := domain.MeetingReminder{WallTime: "09:00", Freq: domain.MeetingFreqWeekly, Interval: 1}
	if _, err := nextOccurrence(m, time.Now(), loc); err != ErrNoWeekdays {
		t.Errorf("una semanal sin días no puede sonar nunca; error: %v", err)
	}
}

// Quincenal: el ancla dice cuál de las dos semanas es la que toca. Sin ella la
// regla es ambigua y sonaría todas.
func TestLaQuincenalRespetaSuAncla(t *testing.T) {
	loc := mx(t)
	m := domain.MeetingReminder{
		WallTime: "09:00", Freq: domain.MeetingFreqWeekly, Interval: 2,
		Weekdays: "1", Anchor: "2026-03-02", // un lunes
	}
	// Desde el lunes 2 pasadas las nueve: la semana del 9 NO toca, la del 16 sí.
	got, _ := nextOccurrence(m, time.Date(2026, 3, 2, 10, 0, 0, 0, loc), loc)
	if q := pared(got, loc); q != "2026-03-16 09:00 CST" {
		t.Errorf("cada dos semanas se salta la del 9, fue %s", q)
	}
}

func TestLaMensualSeRecortaAlFinDeMes(t *testing.T) {
	loc := mx(t)
	m := domain.MeetingReminder{
		WallTime: "09:00", Freq: domain.MeetingFreqMonthly, Interval: 1, MonthDay: 31,
	}
	// Desde el 1 de febrero: febrero de 2026 tiene 28 días, así que «el 31» es
	// el 28 — y no «no hay reunión en febrero», que sería perder una.
	got, _ := nextOccurrence(m, time.Date(2026, 2, 1, 0, 0, 0, 0, loc), loc)
	if q := pared(got, loc); q != "2026-02-28 09:00 CST" {
		t.Errorf("el 31 de febrero es el 28, fue %s", q)
	}
	// Y en abril, que tiene 30.
	got, _ = nextOccurrence(m, time.Date(2026, 4, 1, 0, 0, 0, 0, loc), loc)
	if q := pared(got, loc); q != "2026-04-30 09:00 CST" {
		t.Errorf("el 31 de abril es el 30, fue %s", q)
	}
}

func TestElVeintinueveDeFebreroEnUnAnioBisiesto(t *testing.T) {
	loc := mx(t)
	m := domain.MeetingReminder{
		WallTime: "09:00", Freq: domain.MeetingFreqMonthly, Interval: 1, MonthDay: 29,
	}
	// 2028 sí es bisiesto: el 29 existe.
	got, _ := nextOccurrence(m, time.Date(2028, 2, 1, 0, 0, 0, 0, loc), loc)
	if q := pared(got, loc); q != "2028-02-29 09:00 CST" {
		t.Errorf("2028 es bisiesto, fue %s", q)
	}
	// 2026 no: se recorta al 28.
	got, _ = nextOccurrence(m, time.Date(2026, 2, 1, 0, 0, 0, 0, loc), loc)
	if q := pared(got, loc); q != "2026-02-28 09:00 CST" {
		t.Errorf("2026 no es bisiesto, fue %s", q)
	}
}

// ─── Los dos cambios de hora ────────────────────────────────────────────────

// La prueba que justifica todo el diseño.
//
// Nueva York adelanta el reloj el 8 de marzo de 2026. Una reunión a las 09:00
// sigue siendo a las 09:00 los dos días — pero el **instante UTC cambia**,
// porque el sábado son las 14:00Z y el domingo las 13:00Z. Guardar la
// recurrencia en UTC y sumar 24 horas devolvería las 14:00Z del domingo, o sea
// las 10:00 locales: la reunión se le movió una hora a todo el mundo.
func TestLaHoraDeParedSobreviveAlCambioDeHorario(t *testing.T) {
	loc := ny(t)
	m := domain.MeetingReminder{WallTime: "09:00", Freq: domain.MeetingFreqDaily, Interval: 1}

	antes, _ := nextOccurrence(m, time.Date(2026, 3, 7, 0, 0, 0, 0, loc), loc)
	despues, _ := nextOccurrence(m, time.Date(2026, 3, 8, 0, 0, 0, 0, loc), loc)

	if a, d := pared(antes, loc), pared(despues, loc); a != "2026-03-07 09:00 EST" || d != "2026-03-08 09:00 EDT" {
		t.Errorf("las dos son a las nueve locales: %s y %s", a, d)
	}
	// Y el instante UTC **no** está a 24 horas: ahí está la diferencia.
	if h := despues.Sub(antes).Hours(); h != 23 {
		t.Errorf("del sábado al domingo del cambio hay 23 horas UTC, no %g", h)
	}
}

// Cruzando el cambio **dentro de una misma búsqueda**, que es donde de verdad
// se rompe.
//
// La prueba de arriba pregunta dos veces y cada una resuelve en el mismo día,
// así que el bucle nunca avanza sobre la frontera: un `nextOccurrence` que
// sumara 24 horas fijas por día la pasaba igual. Ésta pregunta un miércoles por
// la reunión del lunes siguiente, y ese lunes ya está al otro lado del cambio —
// hay que recorrer cinco días y uno de ellos dura 23 horas.
//
// Sumar duraciones fijas daría las 10:00: la reunión llegaría una hora tarde, y
// sólo medio año, hasta el siguiente cambio. Lo cazó un mutante; la prueba
// anterior no bastaba.
func TestElBucleQueCruzaElCambioSigueDandoLaHoraDePared(t *testing.T) {
	loc := ny(t)
	m := domain.MeetingReminder{
		WallTime: "09:00", Freq: domain.MeetingFreqWeekly, Interval: 1, Weekdays: "1", // lunes
	}
	miercolesAntes := time.Date(2026, 3, 4, 12, 0, 0, 0, loc) // el cambio es el 8
	got, err := nextOccurrence(m, miercolesAntes, loc)
	if err != nil {
		t.Fatal(err)
	}
	if q := pared(got, loc); q != "2026-03-09 09:00 EDT" {
		t.Errorf("el lunes de después del cambio sigue siendo a las nueve, fue %s", q)
	}
}

// Y lo mismo hacia el otro lado: en otoño el día dura 25 horas.
func TestElBucleQueCruzaLaVueltaAlHorarioDeInvierno(t *testing.T) {
	loc := ny(t)
	m := domain.MeetingReminder{
		WallTime: "09:00", Freq: domain.MeetingFreqWeekly, Interval: 1, Weekdays: "3", // miércoles
	}
	viernesAntes := time.Date(2026, 10, 30, 12, 0, 0, 0, loc) // se atrasa el 1 de noviembre
	got, _ := nextOccurrence(m, viernesAntes, loc)
	if q := pared(got, loc); q != "2026-11-04 09:00 EST" {
		t.Errorf("el miércoles de después sigue siendo a las nueve, fue %s", q)
	}
}

// La hora que no existe. El 8 de marzo de 2026, Nueva York salta de las 02:00 a
// las 03:00: las 02:30 no ocurren. Una reunión a esa hora tiene que sonar una
// vez —corrida—, no desaparecer ni sonar dos veces.
func TestLaHoraQueNoExisteSuenaUnaVez(t *testing.T) {
	loc := ny(t)
	m := domain.MeetingReminder{WallTime: "02:30", Freq: domain.MeetingFreqDaily, Interval: 1}

	got, err := nextOccurrence(m, time.Date(2026, 3, 8, 0, 0, 0, 0, loc), loc)
	if err != nil {
		t.Fatal(err)
	}
	// 03:30 EDT: el mismo instante que habrían sido las 02:30 si el reloj no
	// hubiera saltado. Go por su cuenta devuelve 01:30 EST —una hora *antes*—;
	// lo corrige `enLaZona`.
	if q := pared(got, loc); q != "2026-03-08 03:30 EDT" {
		t.Errorf("la hora inexistente se corre hacia adelante, fue %s", q)
	}
	if got.Day() != 8 {
		t.Errorf("y sigue siendo ese día, no el siguiente: %s", pared(got, loc))
	}
}

// El daño concreto de dejar que Go decida: dos reuniones a horas distintas
// sonando en el mismo instante. Sin corrección, la de las 02:30 cae en las
// 01:30 y las dos coinciden — el día del cambio recibirías dos timbres a la vez
// y ninguno a su hora.
func TestDosReunionesSeguidasNoSePisanElDiaDelCambio(t *testing.T) {
	loc := ny(t)
	medianoche := time.Date(2026, 3, 8, 0, 0, 0, 0, loc)

	temprana, _ := nextOccurrence(
		domain.MeetingReminder{WallTime: "01:30", Freq: domain.MeetingFreqDaily, Interval: 1},
		medianoche, loc)
	enElHueco, _ := nextOccurrence(
		domain.MeetingReminder{WallTime: "02:30", Freq: domain.MeetingFreqDaily, Interval: 1},
		medianoche, loc)

	if temprana.Equal(enElHueco) {
		t.Errorf("las dos sonarían a la vez: %s", pared(temprana, loc))
	}
	if !enElHueco.After(temprana) {
		t.Errorf("la de las 02:30 va después de la de la 01:30, no antes: %s vs %s",
			pared(enElHueco, loc), pared(temprana, loc))
	}
}

// La hora que ocurre dos veces. El 1 de noviembre de 2026, Nueva York atrasa el
// reloj y la 01:30 pasa dos veces. La reunión es **una**.
func TestLaHoraAmbiguaSuenaUnaSolaVez(t *testing.T) {
	loc := ny(t)
	m := domain.MeetingReminder{WallTime: "01:30", Freq: domain.MeetingFreqDaily, Interval: 1}

	primera, _ := nextOccurrence(m, time.Date(2026, 11, 1, 0, 0, 0, 0, loc), loc)
	if primera.Day() != 1 {
		t.Fatalf("la primera es ese día: %s", pared(primera, loc))
	}
	// Preguntando otra vez desde justo después, la siguiente es **al día
	// siguiente**: no la segunda pasada de la misma hora.
	siguiente, _ := nextOccurrence(m, primera, loc)
	if d := siguiente.In(loc).Day(); d != 2 {
		t.Errorf("la siguiente es el día 2, no otra vez el 1; fue %s", pared(siguiente, loc))
	}
}

// Y con una zona europea, que cambia en fechas distintas: la regla no puede
// tener el calendario de nadie metido dentro.
func TestCadaZonaCambiaCuandoLeToca(t *testing.T) {
	loc := mad(t)
	m := domain.MeetingReminder{WallTime: "09:00", Freq: domain.MeetingFreqDaily, Interval: 1}
	// Madrid adelanta el 29 de marzo de 2026, tres semanas después que EE.UU.
	antes, _ := nextOccurrence(m, time.Date(2026, 3, 28, 0, 0, 0, 0, loc), loc)
	despues, _ := nextOccurrence(m, time.Date(2026, 3, 29, 0, 0, 0, 0, loc), loc)
	if h := despues.Sub(antes).Hours(); h != 23 {
		t.Errorf("Madrid cambia el 29: esperaba 23 horas, hubo %g", h)
	}
}

// ─── La gracia ──────────────────────────────────────────────────────────────

func TestSonarConUnPocoDeRetrasoSigueValiendo(t *testing.T) {
	ahora := time.Date(2026, 3, 10, 9, 0, 30, 0, time.UTC)
	toca := time.Date(2026, 3, 10, 9, 0, 0, 0, time.UTC)
	if !vencida(toca, ahora, 5*time.Minute) {
		t.Error("treinta segundos tarde es lo normal entre dos vueltas del reloj")
	}
}

// Un pod que estuvo caído no puede volver avisando de la reunión de la
// madrugada: ya pasó, y nadie puede hacer nada con ese aviso.
func TestUnaReunionDeHaceHorasYaNoSuena(t *testing.T) {
	ahora := time.Date(2026, 3, 10, 12, 0, 0, 0, time.UTC)
	toca := time.Date(2026, 3, 10, 9, 0, 0, 0, time.UTC)
	if vencida(toca, ahora, 5*time.Minute) {
		t.Error("tres horas tarde se recalcula en silencio, no se timbra")
	}
}

func TestLoQueTodaviaNoHaLlegadoNoSuena(t *testing.T) {
	ahora := time.Date(2026, 3, 10, 8, 59, 0, 0, time.UTC)
	toca := time.Date(2026, 3, 10, 9, 0, 0, 0, time.UTC)
	if vencida(toca, ahora, 5*time.Minute) {
		t.Error("un minuto antes no es la hora")
	}
}

// ─── Entradas que no valen ──────────────────────────────────────────────────

func TestUnaHoraQueNoEsUnaHora(t *testing.T) {
	loc := mx(t)
	m := domain.MeetingReminder{WallTime: "9am", Freq: domain.MeetingFreqDaily, Interval: 1}
	if _, err := nextOccurrence(m, time.Now(), loc); err != ErrBadWallTime {
		t.Errorf("«9am» no es una hora de pared; error: %v", err)
	}
}

func TestUnaFrecuenciaQueNoExiste(t *testing.T) {
	loc := mx(t)
	m := domain.MeetingReminder{WallTime: "09:00", Freq: "cada rato", Interval: 1}
	if _, err := nextOccurrence(m, time.Now(), loc); err != ErrBadFreq {
		t.Errorf("esa frecuencia no existe; error: %v", err)
	}
}
