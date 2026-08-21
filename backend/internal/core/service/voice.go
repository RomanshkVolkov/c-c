package service

import (
	"errors"
	"time"

	"github.com/livekit/protocol/auth"
)

// ErrVoiceUnconfigured: no hay SFU al que mandar a nadie.
//
// Se distingue de un fallo porque no lo es: una instalación sin voz configurada
// es legítima, y la pantalla debe poder decir «esto no está montado» en vez de
// enseñar un error rojo.
var ErrVoiceUnconfigured = errors.New("voice is not configured")

// VoiceService acuña los permisos de entrada a una sala de LiveKit.
//
// El token se firma **aquí y sólo aquí**. Es lo que hace que la autorización de
// la voz sea la misma que la del resto de cac: la app no conoce el secreto, así
// que no puede fabricarse la entrada a una sala que no le toca. Su única vía es
// pedirla, y quien la concede ya sabe a qué organización pertenece.
type VoiceService struct {
	url    string
	key    string
	secret string
}

func NewVoiceService(url, key, secret string) *VoiceService {
	return &VoiceService{url: url, key: key, secret: secret}
}

// Configured dice si hay SFU. Sin llaves no se acuña nada.
func (s *VoiceService) Configured() bool {
	return s != nil && s.url != "" && s.key != "" && s.secret != ""
}

// RoomFor es el nombre de la sala de un espacio.
//
// Derivado del id **en el servidor**, nunca recibido del cliente: si la sala
// viajara en la petición, cualquiera podría pedir entrada a la de otro equipo y
// el guard de pertenencia estaría comprobando una cosa mientras el token
// concede otra. El prefijo mantiene el espacio de nombres separado de cualquier
// otro uso futuro de LiveKit.
func RoomFor(spaceID string) string { return "voice:" + spaceID }

// TTL corto a propósito: el token es una llave de entrada, no una sesión. Una
// reconexión pide otro, y eso mantiene corta la ventana en la que un token
// filtrado sirve de algo.
const voiceTokenTTL = time.Hour

// Token acuña la entrada de una persona a la sala de un espacio.
//
// `identity` es el id de usuario de cac: es lo que permite que la app sepa quién
// es cada participante sin un segundo directorio, y lo que hace que echar a
// alguien sea posible más adelante.
func (s *VoiceService) Token(spaceID, userID, username string) (string, error) {
	if !s.Configured() {
		return "", ErrVoiceUnconfigured
	}
	sala := RoomFor(spaceID)
	concesion := &auth.VideoGrant{
		RoomJoin: true,
		Room:     sala,
		// Publicar y suscribirse, sí; administrar la sala, no. Un cliente no
		// tiene por qué poder echar a nadie ni cambiar metadatos, y concederlo
		// «por si acaso» es dar permisos que nadie pidió.
		CanPublish:     boolPtr(true),
		CanSubscribe:   boolPtr(true),
		CanPublishData: boolPtr(true),
	}
	t := auth.NewAccessToken(s.key, s.secret).
		SetVideoGrant(concesion).
		SetIdentity(userID).
		SetName(username).
		SetValidFor(voiceTokenTTL)
	return t.ToJWT()
}

// URL del SFU, para que la app sepa a dónde conectarse.
func (s *VoiceService) URL() string { return s.url }

func boolPtr(b bool) *bool { return &b }
