package main

import (
	"context"
	"crypto/hmac"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"printfarm/internal/pwcrypto"
)

// oauth.go ports the auth hand-off completers from server/app.js: the slicer
// operator-grant verify (slicerGrant.js), the session-bound slicer token mint /
// revoke, and the OAuth (Google / Microsoft Entra ID) Authorization-Code login
// dance. The SAML side and the shared HMAC grant/state helpers already live in
// sso.go; this file reuses ssoSign / signState / verifyState / mintAuthGrant.

const (
	oauthScope       = "openid email profile"
	oauthDefaultRole = "student"
)

// ── slicer operator grant (port of slicerGrant.js) ───────────────────────────

var (
	slicerGrantSecretOnce sync.Once
	slicerGrantSecretVal  string
)

// slicerGrantSecret reads SLICER_GRANT_SECRET once, trimmed. With no secret the
// feature fails closed (verification rejects everything), matching Node.
func slicerGrantSecret() string {
	slicerGrantSecretOnce.Do(func() {
		slicerGrantSecretVal = strings.TrimSpace(os.Getenv("SLICER_GRANT_SECRET"))
	})
	return slicerGrantSecretVal
}

// verifySlicerGrant returns the printer id when the signature is valid and the
// token has not expired; ok=false for anything else (no secret, malformed, bad
// signature, expired). Mirrors verifySlicerGrant in slicerGrant.js.
func verifySlicerGrant(token string) (string, bool) {
	secret := slicerGrantSecret()
	if secret == "" || token == "" {
		return "", false
	}
	sep := strings.IndexByte(token, '.')
	if sep == -1 {
		return "", false
	}
	payload, signature := token[:sep], token[sep+1:]
	expected := ssoSign(secret, payload)
	if len(signature) != len(expected) || !hmac.Equal([]byte(signature), []byte(expected)) {
		return "", false
	}
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return "", false
	}
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		return "", false
	}
	pid, pok := data["pid"].(string)
	exp, eok := data["exp"].(float64)
	if !pok || !eok {
		return "", false
	}
	if float64(time.Now().UnixMilli()) > exp {
		return "", false
	}
	return pid, true
}

// ── OAuth provider registry (port of OAUTH_PROVIDERS / getOAuthConfig) ────────

type oauthConfig struct {
	provider       string
	enabled        bool
	clientID       string
	clientSecret   string
	tenant         string
	authority      string
	allowedDomains []string
}

var oauthSettingsKeys = map[string]string{
	"google":    "oauth_google",
	"microsoft": "oauth_microsoft",
	"adfs":      "oauth_adfs",
}

func oauthUsesTenant(provider string) bool { return provider == "microsoft" }

// adfsCallbackPath is the fixed redirect_uri pre-registered with the ADFS IdP.
// All other providers use /api/auth/<provider>/callback.
const adfsCallbackPath = "/api/auth/oauth2_redirect"

// getOAuthConfig resolves a provider's stored config (nil for an unknown
// provider). allowedDomains are normalized (trim, lowercase, strip a leading @).
func getOAuthConfig(ctx context.Context, providerName string) (*oauthConfig, error) {
	key, ok := oauthSettingsKeys[providerName]
	if !ok {
		return nil, nil
	}
	raw, err := getAppSetting(ctx, key)
	if err != nil {
		return nil, err
	}
	m := decodeStored(raw)
	storedEnabled, _ := m["enabled"].(bool)
	cfg := &oauthConfig{
		provider:     providerName,
		enabled:      storedEnabled,
		clientID:     strings.TrimSpace(storedString(m, "clientId")),
		clientSecret: storedString(m, "clientSecret"),
		tenant:       strings.TrimSpace(storedString(m, "tenant")),
		authority:    strings.TrimSpace(storedString(m, "authority")),
	}
	if domains, ok := m["allowedDomains"].([]any); ok {
		for _, d := range domains {
			s, ok := d.(string)
			if !ok {
				continue
			}
			s = strings.TrimPrefix(strings.ToLower(strings.TrimSpace(s)), "@")
			if s != "" {
				cfg.allowedDomains = append(cfg.allowedDomains, s)
			}
		}
	}
	return cfg, nil
}

