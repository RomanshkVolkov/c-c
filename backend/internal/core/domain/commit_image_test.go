package domain

import (
	"strings"
	"testing"
)

// cac#185. Roturas que detecta, en orden: que un servicio que construye en el
// servidor use el tag a secas (el del CI lo pisa); que dev y prod del mismo
// repo compartan tag; que un servicio sin build en el servidor cambie (su tag
// es el que publica el CI, y tiene que seguir siéndolo); que el nombre del
// servicio meta en el tag algo que no admite; que se pase de 128 caracteres;
// y que el repo cambie (volver a la versión anterior lo exige, y el agente
// también: `ImageRef`).
func TestAHostBuiltImageIsNamedAfterItsService(t *testing.T) {
	const sha = "f01b62f0123456789abcdef0123456789abcdef0"
	prod := &Deployable{ImageRepo: "ghcr.io/dwit/rrhh", ServiceName: "rrhh-prod_app", BuildOnHost: true, ShortTags: true}
	dev := &Deployable{ImageRepo: "ghcr.io/dwit/rrhh", ServiceName: "rrhh-dev_app", BuildOnHost: true, ShortTags: true}
	ci := &Deployable{ImageRepo: "ghcr.io/dwit/rrhh", ServiceName: "rrhh-prod_app", ShortTags: true}

	if got := prod.CommitImage(sha); got != "ghcr.io/dwit/rrhh:f01b62f-rrhh-prod_app" {
		t.Errorf("prod: %s", got)
	}
	if prod.CommitImage(sha) == dev.CommitImage(sha) {
		t.Error("dev y prod comparten tag en el mismo servidor")
	}
	if got := ci.CommitImage(sha); got != "ghcr.io/dwit/rrhh:f01b62f" {
		t.Errorf("sin build en el servidor cambió: %s", got)
	}
	odd := &Deployable{ImageRepo: "r", ServiceName: "Mi Servicio/raro@x", BuildOnHost: true}
	if got := odd.CommitImage(sha); got != "r:"+sha+"-mi-servicio-raro-x" {
		t.Errorf("caracteres raros: %s", got)
	}
	long := &Deployable{ImageRepo: "r", ServiceName: strings.Repeat("s", 300), BuildOnHost: true}
	for _, d := range []*Deployable{prod, dev, ci, odd, long} {
		img := d.CommitImage(sha)
		if _, ok := ImageRef(d.ImageRepo, img); !ok {
			t.Errorf("%q no pasa ImageRef (el agente la rechazaría)", img)
		}
		if !strings.HasPrefix(img, d.ImageRepo+":") {
			t.Errorf("%q cambió de repo", img)
		}
	}
}
