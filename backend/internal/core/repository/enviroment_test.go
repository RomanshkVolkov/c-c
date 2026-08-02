package repository

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A .env holds the database password, the JWT secret and every API key. Logging
// the value alongside the name put all of them in the startup output of every
// environment, in clear text.
func TestLoadEnvNeverLogsAValue(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("enviroment.go"))
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(src), "\n") {
		code := strings.TrimSpace(line)
		if strings.HasPrefix(code, "//") || !strings.Contains(code, "lg.") {
			continue
		}
		if strings.Contains(code, "value") {
			t.Errorf("this log line can carry a secret: %s", code)
		}
	}
}
