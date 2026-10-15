package domain

// Responder a un mensaje: la cita encima de la respuesta, como en WhatsApp.
//
// Vale igual en un canal y en un directo, así que vive aquí y no en uno de los
// dos. La respuesta guarda sólo el id de lo que cita (`reply_to_id`); el autor
// y el texto se leen al pintar el hilo, con un join, y **no se copian**. Una
// copia se quedaría diciendo lo que ponía antes de que lo editaran, y seguiría
// enseñando un mensaje retirado — retirar es precisamente dejar de enseñarlo.
//
// Por eso una cita puede volver «ida» (`Gone`): lo citado se retiró. La
// respuesta sigue en pie y dice que lo que contestaba ya no está, sin
// enseñarlo, igual que WhatsApp con «Se eliminó este mensaje».

// MessageQuote es lo que una respuesta enseña de lo que cita.
type MessageQuote struct {
	ID         string `json:"id"`
	AuthorName string `json:"authorName"`
	// Body, recortado: es una cita, no el mensaje. Vacío si Gone.
	Body string `json:"body"`
	Gone bool   `json:"gone"`
}

// QuoteLen es cuánto del mensaje citado viaja con la respuesta. Se recorta en
// el servidor porque una página de cincuenta respuestas a un mensaje largo
// mandaría cincuenta copias enteras.
const QuoteLen = 280

// QuoteRow son las columnas de la cita tal como las lee el join del hilo.
// Planas porque `Scan` no rellena un struct anidado.
type QuoteRow struct {
	ReplyToID      *string `json:"-"`
	ReplyAuthor    string  `json:"-"`
	ReplyBody      string  `json:"-"`
	ReplyWithdrawn bool    `json:"-"`
}

// quote arma la cita a partir de las columnas planas; nil si no responde a nada.
func (q QuoteRow) quote() *MessageQuote {
	if q.ReplyToID == nil || *q.ReplyToID == "" {
		return nil
	}
	if q.ReplyWithdrawn {
		return &MessageQuote{ID: *q.ReplyToID, Gone: true}
	}
	return &MessageQuote{ID: *q.ReplyToID, AuthorName: q.ReplyAuthor, Body: quoteBody(q.ReplyBody)}
}

// quoteBody recorta por runas (clipRunes): un corte a mitad de una «ñ» o de un
// emoji mandaría un carácter roto.
func quoteBody(s string) string {
	if c := clipRunes(s, QuoteLen); c != s {
		return c + "…"
	}
	return s
}
