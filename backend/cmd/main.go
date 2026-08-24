package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	// La base de datos de zonas horarias, dentro del binario.
	//
	// Una reunión periódica se guarda en hora de pared con su zona IANA —«las
	// 9:00 de CDMX»— y `time.LoadLocation` la necesita para saber a qué instante
	// corresponde eso cada día. La imagen final es `alpine` sin el paquete
	// `tzdata`, así que en producción esa llamada fallaría con «unknown time
	// zone» y ninguna reunión sonaría nunca. Un test no lo cazaría: los
	// runners y esta máquina sí tienen la base instalada.
	//
	// Importarla cuesta ~450 KB y viaja con el binario, que es preferible a que
	// funcione o no según la imagen base que alguien elija mañana.
	_ "time/tzdata"

	httpRoutes "github.com/guz-studio/cac/backend/internal/adapters/http"
	"github.com/guz-studio/cac/backend/internal/banner"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

func main() {
	repository.LoadEnv()
	port := repository.GetEnv("PORT", "8080")
	env := repository.GetEnv("APP_ENV", "development")

	repository.DBConnection()

	r := httpRoutes.InitRoutes(repository.DATABASE)

	server := &http.Server{
		Addr:         ":" + port,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		banner.Print(env, port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server failed: %v", err)
		}
	}()

	<-sigChan
	log.Println("Shutting down...")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Fatalf("Forced shutdown: %v", err)
	}
	log.Println("Server stopped")
}
