package main

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strings"
	"time"
)

// queue.go ports the public print-request intake (POST /api/queue/submit) and
// the stored-model download (GET /api/queue/:id/file) from server/app.js, plus
// the Discord "queue added" notification. Both routes are classified public by
// the auth gate (submit is in publicAPIMutations; the file GET is a plain read),
// so handleQueueIntake runs without a session and mirrors each Node handler's
// status codes and response shapes.

// queueUploadMaxBytes mirrors QUEUE_UPLOAD_MAX_BYTES (default 50 MB).
var queueUploadMaxBytes = envInt("QUEUE_UPLOAD_MAX_BYTES", 50*1024*1024)

// queueFileStreamChunkBytes mirrors QUEUE_FILE_STREAM_CHUNK_BYTES: bytes pulled
// per DB round-trip when streaming a stored file out, capping resident memory
// per in-flight download.
const queueFileStreamChunkBytes = 256 * 1024

// queueAllowedFileExt mirrors QUEUE_ALLOWED_FILE_EXT in server/app.js.
var queueAllowedFileExt = map[string]bool{".stl": true, ".3mf": true, ".obj": true}

// ── Queue-availability window ────────────────────────────────────────────────
// Ports QUEUE_AVAILABILITY_KEY / QUEUE_AVAILABILITY_DEFAULTS / evaluateQueueAvailability
// from server/app.js: a configurable window during which the public print-request
// form (/request) accepts new submissions, enforced server-side on POST
// /api/queue/submit — not just as a frontend UI gate.
const queueAvailabilityKey = "queue_availability"

type queueAvailabilitySetting struct {
	Enabled       bool   `json:"enabled"`
	Timezone      string `json:"timezone"`
	Days          []int  `json:"days"`
	StartTime     string `json:"startTime"`
	EndTime       string `json:"endTime"`
	ClosedMessage string `json:"closedMessage"`
}

var queueAvailabilityDefaults = queueAvailabilitySetting{
	Enabled:       false,
	Timezone:      "Asia/Bangkok",
	Days:          []int{1, 2, 3, 4, 5},
	StartTime:     "09:00",
	EndTime:       "17:00",
	ClosedMessage: "The print queue is currently closed. Please check back during open hours.",
}

// getQueueAvailabilitySetting mirrors `{ ...QUEUE_AVAILABILITY_DEFAULTS, ...stored }`.
func getQueueAvailabilitySetting(ctx context.Context) (queueAvailabilitySetting, error) {
	raw, err := getAppSetting(ctx, queueAvailabilityKey)
	if err != nil {
		return queueAvailabilityDefaults, err
	}
	return queueAvailabilityShape(raw), nil
}

// queueAvailabilityShape merges a stored app_settings value over the defaults,
// keeping a default field when the stored value is absent or the wrong type.
func queueAvailabilityShape(raw json.RawMessage) queueAvailabilitySetting {
	m := decodeStored(raw)
	setting := queueAvailabilityDefaults
	if v, ok := m["enabled"].(bool); ok {
		setting.Enabled = v
	}
	if v, ok := m["timezone"].(string); ok && v != "" {
		setting.Timezone = v
	}
	if arr, ok := m["days"].([]any); ok && len(arr) > 0 {
		days := make([]int, 0, len(arr))
		for _, d := range arr {
			if f, ok := d.(float64); ok {
				days = append(days, int(f))
			}
		}
		if len(days) > 0 {
			setting.Days = days
		}
	}
	if v, ok := m["startTime"].(string); ok && v != "" {
		setting.StartTime = v
	}
	if v, ok := m["endTime"].(string); ok && v != "" {
		setting.EndTime = v
	}
	if v, ok := m["closedMessage"].(string); ok && v != "" {
		setting.ClosedMessage = v
	}
	return setting
}

type queueAvailabilityStatus struct {
	Open    bool   `json:"open"`
	Message string `json:"message,omitempty"`
}

