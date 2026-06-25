package main

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
)

// maintenance.go ports the read paths of the preventive-maintenance surface from
// server/postgres.js (getPrinterMaintenance, getMaintenanceSummary,
// listMaintenanceEvents, listMaintenanceNotifications, getMaintenanceDefaultIntervals).
//
// Unlike the printers/queue reads, the Node maintenance functions return raw `pg`
// rows (not json_build_object), so timestamptz columns arrive as JS Dates and are
// emitted by JSON.stringify as toISOString() (millisecond precision + 'Z'). The Go
// port scans typed columns and formats timestamps the same way (jsISO). Ordered
// structs reproduce the object key order Node emits.

// jsISO formats a timestamp the way JS Date.toISOString() does: UTC, exactly three
// fractional digits, trailing 'Z'. Returns nil for a NULL timestamp.
func jsISO(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.UTC().Format("2006-01-02T15:04:05.000") + "Z"
	return &s
}

// maintEvent mirrors maintenanceEventSelect()'s aliased columns, in order.
type maintEvent struct {
	ID               string   `json:"id"`
	PrinterID        string   `json:"printerId"`
	MaintenanceType  string   `json:"maintenanceType"`
	IntervalHours    *float64 `json:"intervalHours"`
	TriggeredAtHours *float64 `json:"triggeredAtHours"`
	CompletedAtHours *float64 `json:"completedAtHours"`
	Status           string   `json:"status"`
	Notes            *string  `json:"notes"`
	CreatedAt        *string  `json:"createdAt"`
	CompletedAt      *string  `json:"completedAt"`
}

// pendingEvent is a maintEvent decorated with overdue (classifyPendingEvent spreads
// {...event, overdue}, so overdue is the last key).
type pendingEvent struct {
	maintEvent
	Overdue bool `json:"overdue"`
}

func scanMaintEvents(rows pgx.Rows) ([]maintEvent, error) {
	defer rows.Close()
	out := []maintEvent{}
	for rows.Next() {
		var (
			e           maintEvent
			createdAt   time.Time
			completedAt *time.Time
		)
		if err := rows.Scan(&e.ID, &e.PrinterID, &e.MaintenanceType, &e.IntervalHours,
			&e.TriggeredAtHours, &e.CompletedAtHours, &e.Status, &e.Notes,
			&createdAt, &completedAt); err != nil {
			return nil, err
		}
		e.CreatedAt = jsISO(&createdAt)
		e.CompletedAt = jsISO(completedAt)
		out = append(out, e)
	}
	return out, rows.Err()
}

const maintEventSelect = `
    id,
    printer_id,
    maintenance_type,
    interval_hours,
    triggered_at_hours,
    completed_at_hours,
    status,
    notes,
    created_at,
    completed_at`

// listMaintenanceEvents mirrors the like-named export: optional printer/status/type
// filters, capped limit, pending-first ordering.
func listMaintenanceEvents(ctx context.Context, printerID, status, maintenanceType string, limit int) ([]maintEvent, error) {
	conds := ""
	args := []any{}
	add := func(col, val string) {
		if val == "" {
			return
		}
		args = append(args, val)
		if conds == "" {
			conds = "WHERE "
		} else {
			conds += " AND "
		}
		conds += col + " = $" + itoa(len(args))
	}
	add("printer_id", printerID)
	add("status", status)
	add("maintenance_type", maintenanceType)

	if limit <= 0 {
		limit = 500
	}
	limit = clampInt(limit, 1, 5000)
	args = append(args, limit)

	rows, err := dbPool.Query(ctx, `SELECT `+maintEventSelect+`
     FROM maintenance_events
     `+conds+`
     ORDER BY (status = 'pending') DESC, created_at DESC
     LIMIT $`+itoa(len(args))+`;`, args...)
	if err != nil {
		return nil, err
	}
	return scanMaintEvents(rows)
}

// maintNotification mirrors listMaintenanceNotifications' selected columns, in order.
type maintNotification struct {
	ID        string  `json:"id"`
	PrinterID *string `json:"printerId"`
	Kind      string  `json:"kind"`
	Title     string  `json:"title"`
	Body      *string `json:"body"`
	Read      bool    `json:"read"`
	CreatedAt *string `json:"createdAt"`
}

