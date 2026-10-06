package handler

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	lg "github.com/guz-studio/cac/backend/internal/core/logger"
	"github.com/guz-studio/cac/backend/internal/core/repository"
)

const (
	// launchTTL is how long the one-shot launch token stays usable.
	launchTTL = 2 * time.Minute
	// proxySessionTTL is the lifetime of the cookie the proxy issues.
	proxySessionTTL = 8 * time.Hour
	proxyQueryParam = "__cac"
)

// ProxyHost es el dominio **propio** del proxy de integraciones
// (`INTEGRATIONS_PROXY_HOST`, p. ej. tools.guz-studio.dev).
//
// Hasta el 6-oct-2026 el proxy servía las herramientas desde
// cac.guz-studio.dev, el mismo origen que la versión web (`/app`), que guarda
// la sesión en `localStorage`. Cualquier página servida por el proxy —una
// integración maliciosa, o un fallo de la herramienta— podía leer los tokens de
// quien la abriera. En su propio dominio, el navegador la aísla de cac.
//
// Vacío = el proxy está apagado. No hay vuelta atrás al mismo origen.
func ProxyHost() string { return strings.ToLower(repository.GetEnv("INTEGRATIONS_PROXY_HOST", "")) }

// IsProxyPath: si una ruta es del proxy de integraciones.
func IsProxyPath(path string) bool {
	return strings.HasPrefix(path, "/api/v1/servers/") && strings.Contains(path, "/integrations/") &&
		(strings.HasSuffix(path, "/proxy") || strings.Contains(path, "/proxy/"))
}

// RequestHostOf: el host de la petición, sin puerto y en minúsculas.
func RequestHostOf(r *http.Request) string { return requestHost(r) }

// requestHost: el host de la petición, sin puerto y en minúsculas.
func requestHost(r *http.Request) string {
	h := r.Host
	if i := strings.LastIndexByte(h, ':'); i >= 0 && !strings.Contains(h[i:], "]") {
		h = h[:i]
	}
	return strings.ToLower(h)
}

func proxyCookieName(integrationID string) string {
	return "cac_proxy_" + strings.ReplaceAll(integrationID, "-", "")
}

// proxyBasePath is the public prefix the tool is served under. Grafana must be
// configured with root_url = <this> and serve_from_sub_path = true so its own
// links and assets resolve.
func proxyBasePath(serverID, integrationID string) string {
	return "/api/v1/servers/" + serverID + "/integrations/" + integrationID + "/proxy"
}

// Launch mints a short-lived signed URL that opens the tool through cac's
// authenticated proxy. JWT-authenticated (viewer+): the caller must be able to
// see the server's org.
func (h *integrationHandler) Launch(w http.ResponseWriter, r *http.Request) {
	server, ok := h.serverScope(w, r, domain.OrgRoleViewer)
	if !ok {
		return
	}
	it, ok := h.ownedIntegration(w, r, server)
	if !ok {
		return
	}
	user, _ := currentUser(r)

	host := ProxyHost()
	if host == "" {
		SendErrorResponse(w, http.StatusServiceUnavailable, "Integration proxy is off", "proxy-off")
		return
	}
	token := repository.SignProxyToken(it.ID, user.Username, time.Now().Add(launchTTL).Unix())
	path := proxyBasePath(server.ID, it.ID) + "/?" + proxyQueryParam + "=" + url.QueryEscape(token)

	// `url` es la dirección completa, en el dominio del proxy. `path` se deja
	// para las apps anteriores, que lo pegaban al dominio de cac: ahí el proxy
	// ya no contesta, así que en ellas el botón deja de funcionar en vez de
	// abrir la herramienta en el origen de cac.
	SendResult(w, http.StatusOK, domain.APIResponse[map[string]string]{
		Success: true,
		Data:    map[string]string{"path": path, "url": "https://" + host + path},
	})
}

