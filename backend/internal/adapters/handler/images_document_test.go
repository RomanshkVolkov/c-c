package handler

import "testing"

func TestDocumentType(t *testing.T) {
	cases := []struct {
		name, file, sniffed, want string
	}{
		{"csv de Airbnb", "pagos-airbnb.csv", "text/plain; charset=utf-8", "text/csv"},
		{"xlsx de Booking", "Booking.XLSX", "application/zip", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
		{"xls viejo", "reporte.xls", "application/octet-stream", "application/vnd.ms-excel"},
		{"pdf", "factura.pdf", "application/pdf", "application/pdf"},
		{"html disfrazado de csv", "x.csv", "text/html; charset=utf-8", ""},
		{"zip cualquiera como xlsx falso", "x.zip", "application/zip", ""},
		{"svg", "x.svg", "text/xml; charset=utf-8", ""},
		{"sin extension", "datos", "text/plain; charset=utf-8", ""},
	}
	for _, c := range cases {
		if got := documentType(c.file, c.sniffed); got != c.want {
			t.Errorf("%s: documentType(%q, %q) = %q, quería %q", c.name, c.file, c.sniffed, got, c.want)
		}
	}
}