// evaluateQueueAvailability mirrors the Node function of the same name. Unlike
// Node (which has to fight Intl.DateTimeFormat to get "now" in an arbitrary IANA
// zone), Go's time.Time.In() does this directly, and time.Weekday numbering
// (Sunday=0 .. Saturday=6) already matches Node's weekdayMap.
func evaluateQueueAvailability(setting queueAvailabilitySetting, now time.Time) queueAvailabilityStatus {
	if !setting.Enabled {
		return queueAvailabilityStatus{Open: true}
	}
	loc, err := time.LoadLocation(setting.Timezone)
	if err != nil {
		loc = time.UTC
	}
	local := now.In(loc)
	weekday := int(local.Weekday())
	nowMinutes := local.Hour()*60 + local.Minute()

	startMinutes, _ := parseHHMM(setting.StartTime)
	endMinutes, _ := parseHHMM(setting.EndTime)

	dayOk := false
	for _, d := range setting.Days {
		if d == weekday {
			dayOk = true
			break
		}
	}
	timeOk := nowMinutes >= startMinutes && nowMinutes < endMinutes
	if dayOk && timeOk {
		return queueAvailabilityStatus{Open: true}
	}
	return queueAvailabilityStatus{Open: false, Message: setting.ClosedMessage}
}

// parseHHMM parses a "HH:MM" string into minutes since midnight.
func parseHHMM(s string) (int, bool) {
	if len(s) != 5 || s[2] != ':' {
		return 0, false
	}
	h, ok1 := jsParseInt(s[0:2])
	m, ok2 := jsParseInt(s[3:5])
	if !ok1 || !ok2 {
		return 0, false
	}
	return h*60 + m, true
}

func handleQueueIntake(w http.ResponseWriter, req *http.Request) bool {
	p := req.URL.Path
	switch {
	// Public, read-only status check for the queue-availability window — lets
	// /request show a "closed" notice before a student even opens the form.
	case p == "/api/queue/availability" && req.Method == http.MethodGet:
		setting, err := getQueueAvailabilitySetting(req.Context())
		if err != nil {
			internalError(w, "getQueueAvailabilitySetting", err)
			return true
		}
		sendJSON(w, http.StatusOK, evaluateQueueAvailability(setting, time.Now()), "")
		return true
	case p == "/api/queue/submit" && req.Method == http.MethodPost:
		handleQueueSubmit(w, req)
		return true
	case strings.HasPrefix(p, "/api/queue/") && strings.HasSuffix(p, "/file") && req.Method == http.MethodGet:
		id := decodePathSegment(p, "/api/queue/", "/file")
		inline := req.URL.Query().Get("open") == "1"
		streamed, err := streamQueueJobFile(req.Context(), w, id, inline)
		if err != nil {
			internalError(w, "streamQueueJobFile", err)
			return true
		}
		if !streamed {
			sendJSON(w, http.StatusNotFound, map[string]any{"error": "File not found"}, "")
		}
		return true
	}
	return false
}

// ── POST /api/queue/submit ───────────────────────────────────────────────────

