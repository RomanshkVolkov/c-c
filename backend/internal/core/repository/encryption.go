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

// ─── JWT ──────────────────────────────────────────────────────────────────────

func generateToken(claims jwt.Claims, secret []byte) (string, error) {
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(secret)
}

func GenerateTokens(userID, username string, orgs []domain.OrgMembershipClaim) (*domain.TokenPair, error) {
	tokenID := uuid.NewString()

	accessClaims := &domain.ClaimsJWT{
		UserID:   userID,
		Username: username,
		Orgs:     orgs,
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
