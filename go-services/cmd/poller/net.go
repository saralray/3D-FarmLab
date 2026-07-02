package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// httpGet performs a GET with the given single auth header (from
// parseHeaderString) and timeout, returning the body on a 2xx and an error
// otherwise (mirroring requests' raise_for_status()). Every poller HTTP call
// (generic reachability ping, Snapmaker/Moonraker status/filament queries,
// webcam snapshot fetches) goes through this one function, so this is the
// single instrumentation point for the poller's HTTP traffic.
func httpGet(url string, header [2]string, timeout time.Duration) ([]byte, error) {
	client := &http.Client{Timeout: timeout}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if header[0] != "" {
		req.Header.Set(header[0], header[1])
	}
	addBytesOut(estimateRequestLineBytes(req))
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	addBytesIn(len(body))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d for %s", resp.StatusCode, url)
	}
	return body, nil
}

// estimateRequestLineBytes approximates the bytes actually put on the wire for
// a GET (which has no body): request line + Host + headers. There's no cheap
// way to get the exact wire size without a full transport-level dump, and a
// GET is small next to the response payload it fetches, so this is only ever
// the minor side of the out/in split — same "approximate" caveat as the rest
// of this feature.
func estimateRequestLineBytes(req *http.Request) int {
	n := len(req.Method) + 1 + len(req.URL.RequestURI()) + len(" HTTP/1.1\r\n")
	n += len("Host: ") + len(req.Host) + 2
	for name, values := range req.Header {
		for _, v := range values {
			n += len(name) + 2 + len(v) + 2
		}
	}
	return n
}

// getJSON fetches and decodes a JSON object body.
func getJSON(url string, header [2]string, timeout time.Duration) (pmap, error) {
	body, err := httpGet(url, header, timeout)
	if err != nil {
		return nil, err
	}
	var out any
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	if m, ok := out.(pmap); ok {
		return m, nil
	}
	return nil, fmt.Errorf("expected JSON object from %s", url)
}

// parseHeaderString turns a "Name: value" (or bare value) config string into a
// single header pair. A bare value uses the X-API-Key header. Returns ["",""] for
// an empty/invalid string (no header sent).
func parseHeaderString(headerValue string) [2]string {
	idx := strings.Index(headerValue, ":")
	if idx == -1 {
		trimmed := strings.TrimSpace(headerValue)
		if trimmed == "" {
			return [2]string{"", ""}
		}
		return [2]string{"X-API-Key", trimmed}
	}
	name := strings.TrimSpace(headerValue[:idx])
	value := strings.TrimSpace(headerValue[idx+1:])
	if name == "" || value == "" {
		return [2]string{"", ""}
	}
	return [2]string{name, value}
}
