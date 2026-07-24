package repository

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/guz-studio/cac/backend/internal/core/domain"
	"golang.org/x/crypto/scrypt"
	"golang.org/x/text/unicode/norm"
)

var (
	accessExpiry, _  = time.ParseDuration("60m")
	refreshExpiry, _ = time.ParseDuration("168h")
)

// ─── Scrypt params (compatible with Better Auth) ──────────────────────────────

const (
	scryptN      = 16384
	scryptR      = 16
	scryptP      = 1
	scryptKeyLen = 64
	scryptSalt   = 16
)

func generateSalt(saltSize int) ([]byte, error) {
	salt := make([]byte, saltSize)
	if _, err := rand.Read(salt); err != nil {
		return nil, fmt.Errorf("failed to generate salt: %w", err)
	}
	return salt, nil
}

func generateKey(password, saltHex string) ([]byte, error) {
	normalized := norm.NFKC.String(password)
	key, err := scrypt.Key([]byte(normalized), []byte(saltHex), scryptN, scryptR, scryptP, scryptKeyLen)
	if err != nil {
		return nil, fmt.Errorf("failed to derive key: %w", err)
	}
	return key, nil
}

func HashPassword(password string) (string, error) {
	if password == "" {
		return "", fmt.Errorf("password cannot be empty")
	}
	saltBytes, err := generateSalt(scryptSalt)
	if err != nil {
		return "", err
	}
	saltHex := hex.EncodeToString(saltBytes)
	key, err := generateKey(password, saltHex)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s:%s", saltHex, hex.EncodeToString(key)), nil
}

func CompareHash(password, encodedHash string) (bool, error) {
	if password == "" || encodedHash == "" {
		return false, fmt.Errorf("password and hash cannot be empty")
	}
	parts := splitHash(encodedHash)
	if len(parts) != 2 {
		return false, fmt.Errorf("invalid hash format")
	}
	storedKey, err := hex.DecodeString(parts[1])
	if err != nil {
		return false, fmt.Errorf("failed to decode stored key: %w", err)
	}
	calculatedKey, err := generateKey(password, parts[0])
	if err != nil {
		return false, err
	}
	return subtle.ConstantTimeCompare(calculatedKey, storedKey) == 1, nil
}

func splitHash(s string) []string {
	idx := findColon(s)
	if idx < 0 {
		return nil
	}
	return []string{s[:idx], s[idx+1:]}
}

func findColon(s string) int {
	for i, c := range s {
		if c == ':' {
			return i
		}
	}
	return -1
}

// ─── Ingest keys ──────────────────────────────────────────────────────────────
//
// The public write-only key handed to the widget (Sentry-DSN model). Only its
// HMAC is stored; the plaintext is shown to the admin exactly once. Verification
// HMACs the presented key and constant-time compares — a DB leak never yields
// usable keys.

func ingestSecret() []byte {
	return []byte(GetEnv("INGEST_KEY_SECRET", "change-me-ingest-hmac-secret"))
}

// HashIngestKey returns the HMAC-SHA256 of a plaintext ingest key.
func HashIngestKey(plain string) []byte {
	mac := hmac.New(sha256.New, ingestSecret())
	mac.Write([]byte(plain))
	return mac.Sum(nil)
}

// GenerateIngestKey mints a random `pk_…` key and returns (plaintext, hash).
func GenerateIngestKey() (string, []byte, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, fmt.Errorf("failed to generate ingest key: %w", err)
	}
	plain := "pk_" + base64.RawURLEncoding.EncodeToString(raw)
	return plain, HashIngestKey(plain), nil
}

// IngestKeyMatches constant-time compares a presented key against a stored hash.
func IngestKeyMatches(plain string, hash []byte) bool {
	return subtle.ConstantTimeCompare(HashIngestKey(plain), hash) == 1
}

// ─── Personal access tokens (read-only API/MCP access) ────────────────────────

// PATPrefix marks a token as a personal access token so the auth middleware can
// route it to the PAT path instead of JWT validation.
const PATPrefix = "cac_pat_"

// HashPAT returns the HMAC-SHA256 of a plaintext token. Only the hash is stored,
// so a DB leak never exposes usable tokens.
func HashPAT(plain string) []byte {
	mac := hmac.New(sha256.New, ingestSecret())
	mac.Write([]byte("pat:" + plain))
	return mac.Sum(nil)
}

// GeneratePAT mints a random `cac_pat_…` token and returns (plaintext, hash).
func GeneratePAT() (string, []byte, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, fmt.Errorf("failed to generate token: %w", err)
	}
	plain := PATPrefix + base64.RawURLEncoding.EncodeToString(raw)
	return plain, HashPAT(plain), nil
}

