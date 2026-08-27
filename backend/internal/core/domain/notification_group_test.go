package domain

import "testing"

// La gramática de las claves de grupo.
//
// Sin base de datos: son cadenas y un `switch`. Y es donde de verdad se puede
// romper la campana sin que nada avise — una clave mal formada no da error, no
// deja traza, y sólo se nota mirando el panel y viendo dos filas del mismo
// canal.

func TestLaFamiliaSaleDeLaClaseNoDelEnlace(t *testing.T) {
	// El caso que justifica la regla entera: un recordatorio de reunión lleva
	// **el mismo enlace** que un mensaje de ese canal. Deduciendo la familia del
	// enlace, «empieza la daily» acabaría dentro del grupo de mensajes.
	const enlace = "/chat?space=s1"
	if canal, reunion := DeriveGroup("chat:message", enlace), DeriveGroup("meeting:reminder", enlace); canal == reunion {
		t.Fatalf("la reunión cayó en el grupo del canal: %q", reunion)
	}
	if got := DeriveGroup("meeting:reminder", enlace); got != "" {
		t.Errorf("una reunión antigua no se puede agrupar —no lleva su id—, salió %q", got)
	}
}

func TestLoQueSeDeduceYLoQueSeConstruyeCoinciden(t *testing.T) {
	// El fallo que esto vigila es de los que no se ven: si las dos vías
	// escribieran distinto, las filas viejas y las nuevas del mismo canal
	// formarían **dos grupos**, y nadie sabría por qué.
	casos := []struct {
		nombre    string
		kind, url string
		esperado  string
	}{
		{"un mensaje de canal", "chat:message", "/chat?space=s1", ChannelGroup("s1")},
		{"una mención en ese canal", "chat:mention", "/chat?space=s1", ChannelGroup("s1")},
		{"un directo", "dm:message", "/dm?c=c7", DMGroup("c7")},
		{"un comentario", "task:comment", "/tasks?task=t3", ItemGroup("t3")},
		{"una asignación", "task:assigned", "/tasks?task=t3", ItemGroup("t3")},
		{"un reporte nuevo", "report:new", "/tasks?task=t3", ItemGroup("t3")},
		{"el enlace viejo de reportes", "report:new", "/reports?open=r9", ItemGroup("r9")},
	}
	for _, c := range casos {
		if got := DeriveGroup(c.kind, c.url); got != c.esperado {
			t.Errorf("%s: esperaba %q, salió %q", c.nombre, c.esperado, got)
		}
	}
}

func TestUnaMencionEsDelMismoSitioQueUnMensaje(t *testing.T) {
	// Que te nombren pasa **en el canal**, no en un sitio aparte: si fueran
	// grupos distintos, la mención se perdería en una fila suelta justo cuando
	// más quieres verla.
	if DeriveGroup("chat:mention", "/chat?space=s1") != DeriveGroup("chat:message", "/chat?space=s1") {
		t.Error("la mención y el mensaje del mismo canal tienen que ir juntos")
	}
}

func TestSinIdNoHayClave(t *testing.T) {
	// Una clave con la familia y nada más —«space:»— juntaría todos los canales
	// del mundo en un montón. Mejor suelta.
	casos := []struct{ nombre, kind, url string }{
		{"sin enlace", "chat:message", ""},
		{"enlace sin parámetros", "chat:message", "/chat"},
		{"el parámetro que no es", "chat:message", "/chat?otro=s1"},
		{"parámetro vacío", "dm:message", "/dm?c="},
		{"clase desconocida", "algo:raro", "/chat?space=s1"},
	}
	for _, c := range casos {
		if got := DeriveGroup(c.kind, c.url); got != "" {
			t.Errorf("%s: tenía que quedarse sin clave, salió %q", c.nombre, got)
		}
	}
}

func TestLasConstructorasNoInventanClavesVacias(t *testing.T) {
	// Un id vacío llega cuando algo va mal más arriba. Devolver «space:» sería
	// propagar el error a la pantalla de todo el mundo.
	if ChannelGroup("") != "" || DMGroup("") != "" || ItemGroup("") != "" || MeetingGroup("") != "" {
		t.Error("sin id no hay grupo")
	}
}

func TestCadaFamiliaTieneSuPropioEspacioDeNombres(t *testing.T) {
	// El mismo uuid puede ser un espacio y una tarea a la vez. Sin el prefijo,
	// los avisos de los dos caerían en el mismo grupo.
	const id = "d0d0"
	claves := map[string]bool{
		ChannelGroup(id): true, DMGroup(id): true, ItemGroup(id): true, MeetingGroup(id): true,
	}
	if len(claves) != 4 {
		t.Errorf("las cuatro familias tienen que dar claves distintas: %v", claves)
	}
}