// isOAuthConfigured reports whether the flow can actually run: enabled, with a
// client id + secret, plus (for Microsoft) a tenant or AD FS authority, and
// (for ADFS) a non-empty authority URL.
func isOAuthConfigured(c *oauthConfig) bool {
	if c == nil || !c.enabled || c.clientID == "" || c.clientSecret == "" {
		return false
	}
	if oauthUsesTenant(c.provider) && c.tenant == "" && c.authority == "" {
		return false
	}
	if c.provider == "adfs" && c.authority == "" {
		return false
	}
	return true
}

func oauthAuthorizeEndpoint(c *oauthConfig) string {
	switch c.provider {
	case "google":
		return "https://accounts.google.com/o/oauth2/v2/auth"
	case "adfs":
		return strings.TrimRight(c.authority, "/") + "/oauth2/authorize"
	}
	if c.authority != "" {
		return strings.TrimRight(c.authority, "/") + "/oauth2/authorize"
	}
	tenant := c.tenant
	if tenant == "" {
		tenant = "common"
	}
	return "https://login.microsoftonline.com/" + encodeURIComponent(tenant) + "/oauth2/v2.0/authorize"
}

func oauthTokenEndpoint(c *oauthConfig) string {
	switch c.provider {
	case "google":
		return "https://oauth2.googleapis.com/token"
	case "adfs":
		return strings.TrimRight(c.authority, "/") + "/oauth2/token"
	}
	if c.authority != "" {
		return strings.TrimRight(c.authority, "/") + "/oauth2/token"
	}
	tenant := c.tenant
	if tenant == "" {
		tenant = "common"
	}
	return "https://login.microsoftonline.com/" + encodeURIComponent(tenant) + "/oauth2/v2.0/token"
}

// oauthClaimEmail pulls the user's email out of id_token claims: Google sets
// `email`, Microsoft / ADFS commonly carry it in `preferred_username`, `upn`,
// or `unique_name`.
func oauthClaimEmail(claims map[string]any) string {
	if claims == nil {
		return ""
	}
	for _, k := range []string{"email", "preferred_username", "upn", "unique_name"} {
		if s, ok := claims[k].(string); ok && strings.Contains(s, "@") {
			return strings.ToLower(s)
		}
	}
	return ""
}

// decodeJwtClaims decodes the (unverified) payload of a JWT — the id_token comes
// straight from the provider's token endpoint over TLS using our client secret,
// so its claims are trusted without re-verifying the signature.
func decodeJwtClaims(jwt string) map[string]any {
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil
	}
	var claims map[string]any
	if err := json.Unmarshal(raw, &claims); err != nil {
		return nil
	}
	return claims
}

func oauthRedirectURI(req *http.Request, providerName string) string {
	if providerName == "adfs" {
		return resolvePublicOrigin(req) + adfsCallbackPath
	}
	return resolvePublicOrigin(req) + "/api/auth/" + providerName + "/callback"
}

// ── routes ───────────────────────────────────────────────────────────────────

