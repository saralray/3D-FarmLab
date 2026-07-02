package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// camera.go ports server/bambuCamera.js (the H2/X1-class live-view camera hub)
// and captureBambuSnapshot (the A1/P1 port-6000 JPEG socket) from server/app.js.
//
// A Bambu camera (LIVE555 RTSP-over-TLS on port 322) tolerates only a couple of
// concurrent connections, so the hub holds ONE persistent ffmpeg per printer:
// one camera connection transcoded H264→MJPEG, its frames fanned out to every
// live viewer and reused for still snapshots, with a health-check supervisor
// that restarts a stalled/dead feed and shuts an idle one down. Node runs this
// single-threaded on the event loop; the Go port guards all mutable stream state
// with a per-stream mutex and fans frames to viewers over per-viewer channels so
// the ffmpeg reader never blocks on a slow client.

const (
	rtspPort            = 322
	supervisorInterval  = 4000 * time.Millisecond
	frameStallMs        = 12000
	onlineFreshMs       = 10000
	idleShutdownMs      = 30000
	restartBaseMs       = 1000
	restartMaxMs        = 15000
	snapshotWaitMs      = 12000
	snapshotFreshMs     = 1500
	maxFrameBytes       = 25 * 1024 * 1024
	viewerBoundary      = "frame"
	bambuCameraPortSnap = 6000
)

// bambuRtspProfiles mirrors BAMBU_RTSP_PROFILES.
var bambuRtspProfiles = map[string]bool{
	"bambulab_h2s": true,
	"bambulab_h2d": true,
	"bambulab_h2c": true,
}

func buildRtspURL(host, accessCode string) string {
	return fmt.Sprintf("rtsps://bblp:%s@%s:%d/streaming/live/1", encodeURIComponent(accessCode), host, rtspPort)
}

// ffmpegArgs mirrors the Node arg list exactly: low-latency H264→MJPEG transcode.
func ffmpegArgs(url string) []string {
	return []string{
		"-nostdin",
		"-loglevel", "error",
		"-fflags", "nobuffer",
		"-flags", "low_delay",
		"-avioflags", "direct",
		"-analyzeduration", "0",
		"-probesize", "32768",
		"-rtsp_transport", "tcp",
		"-i", url,
		"-an",
		"-vsync", "drop",
		// Cap output to 8 fps: cuts steady-state bandwidth for every viewer with
		// no visible loss for a monitoring feed. Keep in sync with bambuCamera.js.
		"-vf", "fps=8,scale=1280:-2",
		"-q:v", "6",
		"-f", "mpjpeg",
		"pipe:1",
	}
}

type cameraViewer struct {
	ch chan []byte
}

type cameraStream struct {
	id string

	mu         sync.Mutex
	name       string
	host       string
	accessCode string

	proc      *exec.Cmd
	status    string // idle | starting | running | error
	lastError string
	startedAt time.Time
	lastFrame []byte

	lastFrameAt    time.Time
	frames         int
	restarts       int
	lastSnapshotAt time.Time

	viewers      map[*cameraViewer]bool
	frameWaiters []chan []byte

	restartDelay time.Duration
	restartTimer *time.Timer
	stderrTail   string
	stopped      bool
}

func newCameraStream(p *printerConn) *cameraStream {
	s := &cameraStream{
		id:           p.ID,
		status:       "idle",
		viewers:      map[*cameraViewer]bool{},
		restartDelay: restartBaseMs * time.Millisecond,
	}
	s.applyPrinterLocked(p)
	return s
}

func (s *cameraStream) applyPrinterLocked(p *printerConn) {
	s.name = printerNameFor(p)
	s.host = p.IPAddress
	s.accessCode = strings.TrimSpace(p.APIKeyHeader)
}

// printerNameFor resolves the camera-stream name. printerConn doesn't carry the
// display name, so we fall back to the id (the health badge only needs *a*
// stable label; Node uses printer.name).
func printerNameFor(p *printerConn) string {
	if p.Name != "" {
		return p.Name
	}
	return p.ID
}

