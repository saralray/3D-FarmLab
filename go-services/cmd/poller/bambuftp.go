package main

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"log"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jlaffaye/ftp"
)

var weightRe = regexp.MustCompile(`(?i)key="weight"\s+value="([0-9]*\.?[0-9]+)"`)

// parse3mfFilamentGrams sums the plate-level filament weight from a 3MF's
// Metadata/slice_info.config. Returns (grams>0, true) or (0, false).
func parse3mfFilamentGrams(buf []byte) (float64, bool) {
	zr, err := zip.NewReader(bytes.NewReader(buf), int64(len(buf)))
	if err != nil {
		return 0, false
	}
	var xml string
	found := false
	for _, f := range zr.File {
		if f.Name == "Metadata/slice_info.config" {
			rc, err := f.Open()
			if err != nil {
				return 0, false
			}
			data, err := io.ReadAll(rc)
			rc.Close()
			if err != nil {
				return 0, false
			}
			xml = string(data)
			found = true
			break
		}
	}
	if !found {
		return 0, false
	}

	total := 0.0
	seen := false
	for _, m := range weightRe.FindAllStringSubmatch(xml, -1) {
		if g, ok := parseFloat(m[1]); ok && g > 0 {
			total += g
			seen = true
		}
	}
	if !seen {
		return 0, false
	}
	return round1(total), true
}

// openBambuFTP opens an implicit-FTPS control connection (port 990, bblp + LAN
// access code), trusting the printer's self-signed cert.
func openBambuFTP(printer pmap) (*ftp.ServerConn, error) {
	addr := mStr(printer, "ipAddress")
	conn, err := ftp.Dial(
		addrPort(addr, bambuFtpPort),
		ftp.DialWithTimeout(bambuFtpTimeout),
		ftp.DialWithTLS(bambuTLSConfig()), // H-2: see util.go bambuTLSConfig
	)
	if err != nil {
		return nil, err
	}
	if err := conn.Login(bambuFtpUsername, strings.TrimSpace(mStr(printer, "apiKeyHeader"))); err != nil {
		_ = conn.Quit()
		return nil, err
	}
	return conn, nil
}

func bambu3mfCandidates(printData pmap, jobName string) []string {
	var candidates []string
	add := func(path string) {
		if path == "" {
			return
		}
		cleaned := strings.TrimLeft(path, "/")
		if !strings.HasSuffix(strings.ToLower(cleaned), ".3mf") {
			return
		}
		for _, c := range candidates {
			if c == cleaned {
				return
			}
		}
		candidates = append(candidates, cleaned)
	}
	add(mStr(printData, "gcode_file"))
	for _, base := range []string{jobName, jobName + ".gcode"} {
		add(base + ".3mf")
		add("cache/" + base + ".3mf")
	}
	return candidates
}

func fetchBambu3mf(printer, printData pmap, jobName string) []byte {
	candidates := bambu3mfCandidates(printData, jobName)
	conn, err := openBambuFTP(printer)
	if err != nil {
		log.Printf("bambu ftp connect failed (%s): %v", mStr(printer, "ipAddress"), err)
		return nil
	}
	defer func() { _ = conn.Quit() }()

	token := strings.ToLower(stripGcodeSuffix(jobName))
	for _, directory := range []string{"", "cache"} {
		names, err := conn.NameList(directory)
		if err != nil {
			continue
		}
		for _, name := range names {
			cleaned := strings.TrimLeft(name, "/")
			if directory != "" && !strings.Contains(cleaned, "/") {
				cleaned = directory + "/" + cleaned
			}
			if strings.HasSuffix(strings.ToLower(cleaned), ".3mf") && token != "" && strings.Contains(strings.ToLower(cleaned), token) {
				candidates = append(candidates, cleaned)
			}
		}
	}

	seen := map[string]bool{}
	for _, path := range candidates {
		if seen[path] {
			continue
		}
		seen[path] = true
		resp, err := conn.Retr(path)
		if err != nil {
			continue
		}
		data, err := io.ReadAll(resp)
		resp.Close()
		addBytesIn(len(data))
		if err == nil && len(data) > 0 {
			return data
		}
	}
	return nil
}