func handleQueueSubmit(w http.ResponseWriter, req *http.Request) {
	ctx := req.Context()

	setting, err := getQueueAvailabilitySetting(ctx)
	if err != nil {
		internalError(w, "getQueueAvailabilitySetting", err)
		return
	}
	if availability := evaluateQueueAvailability(setting, time.Now()); !availability.Open {
		sendJSON(w, http.StatusForbidden, map[string]any{"error": availability.Message}, "")
		return
	}

	fields, file, err := parsePrintRequest(req)
	if err != nil {
		if err == errFileTooLarge {
			limitMb := (queueUploadMaxBytes + (1024*1024)/2) / (1024 * 1024)
			sendJSON(w, http.StatusRequestEntityTooLarge,
				map[string]any{"error": fmt.Sprintf("File exceeds the %d MB upload limit.", limitMb)}, "")
		} else {
			sendJSON(w, http.StatusBadRequest, map[string]any{"error": "Invalid form submission"}, "")
		}
		return
	}

	firstName := strings.TrimSpace(fields["firstName"])
	lastName := strings.TrimSpace(fields["lastName"])
	studentID := strings.TrimSpace(fields["studentId"])
	course := strings.TrimSpace(fields["course"])
	email := strings.TrimSpace(fields["email"])
	noteText := strings.TrimSpace(fields["notes"])
	quantity := parseQuantity(fields["quantity"])

	nameParts := make([]string, 0, 2)
	for _, part := range []string{firstName, lastName} {
		if part != "" {
			nameParts = append(nameParts, part)
		}
	}
	submitterName := strings.TrimSpace(strings.Join(nameParts, " "))
	if submitterName == "" {
		submitterName = studentID
	}

	if submitterName == "" {
		sendJSON(w, http.StatusBadRequest, map[string]any{"error": "Please provide your name or student ID."}, "")
		return
	}
	if file == nil || len(file.content) == 0 {
		sendJSON(w, http.StatusBadRequest, map[string]any{"error": "Please attach a model file to print."}, "")
		return
	}

	ext := strings.ToLower(nodeExtname(file.filename))
	if !queueAllowedFileExt[ext] {
		shown := ext
		if shown == "" {
			shown = "unknown"
		}
		sendJSON(w, http.StatusUnsupportedMediaType,
			map[string]any{"error": fmt.Sprintf("Unsupported file type %q. Allowed: STL, 3MF, OBJ.", shown)}, "")
		return
	}

	submittedAt := time.Now()
	noteParts := make([]string, 0, 3)
	if studentID != "" {
		noteParts = append(noteParts, "Student ID: "+studentID)
	}
	if course != "" {
		noteParts = append(noteParts, "Course: "+course)
	}
	if noteText != "" {
		noteParts = append(noteParts, noteText)
	}
	estimatedTime := quantity * 60
	if estimatedTime < 30 {
		estimatedTime = 30
	}

	idSeed := studentID
	if idSeed == "" {
		idSeed = submitterName
	}
	sum := sha1.Sum([]byte(*jsISO(&submittedAt) + "|" + idSeed + "|" + file.filename))
	id := "queue-" + hex.EncodeToString(sum[:])[:16]

	priority := "low"
	if quantity >= 3 {
		priority = "high"
	} else if quantity >= 2 {
		priority = "medium"
	}

	job := queueSubmission{
		id:            id,
		filename:      file.filename,
		fileCount:     quantity,
		submitterName: submitterName,
		notes:         strings.Join(noteParts, " | "),
		submittedAt:   submittedAt,
		priority:      priority,
		estimatedTime: estimatedTime,
		fileContent:   file.content,
		fileMime:      file.mimeType,
		fileSize:      len(file.content),
	}
	if job.filename == "" {
		job.filename = "Submission " + id
	}
	if email != "" {
		job.submitterEmail = &email
	}
	if job.fileMime == "" {
		job.fileMime = "application/octet-stream"
	}

	if err := insertQueueSubmission(ctx, job); err != nil {
		internalError(w, "insertQueueSubmission", err)
		return
	}

	// Fire the Discord add-notification asynchronously (detached from the request
	// context, which is cancelled once the response is written) — mirroring the
	// Node `.catch`-logged background send.
	notifyJob := job
	go func() {
		nctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := sendQueueAddedNotifications(nctx, notifyJob, fmt.Sprintf("/api/queue/%s/file", id)); err != nil {
			logError("failed to send queue add notification", map[string]any{"err": err.Error()})
		}
	}()

	sendJSON(w, http.StatusCreated, queueSubmitResponse{OK: true, ID: id}, "")
}

// queueSubmitResponse keeps Node's {ok, id} key order.
type queueSubmitResponse struct {
	OK bool   `json:"ok"`
	ID string `json:"id"`
}

func parseQuantity(raw string) int {
	q, ok := jsParseInt(raw)
	if !ok || q < 1 {
		return 1
	}
	return q
}

// nodeExtname mirrors path.extname (posix): the extension of the basename,
// starting at the last '.', or "" when the basename has no interior dot (a
// leading-dot basename like ".stl" yields "").
func nodeExtname(p string) string {
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		p = p[i+1:]
	}
	dot := strings.LastIndexByte(p, '.')
	if dot <= 0 {
		return ""
	}
	return p[dot:]
}