func (s *cameraStream) isDemandedLocked() bool {
	return len(s.viewers) > 0 || time.Since(s.lastSnapshotAt) < idleShutdownMs*time.Millisecond
}

func (s *cameraStream) ensureRunningLocked() {
	s.stopped = false
	if s.proc == nil && s.restartTimer == nil {
		s.startLocked()
	}
}

func (s *cameraStream) startLocked() {
	if s.proc != nil {
		return
	}
	s.status = "starting"
	s.startedAt = time.Now()

	cmd := exec.Command("ffmpeg", ffmpegArgs(buildRtspURL(s.host, s.accessCode))...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		s.lastError = "ffmpeg failed to start: " + err.Error()
		s.status = "error"
		s.scheduleRestartLocked()
		return
	}
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		s.lastError = "ffmpeg failed to start: " + err.Error()
		s.status = "error"
		s.scheduleRestartLocked()
		return
	}
	s.proc = cmd
	go s.readStderr(stderr)
	go s.readStdout(cmd, stdout)
}

func (s *cameraStream) readStderr(stderr io.ReadCloser) {
	buf := make([]byte, 4096)
	for {
		n, err := stderr.Read(buf)
		if n > 0 {
			s.mu.Lock()
			s.stderrTail = lastN(s.stderrTail+string(buf[:n]), 500)
			s.mu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

// readStdout owns the mpjpeg parser state (local, never shared) and feeds each
// decoded JPEG to onFrame. On EOF it waits for the process and routes the exit
// code through onClose.
func (s *cameraStream) readStdout(cmd *exec.Cmd, stdout io.ReadCloser) {
	var parseBuf []byte
	expecting := "header"
	contentLength := 0
	readBuf := make([]byte, 64*1024)

	ingest := func(chunk []byte) {
		if len(parseBuf) == 0 {
			parseBuf = append(parseBuf[:0], chunk...)
		} else {
			parseBuf = append(parseBuf, chunk...)
		}
		for {
			if expecting == "header" {
				idx := bytes.Index(parseBuf, []byte("\r\n\r\n"))
				if idx == -1 {
					if len(parseBuf) > 65536 {
						parseBuf = append([]byte(nil), parseBuf[len(parseBuf)-4:]...)
					}
					break
				}
				header := string(parseBuf[:idx])
				contentLength = parseContentLength(header)
				parseBuf = append([]byte(nil), parseBuf[idx+4:]...)
				expecting = "body"
				if contentLength == 0 || contentLength > maxFrameBytes {
					expecting = "header"
					continue
				}
			}
			if expecting == "body" {
				if len(parseBuf) < contentLength {
					break
				}
				frame := append([]byte(nil), parseBuf[:contentLength]...)
				parseBuf = append([]byte(nil), parseBuf[contentLength:]...)
				expecting = "header"
				s.onFrame(frame)
			}
		}
	}

	for {
		n, err := stdout.Read(readBuf)
		if n > 0 {
			ingest(readBuf[:n])
		}
		if err != nil {
			break
		}
	}
	werr := cmd.Wait()
	s.onClose(exitCodeOf(werr))
}

var contentLengthRe = regexp.MustCompile(`(?i)content-length:\s*(\d+)`)

func parseContentLength(header string) int {
	m := contentLengthRe.FindStringSubmatch(header)
	if m == nil {
		return 0
	}
	v, _ := strconv.Atoi(m[1])
	return v
}

func (s *cameraStream) onFrame(frame []byte) {
	s.mu.Lock()
	s.frames++
	s.lastFrameAt = time.Now()
	s.lastFrame = frame
	s.status = "running"
	s.lastError = ""
	s.restartDelay = restartBaseMs * time.Millisecond

	if len(s.frameWaiters) > 0 {
		for _, ch := range s.frameWaiters {
			select {
			case ch <- frame:
			default:
			}
		}
		s.frameWaiters = nil
	}
	for v := range s.viewers {
		// Non-blocking: a backed-up viewer just drops this frame and gets the next
		// one it can take, so one slow client can't stall the feed.
		select {
		case v.ch <- frame:
		default:
		}
	}
	s.mu.Unlock()
}

func (s *cameraStream) onClose(code int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.proc = nil
	if code != 0 && code != 255 {
		detail := lastLine(strings.TrimSpace(s.stderrTail))
		if detail != "" {
			s.lastError = fmt.Sprintf("ffmpeg exited %d: %s", code, detail)
		} else {
			s.lastError = fmt.Sprintf("ffmpeg exited %d", code)
		}
	}
	if s.stopped {
		s.status = "idle"
		return
	}
	s.status = "error"
	s.scheduleRestartLocked()
}

func (s *cameraStream) scheduleRestartLocked() {
	if s.restartTimer != nil || s.stopped {
		return
	}
	if !s.isDemandedLocked() {
		s.status = "idle"
		return
	}
	s.restarts++
	delay := s.restartDelay
	s.restartDelay = s.restartDelay * 2
	if s.restartDelay > restartMaxMs*time.Millisecond {
		s.restartDelay = restartMaxMs * time.Millisecond
	}
	s.restartTimer = time.AfterFunc(delay, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.restartTimer = nil
		if s.stopped || !s.isDemandedLocked() {
			s.status = "idle"
			return
		}
		s.startLocked()
	})
}

func (s *cameraStream) stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stopLocked()
}

func (s *cameraStream) stopLocked() {
	s.stopped = true
	if s.restartTimer != nil {
		s.restartTimer.Stop()
		s.restartTimer = nil
	}
	if s.proc != nil && s.proc.Process != nil {
		_ = s.proc.Process.Kill()
	}
	s.status = "idle"
}

func (s *cameraStream) restartForConfigChangeLocked() {
	if s.proc != nil && s.proc.Process != nil {
		_ = s.proc.Process.Kill()
	}
}

// addViewer streams multipart/x-mixed-replace MJPEG to one client. It mirrors
// Node's addViewer: paint the latest frame immediately, then push each new frame
// (dropping frames for a backed-up client), and drop out when the client leaves.
func (s *cameraStream) addViewer(w http.ResponseWriter, req *http.Request) {
	h := w.Header()
	h.Set("Content-Type", "multipart/x-mixed-replace; boundary="+viewerBoundary)
	h.Set("Cache-Control", "no-store")
	h.Set("Connection", "close")
	h.Set("Cross-Origin-Resource-Policy", "cross-origin")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)

	v := &cameraViewer{ch: make(chan []byte, 1)}
	s.mu.Lock()
	last := s.lastFrame
	s.viewers[v] = true
	s.ensureRunningLocked()
	s.mu.Unlock()

	remove := func() {
		s.mu.Lock()
		delete(s.viewers, v)
		s.mu.Unlock()
	}
	defer remove()

	writePart := func(frame []byte) bool {
		head := fmt.Sprintf("--%s\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n", viewerBoundary, len(frame))
		if _, err := io.WriteString(w, head); err != nil {
			return false
		}
		if _, err := w.Write(frame); err != nil {
			return false
		}
		if _, err := io.WriteString(w, "\r\n"); err != nil {
			return false
		}
		if flusher != nil {
			flusher.Flush()
		}
		return true
	}

	if last != nil {
		if !writePart(last) {
			return
		}
	}

	ctx := req.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case frame := <-v.ch:
			if !writePart(frame) {
				return
			}
		}
	}
}

