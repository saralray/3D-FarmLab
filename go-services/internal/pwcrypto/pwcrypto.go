// Package pwcrypto ports the server-side credential KDF from server/app.js. The
// browser sends a sha256 of the password; the server runs that through a slow,
// salted scrypt KDF before storing it as a self-describing string:
//
//	scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>
//
// Pre-KDF records are a bare 64-char sha256 hex; Verify accepts both and the
// login path lazily re-stores legacy records in the scrypt format on the next
// successful sign-in. Parameters and wire format match the Node implementation
// exactly, so the same app_settings/staff_users rows verify under either runtime.
package pwcrypto

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/crypto/scrypt"
)

const (
	scryptN      = 16384
	scryptR      = 8
	scryptP      = 1
	scryptKeyLen = 32
)

var sha256HexRe = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

// Hash returns the lowercase sha256 hex of value (the `hash` helper in app.js).
func Hash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

// IsSha256Hex reports whether value is a 64-char hex string.
func IsSha256Hex(value string) bool {
	return sha256HexRe.MatchString(value)
}

// IsScryptHash reports whether value is a stored scrypt credential string.
func IsScryptHash(value string) bool {
	return strings.HasPrefix(value, "scrypt$")
}

// NeedsUpgrade reports whether a stored credential is the legacy bare-sha256
// format and should be re-derived to scrypt after a successful verify.
func NeedsUpgrade(stored string) bool {
	return IsSha256Hex(stored)
}

// Derive turns a client-supplied sha256 hex into the stored scrypt string.
func Derive(clientSha256 string) (string, error) {
	normalized := strings.ToLower(clientSha256)
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	derived, err := scrypt.Key([]byte(normalized), salt, scryptN, scryptR, scryptP, scryptKeyLen)
	if err != nil {
		return "", err
	}
	return "scrypt$" + strconv.Itoa(scryptN) + "$" + strconv.Itoa(scryptR) + "$" +
		strconv.Itoa(scryptP) + "$" + hex.EncodeToString(salt) + "$" + hex.EncodeToString(derived), nil
}

// ToStored coerces a credential input into its stored form: pass a scrypt string
// through unchanged, derive from a sha256, or report !ok for anything else.
func ToStored(value string) (string, bool, error) {
	if IsScryptHash(value) {
		return value, true, nil
	}
	if IsSha256Hex(value) {
		s, err := Derive(value)
		return s, err == nil, err
	}
	return "", false, nil
}

// Verify checks a client-supplied sha256 against a stored credential (scrypt or
// legacy bare-sha256) in constant time, mirroring verifyPassword in app.js.
func Verify(stored, clientSha256 string) bool {
	if stored == "" || !IsSha256Hex(clientSha256) {
		return false
	}
	normalized := strings.ToLower(clientSha256)
	if !IsScryptHash(stored) {
		return subtle.ConstantTimeCompare([]byte(strings.ToLower(stored)), []byte(normalized)) == 1
	}
	parts := strings.Split(stored, "$") // scrypt, N, r, p, saltHex, hashHex
	if len(parts) != 6 {
		return false
	}
	n, _ := strconv.Atoi(parts[1])
	r, _ := strconv.Atoi(parts[2])
	p, _ := strconv.Atoi(parts[3])
	salt, err1 := hex.DecodeString(parts[4])
	expected, err2 := hex.DecodeString(parts[5])
	if n == 0 || r == 0 || p == 0 || err1 != nil || err2 != nil || len(salt) == 0 || len(expected) == 0 {
		return false
	}
	derived, err := scrypt.Key([]byte(normalized), salt, n, r, p, len(expected))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(derived, expected) == 1
}
