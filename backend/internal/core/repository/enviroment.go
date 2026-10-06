package repository

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	lg "github.com/guz-studio/cac/backend/internal/core/logger"
)

func LoadEnv() {
	file, err := os.Open(".env")
	if err != nil {
		fmt.Println("No .env file found")
		return
	}

	defer func(file *os.File) {
		err := file.Close()
		if err != nil {

		}
	}(file)

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.Contains(line, "=") && !strings.HasPrefix(line, "#") {
			parts := strings.SplitN(line, "=", 2)
			key := strings.TrimSpace(parts[0])
			value := strings.ReplaceAll(strings.TrimSpace(parts[1]), "\"", "")
			if os.Getenv(key) == "" {
				// The name only. This used to log the value too, which put
				// DB_PASSWORD, the JWT secret and every key in the .env into the
				// startup output of every environment in clear text — somewhere
				// nobody thinks to look for a secret, and everywhere logs get
				// shipped, tailed and pasted into a chat.
				lg.Info("Variable " + key + " cargada")
				err := os.Setenv(key, value)
				if err != nil {
					return
				}
			}
		}
	}
}

func GetEnv(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return fallback
}

// requiredSecrets son los secretos que firman sesiones, llaves y enlaces. Si
// faltan, el código cae en un `change-me-*` público, y cualquiera que lea este
// repositorio podría firmar un token válido.
var requiredSecrets = []string{"JWT_SECRET_ACCESS", "JWT_SECRET_REFRESH", "INGEST_KEY_SECRET"}

// MissingSecrets: los que faltan o siguen con un valor de ejemplo.
func MissingSecrets() []string {
	var out []string
	for _, k := range requiredSecrets {
		v := os.Getenv(k)
		if v == "" || strings.HasPrefix(v, "change-me") {
			out = append(out, k)
		}
	}
	return out
}

// InCluster: si el proceso corre dentro de Kubernetes, que es producción. En
// desarrollo y en las pruebas los `change-me-*` siguen sirviendo.
func InCluster() bool {
	return os.Getenv("KUBERNETES_SERVICE_HOST") != "" || os.Getenv("APP_ENV") == "production"
}