func (s *cameraStream) getSnapshot(ctx context.Context) ([]byte, error) {
	s.mu.Lock()
	s.lastSnapshotAt = time.Now()
	s.ensureRunningLocked()
	if s.lastFrame != nil && time.Since(s.lastFrameAt) < snapshotFreshMs*time.Millisecond {
		f := s.lastFrame
		s.mu.Unlock()
		return f, nil
	}
	ch := make(chan []byte, 1)
	s.frameWaiters = append(s.frameWaiters, ch)
	s.mu.Unlock()

	timer := time.NewTimer(snapshotWaitMs * time.Millisecond)
	defer timer.Stop()
	select {
	case f := <-ch:
		return f, nil
	case <-timer.C:
		s.mu.Lock()
		s.frameWaiters = removeWaiter(s.frameWaiters, ch)
		reason := s.lastError
		if reason == "" {
			reason = s.status
		}
		s.mu.Unlock()
		return nil, fmt.Errorf("camera produced no frame within %dms (%s) — check LAN Mode Liveview", snapshotWaitMs, reason)
	}
}

// cameraHealthFull mirrors CameraStream.health() (running shape, with name).
type cameraHealthFull struct {
	PrinterID      string  `json:"printerId"`
	Name           string  `json:"name"`
	Status         string  `json:"status"`
	Online         bool    `json:"online"`
	Viewers        int     `json:"viewers"`
	LastFrameAgeMs *int64  `json:"lastFrameAgeMs"`
	Frames         int     `json:"frames"`
	Restarts       int     `json:"restarts"`
	UptimeMs       int64   `json:"uptimeMs"`
	LastError      *string `json:"lastError"`
}

