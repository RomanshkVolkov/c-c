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
				lg.Info("Variable " + key + " cargada con valor " + value)
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