func listMaintenanceNotifications(ctx context.Context, unreadOnly bool, limit int) ([]maintNotification, error) {
	where := ""
	if unreadOnly {
		where = "WHERE read = FALSE"
	}
	if limit <= 0 {
		limit = 100
	}
	limit = clampInt(limit, 1, 500)
	rows, err := dbPool.Query(ctx, `SELECT id, printer_id, kind, title, body, read, created_at
     FROM maintenance_notifications
     `+where+`
     ORDER BY created_at DESC
     LIMIT $1;`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []maintNotification{}
	for rows.Next() {
		var (
			n         maintNotification
			createdAt time.Time
		)
		if err := rows.Scan(&n.ID, &n.PrinterID, &n.Kind, &n.Title, &n.Body, &n.Read, &createdAt); err != nil {
			return nil, err
		}
		n.CreatedAt = jsISO(&createdAt)
		out = append(out, n)
	}
	return out, rows.Err()
}

// maintenanceSummary mirrors getMaintenanceSummary's output object, in order.
type maintenanceSummary struct {
	PrintersRequiringMaintenance int     `json:"printersRequiringMaintenance"`
	OverdueTasks                 int     `json:"overdueTasks"`
	AverageHealth                float64 `json:"averageHealth"`
	TotalFleetHours              float64 `json:"totalFleetHours"`
	PrinterCount                 int     `json:"printerCount"`
}

func getMaintenanceSummary(ctx context.Context) (maintenanceSummary, error) {
	var s maintenanceSummary
	err := dbPool.QueryRow(ctx, `WITH pending AS (
       SELECT e.printer_id,
              bool_or(p.total_print_hours
                      >= e.triggered_at_hours + GREATEST(e.interval_hours * 0.1, 10)) AS has_overdue,
              count(*) AS pending_count,
              count(*) FILTER (
                WHERE p.total_print_hours
                      >= e.triggered_at_hours + GREATEST(e.interval_hours * 0.1, 10)
              ) AS overdue_count
       FROM maintenance_events e
       JOIN printers p ON p.id = e.printer_id
       WHERE e.status = 'pending'
       GROUP BY e.printer_id
     )
     SELECT
       (SELECT count(*) FROM pending WHERE pending_count > 0) AS printers_requiring_maintenance,
       (SELECT COALESCE(sum(overdue_count), 0) FROM pending) AS overdue_tasks,
       (SELECT COALESCE(round(avg(health_score)), 0) FROM printers) AS average_health,
       (SELECT COALESCE(round(sum(total_print_hours)::numeric, 2), 0) FROM printers) AS total_fleet_hours,
       (SELECT count(*) FROM printers) AS printer_count;`).
		Scan(&s.PrintersRequiringMaintenance, &s.OverdueTasks, &s.AverageHealth, &s.TotalFleetHours, &s.PrinterCount)
	if err != nil {
		return s, err
	}
	return s, nil
}

// printerMaintenance mirrors getPrinterMaintenance's output object, in order.
type printerMaintenance struct {
	PrinterID         string         `json:"printerId"`
	PrinterName       string         `json:"printerName"`
	TotalHours        float64        `json:"totalHours"`
	NozzleHours       float64        `json:"nozzleHours"`
	HealthScore       int            `json:"healthScore"`
	HealthStatus      string         `json:"healthStatus"`
	LastMaintenanceAt *string        `json:"lastMaintenanceAt"`
	PendingTasks      []pendingEvent `json:"pendingTasks"`
	CompletedTasks    []maintEvent   `json:"completedTasks"`
	NextService       *nextService   `json:"nextService"`
}

type nextService struct {
	Type           string  `json:"type"`
	IntervalHours  float64 `json:"intervalHours"`
	RemainingHours float64 `json:"remainingHours"`
}

type maintSchedule struct {
	maintenanceType string
	intervalHours   float64
	enabled         bool
}

// getPrinterMaintenance mirrors the like-named export. Returns nil when the printer
// is unknown (→ 404).
func getPrinterMaintenance(ctx context.Context, printerID string) (*printerMaintenance, error) {
	var (
		id, name          string
		totalHours        float64
		currentNozzleHrs  float64
		successRate       float64
		healthScore       int
		lastMaintenanceAt *time.Time
	)
	err := dbPool.QueryRow(ctx, `SELECT id, name,
            total_print_hours, current_nozzle_hours, success_rate, health_score, last_maintenance_at
     FROM printers WHERE id = $1;`, printerID).
		Scan(&id, &name, &totalHours, &currentNozzleHrs, &successRate, &healthScore, &lastMaintenanceAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	schedules, err := listMaintenanceSchedules(ctx, printerID)
	if err != nil {
		return nil, err
	}
	events, err := listMaintenanceEvents(ctx, printerID, "", "", 500)
	if err != nil {
		return nil, err
	}

	pending := []pendingEvent{}
	completed := []maintEvent{}
	for _, e := range events {
		switch e.Status {
		case "pending":
			pending = append(pending, pendingEvent{maintEvent: e, Overdue: isOverdue(e, totalHours)})
		case "completed":
			completed = append(completed, e)
		}
	}

	// next_service: the enabled schedule whose next interval multiple is soonest.
	var next *nextService
	for _, s := range schedules {
		if !s.enabled || s.intervalHours <= 0 {
			continue
		}
		nextMultiple := (math.Floor(totalHours/s.intervalHours) + 1) * s.intervalHours
		remaining := math.Max(0, nextMultiple-totalHours)
		if next == nil || remaining < next.RemainingHours {
			next = &nextService{Type: s.maintenanceType, IntervalHours: s.intervalHours, RemainingHours: remaining}
		}
	}

	lubricationOverdue := false
	anyTaskOverdue := false
	for _, e := range pending {
		if e.Overdue {
			anyTaskOverdue = true
			if matchLubric(e.MaintenanceType) {
				lubricationOverdue = true
			}
		}
	}
	nozzleOverdue := currentNozzleHrs > 1000
	highFailureRate := 100-successRate > 10
	score := recalcHealthScore(lubricationOverdue, nozzleOverdue, anyTaskOverdue, highFailureRate)

	return &printerMaintenance{
		PrinterID:         id,
		PrinterName:       name,
		TotalHours:        round2(totalHours),
		NozzleHours:       round2(currentNozzleHrs),
		HealthScore:       score,
		HealthStatus:      healthStatusFromScore(score),
		LastMaintenanceAt: jsISO(lastMaintenanceAt),
		PendingTasks:      pending,
		CompletedTasks:    completed,
		NextService:       next,
	}, nil
}

func listMaintenanceSchedules(ctx context.Context, printerID string) ([]maintSchedule, error) {
	rows, err := dbPool.Query(ctx, `SELECT maintenance_type, interval_hours, enabled
     FROM maintenance_schedules
     WHERE printer_id = $1
     ORDER BY interval_hours ASC;`, printerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []maintSchedule{}
	for rows.Next() {
		var s maintSchedule
		if err := rows.Scan(&s.maintenanceType, &s.intervalHours, &s.enabled); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// isOverdue mirrors classifyPendingEvent: overdue once totalHours has passed the
// trigger point plus the grace window (max(interval*0.1, 10)).
func isOverdue(e maintEvent, totalHours float64) bool {
	interval := derefFloat(e.IntervalHours)
	trig := derefFloat(e.TriggeredAtHours)
	grace := math.Max(interval*0.1, 10)
	return totalHours >= trig+grace
}

// recalcHealthScore / healthStatusFromScore mirror the like-named exports.
func recalcHealthScore(lubricationOverdue, nozzleOverdue, anyTaskOverdue, highFailureRate bool) int {
	score := 100
	if lubricationOverdue {
		score -= 5
	}
	if nozzleOverdue {
		score -= 10
	}
	if anyTaskOverdue {
		score -= 15
	}
	if highFailureRate {
		score -= 10
	}
	return clampInt(score, 0, 100)
}

func healthStatusFromScore(score int) string {
	switch {
	case score >= 90:
		return "Excellent"
	case score >= 70:
		return "Good"
	case score >= 50:
		return "Warning"
	default:
		return "Service Required"
	}
}

// maintenanceInterval mirrors a row in the default-intervals list.
type maintenanceInterval struct {
	Type          string  `json:"type"`
	IntervalHours float64 `json:"intervalHours"`
	Description   string  `json:"description"`
}

// defaultMaintenanceIntervals mirrors DEFAULT_MAINTENANCE_INTERVALS.
var defaultMaintenanceIntervals = []maintenanceInterval{
	{"Basic Inspection", 50, "Basic inspection; clean build plate; inspect nozzle"},
	{"Extruder & Fans", 100, "Clean extruder gears; check fans; inspect belts"},
	{"Lubrication", 250, "Lubricate rods / rails; check screws"},
	{"Deep Clean", 500, "Deep clean toolhead; inspect wiring"},
	{"Nozzle Service", 1000, "Nozzle inspection / replacement"},
	{"Full Service", 2000, "Full maintenance service"},
}

// getMaintenanceDefaultIntervals mirrors the export: normalize the stored value,
// falling back to the shipped defaults.
func getMaintenanceDefaultIntervals(ctx context.Context) ([]maintenanceInterval, error) {
	stored, err := getAppSetting(ctx, "maintenance_default_intervals")
	if err != nil {
		return nil, err
	}
	return normalizeIntervals(stored), nil
}

// normalizeIntervals mirrors normalizeIntervals in server/postgres.js.
func normalizeIntervals(raw json.RawMessage) []maintenanceInterval {
	if isJSONNull(raw) {
		return defaultMaintenanceIntervals
	}
	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err != nil {
		return defaultMaintenanceIntervals
	}
	cleaned := []maintenanceInterval{}
	for _, row := range rows {
		typ := trimString(row["type"])
		desc := trimString(row["description"])
		hours, ok := toFloat(row["intervalHours"])
		if typ == "" || !ok || math.IsNaN(hours) || math.IsInf(hours, 0) || hours <= 0 {
			continue
		}
		cleaned = append(cleaned, maintenanceInterval{Type: typ, IntervalHours: hours, Description: desc})
	}
	if len(cleaned) == 0 {
		return defaultMaintenanceIntervals
	}
	return cleaned
}