func (s *cameraStream) health() cameraHealthFull {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	hf := cameraHealthFull{
		PrinterID: s.id,
		Name:      s.name,
		Status:    s.status,
		Online:    s.status == "running" && s.lastFrame != nil && now.Sub(s.lastFrameAt) < onlineFreshMs*time.Millisecond,
		Viewers:   len(s.viewers),
		Frames:    s.frames,
		Restarts:  s.restarts,
	}
	if !s.lastFrameAt.IsZero() {
		age := now.Sub(s.lastFrameAt).Milliseconds()
		hf.LastFrameAgeMs = &age
	}
	if s.proc != nil && !s.startedAt.IsZero() {
		hf.UptimeMs = now.Sub(s.startedAt).Milliseconds()
	}
	if s.lastError != "" {
		le := s.lastError
		hf.LastError = &le
	}
	return hf
}

func (s *cameraStream) supervise() {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if s.proc != nil && s.status == "running" && now.Sub(s.lastFrameAt) > frameStallMs*time.Millisecond {
		s.lastError = "frame stall — restarting"
		if s.proc.Process != nil {
			_ = s.proc.Process.Kill() // onClose schedules the restart
		}
		return
	}
	if s.proc != nil && !s.isDemandedLocked() {
		s.stopLocked()
	}
}

// ── registry + supervisor ────────────────────────────────────────────────────

var (
	camMu         sync.Mutex
	camStreams    = map[string]*cameraStream{}
	camSupervisor sync.Once
)

func ensureSupervisor() {
	camSupervisor.Do(func() {
		go func() {
			ticker := time.NewTicker(supervisorInterval)
			defer ticker.Stop()
			for range ticker.C {
				camMu.Lock()
				list := make([]*cameraStream, 0, len(camStreams))
				for _, s := range camStreams {
					list = append(list, s)
				}
				camMu.Unlock()
				for _, s := range list {
					s.supervise()
				}
			}
		}()
	})
}

func getStream(p *printerConn) *cameraStream {
	camMu.Lock()
	s := camStreams[p.ID]
	if s == nil {
		s = newCameraStream(p)
		camStreams[p.ID] = s
		camMu.Unlock()
	} else {
		camMu.Unlock()
		s.mu.Lock()
		changed := s.host != p.IPAddress || s.accessCode != strings.TrimSpace(p.APIKeyHeader)
		s.applyPrinterLocked(p)
		if changed && s.proc != nil {
			s.restartForConfigChangeLocked()
		}
		s.mu.Unlock()
	}
	ensureSupervisor()
	return s
}

