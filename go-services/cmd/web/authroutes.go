package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"printfarm/internal/pwcrypto"
)

// authroutes.go ports the cookie-authenticated auth endpoints from server/app.js:
// providers, session (me), login, logout, and the admin-credential / verify
// surface. Mutating user/credential management beyond first-run + change lands in
// phase 4.

const (
	adminCredentialKey = "admin_credential"
	reservedUsername   = "admin"
	maxBodyBytes       = 1024 * 1024
)

// readJSONBody decodes the request body into dst, capped at maxBodyBytes. An empty
// body leaves dst at its zero value (matching readJsonBody's {} default).
func readJSONBody(req *http.Request, dst any) error {
	body, err := io.ReadAll(io.LimitReader(req.Body, maxBodyBytes))
	if err != nil {
		return err
	}
	if len(body) == 0 {
		return nil
	}
	return json.Unmarshal(body, dst)
}

// handleAuthRoutes dispatches the auth surface; returns true once handled.
func handleAuthRoutes(w http.ResponseWriter, req *http.Request, sessFn func() *sessionRow) bool {
	ctx := req.Context()
	p := req.URL.Path

	switch {
	case p == "/api/auth/providers" && req.Method == http.MethodGet:
		sendJSON(w, http.StatusOK, authProviders(ctx), "")
		return true

	case p == "/api/auth/session" && req.Method == http.MethodGet:
		sendJSON(w, http.StatusOK, sessionUserPayload(sessFn()), "no-store")
		return true

	case p == "/api/auth/login" && req.Method == http.MethodPost:
		handleLogin(ctx, w, req)
		return true

	case p == "/api/auth/logout" && req.Method == http.MethodPost:
		handleLogout(ctx, w, req)
		return true

	case p == "/api/admin/credential":
		handleAdminCredential(ctx, w, req)
		return true

	case p == "/api/admin/credential/verify" && req.Method == http.MethodPost:
		handleAdminCredentialVerify(ctx, w, req)
		return true

	case p == "/api/users/verify" && req.Method == http.MethodPost:
		handleUsersVerify(ctx, w, req)
		return true
	}
	return false
}

// ── /api/auth/providers ──────────────────────────────────────────────────────

func authProviders(ctx context.Context) map[string]any {
	adfs, _ := getOAuthConfig(ctx, "adfs")
	return map[string]any{
		"google":    oauthConfigured(ctx, "oauth_google", false),
		"microsoft": oauthConfigured(ctx, "oauth_microsoft", true),
		"adfs":      isOAuthConfigured(adfs),
		"saml":      samlConfigured(ctx),
	}
}

func oauthConfigured(ctx context.Context, key string, usesTenant bool) bool {
	raw, err := getAppSetting(ctx, key)
	if err != nil {
		return false
	}
	m := decodeStored(raw)
	enabled, _ := m["enabled"].(bool)
	clientID := strings.TrimSpace(storedString(m, "clientId"))
	clientSecret := storedString(m, "clientSecret")
	if !enabled || clientID == "" || clientSecret == "" {
		return false
	}
	if usesTenant {
		tenant := strings.TrimSpace(storedString(m, "tenant"))
		authority := strings.TrimSpace(storedString(m, "authority"))
		if tenant == "" && authority == "" {
			return false
		}
	}
	return true
}

func samlConfigured(ctx context.Context) bool {
	raw, err := getAppSetting(ctx, "saml_sso")
	if err != nil {
		return false
	}
	m := decodeStored(raw)
	enabled, _ := m["enabled"].(bool)
	return enabled && strings.TrimSpace(storedString(m, "idpSsoUrl")) != "" &&
		strings.TrimSpace(storedString(m, "idpCertificate")) != ""
}

// ── /api/auth/session ────────────────────────────────────────────────────────

// userPayload is the user object the auth endpoints emit; ordered struct fields
// reproduce Node's {id, name, username, role} key order (a Go map would sort).
type userPayload struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Username string `json:"username"`
	Role     string `json:"role"`
}

func sessionUserPayload(sess *sessionRow) map[string]any {
	if sess == nil {
		return map[string]any{"user": nil}
	}
	return map[string]any{"user": userPayload{
		ID: sess.UserID, Name: sess.Name, Username: sess.Username, Role: sess.Role,
	}}
}

// ── /api/auth/login ──────────────────────────────────────────────────────────

type loginBody struct {
	Username     string `json:"username"`
	PasswordHash string `json:"passwordHash"`
	Remember     bool   `json:"remember"`
}

