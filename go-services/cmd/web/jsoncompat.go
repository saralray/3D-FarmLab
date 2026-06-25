package main

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
)

// jsoncompat.go re-serializes PostgreSQL `json`-typed output so it matches what
// the Node server emits. Node's `pg` driver parses each json/jsonb column with
// JSON.parse and the handler re-emits it with JSON.stringify, which (a) strips
// the spaces Postgres' json_build_object inserts ("a" : 1 → "a":1) and (b)
// normalizes numbers through JS Number (22.50 → 22.5, 60.00 → 60). Postgres'
// numeric ROUND(...) keeps trailing zeros, so a raw passthrough would diverge.
//
// jsCompact reproduces JSON.stringify(JSON.parse(x)): it walks the token stream
// (preserving object key order — Go maps would reorder), drops insignificant
// whitespace, and re-formats numbers via the shortest float repr, exactly like
// JS. On any parse error it returns the input unchanged.
func jsCompact(raw []byte) []byte {
	if len(raw) == 0 {
		return raw
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var buf bytes.Buffer
	if err := jsWriteValue(dec, &buf); err != nil {
		return raw
	}
	return buf.Bytes()
}

func jsWriteValue(dec *json.Decoder, buf *bytes.Buffer) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			buf.WriteByte('{')
			first := true
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					return err
				}
				if !first {
					buf.WriteByte(',')
				}
				first = false
				jsWriteString(keyTok.(string), buf)
				buf.WriteByte(':')
				if err := jsWriteValue(dec, buf); err != nil {
					return err
				}
			}
			if _, err := dec.Token(); err != nil { // consume '}'
				return err
			}
			buf.WriteByte('}')
		case '[':
			buf.WriteByte('[')
			first := true
			for dec.More() {
				if !first {
					buf.WriteByte(',')
				}
				first = false
				if err := jsWriteValue(dec, buf); err != nil {
					return err
				}
			}
			if _, err := dec.Token(); err != nil { // consume ']'
				return err
			}
			buf.WriteByte(']')
		}
	case string:
		jsWriteString(t, buf)
	case json.Number:
		jsWriteNumber(t, buf)
	case bool:
		if t {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case nil:
		buf.WriteString("null")
	}
	return nil
}

// jsWriteString emits a JSON string with JSON.stringify-compatible escaping: no
// HTML escaping of <, >, & (Go escapes those by default).
func jsWriteString(s string, buf *bytes.Buffer) {
	// json.Encoder appends a newline, so encode to a scratch buffer and trim it.
	var scratch bytes.Buffer
	enc := json.NewEncoder(&scratch)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	buf.Write(bytes.TrimRight(scratch.Bytes(), "\n"))
}

// jsWriteNumber emits a number the way JSON.stringify(JSON.parse(x)) would:
// integers verbatim (preserving precision for large ids), and any number with a
// fraction/exponent re-formatted through the shortest float repr (so 22.50→22.5,
// 60.00→60), matching JS Number formatting.
func jsWriteNumber(n json.Number, buf *bytes.Buffer) {
	s := n.String()
	if !strings.ContainsAny(s, ".eE") {
		buf.WriteString(s)
		return
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		buf.WriteString(s)
		return
	}
	b, err := json.Marshal(f)
	if err != nil {
		buf.WriteString(s)
		return
	}
	buf.Write(b)
}
