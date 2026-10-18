package service

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"

	"filippo.io/age"
)

// La llave de restauración de este servidor (#166 B5).
//
// La prueba semanal de restauración tiene que poder abrir un backup sin la
// llave de jose, que vive en su 1Password. Así que cada servidor tiene la suya:
// la genera su agente la primera vez, la guarda como Docker secret y se la
// monta a sí mismo. **La privada nunca sale del host**; al backend sólo va la
// pública, que se añade como destinataria de los backups de ese servidor. Si
// se pierde la máquina se pierde esta llave, y la de jose sigue abriéndolo
// todo.

// RestoreKeySecret: el nombre del secret y del fichero en `/run/secrets`.
const RestoreKeySecret = "cac_backup_restore_key"

// RestoreKeyDocker: lo que hace falta de Docker para crearla y montarla.
type RestoreKeyDocker interface {
	FindSecretByName(ctx context.Context, name string) (string, error)
	CreateSecret(ctx context.Context, name string, data []byte, labels map[string]string) (string, error)
	SelfServiceID(ctx context.Context) (string, error)
	AddSecretToService(ctx context.Context, serviceID, secretID, secretName, file string) (bool, error)
}

type RestoreKeyBackend interface {
	RestoreKey(ctx context.Context, publicKey string) error
}

// EnsureRestoreKey devuelve la llave si ya está montada (y le dice al backend
// su parte pública). Si no, la crea si hace falta y se la monta al servicio de
// este agente: Swarm lo reinicia, y en el siguiente arranque ya está. Devuelve
// nil mientras tanto, y el agente sigue: sin llave sólo falla la prueba.
func EnsureRestoreKey(ctx context.Context, path string, docker RestoreKeyDocker, backend RestoreKeyBackend) (*age.X25519Identity, error) {
	if raw, err := os.ReadFile(path); err == nil {
		id, err := parseIdentity(raw)
		if err != nil {
			return nil, err
		}
		if backend != nil {
			if err := backend.RestoreKey(ctx, id.Recipient().String()); err != nil {
				log.Printf("restore key: el backend no la recibió (se reintenta al arrancar): %v", err)
			}
		}
		return id, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}

	secretID, err := docker.FindSecretByName(ctx, RestoreKeySecret)
	if err != nil {
		return nil, err
	}
	if secretID == "" {
		id, err := age.GenerateX25519Identity()
		if err != nil {
			return nil, err
		}
		secretID, err = docker.CreateSecret(ctx, RestoreKeySecret, []byte(id.String()+"\n"),
			map[string]string{"cac.restore-key": "1"})
		if err != nil {
			return nil, fmt.Errorf("create the restore key secret: %w", err)
		}
		log.Printf("restore key: creada (pública %s)", id.Recipient().String())
	}
	self, err := docker.SelfServiceID(ctx)
	if err != nil {
		return nil, fmt.Errorf("mount the restore key: %w", err)
	}
	if changed, err := docker.AddSecretToService(ctx, self, secretID, RestoreKeySecret, RestoreKeySecret); err != nil {
		return nil, fmt.Errorf("mount the restore key: %w", err)
	} else if changed {
		log.Printf("restore key: montada; Swarm reinicia este agente para leerla")
	}
	return nil, nil
}

func parseIdentity(raw []byte) (*age.X25519Identity, error) {
	ids, err := age.ParseIdentities(strings.NewReader(string(raw)))
	if err != nil {
		return nil, fmt.Errorf("restore key: %w", err)
	}
	for _, i := range ids {
		if x, ok := i.(*age.X25519Identity); ok {
			return x, nil
		}
	}
	return nil, errors.New("restore key: no X25519 identity in the secret")
}