func handleLogin(ctx context.Context, w http.ResponseWriter, req *http.Request) {
	rateKey := clientIPString(req)
	if rate := checkLoginRate(rateKey); !rate.allowed {
		w.Header().Set("Retry-After", itoa(int((rate.retryAfter+999*time.Millisecond)/time.Second)))
		sendJSON(w, http.StatusTooManyRequests, map[string]any{
			"error":        "Too many failed attempts. Please wait and try again.",
			"retryAfterMs": rate.retryAfter.Milliseconds(),
		}, "")
		return
	}

	var body loginBody
	if err := readJSONBody(req, &body); err != nil {
		recordLoginFailure(rateKey)
		sendJSON(w, http.StatusUnauthorized, map[string]any{"error": "Invalid credentials."}, "")
		return
	}
	username := strings.ToLower(strings.TrimSpace(body.Username))
	if username == "" || !pwcrypto.IsSha256Hex(body.PasswordHash) {
		recordLoginFailure(rateKey)
		sendJSON(w, http.StatusUnauthorized, map[string]any{"error": "Invalid credentials."}, "")
		return
	}

	var user *sessionUser
	if username == reservedUsername {
		storedHash := adminStoredHash(ctx)
		if storedHash != "" && pwcrypto.Verify(storedHash, body.PasswordHash) {
			user = &sessionUser{ID: "admin", Name: "Print Farm Admin", Username: "admin", Role: "admin"}
			if pwcrypto.NeedsUpgrade(storedHash) {
				if derived, err := pwcrypto.Derive(body.PasswordHash); err == nil {
					_ = setAppSetting(ctx, adminCredentialKey, map[string]any{"passwordHash": derived})
				}
			}
		}
	} else {
		users, _ := readStaffUsers(ctx)
		if found := findUserByCredential(users, username, body.PasswordHash); found != nil {
			user = &sessionUser{ID: found.ID, Name: found.Name, Username: found.Username, Role: found.Role}
			if pwcrypto.NeedsUpgrade(found.PasswordHash) {
				if derived, err := pwcrypto.Derive(body.PasswordHash); err == nil {
					upgradeStaffPassword(ctx, users, found.ID, derived)
				}
			}
		}
	}

	if user == nil {
		recordLoginFailure(rateKey)
		sendJSON(w, http.StatusUnauthorized, map[string]any{"error": "Invalid credentials."}, "")
		return
	}

	clearLoginAttempts(rateKey)
	if err := issueSession(ctx, w, req, *user, body.Remember); err != nil {
		logError("login: issueSession failed", map[string]any{"err": err.Error()})
		sendJSON(w, http.StatusInternalServerError, map[string]any{"error": "Internal Server Error"}, "")
		return
	}
	_ = recordAuditLog(ctx, auditEntry{
		ActorName:     &user.Name,
		ActorUsername: &user.Username,
		ActorRole:     &user.Role,
		Action:        "auth.login",
		Source:        "web",
		IP:            getClientIP(req),
	})
	sendJSON(w, http.StatusOK, map[string]any{"user": userPayload{
		ID: user.ID, Name: user.Name, Username: user.Username, Role: user.Role,
	}}, "")
}

func adminStoredHash(ctx context.Context) string {
	raw, err := getAppSetting(ctx, adminCredentialKey)
	if err != nil {
		return ""
	}
	m := decodeStored(raw)
	return storedString(m, "passwordHash")
}

// findUserByCredential mirrors the async finder: first username match whose
// password verifies.
func findUserByCredential(users []staffUser, username, clientSha256 string) *staffUser {
	for i := range users {
		if users[i].Username == username && pwcrypto.Verify(users[i].PasswordHash, clientSha256) {
			return &users[i]
		}
	}
	return nil
}

func upgradeStaffPassword(ctx context.Context, users []staffUser, id, derived string) {
	next := make([]map[string]any, 0, len(users))
	for _, u := range users {
		ph := u.PasswordHash
		if u.ID == id {
			ph = derived
		}
		next = append(next, map[string]any{
			"id": u.ID, "name": u.Name, "username": u.Username, "role": u.Role, "passwordHash": ph,
		})
	}
	_ = setAppSetting(ctx, "staff_users", next)
}

// ── /api/auth/logout ─────────────────────────────────────────────────────────

func handleLogout(ctx context.Context, w http.ResponseWriter, req *http.Request) {
	if token := parseCookies(req)[sessionCookie]; token != "" {
		_ = deleteSession(ctx, pwcrypto.Hash(token))
	}
	clearSessionCookie(w, req)
	sendEmpty(w, http.StatusNoContent)
}

// ── /api/admin/credential ────────────────────────────────────────────────────

type adminCredBody struct {
	PasswordHash        string `json:"passwordHash"`
	CurrentPasswordHash string `json:"currentPasswordHash"`
	NewPasswordHash     string `json:"newPasswordHash"`
}

