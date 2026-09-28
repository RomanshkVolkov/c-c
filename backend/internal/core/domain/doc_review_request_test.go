package domain

import "testing"

// Las peticiones de revisión de un mismo doc se pliegan en una fila de la
// campana, y las de docs distintos no (#92). Dos docs del mismo id pero de
// distinto tipo —una lista y un espacio— son dos docs.
func TestReviewRequestsGroupByDocument(t *testing.T) {
	if DocGroup("list", "a") != DocGroup("list", "a") {
		t.Fatal("el mismo doc tiene que dar la misma clave")
	}
	if DocGroup("list", "a") == DocGroup("list", "b") {
		t.Error("dos docs distintos no pueden plegarse juntos")
	}
	if DocGroup("list", "a") == DocGroup("space", "a") {
		t.Error("una lista y un espacio con el mismo id son dos docs")
	}
	if DocGroup("list", "") != "" {
		t.Error("sin doc no hay grupo: se pinta suelta, como antes")
	}
}

// Una revisión pedida es trabajo que te llega, así que se calla con lo mismo que
// una asignación. El mutante que mata: quitar el caso, que la dejaría sonando
// para quien pidió silencio.
func TestAReviewRequestIsQuietWhenWorkIsQuiet(t *testing.T) {
	if (NotificationPrefs{WorkQuiet: true}).Allows("doc:review") {
		t.Error("con el trabajo en silencio, una revisión pedida no avisa")
	}
	if !(NotificationPrefs{}).Allows("doc:review") {
		t.Error("sin silencio, sí")
	}
}