// ─── Signed image URLs ────────────────────────────────────────────────────────
//
// The Tauri webview can't attach an Authorization header to <img> tags, so the
// backend emits short-lived HMAC-signed URLs (?exp=&sig=). The image proxy
// accepts either a valid signature or a JWT. Signature binds reportID+imageID+exp.

func imageURLSecret() []byte {
	return []byte(GetEnv("IMAGE_URL_SECRET", GetEnv("JWT_SECRET_ACCESS", "change-me-access-secret")))
}

// SignImage returns the hex HMAC for a (reportID, imageID, expUnix) triple.
func SignImage(reportID, imageID string, expUnix int64) string {
	mac := hmac.New(sha256.New, imageURLSecret())
	fmt.Fprintf(mac, "%s:%s:%d", reportID, imageID, expUnix)
	return hex.EncodeToString(mac.Sum(nil))
}

// VerifyImageSig checks the signature and that it hasn't expired.
func VerifyImageSig(reportID, imageID string, expUnix int64, sig string) bool {
	if time.Now().Unix() > expUnix {
		return false
	}
	want := SignImage(reportID, imageID, expUnix)
	return subtle.ConstantTimeCompare([]byte(want), []byte(sig)) == 1
}

// ─── Integration proxy tokens ─────────────────────────────────────────────────
//
// The hub proxies a tool (e.g. Grafana) on behalf of the signed-in cac user. A
// browser/webview can't attach the JWT to navigations and asset requests, so the
// launcher mints a short-lived signed token that the proxy exchanges for a
// session cookie. Binds integration + username + expiry.

// SignProxyToken returns "<b64user>.<exp>.<hmac>". The username travels inside
// the token (the proxy learns who the caller is from it) and is covered by the
// signature, so it can't be swapped.
func SignProxyToken(integrationID, username string, expUnix int64) string {
	u := base64.RawURLEncoding.EncodeToString([]byte(username))
	mac := hmac.New(sha256.New, imageURLSecret())
	fmt.Fprintf(mac, "proxy:%s:%s:%d", integrationID, username, expUnix)
	return fmt.Sprintf("%s.%d.%s", u, expUnix, hex.EncodeToString(mac.Sum(nil)))
}

// ParseProxyToken validates a token for integrationID and returns the username
// it carries. ok is false when malformed, expired or tampered with.
func ParseProxyToken(integrationID, token string) (string, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", false
	}
	expUnix, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || time.Now().Unix() > expUnix {
		return "", false
	}
	username := string(raw)
	want := SignProxyToken(integrationID, username, expUnix)
	if subtle.ConstantTimeCompare([]byte(want), []byte(token)) != 1 {
		return "", false
	}
	return username, true
}

// ─── Telemetry encryption (AES-GCM with KEK) ──────────────────────────────────
//
// Report telemetry/snapshot blobs can contain end-user PII, so they're encrypted
// at rest with a KEK (env REPORTS_KEK, base64 of 32 bytes) — same pattern
// image-service uses for its storage creds. No KEK → telemetry isn't stored.

func reportsKEK() ([]byte, bool) {
	raw := GetEnv("REPORTS_KEK", "")
	if raw == "" {
		return nil, false
	}
	key, err := base64.StdEncoding.DecodeString(raw)
	if err != nil || len(key) != 32 {
		return nil, false
	}
	return key, true
}

// TelemetryEncryptionEnabled reports whether a valid KEK is configured.
func TelemetryEncryptionEnabled() bool {
	_, ok := reportsKEK()
	return ok
}

// EncryptTelemetry seals plaintext with AES-256-GCM; the 12-byte nonce is
// prepended to the ciphertext.
func EncryptTelemetry(plaintext []byte) ([]byte, error) {
	key, ok := reportsKEK()
	if !ok {
		return nil, errors.New("REPORTS_KEK not configured")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, plaintext, nil), nil
}

// DecryptTelemetry reverses EncryptTelemetry.
func DecryptTelemetry(ciphertext []byte) ([]byte, error) {
	key, ok := reportsKEK()
	if !ok {
		return nil, errors.New("REPORTS_KEK not configured")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(ciphertext) < gcm.NonceSize() {
		return nil, errors.New("ciphertext too short")
	}
	nonce, ct := ciphertext[:gcm.NonceSize()], ciphertext[gcm.NonceSize():]
	return gcm.Open(nil, nonce, ct, nil)
}

var (
	reJWT    = regexp.MustCompile(`eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`)
	reBearer = regexp.MustCompile(`(?i)Bearer\s+[A-Za-z0-9._-]+`)
	reEmail  = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)
)