func handleAdminCredential(ctx context.Context, w http.ResponseWriter, req *http.Request) {
	storedHash := adminStoredHash(ctx)
	configured := storedHash != ""

	switch req.Method {
	case http.MethodGet:
		sendJSON(w, http.StatusOK, map[string]any{"configured": configured}, "")
	case http.MethodPost:
		if configured {
			sendJSON(w, http.StatusConflict, map[string]any{"error": "Admin password is already configured"}, "")
			return
		}
		var body adminCredBody
		_ = readJSONBody(req, &body)
		if !pwcrypto.IsSha256Hex(body.PasswordHash) {
			sendJSON(w, http.StatusBadRequest, map[string]any{"error": "passwordHash must be a sha256 hex string"}, "")
			return
		}
		derived, err := pwcrypto.Derive(body.PasswordHash)
		if err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]any{"error": "Internal Server Error"}, "")
			return
		}
		if err := setAppSetting(ctx, adminCredentialKey, map[string]any{"passwordHash": derived}); err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]any{"error": "Internal Server Error"}, "")
			return
		}
		if err := issueSession(ctx, w, req, sessionUser{ID: "admin", Name: "Print Farm Admin", Username: "admin", Role: "admin"}, false); err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]any{"error": "Internal Server Error"}, "")
			return
		}
		sendEmpty(w, http.StatusCreated)
	case http.MethodPut:
		if !configured {
			sendJSON(w, http.StatusConflict, map[string]any{"error": "Admin password is not configured yet"}, "")
			return
		}
		var body adminCredBody
		_ = readJSONBody(req, &body)
		if !pwcrypto.IsSha256Hex(body.NewPasswordHash) {
			sendJSON(w, http.StatusBadRequest, map[string]any{"error": "newPasswordHash must be a sha256 hex string"}, "")
			return
		}
		if !pwcrypto.Verify(storedHash, body.CurrentPasswordHash) {
			sendJSON(w, http.StatusUnauthorized, map[string]any{"error": "Current password is incorrect"}, "")
			return
		}
		derived, err := pwcrypto.Derive(body.NewPasswordHash)
		if err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]any{"error": "Internal Server Error"}, "")
			return
		}
		if err := setAppSetting(ctx, adminCredentialKey, map[string]any{"passwordHash": derived}); err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]any{"error": "Internal Server Error"}, "")
			return
		}
		_ = deleteSessionsForUser(ctx, "admin")
		if err := issueSession(ctx, w, req, sessionUser{ID: "admin", Name: "Print Farm Admin", Username: "admin", Role: "admin"}, false); err != nil {
			sendJSON(w, http.StatusInternalServerError, map[string]any{"error": "Internal Server Error"}, "")
			return
		}
		sendEmpty(w, http.StatusNoContent)
	default:
		sendJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "Method not allowed."}, "")
	}
}

func handleAdminCredentialVerify(ctx context.Context, w http.ResponseWriter, req *http.Request) {
	storedHash := adminStoredHash(ctx)
	var body adminCredBody
	_ = readJSONBody(req, &body)
	valid := storedHash != "" && pwcrypto.Verify(storedHash, body.PasswordHash)
	status := http.StatusUnauthorized
	if valid {
		status = http.StatusOK
	}
	sendJSON(w, status, map[string]any{"valid": valid}, "")
}

func handleUsersVerify(ctx context.Context, w http.ResponseWriter, req *http.Request) {
	var body loginBody
	_ = readJSONBody(req, &body)
	username := strings.ToLower(strings.TrimSpace(body.Username))
	users, _ := readStaffUsers(ctx)
	var found *staffUser
	if pwcrypto.IsSha256Hex(body.PasswordHash) {
		found = findUserByCredential(users, username, body.PasswordHash)
	}
	if found == nil {
		sendJSON(w, http.StatusUnauthorized, map[string]any{"valid": false}, "")
		return
	}
	sendJSON(w, http.StatusOK, map[string]any{"valid": true, "user": userPayload{
		ID: found.ID, Name: found.Name, Username: found.Username, Role: found.Role,
	}}, "")
}

// ── In-memory login rate limiter (Redis path omitted; disabled deployment) ────

const (
	loginMaxFailures = 8
	loginWindow      = 15 * time.Minute
)

type loginAttempt struct {
	count   int
	resetAt time.Time
}

var (
	loginMu       sync.Mutex
	loginAttempts = map[string]*loginAttempt{}
)

type rateResult struct {
	allowed    bool
	retryAfter time.Duration
}

func checkLoginRate(key string) rateResult {
	loginMu.Lock()
	defer loginMu.Unlock()
	e := loginAttempts[key]
	now := time.Now()
	if e == nil || now.After(e.resetAt) {
		return rateResult{allowed: true}
	}
	if e.count >= loginMaxFailures {
		return rateResult{allowed: false, retryAfter: e.resetAt.Sub(now)}
	}
	return rateResult{allowed: true}
}

func recordLoginFailure(key string) {
	loginMu.Lock()
	defer loginMu.Unlock()
	e := loginAttempts[key]
	now := time.Now()
	if e == nil || now.After(e.resetAt) {
		loginAttempts[key] = &loginAttempt{count: 1, resetAt: now.Add(loginWindow)}
		return
	}
	e.count++
}

func clearLoginAttempts(key string) {
	loginMu.Lock()
	defer loginMu.Unlock()
	delete(loginAttempts, key)
}

func clientIPString(req *http.Request) string {
	if ip := getClientIP(req); ip != nil {
		return *ip
	}
	return "unknown"
}