// handleOAuthRoutes covers /api/slicer-grant/verify, /api/auth/slicer-token, and
// the GET /api/auth/(google|microsoft)/(config|start|callback) login dance. The
// SAML routes are claimed earlier by handleSSORoutes; the provider match here
// excludes "saml" by construction.
func handleOAuthRoutes(ctx context.Context, w http.ResponseWriter, req *http.Request, sessFn func() *sessionRow) bool {
	p := req.URL.Path
	m := req.Method

	// POST /api/slicer-grant/verify — verify the HMAC grant, establish an operator
	// session (pause/resume/cancel), return the printer id.
	if p == "/api/slicer-grant/verify" && m == http.MethodPost {
		var body struct {
			Token string `json:"token"`
		}
		_ = readJSONBody(req, &body)
		pid, ok := verifySlicerGrant(body.Token)
		if !ok {
			sendJSON(w, http.StatusUnauthorized, map[string]any{"error": "Invalid or expired slicer grant"}, "")
			return true
		}
		if err := issueSession(ctx, w, req,
			sessionUser{ID: "slicer-operator", Name: "Slicer Operator", Username: "slicer-operator", Role: "operator"},
			false); err != nil {
			internalError(w, "issueSession", err)
			return true
		}
		sendJSON(w, http.StatusOK, map[string]any{"printerId": pid}, "")
		return true
	}

	// POST|DELETE /api/auth/slicer-token — mint / revoke a session-bound slicer key
	// (the cookie session backs an OctoPrint upload key). The gate has already
	// required a session (class 'authed'); the nil branch mirrors Node's dead path.
	if p == "/api/auth/slicer-token" {
		session := sessFn()
		if session == nil {
			sendJSON(w, http.StatusUnauthorized, map[string]any{"error": "Not signed in."}, "")
			return true
		}
		sessionTokenHash := pwcrypto.Hash(parseCookies(req)[sessionCookie])

		switch m {
		case http.MethodPost:
			// Re-mint is idempotent: drop any prior token for this session first.
			_ = deleteSlicerApiKeysBySession(ctx, sessionTokenHash)
			key, err := randomBase64URL(24)
			if err != nil {
				internalError(w, "randomBase64URL", err)
				return true
			}
			newID := uuid.NewString()
			if err := createSlicerApiKey(ctx, newID, "Slicer session ("+session.Username+")",
				pwcrypto.Hash(key), key[:8], []string{"slicer_upload"}, &sessionTokenHash); err != nil {
				internalError(w, "createSlicerApiKey", err)
				return true
			}
			sendJSON(w, http.StatusCreated, ojson{
				{"id", newID}, {"key", key}, {"permissions", []string{"slicer_upload"}},
			}, "")
			return true
		case http.MethodDelete:
			_ = deleteSlicerApiKeysBySession(ctx, sessionTokenHash)
			sendEmpty(w, http.StatusNoContent)
			return true
		default:
			sendJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "Method not allowed."}, "")
			return true
		}
	}

	// GET /api/auth/oauth2_redirect — ADFS fixed callback path (pre-registered
	// with the Satit-M Chula ADFS server as the redirect_uri).
	if p == adfsCallbackPath && m == http.MethodGet {
		handleOAuthProvider(ctx, w, req, "adfs", "callback")
		return true
	}

	// GET /api/auth/(google|microsoft|adfs)/(config|start|callback)
	if m == http.MethodGet && strings.HasPrefix(p, "/api/auth/") {
		rest := p[len("/api/auth/"):]
		if slash := strings.IndexByte(rest, '/'); slash > 0 {
			providerName, op := rest[:slash], rest[slash+1:]
			if (providerName == "google" || providerName == "microsoft" || providerName == "adfs") &&
				(op == "config" || op == "start" || op == "callback") {
				handleOAuthProvider(ctx, w, req, providerName, op)
				return true
			}
		}
	}

	return false
}

