package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"testing"
	"time"
)

// selfSignedDER generates a throwaway self-signed cert and returns its DER bytes.
func selfSignedDER(t *testing.T, cn string) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

func TestCertFingerprintStableAndPrefixed(t *testing.T) {
	der := selfSignedDER(t, "printer-a")
	fp1 := certFingerprint(der)
	fp2 := certFingerprint(der)
	if fp1 != fp2 {
		t.Fatalf("fingerprint not deterministic: %s vs %s", fp1, fp2)
	}
	if len(fp1) != len("sha256:")+64 || fp1[:7] != "sha256:" {
		t.Fatalf("unexpected fingerprint shape: %s", fp1)
	}
}

func TestNormalizeFingerprintForms(t *testing.T) {
	base := "AABBccdd"
	forms := []string{"aabbccdd", "AABBCCDD", "sha256:aabbccdd", "SHA256:AABBCCDD", "aa:bb:cc:dd", " aabbccdd "}
	want := normalizeFingerprint(base)
	for _, f := range forms {
		if got := normalizeFingerprint(f); got != want {
			t.Errorf("normalize(%q)=%q, want %q", f, got, want)
		}
	}
}

func TestFingerprintsMatch(t *testing.T) {
	der := selfSignedDER(t, "p")
	fp := certFingerprint(der)
	hexOnly := normalizeFingerprint(fp)
	if !fingerprintsMatch(fp, "sha256:"+hexOnly) {
		t.Error("prefixed vs prefixed should match")
	}
	if !fingerprintsMatch(fp, hexOnly) {
		t.Error("prefixed vs bare-hex should match")
	}
	if fingerprintsMatch(fp, "") {
		t.Error("empty should never match")
	}
	if fingerprintsMatch("", "") {
		t.Error("empty vs empty should not match")
	}
	if fingerprintsMatch(fp, "sha256:deadbeef") {
		t.Error("different length should not match")
	}
}

func TestParseCertPins(t *testing.T) {
	pins := parseCertPins("SER1=sha256:AABB, ser2 = ccdd , =nofp, bad, ser3=")
	if len(pins) != 2 {
		t.Fatalf("expected 2 valid pins, got %d: %v", len(pins), pins)
	}
	if pins["SER1"] != "aabb" {
		t.Errorf("SER1 => %q, want aabb", pins["SER1"])
	}
	if pins["ser2"] != "ccdd" {
		t.Errorf("ser2 => %q, want ccdd", pins["ser2"])
	}
	if parseCertPins("") == nil || len(parseCertPins("")) != 0 {
		t.Error("empty env should yield empty map")
	}
}

func TestEvaluatePin(t *testing.T) {
	derA := selfSignedDER(t, "a")
	derB := selfSignedDER(t, "b")
	fpA := certFingerprint(derA)

	// Unpinned serial: observe-only, always ok.
	d := evaluatePin([][]byte{derA}, "SER1", map[string]string{})
	if !d.ok || d.pinned {
		t.Errorf("unpinned should be ok & not pinned: %+v", d)
	}
	if d.observed != fpA {
		t.Errorf("observed %q, want %q", d.observed, fpA)
	}

	// Pinned & matching leaf → ok.
	pins := map[string]string{"SER1": normalizeFingerprint(fpA)}
	d = evaluatePin([][]byte{derA}, "SER1", pins)
	if !d.ok || !d.pinned {
		t.Errorf("matching pin should be ok & pinned: %+v", d)
	}

	// Pinned but presented the WRONG cert → reject.
	d = evaluatePin([][]byte{derB}, "SER1", pins)
	if d.ok || !d.pinned {
		t.Errorf("mismatched pin must NOT be ok: %+v", d)
	}

	// Pinned serial but empty chain → reject.
	d = evaluatePin([][]byte{}, "SER1", pins)
	if d.ok {
		t.Errorf("empty chain against a pin must NOT be ok: %+v", d)
	}

	// A pin for a DIFFERENT serial doesn't affect this one (observe-only).
	d = evaluatePin([][]byte{derA}, "OTHER", pins)
	if !d.ok || d.pinned {
		t.Errorf("other serial should be observe-only: %+v", d)
	}
}
