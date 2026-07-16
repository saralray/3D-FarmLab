package main

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
)

func parseFloat(s string) (float64, bool) {
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return f, true
}

func addrPort(host string, port int) string {
	return net.JoinHostPort(host, strconv.Itoa(port))
}

// bambuTLSConfig returns the TLS config for a Bambu printer connection.
// H-2: controlled by BAMBU_TLS_SKIP_VERIFY (default "true" for backward compat
// with Bambu's self-signed certificates). Set to "false" when the printer
// certificate is trusted at the OS level or via a private CA.
//
// When verification is skipped (the working default for self-signed printers),
// certificate PINNING closes the resulting MITM window without a CA: pass the
// printer's serial and, via BAMBU_CERT_PINS, the poller (a) logs each observed
// cert fingerprint so an operator can discover it and (b) REJECTS a connection
// whose leaf cert doesn't match a serial that has been pinned. Unpinned serials
// are observe-only, so the default (no pins) changes nothing.
func bambuTLSConfig(serial string) *tls.Config {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("BAMBU_TLS_SKIP_VERIFY")))
	skip := v != "false" && v != "0"
	pins := parseCertPins(os.Getenv("BAMBU_CERT_PINS"))

	cfg := &tls.Config{InsecureSkipVerify: skip} //nolint:gosec // G402: self-signed printers; pinning below
	// Install pin verification whenever we're skipping CA verification (the
	// common self-signed case). Go still calls VerifyPeerCertificate even with
	// InsecureSkipVerify set, giving us the presented raw certs to pin against.
	if skip {
		cfg.VerifyPeerCertificate = func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			d := evaluatePin(rawCerts, serial, pins)
			if d.pinned && !d.ok {
				return fmt.Errorf("bambu cert pin mismatch for serial %q: presented %s (set BAMBU_CERT_PINS correctly or investigate a possible MITM)", serial, d.observed)
			}
			if d.pinned {
				return nil // matched — quiet
			}
			// Observe-only: surface the fingerprint so the operator can pin it.
			log.Printf("H-2: bambu serial %q presented cert %s (unpinned; add to BAMBU_CERT_PINS to enforce)", serial, d.observed)
			return nil
		}
	}
	return cfg
}
