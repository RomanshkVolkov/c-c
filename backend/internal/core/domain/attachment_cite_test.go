package domain

import "testing"

// Quitar la cita de un adjunto borrado.
//
// Lo delicado no es quitarla: es no llevarse nada más por delante. Esto reescribe
// texto que alguien escribió, en la descripción de una tarjeta que puede ser un
// reporte de un cliente, y no hay vuelta atrás.
func TestStripAttachmentCitations(t *testing.T) {
	const id = "a0b99fff-1111-2222-3333-444455556666"
	cita := func(alt string) string {
		return "![" + alt + "](/api/v1/tasks/t1/attachments/" + id + "/raw)"
	}

	t.Run("quita la imagen y deja el texto", func(t *testing.T) {
		got := StripAttachmentCitations("antes\n\n"+cita("captura")+"\n\ndespués", id)
		if got != "antes\n\ndespués" {
			t.Fatalf("%q", got)
		}
	})

	t.Run("un enlace a un fichero también es una cita", func(t *testing.T) {
		got := StripAttachmentCitations("mira [informe.pdf](/api/v1/tasks/t1/attachments/"+id+"/raw) va", id)
		if got != "mira  va" {
			t.Fatalf("%q", got)
		}
	})

	// El de al lado se queda. Es el duplicado: se pegó dos veces, salieron dos
	// adjuntos y se borra uno — si se fueran los dos, el arreglo sería peor que
	// el fallo.
	t.Run("no toca las citas de otro adjunto", func(t *testing.T) {
		otro := "![otra](/api/v1/tasks/t1/attachments/8a92adac-0000/raw)"
		got := StripAttachmentCitations(cita("una")+"\n"+otro, id)
		if got != otro {
			t.Fatalf("%q", got)
		}
	})

	/**
	 * El fallo caro, y el que una expresión glotona comete sola.
	 *
	 * Con `.*` en vez de `[^)]*`, la coincidencia va desde el primer `](` hasta
	 * el último `)` de la línea: se lleva el enlace de en medio y todas las
	 * palabras que hubiera entre los dos. El texto queda mutilado y nadie sabe
	 * qué decía.
	 */
	t.Run("con dos enlaces en la misma línea no se come lo de en medio", func(t *testing.T) {
		linea := "ver " + cita("x") + " y también [la guía](https://ejemplo.com) al final"
		got := StripAttachmentCitations(linea, id)
		if got != "ver  y también [la guía](https://ejemplo.com) al final" {
			t.Fatalf("%q", got)
		}
		// Y con la cita **detrás**, que es el orden en el que muerde: hacia atrás
		// la expresión glotona sí tiene de dónde estirar, y se lleva el enlace de
		// delante y todo lo que hubiera entre los dos.
		alReves := "[la guía](https://ejemplo.com) y luego " + cita("x") + " fin"
		got = StripAttachmentCitations(alReves, id)
		if got != "[la guía](https://ejemplo.com) y luego  fin" {
			t.Fatalf("%q", got)
		}
	})

	/**
	 * El identificador se busca **literal**, no como expresión.
	 *
	 * Hoy siempre es un uuid y ninguno lleva metacaracteres, así que esto no
	 * salta nunca en producción. Se prueba igual porque la función acepta una
	 * cadena: el día que alguien le pase otra cosa, un `.` casaría con cualquier
	 * carácter y se llevaría por delante la cita de un adjunto distinto — que es
	 * exactamente el fallo del que sale esta tarjeta, con otro disfraz.
	 */
	t.Run("el id no se interpreta como expresión", func(t *testing.T) {
		const vecino = "![otra](/api/v1/tasks/t1/attachments/abc/raw)"
		if got := StripAttachmentCitations(vecino, "a.c"); got != vecino {
			t.Fatalf("se llevó la cita de otro: %q", got)
		}
	})

	// Nada que quitar significa **nada que tocar**, ni siquiera los saltos de
	// línea. Este camino lo recorre cada borrado de adjunto, también los que no
	// estaban citados, y «arreglarle» el espaciado a la descripción de alguien es
	// reescribir lo que nadie pidió reescribir.
	t.Run("si no está citado no cambia nada, ni el espaciado", func(t *testing.T) {
		const texto = "un párrafo\n\n\n\notro, con hueco a propósito"
		if got := StripAttachmentCitations(texto, id); got != texto {
			t.Fatalf("%q", got)
		}
	})

	// Un id vacío casaría con cualquier URL y vaciaría el texto entero.
	t.Run("sin id no toca nada", func(t *testing.T) {
		const texto = "![x](/api/v1/tasks/t1/attachments/zzz/raw)"
		if got := StripAttachmentCitations(texto, ""); got != texto {
			t.Fatalf("%q", got)
		}
	})

	t.Run("no deja un hueco donde no lo había", func(t *testing.T) {
		got := StripAttachmentCitations("uno\n"+cita("x")+"\ndos", id)
		if got != "uno\ndos" {
			t.Fatalf("%q", got)
		}
	})
}