// Proxy reverse-proxies the registered tool, authenticating the caller as the
// cac user via Grafana-style auth.proxy headers.
//
// Auth: a `__cac` launch token (exchanged for a session cookie, so navigations
// and asset requests keep working) or an existing cookie. It lives OUTSIDE the
// JWT middleware because a browser can't attach Authorization to navigations.
//
// Only the integration's registered URL is ever reached (anti-SSRF: no
// client-controlled destination), and inbound identity headers are stripped so a
// caller can't impersonate another user.
func (h *integrationHandler) Proxy(w http.ResponseWriter, r *http.Request) {
	// Sólo en su dominio. En cac.guz-studio.dev el proxy no existe: ahí vive la
	// versión web con la sesión en el navegador (ver ProxyHost).
	if host := ProxyHost(); host == "" || requestHost(r) != host {
		http.NotFound(w, r)
		return
	}
	serverID := chi.URLParam(r, "id")
	iid := chi.URLParam(r, "iid")

	it, err := h.svc.Find(iid)
	if err != nil || it.ServerID != serverID {
		http.NotFound(w, r)
		return
	}

	cookieName := proxyCookieName(it.ID)

	// Exchange a fresh launch token for a session cookie, then redirect to the
	// same path without the token (keeps it out of history/logs).
	if token := r.URL.Query().Get(proxyQueryParam); token != "" {
		username, ok := repository.ParseProxyToken(it.ID, token)
		if !ok {
			http.Error(w, "invalid or expired launch token", http.StatusUnauthorized)
			return
		}
		session := repository.SignProxyToken(it.ID, username, time.Now().Add(proxySessionTTL).Unix())
		http.SetCookie(w, &http.Cookie{
			Name:     cookieName,
			Value:    session,
			Path:     proxyBasePath(serverID, it.ID),
			HttpOnly: true,
			Secure:   r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
			SameSite: http.SameSiteLaxMode,
			Expires:  time.Now().Add(proxySessionTTL),
		})
		clean := *r.URL
		q := clean.Query()
		q.Del(proxyQueryParam)
		clean.RawQuery = q.Encode()
		http.Redirect(w, r, clean.RequestURI(), http.StatusFound)
		return
	}

	c, err := r.Cookie(cookieName)
	if err != nil {
		http.Error(w, "not authenticated for this integration", http.StatusUnauthorized)
		return
	}
	username, ok := repository.ParseProxyToken(it.ID, c.Value)
	if !ok {
		http.Error(w, "session expired — reopen from cac", http.StatusUnauthorized)
		return
	}

	target, err := url.Parse(it.URL)
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") {
		http.Error(w, "integration URL is not proxyable", http.StatusBadRequest)
		return
	}

	base := proxyBasePath(serverID, it.ID)
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			// Strip our prefix so the tool sees its own paths.
			pr.Out.URL.Path = strings.TrimPrefix(pr.In.URL.Path, base)
			if pr.Out.URL.Path == "" {
				pr.Out.URL.Path = "/"
			}
			pr.Out.Host = target.Host

			// Never forward client-supplied identity/auth material.
			for _, k := range []string{
				"Authorization", "Cookie", "X-WEBAUTH-USER", "X-WEBAUTH-NAME",
				"X-WEBAUTH-EMAIL", "X-WEBAUTH-ROLE", "X-Grafana-User",
			} {
				pr.Out.Header.Del(k)
			}
			// Authenticate as the cac user (Grafana auth.proxy).
			pr.Out.Header.Set("X-WEBAUTH-USER", username)
			pr.SetXForwarded()
		},
		// Lo que la herramienta no puede decidir por cac: registrar un service
		// worker con alcance más amplio que su ruta, ni que el navegador adivine
		// el tipo de lo que manda.
		ModifyResponse: func(resp *http.Response) error {
			resp.Header.Del("Service-Worker-Allowed")
			resp.Header.Set("X-Content-Type-Options", "nosniff")
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			lg.Warn("integration proxy upstream error: " + err.Error())
			http.Error(w, "integration unreachable", http.StatusBadGateway)
		},
	}
	rp.ServeHTTP(w, r)
}
