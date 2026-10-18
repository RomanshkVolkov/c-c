package domain

import (
	"testing"
	"time"
)

func target() BackupTarget {
	return BackupTarget{
		ServiceName: "sqlserver-prod_sqlserver-vps--db", Engine: BackupEngineMSSQL, Database: "boaty",
		CredentialEnv: "MSSQL_SA_PASSWORD", EveryHours: 24, AnchorTime: "03:30", Timezone: "America/Mexico_City",
		KeepDays: 7, KeepWeekly: 4, KeepMonthly: 6, RestoreTestEveryDays: 7,
	}
}

func at(t *testing.T, tz, s string) time.Time {
	t.Helper()
	loc, err := time.LoadLocation(tz)
	if err != nil {
		t.Fatal(err)
	}
	v, err := time.ParseInLocation("2006-01-02 15:04", s, loc)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// Las horas son de pared en la zona de la base, también el día que se cambia
// la hora. Mutantes: calcular en UTC (las 03:30 de México serían las 21:30);
// sumar 24 h a un instante (el día del cambio se corre una hora); con el
// ancla tarde, olvidarse de las horas que dan la vuelta al día.
func TestTheBackupScheduleIsWallClock(t *testing.T) {
	tg := target()
	tg.Timezone = "America/New_York" // México ya no cambia la hora; Nueva York sí.
	for _, c := range []struct{ after, want string }{
		{"2026-10-17 10:00", "2026-10-18 03:30"},
		{"2026-10-18 03:29", "2026-10-18 03:30"},
		{"2026-10-18 03:30", "2026-10-19 03:30"},
		// El 1 de noviembre de 2026 Nueva York atrasa la hora a las 02:00.
		{"2026-10-31 12:00", "2026-11-01 03:30"},
		{"2026-11-01 03:31", "2026-11-02 03:30"},
	} {
		got, err := NextBackupRun(tg, at(t, tg.Timezone, c.after))
		if err != nil {
			t.Fatal(err)
		}
		if want := at(t, tg.Timezone, c.want); !got.Equal(want) {
			t.Errorf("después de %s: %s, se esperaba %s", c.after, got.In(want.Location()), want)
		}
	}

	tg.EveryHours, tg.AnchorTime = 6, "21:00"
	got, _ := NextBackupRun(tg, at(t, tg.Timezone, "2026-10-17 22:00"))
	if want := at(t, tg.Timezone, "2026-10-18 03:00"); !got.Equal(want) {
		t.Errorf("cada 6 h desde las 21:00, tras las 22:00: %s, se esperaba %s", got, want)
	}
	got, _ = NextBackupRun(tg, at(t, tg.Timezone, "2026-10-17 01:00"))
	if want := at(t, tg.Timezone, "2026-10-17 03:00"); !got.Equal(want) {
		t.Errorf("cada 6 h desde las 21:00, tras la 01:00: %s, se esperaba %s", got, want)
	}
}

// Con días enteros cuenta desde una fecha fija: «cada 3 días» cae en los
// mismos días pase lo que pase. Mutante: contar desde `after`.
func TestEveryFewDaysIsAFixedCadence(t *testing.T) {
	tg := target()
	tg.EveryHours = 72
	a, _ := NextBackupRun(tg, at(t, tg.Timezone, "2026-10-17 10:00"))
	b, _ := NextBackupRun(tg, a)
	c, _ := NextBackupRun(tg, at(t, tg.Timezone, "2026-10-17 11:00"))
	if b.Sub(a) != 72*time.Hour {
		t.Errorf("entre dos: %s", b.Sub(a))
	}
	if !a.Equal(c) {
		t.Errorf("preguntar una hora después movió el día: %s y %s", a, c)
	}
}

// La clase: el primero del mes, de la semana, o el resto; y una clase con 0
// a guardar cae a la siguiente. Mutantes: semana por día del mes; olvidarse
// de monthly; no caer de clase.
func TestRetentionFollowsMonthWeekAndDay(t *testing.T) {
	tg := target()
	tz := tg.Timezone
	now := at(t, tz, "2026-11-01 03:30") // domingo, mes nuevo
	day := 24 * time.Hour

	if c, until := RetentionFor(tg, now, nil); c != RetentionMonthly || !until.Equal(now.Add(6*31*day)) {
		t.Errorf("el primero de todos: %s %s", c, until)
	}
	last := at(t, tz, "2026-10-31 03:30")
	if c, _ := RetentionFor(tg, now, &last); c != RetentionMonthly {
		t.Errorf("primero de noviembre: %s", c)
	}
	// Lunes 2 de noviembre: semana ISO nueva, mismo mes.
	mon := at(t, tz, "2026-11-02 03:30")
	if c, until := RetentionFor(tg, mon, &now); c != RetentionWeekly || !until.Equal(mon.Add(4*7*day)) {
		t.Errorf("lunes: %s %s", c, until)
	}
	tue := at(t, tz, "2026-11-03 03:30")
	if c, until := RetentionFor(tg, tue, &mon); c != RetentionRegular || !until.Equal(tue.Add(7*day)) {
		t.Errorf("martes: %s %s", c, until)
	}
	// El 15 de un mes, sin semana nueva desde el último: regular aunque sea
	// «mitad de mes».
	a, b := at(t, tz, "2026-10-14 03:30"), at(t, tz, "2026-10-15 03:30")
	if c, _ := RetentionFor(tg, b, &a); c != RetentionRegular {
		t.Errorf("del 14 al 15: %s", c)
	}
	// Sin mensuales, el primero del mes cuenta como semanal.
	tg.KeepMonthly = 0
	if c, _ := RetentionFor(tg, now, &last); c != RetentionWeekly {
		t.Errorf("sin mensuales: %s", c)
	}
	tg.KeepWeekly = 0
	if c, _ := RetentionFor(tg, now, &last); c != RetentionRegular {
		t.Errorf("sin mensuales ni semanales: %s", c)
	}
}

// Lo que va a una shell del servidor tiene su forma, y una base no puede
// llevar el prefijo que borra la prueba de restauración. Mutantes: no mirar
// la variable; aceptar el prefijo; aceptar cualquier intervalo.
func TestABackupTargetIsValidated(t *testing.T) {
	if err := func() error { tg := target(); return tg.Validate() }(); err != nil {
		t.Fatalf("la buena: %v", err)
	}
	for name, mod := range map[string]func(*BackupTarget){
		"variable con shell":   func(t *BackupTarget) { t.CredentialEnv = "X;rm -rf /" },
		"base con comillas":    func(t *BackupTarget) { t.Database = "a'b" },
		"prefijo de pruebas":   func(t *BackupTarget) { t.Database = RestoreTestPrefix + "x" },
		"cada 5 horas":         func(t *BackupTarget) { t.EveryHours = 5 },
		"hora rara":            func(t *BackupTarget) { t.AnchorTime = "25:00" },
		"zona inventada":       func(t *BackupTarget) { t.Timezone = "Marte/Olympus" },
		"motor desconocido":    func(t *BackupTarget) { t.Engine = "oracle" },
		"cero días":            func(t *BackupTarget) { t.KeepDays = 0 },
		"servicio con espacio": func(t *BackupTarget) { t.ServiceName = "a b" },
	} {
		tg := target()
		mod(&tg)
		if tg.Validate() == nil {
			t.Errorf("%s: se aceptó", name)
		}
	}
}

// El aviso de «sin backup» espera el doble del intervalo, y nunca menos del
// intervalo más dos horas. Mutante: sólo el doble (con uno cada hora, dos
// horas de silencio ya sería alarma).
func TestStaleWaitsLongEnough(t *testing.T) {
	tg := target()
	if got := BackupStaleAfterFor(tg); got != 48*time.Hour {
		t.Errorf("diario: %s", got)
	}
	tg.EveryHours = 1
	if got := BackupStaleAfterFor(tg); got != 3*time.Hour {
		t.Errorf("cada hora: %s", got)
	}
}

// Una llave pública age tiene su forma. Mutante: aceptar cualquier `age1…`.
func TestAnAgePublicKeyIsRecognised(t *testing.T) {
	if !ValidAgePublicKey("age1uzcuhrh6yezjg96efqkks530nnrtmea9q89m87pawfqdckp8h9yqf9yvjy") {
		t.Error("la de jose no pasa")
	}
	for _, k := range []string{"age1", "age1uzcuhrh6", "AGE-SECRET-KEY-1ABC", "age1uzcuhrh6yezjg96efqkks530nnrtmea9q89m87pawfqdckp8h9yqf9yvjyb"} {
		if ValidAgePublicKey(k) {
			t.Errorf("%q pasó", k)
		}
	}
}
