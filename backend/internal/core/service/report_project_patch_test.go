package service

import (
	"testing"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

// Omitir un campo no lo borra.
//
// Antes sí: los campos eran valores, y un `PATCH` que sólo quisiera mover la
// bandeja **borraba el webhook y su secreto**, vaciaba los orígenes permitidos
// y devolvía los límites a su defecto. Sin avisar de nada. Cambiar una cosa
// obligaba a reenviar la configuración entera y acertar con todo.
//
// Sin base de datos a propósito: la regla es aritmética sobre dos structs, y el
// CI no corre las pruebas del backend — una que necesitara Postgres no
// vigilaría nada.

/** Un proyecto configurado a conciencia, para ver qué sobrevive. */
func configurado() *domain.ReportProject {
	lista := "lista-vieja"
	responsable := "u-ana"
	return &domain.ReportProject{
		OrgID:                       "org-1",
		Name:                        "boaty",
		AllowedOrigins:              domain.StringList{"https://boaty.app"},
		// A propósito distintos de los valores por defecto —20 y 10—: con los
		// del defecto, reiniciar el campo y dejarlo en paz dan el mismo
		// resultado y la prueba no distingue. Un mutante lo demostró.
		RateLimitPerHour:            500,
		RateLimitPerReporterPerHour: 7,
		IsActive:                    true,
		DefaultAssigneeUserID:       &responsable,
		ListID:                      &lista,
		WebhookURL:                  "https://boaty.app/hooks/cac",
		WebhookSecret:               "un-secreto-de-al-menos-16",
	}
}

func txt(s string) *string { return &s }

// El caso que motivó el cambio: mover la bandeja y nada más.
func TestMoverLaBandejaNoTocaElResto(t *testing.T) {
	p := configurado()
	aplicarCambios(p, domain.UpdateReportProjectRequest{ListID: txt("lista-nueva")})

	if p.ListID == nil || *p.ListID != "lista-nueva" {
		t.Errorf("la bandeja no se movió: %v", p.ListID)
	}
	// Lo que antes se perdía por no mencionarlo.
	if p.WebhookURL != "https://boaty.app/hooks/cac" {
		t.Errorf("se borró el webhook: %q", p.WebhookURL)
	}
	if p.WebhookSecret == "" {
		t.Error("se borró el secreto del webhook, y con él la firma")
	}
	if len(p.AllowedOrigins) != 1 {
		t.Errorf("se vaciaron los orígenes: %v", p.AllowedOrigins)
	}
	if p.RateLimitPerHour != 500 || p.RateLimitPerReporterPerHour != 7 {
		t.Errorf("se reiniciaron los límites: %d y %d",
			p.RateLimitPerHour, p.RateLimitPerReporterPerHour)
	}
	if p.Name != "boaty" {
		t.Errorf("se cambió el nombre: %q", p.Name)
	}
	if p.DefaultAssigneeUserID == nil {
		t.Error("se borró el responsable por defecto")
	}
	if !p.IsActive {
		t.Error("se desactivó el canal")
	}
}

// Un PATCH vacío es una operación válida y no hace nada.
func TestUnPatchVacioNoCambiaNada(t *testing.T) {
	p := configurado()
	antes := *p
	aplicarCambios(p, domain.UpdateReportProjectRequest{})
	if p.WebhookURL != antes.WebhookURL || p.Name != antes.Name ||
		p.RateLimitPerHour != antes.RateLimitPerHour || p.WebhookSecret != antes.WebhookSecret {
		t.Error("un PATCH sin campos tiene que dejar el proyecto igual")
	}
}

// Borrar sigue siendo posible: pidiéndolo.
func TestElVacioExplicitoSiBorra(t *testing.T) {
	p := configurado()
	aplicarCambios(p, domain.UpdateReportProjectRequest{WebhookURL: txt("")})
	if p.WebhookURL != "" {
		t.Errorf("mandar \"\" tiene que borrar el destino, quedó %q", p.WebhookURL)
	}
	// Y retirar el destino retira su secreto: dejarlo sería guardar una
	// credencial para un sitio al que ya no se llama.
	if p.WebhookSecret != "" {
		t.Error("al borrar el webhook tiene que irse su secreto")
	}
}

// El secreto sólo se reemplaza cuando llega uno nuevo. Mandarlo vacío junto a
// otros cambios no puede dejar de firmar en silencio.
func TestElSecretoNoSePisaConUnVacio(t *testing.T) {
	p := configurado()
	aplicarCambios(p, domain.UpdateReportProjectRequest{
		Name:          txt("boaty v2"),
		WebhookSecret: txt(""),
	})
	if p.WebhookSecret != "un-secreto-de-al-menos-16" {
		t.Errorf("el secreto se perdió: %q", p.WebhookSecret)
	}
	if p.Name != "boaty v2" {
		t.Errorf("el nombre sí debía cambiar: %q", p.Name)
	}
}

// Y el responsable, que usa la otra convención: "" lo quita.
func TestElResponsableSeQuitaConElVacio(t *testing.T) {
	p := configurado()
	aplicarCambios(p, domain.UpdateReportProjectRequest{DefaultAssigneeUserID: txt("")})
	if p.DefaultAssigneeUserID != nil {
		t.Errorf("tenía que quedarse sin responsable: %v", p.DefaultAssigneeUserID)
	}
}

// Los orígenes se pueden vaciar a propósito, que no es lo mismo que omitirlos.
func TestLosOrigenesSeVacianSiSeMandaVacio(t *testing.T) {
	p := configurado()
	vacios := []string{}
	aplicarCambios(p, domain.UpdateReportProjectRequest{AllowedOrigins: &vacios})
	if len(p.AllowedOrigins) != 0 {
		t.Errorf("una lista vacía explícita tiene que vaciarlos: %v", p.AllowedOrigins)
	}
}

// Desactivar un canal es un cambio como otro, y omitirlo no lo desactiva.
func TestDesactivarEsExplicito(t *testing.T) {
	p := configurado()
	aplicarCambios(p, domain.UpdateReportProjectRequest{Name: txt("otro")})
	if !p.IsActive {
		t.Error("no se pidió desactivarlo")
	}

	no := false
	aplicarCambios(p, domain.UpdateReportProjectRequest{IsActive: &no})
	if p.IsActive {
		t.Error("sí se pidió desactivarlo")
	}
}