// Per (printerID, jobName) cool-down so an unfetchable .3mf isn't retried every poll.
var bambu3mfAttempts = map[estimateKey]time.Time{}

const bambu3mfRetry = 300 * time.Second

func ensureBambuSlicerEstimate(ctx context.Context, conn *pgx.Conn, printer, printData, job pmap, estimates map[estimateKey]float64, slotEstimates map[estimateKey][]filamentSlot) {
	printerID := mStr(printer, "id")
	if printerID == "" || job == nil {
		return
	}
	if bambuFtpBlockedProfiles[mStr(printer, "profile")] {
		return
	}
	jobName := mStr(job, "filename")
	if jobName == "" {
		return
	}
	key := estimateKey{printerID, jobName}
	if _, ok := estimates[key]; ok {
		return
	}
	if last, ok := bambu3mfAttempts[key]; ok && time.Since(last) < bambu3mfRetry {
		return
	}
	bambu3mfAttempts[key] = time.Now()

	defer func() {
		if r := recover(); r != nil {
			log.Printf("bambu 3mf estimate failed (%s/%s): %v", printerID, jobName, r)
		}
	}()
	data := fetchBambu3mf(printer, printData, jobName)
	if len(data) == 0 {
		return
	}
	grams, ok := parse3mfFilamentGrams(data)
	if !ok || grams <= 0 {
		return
	}
	slots, _ := parse3mfFilamentSlots(data) // best-effort; nil is fine, fallback path covers it
	if err := recordSlicerEstimate(ctx, conn, printerID, jobName, grams, slots); err != nil {
		log.Printf("bambu 3mf estimate store failed (%s/%s): %v", printerID, jobName, err)
		return
	}
	estimates[key] = grams
	if len(slots) > 0 {
		slotEstimates[key] = slots
	}
}

func maybeRecordBambu3mfEstimate(ctx context.Context, conn *pgx.Conn, printer, nextPrinter pmap, estimates map[estimateKey]float64, slotEstimates map[estimateKey][]filamentSlot) {
	profile := mStr(printer, "profile")
	if !bambuProfiles[profile] || bambuFtpBlockedProfiles[profile] {
		return
	}
	job := mMap(nextPrinter, "currentJob")
	status := mStr(nextPrinter, "status")
	if job == nil || (status != "printing" && status != "paused") {
		return
	}
	if _, ok := estimates[estimateKey{mStr(printer, "id"), mStr(job, "filename")}]; ok {
		return
	}
	var printData pmap
	if client := getBambuClient(printer); client != nil {
		printData = client.latestReport()
	}
	if printData == nil {
		printData = pmap{}
	}
	ensureBambuSlicerEstimate(ctx, conn, printer, printData, job, estimates, slotEstimates)
}

// applySlicerFilamentEstimate overrides a job's filament usage with the slicer's
// exact 3MF estimate (scaled by progress) when one is known — taking precedence
// over the AMS remain%-delta fallback.
func applySlicerFilamentEstimate(printer pmap, estimates map[estimateKey]float64) {
	job := mMap(printer, "currentJob")
	if job == nil {
		return
	}
	grams, ok := estimates[estimateKey{mStr(printer, "id"), mStr(job, "filename")}]
	if !ok || grams <= 0 {
		return
	}
	progress := 0.0
	if p, ok := mFloat(job, "progress"); ok {
		progress = p
	}
	job["estimatedFilament"] = round1(grams)
	job["filamentUsed"] = round1(grams * maxF(0, minF(100, progress)) / 100)
}

func minF(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

func stripGcodeSuffix(s string) string {
	if strings.HasSuffix(strings.ToLower(s), ".gcode") {
		return s[:len(s)-len(".gcode")]
	}
	return s
}
