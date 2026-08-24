package service

import (
	"strings"
	"testing"
)

// La URL de una imagen es **relativa**, y eso es contrato, no detalle.
//
// Está documentado en `docs/integrations/server-to-server.md`: apunta al proxy
// de CAC —no a S3— y quien integra la prefija con su propia base. Devolverla
// absoluta haría que cada cliente concatenara dos veces y diera 404 en todas
// las miniaturas, sin que nada del lado del servidor pareciera roto.
//
// El test de forma (`report_contract_shape_test.go`) mira la misma URL, pero
// necesita Postgres y **se salta cuando no lo hay** — que es siempre, porque el
// CI no corre las pruebas del backend. Éste no necesita nada: la función es un
// `Sprintf` y una firma, así que la regla se puede fijar donde de verdad se
// ejecuta.
func TestLaUrlDeUnaImagenEsRelativa(t *testing.T) {
	u := signedImageURL("rep-1", "img-1")

	if !strings.HasPrefix(u, "/api/v1/reports/") {
		t.Errorf("tiene que ser una ruta relativa al proxy de CAC, es %q", u)
	}
	// Dicho de la otra forma, que es la que rompería a los clientes: nada de
	// esquema ni de host, ni el de S3 ni el nuestro.
	if strings.Contains(u, "://") {
		t.Errorf("no puede llevar esquema ni host, es %q", u)
	}
	// Y sigue llevando su firma: sin credencial que mandar, un `<img>` no tiene
	// otra forma de identificarse.
	if !strings.Contains(u, "exp=") || !strings.Contains(u, "sig=") {
		t.Errorf("tiene que ir firmada y caducar, es %q", u)
	}
	// El id del reporte y el de la imagen, en la ruta y no en la query: es lo
	// que firma el HMAC, así que moverlos invalidaría toda firma emitida.
	if !strings.Contains(u, "/reports/rep-1/images/img-1?") {
		t.Errorf("los dos ids van en la ruta, es %q", u)
	}
}
