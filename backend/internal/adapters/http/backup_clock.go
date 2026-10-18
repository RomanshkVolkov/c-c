package http

import (
	"context"
	"log"
	"os/signal"
	"syscall"
	"time"

	"github.com/guz-studio/cac/backend/internal/adapters/backupstore"
	"github.com/guz-studio/cac/backend/internal/core/repository"
	"github.com/guz-studio/cac/backend/internal/core/service"
)

// newBackupStore construye el acceso al bucket desde el entorno. Variable para
// que las pruebas de las rutas pongan uno falso: sin bucket los backups están
// apagados y no habría nada que probar.
var newBackupStore = func() service.BackupStore {
	store, err := backupstore.New(context.Background(), repository.GetEnv("BACKUPS_BUCKET", ""),
		repository.GetEnv("BACKUPS_REGION", ""), repository.GetEnv("BACKUPS_PREFIX", "backups"),
		repository.GetEnv("BACKUPS_ACCESS_KEY_ID", ""), repository.GetEnv("BACKUPS_SECRET_ACCESS_KEY", ""))
	if err != nil {
		log.Printf("backups: %v", err)
		return &backupstore.Store{}
	}
	return store
}

// startBackupClockFn: las pruebas lo cambian por nada y mueven el reloj a mano.
var startBackupClockFn = startBackupClock

// Cada cuánto mira el reloj de los backups qué toca. Un minuto: un backup
// programado a las 03:30 empieza antes de las 03:31, y nada más fino hace falta.
const backupClockTick = time.Minute

// El conserje que borra de S3 lo vencido corre una vez por hora: la retención
// se cuenta en días.
const backupPurgeEvery = time.Hour

// startBackupClock arranca el reloj de los backups (#166). Corre en cada
// réplica; el servicio reserva cada paso con compare-and-swap, así que dos
// relojes no encolan dos veces. Sin bucket no arranca: no hay nada que hacer,
// y así las pruebas que montan las rutas no dejan un reloj suelto.
func startBackupClock(svc *service.BackupService) {
	if !svc.Enabled() {
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	go func() {
		defer stop()
		tick := time.NewTicker(backupClockTick)
		defer tick.Stop()
		lastPurge := time.Time{}
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-tick.C:
				svc.FireDue(now)
				if now.Sub(lastPurge) >= backupPurgeEvery {
					lastPurge = now
					if n, err := svc.Purge(ctx, now); err != nil {
						log.Printf("backups: purge: %v", err)
					} else if n > 0 {
						log.Printf("backups: purged %d expired objects", n)
					}
				}
			}
		}
	}()
}
