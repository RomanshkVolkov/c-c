package service

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// El adelanto que va en un aviso.
//
// Existe porque la fila de la bandeja se guardaba con el cuerpo vacío y siete
// mensajes seguidos daban siete líneas idénticas. Lo que se prueba aquí es lo
// que puede salir mal al recortar, que es más de lo que parece.

func TestAdelantoDejaCortoLoCorto(t *testing.T) {
	if got := Adelanto("hola"); got != "hola" {
		t.Errorf("want %q, got %q", "hola", got)
	}
}

// Un aviso es una línea. Con varios párrafos, el sistema operativo recorta por
// el primer salto y enseña una palabra suelta.
func TestAdelantoAplastaLosSaltosDeLinea(t *testing.T) {
	got := Adelanto("primera\n\nsegunda\ttercera")
	if got != "primera segunda tercera" {
		t.Errorf("want %q, got %q", "primera segunda tercera", got)
	}
}

// El clásico que sólo aparece cuando el texto no está en inglés: cortar por
// bytes parte una «ñ» por la mitad y deja basura al final de cada aviso.
func TestAdelantoNoParteUnCaracterPorLaMitad(t *testing.T) {
	largo := strings.Repeat("ñ", 300)
	got := Adelanto(largo)
	if !utf8.ValidString(got) {
		t.Fatalf("el recorte rompió el UTF-8: %q", got)
	}
	sinPuntos := strings.TrimSuffix(got, "…")
	if n := utf8.RuneCountInString(sinPuntos); n != 140 {
		t.Errorf("want 140 runas, got %d", n)
	}
}

// Y se avisa de que hay más, para que nadie lea media frase como si fuera
// entera.
func TestAdelantoDiceQueHayMas(t *testing.T) {
	got := Adelanto(strings.Repeat("a", 200))
	if !strings.HasSuffix(got, "…") {
		t.Errorf("un texto recortado tiene que decirlo: %q", got)
	}
	if utf8.RuneCountInString(got) != 141 {
		t.Errorf("140 runas más los puntos, got %d", utf8.RuneCountInString(got))
	}
}

// Justo en el límite no se recorta: 140 caben, y poner «…» a un texto entero
// es mentir sobre él.
func TestAdelantoNoRecortaJustoEnElLimite(t *testing.T) {
	exacto := strings.Repeat("b", 140)
	if got := Adelanto(exacto); got != exacto {
		t.Errorf("no debería tocarlo: %q", got)
	}
}

// Un mensaje sólo con espacios no puede convertirse en un aviso con un espacio
// suelto de cuerpo.
func TestAdelantoDeNadaEsNada(t *testing.T) {
	if got := Adelanto("   \n\t "); got != "" {
		t.Errorf("want empty, got %q", got)
	}
}