// RedactSensitive re-applies token/email redaction server-side (defense in depth;
// the SDK already scrubs before sending).
func RedactSensitive(s string) string {
	s = reJWT.ReplaceAllString(s, "[jwt]")
	s = reBearer.ReplaceAllString(s, "Bearer [redacted]")
	s = reEmail.ReplaceAllString(s, "[email]")
	return s
}

// ─── Reporter report tokens ───────────────────────────────────────────────────
//
// Issued at ingest time, bound to a single report (HMAC of reportID+exp). The
// widget stores them so a reporter can follow up on what THEY filed — no email,
// no login. Scoped per-report → no IDOR (you only see reports you have a token
// for). Token wire format: "<expUnix>.<hexsig>".

func reportTokenSecret() []byte {
	return []byte(GetEnv("REPORT_TOKEN_SECRET", GetEnv("JWT_SECRET_ACCESS", "change-me-access-secret")))
}

const reportTokenTTL = 90 * 24 * time.Hour

func signReportToken(reportID string, expUnix int64) string {
	mac := hmac.New(sha256.New, reportTokenSecret())
	fmt.Fprintf(mac, "%s:%d", reportID, expUnix)
	return hex.EncodeToString(mac.Sum(nil))
}

// MintReportToken issues a fresh reporter token for a report.
func MintReportToken(reportID string) string {
	exp := time.Now().Add(reportTokenTTL).Unix()
	return fmt.Sprintf("%d.%s", exp, signReportToken(reportID, exp))
}

// VerifyReportToken checks a "<exp>.<sig>" token against a report id.
func VerifyReportToken(reportID, token string) bool {
	dot := -1
	for i, c := range token {
		if c == '.' {
			dot = i
			break
		}
	}
	if dot < 0 {
		return false
	}
	expStr, sig := token[:dot], token[dot+1:]
	var exp int64
	if _, err := fmt.Sscanf(expStr, "%d", &exp); err != nil {
		return false
	}
	if time.Now().Unix() > exp {
		return false
	}
	want := signReportToken(reportID, exp)
	return subtle.ConstantTimeCompare([]byte(want), []byte(sig)) == 1
}

// ─── JWT ──────────────────────────────────────────────────────────────────────

func generateToken(claims jwt.Claims, secret []byte) (string, error) {
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(secret)
}

func GenerateTokens(userID, username string, superadmin bool, orgs []domain.OrgMembershipClaim) (*domain.TokenPair, error) {
	tokenID := uuid.NewString()

	accessClaims := &domain.ClaimsJWT{
		UserID:     userID,
		Username:   username,
		Superadmin: superadmin,
		Orgs:       orgs,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(accessExpiry)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Subject:   userID,
		},
	}

	refreshClaims := &domain.ClaimsRefresh{
		TokenID: tokenID,
		UserID:  userID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(refreshExpiry)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Subject:   userID,
		},
	}

	secretAccess := []byte(GetEnv("JWT_SECRET_ACCESS", "change-me-access-secret"))
	secretRefresh := []byte(GetEnv("JWT_SECRET_REFRESH", "change-me-refresh-secret"))

	accessToken, err := generateToken(accessClaims, secretAccess)
	if err != nil {
		return nil, errors.New("error generating access token")
	}

	refreshToken, err := generateToken(refreshClaims, secretRefresh)
	if err != nil {
		return nil, errors.New("error generating refresh token")
	}

	return &domain.TokenPair{AccessToken: accessToken, RefreshToken: refreshToken}, nil
}

func ValidateAccessToken(encodedToken string) (*domain.ClaimsJWT, error) {
	var claims domain.ClaimsJWT
	token, err := jwt.ParseWithClaims(encodedToken, &claims, func(t *jwt.Token) (any, error) {
		return []byte(GetEnv("JWT_SECRET_ACCESS", "change-me-access-secret")), nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))

	if err != nil || !token.Valid {
		return nil, errors.New("expired-token")
	}
	return &claims, nil
}

func ValidateRefreshToken(encodedToken string) (*domain.ClaimsRefresh, error) {
	var claims domain.ClaimsRefresh
	token, err := jwt.ParseWithClaims(encodedToken, &claims, func(t *jwt.Token) (any, error) {
		return []byte(GetEnv("JWT_SECRET_REFRESH", "change-me-refresh-secret")), nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))

	if err != nil || !token.Valid {
		return nil, errors.New("close-session")
	}
	return &claims, nil
}
