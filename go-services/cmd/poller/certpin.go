package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"strings"
)

// Bambu printers speak MQTT/FTPS/RTSP over TLS with self-signed certificates,
// so the poller cannot do normal CA verification (BAMBU_TLS_SKIP_VERIFY=true is
// the working default) — which leaves a MITM window on the printer LAN (audit
// H-2): an attacker between poller and printer can present their own cert,
// intercept the LAN access code, and inject/observe traffic.
//
// Certificate pinning closes that window without a CA: the operator records
// each printer's cert fingerprint once and the poller thereafter refuses any
// connection whose leaf cert doesn't match. This file is the pure, unit-tested
// core; util.go wires it into the Bambu tls.Config via VerifyPeerCertificate
// (which Go still invokes even when InsecureSkipVerify is set).
//
// Pins are supplied per-printer via BAMBU_CERT_PINS="<serial>=<fp>,<serial2>=<fp2>".
// Empty (the default) means no printer is pinned — the poller simply LOGS each
// observed fingerprint so the operator can discover the value to pin. So the
// default is zero behavior change; enforcement is strictly opt-in per printer.

// certFingerprint returns the "sha256:<hex>" fingerprint of a DER-encoded cert.
func certFingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// normalizeFingerprint lowercases, trims, and strips a leading "sha256:" (and
// any ':' byte separators, so an openssl-style AA:BB:.. fingerprint also works)
// so operator-supplied and computed forms compare equal.
func normalizeFingerprint(fp string) string {
	s := strings.ToLower(strings.TrimSpace(fp))
	s = strings.TrimPrefix(s, "sha256:")
	s = strings.ReplaceAll(s, ":", "")
	return s
}

// fingerprintsMatch compares two fingerprints in any accepted form, in constant
// time to avoid leaking match progress.
func fingerprintsMatch(a, b string) bool {
	na, nb := normalizeFingerprint(a), normalizeFingerprint(b)
	if na == "" || nb == "" || len(na) != len(nb) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(na), []byte(nb)) == 1
}

// parseCertPins parses BAMBU_CERT_PINS ("serial=fp,serial2=fp2") into a map of
// serial -> normalized fingerprint. Malformed or empty entries are skipped.
func parseCertPins(raw string) map[string]string {
	out := map[string]string{}
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		eq := strings.IndexByte(entry, '=')
		if eq <= 0 {
			continue
		}
		serial := strings.TrimSpace(entry[:eq])
		fp := normalizeFingerprint(entry[eq+1:])
		if serial == "" || fp == "" {
			continue
		}
		out[serial] = fp
	}
	return out
}

// pinDecision is the outcome of checking a presented leaf cert against the pins.
type pinDecision struct {
	observed string // "sha256:<hex>" of the presented leaf
	pinned   bool   // an expected pin exists for this serial
	ok       bool   // true when unpinned (observe-only) OR pinned and matching
}

// evaluatePin checks the presented DER chain's leaf against the configured pin
// for serial. rawCerts[0] is the leaf. When no pin is configured for the serial
// it returns ok=true (observe-only). When a pin is configured it returns ok=true
// only on a match. An empty chain never matches a configured pin.
func evaluatePin(rawCerts [][]byte, serial string, pins map[string]string) pinDecision {
	expected, pinned := pins[serial]
	var observed string
	if len(rawCerts) > 0 {
		observed = certFingerprint(rawCerts[0])
	}
	if !pinned {
		return pinDecision{observed: observed, pinned: false, ok: true}
	}
	return pinDecision{observed: observed, pinned: true, ok: fingerprintsMatch(observed, expected)}
}
