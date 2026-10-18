package service

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"filippo.io/age"
)

type fakeKeyDocker struct {
	secrets map[string][]byte
	mounted []string
	created int
}

func (f *fakeKeyDocker) FindSecretByName(_ context.Context, name string) (string, error) {
	if _, ok := f.secrets[name]; ok {
		return "id-" + name, nil
	}
	return "", nil
}
func (f *fakeKeyDocker) CreateSecret(_ context.Context, name string, data []byte, _ map[string]string) (string, error) {
	if f.secrets == nil {
		f.secrets = map[string][]byte{}
	}
	f.secrets[name] = data
	f.created++
	return "id-" + name, nil
}
func (f *fakeKeyDocker) SelfServiceID(context.Context) (string, error) { return "self", nil }
func (f *fakeKeyDocker) AddSecretToService(_ context.Context, svc, id, name, _ string) (bool, error) {
	f.mounted = append(f.mounted, svc+":"+id)
	return true, nil
}

type fakeKeyBackend struct{ got string }

func (b *fakeKeyBackend) RestoreKey(_ context.Context, k string) error { b.got = k; return nil }

// La llave de restauración se crea **una vez**: si ya hay secret, se monta el
// que hay; si ya está montada, se usa y al backend sólo le llega la pública.
// Mutantes: generar una nueva en cada arranque (los backups cifrados para la
// anterior ya no se podrían probar); mandarle al backend la privada.
func TestTheRestoreKeyIsCreatedOnceAndOnlyItsPublicHalfLeaves(t *testing.T) {
	path := filepath.Join(t.TempDir(), RestoreKeySecret)
	d, b := &fakeKeyDocker{}, &fakeKeyBackend{}

	// Primer arranque: se crea y se monta; todavía no hay llave que usar.
	if id, err := EnsureRestoreKey(context.Background(), path, d, b); err != nil || id != nil {
		t.Fatalf("primer arranque: %v %v", id, err)
	}
	if d.created != 1 || len(d.mounted) != 1 {
		t.Fatalf("creadas %d, montadas %v", d.created, d.mounted)
	}
	// Un arranque que no llegó a tenerla montada: no crea otra.
	if _, err := EnsureRestoreKey(context.Background(), path, d, b); err != nil || d.created != 1 {
		t.Fatalf("segundo arranque creó otra (%d): %v", d.created, err)
	}
	// Montada (Swarm la deja en /run/secrets): se usa, y sale sólo la pública.
	os.WriteFile(path, d.secrets[RestoreKeySecret], 0o400)
	id, err := EnsureRestoreKey(context.Background(), path, d, b)
	if err != nil || id == nil {
		t.Fatalf("con la llave montada: %v %v", id, err)
	}
	if b.got != id.Recipient().String() {
		t.Errorf("al backend le llegó %q, se esperaba la pública", b.got)
	}
	if _, err := age.ParseX25519Recipient(b.got); err != nil {
		t.Errorf("lo que salió no es una llave pública: %v", err)
	}
}
