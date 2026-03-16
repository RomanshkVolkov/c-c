package middleware

import (
	"fmt"
	"log"
	"net/http"
	"runtime/debug"
	"time"
)

func Logger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := &rw{ResponseWriter: w, code: http.StatusOK}
		next.ServeHTTP(ww, r)
		log.Printf("[%s] %s %d %v", r.Method, r.RequestURI, ww.code, time.Since(start))
	})
}

func Recovery(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if err := recover(); err != nil {
				log.Printf("PANIC: %v\n%s", err, debug.Stack())
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusInternalServerError)
				fmt.Fprint(w, `{"success":false,"error":"internal server error"}`)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// CORS allows requests from the CAC backend.
func CORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type rw struct {
	http.ResponseWriter
	code int
}

func (r *rw) WriteHeader(code int) {
	r.code = code
	r.ResponseWriter.WriteHeader(code)
}
