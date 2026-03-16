package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	httpRoutes "github.com/guz-studio/cac/backend/internal/adapters/http"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

func main() {
	repository.LoadEnv()
	port := repository.GetEnv("PORT", "8080")

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
		printBanner(port)
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

func printBanner(port string) {
	fmt.Printf(`
╭───────────────────────────────────────╮
│  CAC — VPS Control Plane API          │
│  http://localhost:%s/health           │
╰───────────────────────────────────────╯
`, port)
}
