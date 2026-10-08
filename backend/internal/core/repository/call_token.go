package repository

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"
)

/*
Los dos tokens de una llamada con gente de fuera (W3).

Un invitado no tiene cuenta, así que no tiene JWT: lo que le deja entrar es lo
que trae en la mano. Son dos cosas distintas y cada una lleva su llave:

  - **El enlace** (`<inviteID>.<firma>`) abre una invitación. No lleva fecha: la
    caducidad y la revocación viven en la fila, que es lo que hace que revocar
    funcione en el acto. Y como es re-derivable del id, un miembro puede volver
    a copiarlo cuando quiera sin que se guarde ningún secreto.
  - **El pase** (`<guestID>.<exp>.<firma>`) es de una persona que ya entró. Es lo
    que deja volver con la misma identidad tras recargar, y lo que permite
    negarle otra entrada a quien se echó.

Las llaves se derivan de la de acceso como la del pase de URL, y **cada una con
su etiqueta**: un enlace no puede pasar por un pase ni por un token de
reportero, aunque los tres sean un HMAC sobre ids.
*/

func callKey(label string) []byte {
	mac := hmac.New(sha256.New, []byte(GetEnv("JWT_SECRET_ACCESS", "change-me-access-secret")))
	mac.Write([]byte(label))
	return mac.Sum(nil)
}

func callInviteKey() []byte { return callKey("call-invite") }
func callGuestKey() []byte  { return callKey("call-guest") }

func signCallInvite(inviteID string) string {
	mac := hmac.New(sha256.New, callInviteKey())
	mac.Write([]byte(inviteID))
	return hex.EncodeToString(mac.Sum(nil))
}

// SignCallInviteLink: el token que va en el enlace de una invitación.
func SignCallInviteLink(inviteID string) string {
	return inviteID + "." + signCallInvite(inviteID)
}

// VerifyCallInviteLink: de qué invitación es un enlace, si la firma es buena.
//
// Que la invitación siga viva lo dice la fila, no esto.
func VerifyCallInviteLink(token string) (string, bool) {
	id, sig, ok := strings.Cut(token, ".")
	if !ok || id == "" || sig == "" {
		return "", false
	}
	if subtle.ConstantTimeCompare([]byte(signCallInvite(id)), []byte(sig)) != 1 {
		return "", false
	}
	return id, true
}

// GuestPassMaxTTL: lo más que vive un pase, aunque la invitación dure más. Es
// lo que tarda una reunión larga, no una semana con la puerta abierta.
const GuestPassMaxTTL = 12 * time.Hour

func signGuestPass(inviteID, guestID string, exp int64) string {
	mac := hmac.New(sha256.New, callGuestKey())
	fmt.Fprintf(mac, "%s:%s:%d", inviteID, guestID, exp)
	return hex.EncodeToString(mac.Sum(nil))
}

// MintGuestPass: el pase de un invitado, hasta `until` como mucho.
func MintGuestPass(inviteID, guestID string, until, now time.Time) string {
	exp := now.Add(GuestPassMaxTTL)
	if until.Before(exp) {
		exp = until
	}
	e := exp.Unix()
	return guestID + "." + strconv.FormatInt(e, 10) + "." + signGuestPass(inviteID, guestID, e)
}

// VerifyGuestPass: de quién es un pase de esta invitación, si sigue valiendo.
//
// La invitación va **dentro de la firma**: un pase de una reunión no abre otra
// aunque el invitado conserve los dos.
func VerifyGuestPass(inviteID, pass string, now time.Time) (string, bool) {
	parts := strings.Split(pass, ".")
	if len(parts) != 3 || parts[0] == "" {
		return "", false
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || now.Unix() > exp {
		return "", false
	}
	want := signGuestPass(inviteID, parts[0], exp)
	if subtle.ConstantTimeCompare([]byte(want), []byte(parts[2])) != 1 {
		return "", false
	}
	return parts[0], true
}