func addCameraViewer(w http.ResponseWriter, req *http.Request, p *printerConn) {
	getStream(p).addViewer(w, req)
}

func getCameraSnapshotHub(ctx context.Context, p *printerConn) ([]byte, error) {
	return getStream(p).getSnapshot(ctx)
}

// getCameraHealth reports one printer's camera health without starting a feed.
// When no stream exists it returns the idle default (no `name`, matching Node's
// object literal), distinct from the running health() shape.
func getCameraHealth(printerID string) any {
	camMu.Lock()
	s := camStreams[printerID]
	camMu.Unlock()
	if s != nil {
		return s.health()
	}
	return idleCameraHealth(printerID)
}

func getAllCameraHealth() []cameraHealthFull {
	camMu.Lock()
	list := make([]*cameraStream, 0, len(camStreams))
	for _, s := range camStreams {
		list = append(list, s)
	}
	camMu.Unlock()
	out := make([]cameraHealthFull, 0, len(list))
	for _, s := range list {
		out = append(out, s.health())
	}
	return out
}

// ── A1/P1 port-6000 JPEG snapshot ────────────────────────────────────────────

// captureBambuSnapshot connects to the A1/P1 chamber camera's raw TLS socket on
// port 6000, sends the 80-byte auth packet, and reads one length-prefixed JPEG
// frame. Mirrors captureBambuSnapshot in server/app.js.
func captureBambuSnapshot(host, accessCode string, timeout time.Duration) ([]byte, error) {
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	auth := make([]byte, 80)
	binary.LittleEndian.PutUint32(auth[0:], 0x40)
	binary.LittleEndian.PutUint32(auth[4:], 0x3000)
	copy(auth[16:], []byte("bblp"))
	copy(auth[48:], []byte(accessCode))

	dialer := &net.Dialer{Timeout: timeout}
	conn, err := tls.DialWithDialer(dialer, "tcp", fmt.Sprintf("%s:%d", host, bambuCameraPortSnap), bambuTLSConfig()) // H-2: see redis.go bambuTLSConfig
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))

	if _, err := conn.Write(auth); err != nil {
		return nil, err
	}

	var buf []byte
	payloadSize := -1
	readBuf := make([]byte, 32*1024)
	for {
		n, err := conn.Read(readBuf)
		if n > 0 {
			buf = append(buf, readBuf[:n]...)
			if payloadSize == -1 {
				if len(buf) < 16 {
					goto checkErr
				}
				payloadSize = int(binary.LittleEndian.Uint32(buf[0:4]))
				buf = buf[16:]
				if payloadSize < 1024 || payloadSize > 20*1024*1024 {
					return nil, fmt.Errorf("Bambu camera returned a non-image frame (%d bytes) — enable LAN Mode Liveview on the printer", payloadSize)
				}
			}
			if payloadSize >= 0 && len(buf) >= payloadSize {
				frame := append([]byte(nil), buf[:payloadSize]...)
				if len(frame) < 3 || frame[0] != 0xff || frame[1] != 0xd8 || frame[2] != 0xff {
					return nil, fmt.Errorf("Bambu camera frame was not a JPEG")
				}
				return frame, nil
			}
		}
	checkErr:
		if err != nil {
			if err == io.EOF {
				return nil, fmt.Errorf("Bambu camera closed before a frame arrived")
			}
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				return nil, fmt.Errorf("Bambu camera timed out")
			}
			return nil, err
		}
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

func lastN(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

func lastLine(s string) string {
	if i := strings.LastIndexByte(s, '\n'); i >= 0 {
		return s[i+1:]
	}
	return s
}

func removeWaiter(ws []chan []byte, target chan []byte) []chan []byte {
	out := ws[:0]
	for _, w := range ws {
		if w != target {
			out = append(out, w)
		}
	}
	return out
}

func exitCodeOf(err error) int {
	if err == nil {
		return 0
	}
	if ee, ok := err.(*exec.ExitError); ok {
		return ee.ExitCode()
	}
	return 255
}
