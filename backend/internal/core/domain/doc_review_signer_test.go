package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// Quién puede firmar la revisión de un documento (#84).
//
// La firma dice que **una persona** leyó el documento y responde de él. Hasta el
// 27-sep-2026 sólo se pedía superadmin, y como los claims de un token copian ese
// campo del usuario, el token de un superadmin firmaba por la API — aunque el
// middleware aseguraba en un comentario que ningún token podía. Lo único que lo
// frenaba era que el MCP no lo exponía.

func TestDocReviewSigner(t *testing.T) {
	for _, c := range []struct {
		caso   string
		claims *ClaimsJWT
		want   error
	}{
		{"un superadmin en su sesión firma", &ClaimsJWT{Superadmin: true}, nil},
		// El que estaba abierto. El mutante que mata: dejar de mirar ViaToken.
		{"un superadmin con token no", &ClaimsJWT{Superadmin: true, ViaToken: true}, ErrReviewNeedsAPerson},
		{"quien no es superadmin, en su sesión, tampoco", &ClaimsJWT{}, ErrReviewNeedsSuperadmin},
		// Aquí el motivo es el token, no el rol: decirle «sólo un superadmin» a
		// alguien a quien no le bastaría con serlo es darle la pista equivocada.
		{"ni con token", &ClaimsJWT{ViaToken: true}, ErrReviewNeedsAPerson},
		{"sin quien llame, nadie", nil, ErrReviewNeedsAPerson},
	} {
		t.Run(c.caso, func(t *testing.T) {
			got := DocReviewSigner(c.claims)
			if !errors.Is(got, c.want) || (c.want == nil) != (got == nil) {
				t.Errorf("salió %v, y es %v", got, c.want)
			}
		})
	}
}

// Y la marca no se puede fabricar.
//
// Si `ViaToken` viajara en el JWT, bastaría con no ponerlo para que un agente
// firmara como una persona; y si se pudiera leer del cuerpo de una petición,
// igual. Por eso va con `json:"-"`, como `ProjectID`: sólo la pone el middleware.
//
// El mutante que mata: darle un nombre JSON al campo.
func TestViaTokenNeverTravelsInJSON(t *testing.T) {
	salida, err := json.Marshal(&ClaimsJWT{UserID: "u1", ViaToken: true})
	if err != nil {
		t.Fatal(err)
	}
	if s := strings.ToLower(string(salida)); strings.Contains(s, "via") {
		t.Errorf("la marca se serializa, así que viajaría en un token: %s", salida)
	}

	var entrada ClaimsJWT
	if err := json.Unmarshal([]byte(`{"ViaToken":true,"viaToken":true,"via_token":true}`), &entrada); err != nil {
		t.Fatal(err)
	}
	if entrada.ViaToken {
		t.Error("la marca se puede traer puesta desde fuera")
	}
}
