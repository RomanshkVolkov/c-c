// Package imageservice is a thin client for the image-service (upload-only).
// The backend proxies report screenshots so the secret API key and the storage
// bucket stay server-side — the web client/widget never touches image-service
// or S3. The returned `id` is the storage Key (canonical); build retrieval from
// it. Calcado del cliente de marvi (pkg/media).
package imageservice

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"time"
)

type Client struct {
	baseURL string
	certCN  string
	apiKey  string
	http    *http.Client
}

// New builds a client. When apiKey is empty the client is disabled (Enabled()
// reports false and uploads return ErrDisabled).
func New(baseURL, certCN, apiKey string) *Client {
	return &Client{
		baseURL: baseURL,
		certCN:  certCN,
		apiKey:  apiKey,
		http:    &http.Client{Timeout: 60 * time.Second},
	}
}

func (c *Client) Enabled() bool { return c != nil && c.apiKey != "" }

var ErrDisabled = fmt.Errorf("image service not configured")

// Result is the upload response. Key (== id) is the canonical storage key that
// gets persisted as report_images.path.
type Result struct {
	Key             string `json:"id"`
	URL             string `json:"url"`
	Format          string `json:"format"`
	OriginalBytes   int64  `json:"original_bytes"`
	CompressedBytes int64  `json:"compressed_bytes"`
}

type uploadOptions struct {
	Folder   string `json:"folder,omitempty"`
	Format   string `json:"format,omitempty"`
	Quality  int    `json:"quality,omitempty"`
	MaxWidth int    `json:"max_width,omitempty"`
}

// UploadImage sends one image to POST /upload under folder, transcoded to webp.
func (c *Client) UploadImage(ctx context.Context, filename, contentType string, data []byte, folder string) (Result, error) {
	if !c.Enabled() {
		return Result{}, ErrDisabled
	}

	var body bytes.Buffer
	w := multipart.NewWriter(&body)

	part, err := w.CreateFormFile("file", filename)
	if err != nil {
		return Result{}, err
	}
	if _, err := part.Write(data); err != nil {
		return Result{}, err
	}

	opts, _ := json.Marshal(uploadOptions{Folder: folder, Format: "webp", Quality: 85, MaxWidth: 2048})
	if err := w.WriteField("options", string(opts)); err != nil {
		return Result{}, err
	}
	if err := w.Close(); err != nil {
		return Result{}, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/upload", &body)
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("X-Client-Cert-CN", c.certCN)
	req.Header.Set("X-API-Key", c.apiKey)

	resp, err := c.http.Do(req)
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return Result{}, fmt.Errorf("image-service %d: %s", resp.StatusCode, string(raw))
	}
	var out Result
	if err := json.Unmarshal(raw, &out); err != nil {
		return Result{}, fmt.Errorf("image-service: bad response: %w", err)
	}
	return out, nil
}