// ── multipart parsing (busboy replacement) ───────────────────────────────────

type uploadedFile struct {
	filename string
	mimeType string
	content  []byte
}

var errFileTooLarge = fmt.Errorf("FILE_TOO_LARGE")

// parsePrintRequest streams the multipart body the way busboy does: it buffers
// the single uploaded file (bounded by queueUploadMaxBytes) alongside the text
// fields. An oversized file returns errFileTooLarge; a malformed body returns a
// generic error (→ 400).
func parsePrintRequest(req *http.Request) (map[string]string, *uploadedFile, error) {
	mediaType, params, err := mime.ParseMediaType(req.Header.Get("Content-Type"))
	if err != nil || !strings.HasPrefix(mediaType, "multipart/") {
		return nil, nil, fmt.Errorf("not multipart")
	}
	boundary := params["boundary"]
	if boundary == "" {
		return nil, nil, fmt.Errorf("missing boundary")
	}

	mr := multipart.NewReader(req.Body, boundary)
	fields := map[string]string{}
	var file *uploadedFile

	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, err
		}

		if part.FileName() == "" {
			// A text field. Cap the read so a hostile field can't exhaust memory.
			value, err := io.ReadAll(io.LimitReader(part, 1<<20))
			_ = part.Close()
			if err != nil {
				return nil, nil, err
			}
			fields[part.FormName()] = string(value)
			continue
		}

		// A file part. Only the first file is taken (busboy files: 1); read up to
		// one byte past the limit so an overflow is detectable.
		if file != nil {
			_ = part.Close()
			continue
		}
		content, err := io.ReadAll(io.LimitReader(part, int64(queueUploadMaxBytes)+1))
		_ = part.Close()
		if err != nil {
			return nil, nil, err
		}
		// busboy's fileSize limit is inclusive: a stream that reaches `limit` bytes
		// emits 'limit' (the max accepted file is limit-1 bytes), so match `>=`.
		if len(content) >= queueUploadMaxBytes {
			return nil, nil, errFileTooLarge
		}
		if len(content) > 0 {
			file = &uploadedFile{
				filename: part.FileName(),
				mimeType: partContentType(part),
				content:  content,
			}
		}
	}

	return fields, file, nil
}

func partContentType(part *multipart.Part) string {
	if ct := part.Header.Get("Content-Type"); ct != "" {
		return ct
	}
	return ""
}

// ── GET /api/queue/:id/file ──────────────────────────────────────────────────

// streamQueueJobFile streams a stored model file to the response in fixed-size
// chunks read straight from Postgres, so the full file never sits in RAM.
// Returns (false, nil) without touching the response when no file exists, so the
// caller can send a 404.
func streamQueueJobFile(ctx context.Context, w http.ResponseWriter, id string, inline bool) (bool, error) {
	meta, err := getQueueJobFileMeta(ctx, id)
	if err != nil {
		return false, err
	}
	if meta == nil {
		return false, nil
	}

	safeName := sanitizeFilename(meta.filename)
	disposition := "attachment"
	if inline {
		disposition = "inline"
	}
	w.Header().Set("Content-Type", meta.mime)
	w.Header().Set("Content-Length", itoa(int(meta.size)))
	w.Header().Set("Content-Disposition", fmt.Sprintf("%s; filename=%q", disposition, safeName))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)

	for offset := 0; offset < int(meta.size); offset += queueFileStreamChunkBytes {
		chunk, err := readQueueJobFileChunk(ctx, id, offset, queueFileStreamChunkBytes)
		if err != nil {
			return true, err
		}
		if len(chunk) == 0 {
			break
		}
		if _, err := w.Write(chunk); err != nil {
			return true, nil // client went away; nothing more to do
		}
	}
	return true, nil
}

