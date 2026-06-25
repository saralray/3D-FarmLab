// Package metrics is a tiny, dependency-free Prometheus text-format writer. It
// reproduces the subset of the exposition format the print-farm exporter needs
// (gauges and counters with labels) so the Go exporter has no client library and
// stays low-memory, matching the hand-rolled approach already used in
// server/metrics.js.
package metrics

import (
	"sort"
	"strconv"
	"strings"
)

// Family accumulates the samples for one metric name before they are rendered
// together under a single # HELP / # TYPE header (as the format requires).
type Family struct {
	Name    string
	Help    string
	Type    string // "gauge" or "counter"
	samples []sample
}

type sample struct {
	labelNames  []string
	labelValues []string
	value       float64
}

// Writer collects metric families and renders them in insertion order.
type Writer struct {
	families []*Family
	index    map[string]*Family
}

// NewWriter returns an empty Writer.
func NewWriter() *Writer {
	return &Writer{index: map[string]*Family{}}
}

func (w *Writer) family(name, help, typ string) *Family {
	if f, ok := w.index[name]; ok {
		return f
	}
	f := &Family{Name: name, Help: help, Type: typ}
	w.index[name] = f
	w.families = append(w.families, f)
	return f
}

// Gauge appends a labelled gauge sample, creating the family on first use.
func (w *Writer) Gauge(name, help string, value float64, labelNames, labelValues []string) {
	f := w.family(name, help, "gauge")
	f.samples = append(f.samples, sample{labelNames, labelValues, value})
}

// Counter appends a counter sample. Following prometheus_client semantics, the
// rendered metric name (HELP, TYPE and sample) carries the _total suffix.
func (w *Writer) Counter(name, help string, value float64) {
	full := name + "_total"
	f := w.family(full, help, "counter")
	f.samples = append(f.samples, sample{nil, nil, value})
}

// String renders all families in the Prometheus text exposition format.
func (w *Writer) String() string {
	var b strings.Builder
	for _, f := range w.families {
		b.WriteString("# HELP ")
		b.WriteString(f.Name)
		b.WriteByte(' ')
		b.WriteString(escapeHelp(f.Help))
		b.WriteByte('\n')
		b.WriteString("# TYPE ")
		b.WriteString(f.Name)
		b.WriteByte(' ')
		b.WriteString(f.Type)
		b.WriteByte('\n')
		for _, s := range f.samples {
			b.WriteString(f.Name)
			writeLabels(&b, s.labelNames, s.labelValues)
			b.WriteByte(' ')
			b.WriteString(formatFloat(s.value))
			b.WriteByte('\n')
		}
	}
	return b.String()
}

func writeLabels(b *strings.Builder, names, values []string) {
	if len(names) == 0 {
		return
	}
	// Render labels in alphabetical order by name, matching prometheus_client so
	// the exposition is byte-identical to the Python exporter (label order is not
	// semantically significant to Prometheus, but keeping it identical avoids any
	// surprises in line-based tooling).
	order := make([]int, len(names))
	for i := range order {
		order[i] = i
	}
	sort.Slice(order, func(a, c int) bool { return names[order[a]] < names[order[c]] })

	b.WriteByte('{')
	for i, idx := range order {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(names[idx])
		b.WriteString(`="`)
		b.WriteString(escapeLabel(values[idx]))
		b.WriteByte('"')
	}
	b.WriteByte('}')
}

func formatFloat(v float64) string {
	return strconv.FormatFloat(v, 'g', -1, 64)
}

func escapeLabel(s string) string {
	if !strings.ContainsAny(s, "\\\"\n") {
		return s
	}
	r := strings.NewReplacer("\\", "\\\\", "\"", "\\\"", "\n", "\\n")
	return r.Replace(s)
}

func escapeHelp(s string) string {
	if !strings.ContainsAny(s, "\\\n") {
		return s
	}
	r := strings.NewReplacer("\\", "\\\\", "\n", "\\n")
	return r.Replace(s)
}

// SortFamilies is unused by the exporter (insertion order is kept) but available
// for callers that want deterministic output.
func (w *Writer) SortFamilies() {
	sort.Slice(w.families, func(i, j int) bool {
		return w.families[i].Name < w.families[j].Name
	})
}
