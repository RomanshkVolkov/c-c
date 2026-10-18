package backupstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// Contra el bucket de verdad, sólo con BACKUPS_TEST_BUCKET puesto (no corre en
// CI ni en una máquina sin las llaves). Lo que se prueba sólo lo puede decir
// S3: que la URL firmada sube **ese** fichero, que el objeto queda bloqueado en
// GOVERNANCE hasta la fecha firmada, y que otro cuerpo con la misma URL se
// rechaza. Deja un objeto pequeño bloqueado un día bajo `backups/_tests/`.
// Mutantes: firmar sin la retención (el objeto queda con la de por defecto, no
// la pedida); firmar sin el sha256 (otro cuerpo pasaría).
func TestAPresignedUploadIsLockedAndExact(t *testing.T) {
	bucket := os.Getenv("BACKUPS_TEST_BUCKET")
	if bucket == "" {
		t.Skip("BACKUPS_TEST_BUCKET no está puesto")
	}
	ctx := context.Background()
	s, err := New(ctx, bucket, os.Getenv("BACKUPS_TEST_REGION"), "backups",
		os.Getenv("BACKUPS_TEST_ACCESS_KEY_ID"), os.Getenv("BACKUPS_TEST_SECRET_ACCESS_KEY"))
	if err != nil || !s.Enabled() {
		t.Fatalf("store: %v", err)
	}
	body := []byte(fmt.Sprintf("backup de prueba %d", time.Now().UnixNano()))
	sum := sha256.Sum256(body)
	key := fmt.Sprintf("backups/_tests/%d.age", time.Now().UnixNano())
	until := time.Now().Add(26 * time.Hour).UTC().Truncate(time.Second)

	req, err := s.PresignPut(ctx, key, int64(len(body)), hex.EncodeToString(sum[:]), until)
	if err != nil {
		t.Fatal(err)
	}
	put := func(b []byte) int {
		r, _ := http.NewRequest(req.Method, req.URL, bytes.NewReader(b))
		for k, v := range req.Headers {
			r.Header.Set(k, v)
		}
		r.ContentLength = int64(len(b))
		res, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode >= 400 {
			var e bytes.Buffer
			e.ReadFrom(res.Body)
			t.Logf("S3 %d: %s", res.StatusCode, e.String())
		}
		return res.StatusCode
	}

	// Otro cuerpo del mismo tamaño: el sha256 firmado no casa.
	other := bytes.Repeat([]byte("x"), len(body))
	if code := put(other); code < 400 {
		t.Fatalf("otro cuerpo con la misma URL → %d", code)
	}
	t.Logf("cabeceras firmadas: %v", keys(req.Headers))
	if u, err := url.Parse(req.URL); err == nil {
		q := []string{}
		for k := range u.Query() {
			q = append(q, k)
		}
		t.Logf("query: %v", q)
	}
	if code := put(body); code != http.StatusOK {
		t.Fatalf("la subida → %d", code)
	}
	ret, err := s.client.GetObjectRetention(ctx, &s3.GetObjectRetentionInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	if err != nil {
		t.Fatal(err)
	}
	if ret.Retention.Mode != types.ObjectLockRetentionModeGovernance || !aws.ToTime(ret.Retention.RetainUntilDate).Equal(until) {
		t.Fatalf("retención: %s hasta %s, se pidió GOVERNANCE hasta %s", ret.Retention.Mode, aws.ToTime(ret.Retention.RetainUntilDate), until)
	}
	// Y se baja con un GET a secas, sin ninguna cabecera: como un navegador
	// (el botón «Descargar») y como el agente en la prueba de restauración.
	get, err := s.PresignGet(ctx, key, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(get.Headers) != 0 {
		t.Errorf("la bajada pide cabeceras %v: un navegador no puede mandarlas", get.Headers)
	}
	res, err := http.Get(get.URL)
	if err != nil {
		t.Fatal(err)
	}
	down, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || !bytes.Equal(down, body) {
		t.Fatalf("la bajada → %d (%d bytes): %s", res.StatusCode, len(down), down)
	}
	// Y no se deja borrar.
	if err := s.DeleteAllVersions(ctx, key); err == nil {
		t.Fatal("se borró un objeto bloqueado")
	}
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