// sanitizeFilename mirrors `(filename || 'model').replace(/[^\w.\- ]+/g, '_')`.
func sanitizeFilename(name string) string {
	if name == "" {
		name = "model"
	}
	var b strings.Builder
	prevReplaced := false
	for _, r := range name {
		keep := r == '.' || r == '-' || r == ' ' || r == '_' ||
			(r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
		if keep {
			b.WriteRune(r)
			prevReplaced = false
		} else if !prevReplaced {
			// A run of disallowed chars collapses to a single underscore (the regex
			// uses the `+` quantifier).
			b.WriteByte('_')
			prevReplaced = true
		}
	}
	return b.String()
}

// ── store helpers (ported from server/postgres.js) ───────────────────────────

type queueSubmission struct {
	id             string
	filename       string
	fileCount      int
	submitterName  string
	submitterEmail *string
	notes          string
	submittedAt    time.Time
	priority       string
	estimatedTime  int
	fileContent    []byte
	fileMime       string
	fileSize       int
}

func insertQueueSubmission(ctx context.Context, job queueSubmission) error {
	var notes any
	if job.notes != "" {
		notes = job.notes
	}
	_, err := dbPool.Exec(ctx, `
    INSERT INTO queue_jobs (
      id, filename, file_count, submitter_name, submitter_email, notes,
      submitted_at, priority, estimated_time, form_type, printed_status,
      file_content, file_mime, file_size_bytes
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12, $13)
    ON CONFLICT (id) DO UPDATE SET
      filename = EXCLUDED.filename,
      file_count = EXCLUDED.file_count,
      submitter_name = EXCLUDED.submitter_name,
      submitter_email = EXCLUDED.submitter_email,
      notes = EXCLUDED.notes,
      submitted_at = EXCLUDED.submitted_at,
      priority = EXCLUDED.priority,
      estimated_time = EXCLUDED.estimated_time,
      file_content = EXCLUDED.file_content,
      file_mime = EXCLUDED.file_mime,
      file_size_bytes = EXCLUDED.file_size_bytes,
      deleted_at = NULL,
      updated_at = NOW();`,
		job.id, job.filename, job.fileCount, job.submitterName, job.submitterEmail, notes,
		job.submittedAt, job.priority, job.estimatedTime, queueFormType,
		job.fileContent, job.fileMime, job.fileSize)
	return err
}

type queueFileMeta struct {
	filename string
	mime     string
	size     int64
}

func getQueueJobFileMeta(ctx context.Context, id string) (*queueFileMeta, error) {
	var filename *string
	var fileMime *string
	var size *int64
	err := dbPool.QueryRow(ctx, `
    SELECT filename, file_mime, octet_length(file_content) AS size
    FROM queue_jobs
    WHERE id = $1
      AND deleted_at IS NULL
      AND file_content IS NOT NULL;`, id).Scan(&filename, &fileMime, &size)
	if err != nil {
		if err.Error() == "no rows in result set" {
			return nil, nil
		}
		return nil, err
	}
	meta := &queueFileMeta{mime: "application/octet-stream"}
	if filename != nil {
		meta.filename = *filename
	}
	if fileMime != nil && *fileMime != "" {
		meta.mime = *fileMime
	}
	if size != nil {
		meta.size = *size
	}
	return meta, nil
}

func readQueueJobFileChunk(ctx context.Context, id string, offset, length int) ([]byte, error) {
	var chunk []byte
	err := dbPool.QueryRow(ctx, `
    SELECT substring(file_content FROM $2 FOR $3) AS chunk
    FROM queue_jobs
    WHERE id = $1
      AND deleted_at IS NULL
      AND file_content IS NOT NULL;`, id, offset+1, length).Scan(&chunk)
	if err != nil {
		if err.Error() == "no rows in result set" {
			return nil, nil
		}
		return nil, err
	}
	return chunk, nil
}

// ── Discord queue-added notification ─────────────────────────────────────────

type discordWebhook struct {
	Name       string          `json:"name"`
	WebhookURL string          `json:"webhookUrl"`
	Events     json.RawMessage `json:"events"`
	Enabled    *bool           `json:"enabled"`
	TTS        bool            `json:"tts"`
}

func listDiscordWebhooks(ctx context.Context) ([]discordWebhook, error) {
	data, err := scanJSON(ctx, `
    SELECT COALESCE(
      json_agg(
        json_build_object(
          'name', name,
          'webhookUrl', webhook_url,
          'events', events,
          'enabled', enabled,
          'tts', tts
        )
        ORDER BY created_at ASC
      ),
      '[]'::json
    ) AS data
    FROM discord_webhooks;`)
	if err != nil {
		return nil, err
	}
	var hooks []discordWebhook
	if err := json.Unmarshal(data, &hooks); err != nil {
		return nil, err
	}
	return hooks, nil
}

// webhookWantsEvent mirrors the like-named Node helper: a disabled webhook is
// skipped; a webhook whose `events` is not an array receives every event; an
// array restricts delivery to the listed event keys.
func webhookWantsEvent(h discordWebhook, eventKey string) bool {
	if h.Enabled != nil && !*h.Enabled {
		return false
	}
	if len(h.Events) == 0 || isJSONNull(h.Events) {
		return true
	}
	var events []string
	if err := json.Unmarshal(h.Events, &events); err != nil {
		// Not a JSON array of strings → treated as "not an array" → wants all.
		return true
	}
	for _, e := range events {
		if e == eventKey {
			return true
		}
	}
	return false
}

func sendQueueAddedNotifications(ctx context.Context, job queueSubmission, fileURL string) error {
	hooks, err := listDiscordWebhooks(ctx)
	if err != nil {
		return err
	}
	if len(hooks) == 0 {
		return nil
	}

	embed := buildQueueAddedEmbed(job, fileURL)
	for _, h := range hooks {
		if h.WebhookURL == "" || !webhookWantsEvent(h, "queue_added") {
			continue
		}
		username := h.Name
		if username == "" {
			username = "PrintFarm Bot"
		}
		var payload any
		if h.TTS {
			payload = map[string]any{
				"username": username,
				"tts":      true,
				"content":  ttsContentForJob(job),
			}
		} else {
			payload = map[string]any{
				"username": username,
				"embeds":   []any{embed},
			}
		}
		postDiscordWebhook(ctx, h.WebhookURL, payload)
	}
	return nil
}

func postDiscordWebhook(ctx context.Context, url string, payload any) {
	body := marshalJSON(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(body)))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
}

