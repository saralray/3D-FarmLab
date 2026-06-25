package main

import (
	"context"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"printfarm/internal/pwcrypto"
)

// auth.go ports the server-side session + RBAC layer from server/app.js: cookie
// parsing, session resolution, the default-deny authorization gate
// (authorizeFrontendApi / classifyApiRequest), and the CSRF same-origin check.

const (
	sessionCookie        = "pf_session"
	sessionTTL           = 8 * time.Hour
	sessionRememberTTL   = 30 * 24 * time.Hour
	publicViewerRedirect = "/"
)

func parseCookies(req *http.Request) map[string]string {
	out := map[string]string{}
	header := req.Header.Get("Cookie")
	if header == "" {
		return out
	}
	for _, part := range strings.Split(header, ";") {
		eq := strings.IndexByte(part, '=')
		if eq == -1 {
			continue
		}
		key := strings.TrimSpace(part[:eq])
		if key == "" {
			continue
		}
		val := strings.TrimSpace(part[eq+1:])
		if dec, err := url.QueryUnescape(val); err == nil {
			val = dec
		}
		out[key] = val
	}
	return out
}

// resolveSession resolves the current session from the cookie (or nil). Redis
// session caching is omitted (disabled deployment); the Node server falls back to
// the same Postgres lookup when Redis is off, so behavior is identical.
func resolveSession(ctx context.Context, req *http.Request) (*sessionRow, error) {
	token := parseCookies(req)[sessionCookie]
	if token == "" {
		return nil, nil
	}
	return getSession(ctx, pwcrypto.Hash(token))
}

func isPrivilegedRole(role string) bool {
	return role == "admin" || role == "operator"
}

// ── Cookie issuing ───────────────────────────────────────────────────────────

func sessionCookieIsSecure(req *http.Request) bool {
	return req.Header.Get("X-Forwarded-Proto") == "https" ||
		os.Getenv("SESSION_COOKIE_SECURE") == "true"
}

func buildSessionCookie(req *http.Request, value string, maxAgeSeconds int) string {
	attrs := []string{
		sessionCookie + "=" + value,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		"Max-Age=" + itoa(maxAgeSeconds),
	}
	if sessionCookieIsSecure(req) {
		attrs = append(attrs, "Secure")
	}
	return strings.Join(attrs, "; ")
}

type sessionUser struct {
	ID       string
	Name     string
	Username string
	Role     string
}

func issueSession(ctx context.Context, w http.ResponseWriter, req *http.Request, user sessionUser, remember bool) error {
	token, err := randomBase64URL(32)
	if err != nil {
		return err
	}
	ttl := sessionTTL
	if remember {
		ttl = sessionRememberTTL
	}
	ip := getClientIP(req)
	if err := createSession(ctx, pwcrypto.Hash(token), user.ID, user.Username, user.Name, user.Role,
		time.Now().Add(ttl), ip); err != nil {
		return err
	}
	w.Header().Set("Set-Cookie", buildSessionCookie(req, token, int(ttl/time.Second)))
	return nil
}

func clearSessionCookie(w http.ResponseWriter, req *http.Request) {
	w.Header().Set("Set-Cookie", buildSessionCookie(req, "", 0))
}

func getClientIP(req *http.Request) *string {
	if fwd := req.Header.Get("X-Forwarded-For"); strings.TrimSpace(fwd) != "" {
		ip := strings.TrimSpace(strings.Split(fwd, ",")[0])
		return &ip
	}
	if req.RemoteAddr != "" {
		host := req.RemoteAddr
		if i := strings.LastIndexByte(host, ':'); i != -1 {
			host = host[:i]
		}
		return &host
	}
	return nil
}

// ── Authorization matrix (classifyApiRequest) ────────────────────────────────

var publicAPIMutations = map[string]bool{
	"POST /api/auth/login":              true,
	"POST /api/auth/logout":             true,
	"POST /api/auth/verify":             true,
	"POST /api/auth/saml/acs":           true,
	"POST /api/slicer-grant/verify":     true,
	"POST /api/admin/credential/verify": true,
	"POST /api/users/verify":            true,
	"POST /api/manager/request":         true,
	"POST /api/queue/submit":            true,
}

func isSensitiveRead(pathname string) bool {
	switch {
	case pathname == "/api/users" || (strings.HasPrefix(pathname, "/api/users/") && pathname != "/api/users/verify"):
		return true
	case pathname == "/api/slicer-keys" || strings.HasPrefix(pathname, "/api/slicer-keys/"):
		return true
	case pathname == "/api/audit-logs":
		return true
	case strings.HasPrefix(pathname, "/api/notifications/"):
		return true
	case pathname == "/api/manager/requests":
		return true
	case strings.HasPrefix(pathname, "/api/manager/requests/") && !strings.HasSuffix(pathname, "/status"):
		return true
	case pathname == "/api/settings/saml":
		return true
	case strings.HasPrefix(pathname, "/api/settings/home-assistant"):
		return true
	}
	return false
}

