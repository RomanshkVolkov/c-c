package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

// BackendReporter le cuenta al backend cómo va un trabajo, con el mismo token
// con el que le pregunta.
type BackendReporter struct {
	BaseURL, Token string
	Client         *http.Client
}

func NewBackendReporter(baseURL, token string) *BackendReporter {
	return &BackendReporter{BaseURL: baseURL, Token: token, Client: &http.Client{Timeout: 15 * time.Second}}
}

// Log manda una línea. Si no llega, se registra aquí y se sigue: el deploy no
// se para porque el backend esté lento; lo que cuenta es el Finish.
func (b *BackendReporter) Log(ctx context.Context, jobID, line string) {
	// La línea no se repite aquí: va al backend, que la guarda en el deploy, y
	// en los logs del contenedor quedaba además todo lo que imprimiera una
	// migración —que puede ser una cadena de conexión—.
	if err := b.post(ctx, "/agent/v1/jobs/"+jobID+"/log", map[string]any{"lines": []string{line}}); err != nil {
		log.Printf("deploy %s: no llegó el log: %v", jobID, err)
	}
}

// Finish se reintenta unas veces: si no llega, el backend da el deploy por
// perdido a los 15 min y el servicio queda bloqueado hasta entonces.
func (b *BackendReporter) Finish(ctx context.Context, jobID string, r FinishReport) error {
	var err error
	for i := 0; i < 5; i++ {
		if err = b.post(ctx, "/agent/v1/jobs/"+jobID+"/finish", r); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(i+1) * 2 * time.Second):
		}
	}
	log.Printf("deploy %s: no se pudo avisar de cómo acabó: %v", jobID, err)
	return err
}

func (b *BackendReporter) post(ctx context.Context, path string, body any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.BaseURL+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+b.Token)
	req.Header.Set("Content-Type", "application/json")
	res, err := b.Client.Do(req)
	if err != nil {
		return err
	}
	res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("el backend contestó %d", res.StatusCode)
	}
	return nil
}

// ─── Backups (v9) ─────────────────────────────────────────────────────────────

func (b *BackendReporter) BackupLog(ctx context.Context, id, line string) {
	if err := b.post(ctx, "/agent/v1/backups/"+id+"/log", map[string]any{"lines": []string{line}}); err != nil {
		log.Printf("backup %s: no llegó el log: %v", id, err)
	}
}

func (b *BackendReporter) BackupUploadURL(ctx context.Context, id string, size int64, sha string) (*Presigned, error) {
	var out Presigned
	err := b.postFor(ctx, "/agent/v1/backups/"+id+"/upload-url", map[string]any{"sizeBytes": size, "sha256": sha}, &out)
	return &out, err
}

func (b *BackendReporter) BackupDownloadURL(ctx context.Context, id string) (*Presigned, error) {
	var out Presigned
	err := b.postFor(ctx, "/agent/v1/backups/"+id+"/download-url", map[string]any{}, &out)
	return &out, err
}

func (b *BackendReporter) BackupFinish(ctx context.Context, id, status, errMsg string) error {
	return b.post(ctx, "/agent/v1/backups/"+id+"/finish", map[string]any{"status": status, "error": errMsg})
}

// RestoreKey manda la parte pública de la llave de restauración del servidor.
func (b *BackendReporter) RestoreKey(ctx context.Context, publicKey string) error {
	return b.post(ctx, "/agent/v1/restore-key", map[string]any{"publicKey": publicKey})
}

// postFor: como post, pero lee el `data` de la respuesta. Un error trae el
// código del backend, que es lo que dice qué pasó.
func (b *BackendReporter) postFor(ctx context.Context, path string, body, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.BaseURL+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+b.Token)
	req.Header.Set("Content-Type", "application/json")
	res, err := b.Client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	var env struct {
		Data  json.RawMessage `json:"data"`
		Error string          `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&env)
	if res.StatusCode >= 300 {
		return fmt.Errorf("el backend contestó %d: %s", res.StatusCode, env.Error)
	}
	return json.Unmarshal(env.Data, out)
}
