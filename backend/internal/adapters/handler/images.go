package handler

import (
	"io"
	"net/http"

	"github.com/guz-studio/cac/backend/internal/core/domain"
)

const (
	maxImageBytes    = 5 << 20  // ~5 MB per image (portento validation)
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
		if fh.Size > maxImageBytes {
			SendErrorResponse(w, http.StatusBadRequest, "Image too large", fh.Filename+": max 5 MB")
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
			SendErrorResponse(w, http.StatusBadRequest, "Unsupported image type", fh.Filename+": "+mime+" (png/jpeg/webp/gif)")
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