func isAdminMutation(method, pathname string) bool {
	switch {
	case pathname == "/api/users" && method == http.MethodPost:
		return true
	case strings.HasPrefix(pathname, "/api/users/") && pathname != "/api/users/verify":
		return true
	case pathname == "/api/slicer-keys" && method == http.MethodPost:
		return true
	case strings.HasPrefix(pathname, "/api/slicer-keys/") && method == http.MethodDelete:
		return true
	case pathname == "/api/admin/credential" && method == http.MethodPut:
		return true
	case strings.HasPrefix(pathname, "/api/notifications/"):
		return true
	case pathname == "/api/settings/saml" || pathname == "/api/settings/saml/test":
		return true
	case strings.HasPrefix(pathname, "/api/settings/") && method != http.MethodGet:
		return true
	case pathname == "/api/analytics/daily/reset":
		return true
	case pathname == "/api/queue/reset":
		return true
	case strings.HasPrefix(pathname, "/api/queue/") && method == http.MethodDelete:
		return true
	case strings.HasPrefix(pathname, "/api/printers/") && method == http.MethodDelete:
		return true
	case strings.HasPrefix(pathname, "/api/manager/requests/") && !strings.HasSuffix(pathname, "/status"):
		return true
	}
	return false
}

func isOperatorMutation(method, pathname string) bool {
	switch {
	case pathname == "/api/printers" && method == http.MethodPost:
		return true
	case strings.HasPrefix(pathname, "/api/printers/") && strings.HasSuffix(pathname, "/command") && method == http.MethodPost:
		return true
	case strings.HasPrefix(pathname, "/api/queue/") && strings.HasSuffix(pathname, "/printed") && method == http.MethodPost:
		return true
	case pathname == "/api/queue" && method == http.MethodPost:
		return true
	case strings.HasPrefix(pathname, "/api/maintenance/") && strings.HasSuffix(pathname, "/complete") && method == http.MethodPost:
		return true
	case pathname == "/api/maintenance/notifications/read" && method == http.MethodPost:
		return true
	}
	return false
}

// classifyApiRequest returns the access class: public | authed | operator | admin.
func classifyApiRequest(method, pathname string) string {
	if method == http.MethodOptions {
		return "public"
	}
	if method == http.MethodGet || method == http.MethodHead {
		if isSensitiveRead(pathname) {
			return "admin"
		}
		return "public"
	}
	if publicAPIMutations[method+" "+pathname] {
		return "public"
	}
	if method == http.MethodPost && pathname == "/api/admin/credential" {
		return "public"
	}
	if pathname == "/api/audit-logs" && method == http.MethodPost {
		return "authed"
	}
	if pathname == "/api/auth/slicer-token" && (method == http.MethodPost || method == http.MethodDelete) {
		return "authed"
	}
	if isOperatorMutation(method, pathname) {
		return "operator"
	}
	if isAdminMutation(method, pathname) {
		return "admin"
	}
	return "admin"
}

// isSameOriginWrite mirrors the CSRF check: a state-changing request must come
// from our own host (or carry no browser origin context at all).
func isSameOriginWrite(req *http.Request) bool {
	source := req.Header.Get("Origin")
	if source == "" {
		source = req.Header.Get("Referer")
	}
	if source == "" {
		return true
	}
	u, err := url.Parse(source)
	if err != nil || u.Hostname() == "" {
		return false
	}
	sourceHost := strings.ToLower(u.Hostname())
	allowed := map[string]bool{}
	stripPort := func(h string) string {
		return strings.ToLower(strings.TrimSpace(strings.Split(h, ":")[0]))
	}
	if req.Host != "" {
		allowed[stripPort(req.Host)] = true
	}
	if fwd := req.Header.Get("X-Forwarded-Host"); fwd != "" {
		for _, h := range strings.Split(fwd, ",") {
			allowed[stripPort(h)] = true
		}
	}
	return allowed[sourceHost]
}

// authorizeFrontendApi enforces classifyApiRequest. On denial it writes the
// response and returns false. sessFn lazily resolves (and memoizes) the session.
func authorizeFrontendApi(w http.ResponseWriter, req *http.Request, sessFn func() *sessionRow) bool {
	pathname := req.URL.Path
	if !strings.HasPrefix(pathname, "/api/") || pathname == "/api/v1" || strings.HasPrefix(pathname, "/api/v1/") {
		return true
	}
	klass := classifyApiRequest(req.Method, pathname)
	if klass == "public" {
		return true
	}
	method := strings.ToUpper(req.Method)
	if method != http.MethodGet && method != http.MethodHead && !isSameOriginWrite(req) {
		sendJSON(w, http.StatusForbidden, map[string]any{"error": "Cross-origin request blocked."}, "")
		return false
	}
	session := sessFn()
	if session == nil {
		sendJSON(w, http.StatusUnauthorized, map[string]any{"error": "Authentication required."}, "")
		return false
	}
	if klass == "admin" && session.Role != "admin" {
		sendJSON(w, http.StatusForbidden, map[string]any{"error": "Administrator access required."}, "")
		return false
	}
	if klass == "operator" && !isPrivilegedRole(session.Role) {
		sendJSON(w, http.StatusForbidden, map[string]any{"error": "Operator access required."}, "")
		return false
	}
	return true
}
