package repository

import "testing"

// The DSN gets logged on every boot, so whatever it contains ends up wherever
// logs go. It contains the database password.
func TestTheLoggedDSNCarriesNoPassword(t *testing.T) {
	for _, c := range []struct{ name, dsn, secret string }{
		{"key=value, the shape this project uses",
			"host=10.0.0.1 user=cac_user password=kqEiguqKdRHM7CHxqQN6j dbname=cac port=5432 sslmode=disable",
			"kqEiguqKdRHM7CHxqQN6j"},
		{"the URL shape, which whoever sets this next may well use",
			"postgres://cac_user:kqEiguqKdRHM7CHxqQN6j@10.0.0.1:5432/cac?sslmode=disable",
			"kqEiguqKdRHM7CHxqQN6j"},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := redactDSN(c.dsn)
			if contains(got, c.secret) {
				t.Errorf("the password survived redaction: %s", got)
			}
			// Still useful: the whole reason to log this is knowing which
			// database a process picked, which is how a boot pointed at
			// production gets noticed at all.
			if !contains(got, "10.0.0.1") {
				t.Errorf("redaction removed the host too, leaving nothing to diagnose with: %s", got)
			}
		})
	}

	if redactDSN("") == "" {
		t.Error("an empty DSN should say where the settings came from instead of logging nothing")
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