func handleOAuthProvider(ctx context.Context, w http.ResponseWriter, req *http.Request, providerName, op string) {
	cfg, err := getOAuthConfig(ctx, providerName)
	if err != nil {
		internalError(w, "getOAuthConfig", err)
		return
	}

	if op == "config" {
		sendJSON(w, http.StatusOK, map[string]any{"enabled": isOAuthConfigured(cfg)}, "")
		return
	}

	if !isOAuthConfigured(cfg) {
		sendRedirect(w, "/login?oauth_error=not_configured")
		return
	}
	secret, err := getOAuthSigningSecret(ctx)
	if err != nil {
		internalError(w, "getOAuthSigningSecret", err)
		return
	}

	if op == "start" {
		state := signState(secret, uuid.NewString(), providerName)
		// On-prem AD FS (authority set) only understands prompt=login; cloud
		// providers get the account chooser.
		// ADFS and on-prem AD FS only support prompt=login/none/consent —
		// they reject `select_account` with invalid_request.
		prompt := "select_account"
		if cfg.authority != "" || providerName == "adfs" {
			prompt = "login"
		}
		authorizeURL, perr := url.Parse(oauthAuthorizeEndpoint(cfg))
		if perr != nil {
			internalError(w, "parse authorize endpoint", perr)
			return
		}
		authorizeURL.RawQuery = orderedQuery([][2]string{
			{"client_id", cfg.clientID},
			{"redirect_uri", oauthRedirectURI(req, providerName)},
			{"response_type", "code"},
			{"scope", oauthScope},
			{"state", state},
			{"prompt", prompt},
		})
		sendRedirect(w, authorizeURL.String())
		return
	}

	// op == "callback"
	q := req.URL.Query()
	code := q.Get("code")
	stateData := verifyState(secret, q.Get("state"))
	if q.Get("error") != "" || code == "" || stateData == nil || stringOrEmpty(stateData["p"]) != providerName {
		sendRedirect(w, "/login?oauth_error=denied")
		return
	}

	idToken, ok := exchangeOAuthCode(cfg, providerName, code, req)
	if !ok {
		sendRedirect(w, "/login?oauth_error=exchange_failed")
		return
	}
	claims := decodeJwtClaims(idToken)
	email := oauthClaimEmail(claims)
	// Google sets email_verified; Microsoft omits it — only reject explicit false.
	if email == "" || claimBoolIsFalse(claims, "email_verified") {
		sendRedirect(w, "/login?oauth_error=unverified_email")
		return
	}
	if len(cfg.allowedDomains) > 0 {
		domain := email[strings.IndexByte(email, '@')+1:]
		if !containsString(cfg.allowedDomains, domain) {
			sendRedirect(w, "/login?oauth_error=domain_not_allowed")
			return
		}
	}
	sub := email
	if s, ok := claims["sub"].(string); ok {
		sub = s
	}
	name := email
	if n, ok := claims["name"].(string); ok && strings.TrimSpace(n) != "" {
		name = strings.TrimSpace(n)
	}
	grant := mintAuthGrant(secret, providerName, sub, email, name, oauthDefaultRole)
	sendRedirect(w, "/login?oauth_grant="+encodeURIComponent(grant))
}

// exchangeOAuthCode swaps the authorization code for tokens at the provider's
// token endpoint and returns the id_token. ok=false on any HTTP / decode error.
func exchangeOAuthCode(cfg *oauthConfig, providerName, code string, req *http.Request) (string, bool) {
	form := url.Values{
		"code":          {code},
		"client_id":     {cfg.clientID},
		"client_secret": {cfg.clientSecret},
		"redirect_uri":  {oauthRedirectURI(req, providerName)},
		"grant_type":    {"authorization_code"},
	}
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Post(oauthTokenEndpoint(cfg), "application/x-www-form-urlencoded",
		strings.NewReader(form.Encode()))
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", false
	}
	var tokens struct {
		IDToken string `json:"id_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tokens); err != nil {
		return "", false
	}
	return tokens.IDToken, true
}

// ── small helpers ─────────────────────────────────────────────────────────────

func stringOrEmpty(v any) string {
	s, _ := v.(string)
	return s
}

func claimBoolIsFalse(claims map[string]any, key string) bool {
	if claims == nil {
		return false
	}
	v, ok := claims[key].(bool)
	return ok && !v
}

func containsString(list []string, s string) bool {
	for _, item := range list {
		if item == s {
			return true
		}
	}
	return false
}

// orderedQuery builds a query string preserving the given param order (url.Values
// would sort keys), matching Node's URLSearchParams insertion order.
func orderedQuery(pairs [][2]string) string {
	var b strings.Builder
	for i, kv := range pairs {
		if i > 0 {
			b.WriteByte('&')
		}
		b.WriteString(url.QueryEscape(kv[0]))
		b.WriteByte('=')
		b.WriteString(url.QueryEscape(kv[1]))
	}
	return b.String()
}