func buildQueueAddedEmbed(job queueSubmission, fileURL string) map[string]any {
	submitter := job.submitterName
	if submitter == "" {
		submitter = "Unknown"
	}
	fields := []map[string]any{
		{"name": "Submitter", "value": submitter, "inline": true},
		{"name": "Numbers", "value": itoa(job.fileCount), "inline": true},
	}
	if job.notes != "" {
		notes := job.notes
		if len(notes) > 1024 {
			notes = notes[:1024]
		}
		fields = append(fields, map[string]any{"name": "Notes", "value": notes, "inline": false})
	}
	if fileURL != "" {
		fields = append(fields, map[string]any{"name": "File", "value": fileURL, "inline": false})
	}
	description := job.filename
	if description == "" {
		description = job.id
	}
	now := time.Now()
	return map[string]any{
		"title":       "New Queue Submission",
		"description": description,
		"color":       0x3b82f6,
		"fields":      fields,
		"timestamp":   *jsISO(&now),
	}
}

func ttsContentForJob(job queueSubmission) string {
	submitter := strings.TrimSpace(job.submitterName)
	count := job.fileCount
	if count < 1 {
		count = 1
	}
	suffix := "s"
	if count == 1 {
		suffix = ""
	}
	filePart := fmt.Sprintf("%d file%s", count, suffix)
	var spoken string
	if submitter != "" {
		spoken = fmt.Sprintf("New print request from %s, %s", submitter, filePart)
	} else {
		spoken = fmt.Sprintf("New print request, %s", filePart)
	}
	if len(spoken) > 2000 {
		spoken = spoken[:2000]
	}
	return spoken
}
