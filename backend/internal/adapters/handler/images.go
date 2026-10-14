package handler

import (
	"io"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

const (
	maxImageBytes    = 5 << 20  // ~5 MB per image (portento validation)
	maxDocumentBytes = 10 << 20 // 10 MB per document (CSV/Excel/PDF)
	maxImagesPerCall = 5        // max images per report/comment
	maxMultipartBody = 32 << 20 // 32 MB total multipart body
)

// allowedImageMimes: png/jpeg/webp/gif (portento validation). Checked against
// the sniffed content (http.DetectContentType), not the client-supplied header.
var allowedImageMimes = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/webp": true,
	"image/gif":  true,
}

// allowedDocuments: lo que no es imagen y sí se acepta en un reporte —las
// exportaciones de las OTAs que adjunta Portento (CSV, Excel) y PDF—. Se decide
// por la extensión y se comprueba contra lo que dice el contenido, para que un
// HTML renombrado a .csv no pase. Se guardan tal cual (image-service
// /upload/file), sin convertir a WebP.
var allowedDocuments = map[string]struct {
	contentType string
	sniffed     func(string) bool
}{
	".csv":  {"text/csv", func(m string) bool { return strings.HasPrefix(m, "text/plain") }},
	".xlsx": {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", func(m string) bool { return m == "application/zip" }},
	".xls":  {"application/vnd.ms-excel", func(m string) bool { return m == "application/octet-stream" || m == "application/vnd.ms-excel" }},
	".pdf":  {"application/pdf", func(m string) bool { return m == "application/pdf" }},
}

// documentType devuelve el tipo con el que se guarda un documento permitido, o "".
func documentType(fileName, sniffed string) string {
	doc, ok := allowedDocuments[strings.ToLower(filepath.Ext(fileName))]
	if !ok || !doc.sniffed(sniffed) {
		return ""
	}
	return doc.contentType
}

// readMultipartImages parses the request as multipart and reads+validates the
// image files under `field`. On failure it writes the error response and
// returns ok=false. A request with no images returns (nil, true).
func readMultipartImages(w http.ResponseWriter, r *http.Request, field string) ([]domain.IngestImage, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxMultipartBody)
	if err := r.ParseMultipartForm(maxMultipartBody); err != nil {
		SendErrorResponse(w, http.StatusBadRequest, "Invalid multipart body", err.Error())
		return nil, false
	}
	if r.MultipartForm == nil {
		return nil, true
	}
	files := r.MultipartForm.File[field]
	if len(files) > maxImagesPerCall {
		SendErrorResponse(w, http.StatusBadRequest, "Too many images", "max-5-images")
		return nil, false
	}

	var images []domain.IngestImage
	for _, fh := range files {
		if fh.Size > maxDocumentBytes {
			SendErrorResponse(w, http.StatusBadRequest, "File too large", fh.Filename+": max 10 MB")
			return nil, false
		}
		f, err := fh.Open()
		if err != nil {
			SendErrorResponse(w, http.StatusBadRequest, "Cannot read image", err.Error())
			return nil, false
		}
		data, err := io.ReadAll(f)
		f.Close()
		if err != nil {
			SendErrorResponse(w, http.StatusBadRequest, "Cannot read image", err.Error())
			return nil, false
		}
		mime := http.DetectContentType(data)
		if !allowedImageMimes[mime] {
			doc := documentType(fh.Filename, mime)
			if doc == "" {
				SendErrorResponse(w, http.StatusBadRequest, "Unsupported file type", fh.Filename+": "+mime+" (png/jpeg/webp/gif, csv/xlsx/xls/pdf)")
				return nil, false
			}
			mime = doc
		} else if fh.Size > maxImageBytes {
			SendErrorResponse(w, http.StatusBadRequest, "Image too large", fh.Filename+": max 5 MB")
			return nil, false
		}
		images = append(images, domain.IngestImage{
			FileName:    fh.Filename,
			ContentType: mime,
			Data:        data,
		})
	}
	return images, true
}
