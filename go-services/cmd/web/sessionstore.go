package main

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// sessionstore.go ports the session, staff-user, and audit-log DB helpers from
// server/postgres.js + server/app.js that the auth surface needs.

// sessionRow mirrors the columns getSession returns (snake_case to match the
// Node session object the handlers read: session.user_id etc.).
type sessionRow struct {
	UserID   string
	Username string
	Name     string
	Role     string
}

func createSession(ctx context.Context, tokenHash, userID, username, name, role string, expiresAt time.Time, ip *string) error {
	_, err := dbPool.Exec(ctx,
		`INSERT INTO sessions (token_hash, user_id, username, name, role, expires_at, created_ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (token_hash) DO NOTHING;`,
		tokenHash, userID, username, name, role, expiresAt, ip)
	return err
}

// getSession resolves a session by token hash, returning nil when absent or
// expired (and opportunistically deleting the expired row), mirroring getSession.
func getSession(ctx context.Context, tokenHash string) (*sessionRow, error) {
	var s sessionRow
	err := dbPool.QueryRow(ctx,
		`SELECT user_id, username, name, role
     FROM sessions
     WHERE token_hash = $1 AND expires_at > NOW();`, tokenHash).
		Scan(&s.UserID, &s.Username, &s.Name, &s.Role)
	if errors.Is(err, pgx.ErrNoRows) {
		// Best-effort cleanup of the matching expired row.
		go func() {
			c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, _ = dbPool.Exec(c, `DELETE FROM sessions WHERE token_hash = $1 AND expires_at <= NOW();`, tokenHash)
		}()
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func deleteSession(ctx context.Context, tokenHash string) error {
	_, err := dbPool.Exec(ctx, `DELETE FROM sessions WHERE token_hash = $1;`, tokenHash)
	return err
}

func deleteSessionsForUser(ctx context.Context, userID string) error {
	_, err := dbPool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1;`, userID)
	return err
}

// staffUser mirrors a record in the staff_users app_settings array.
type staffUser struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Username     string `json:"username"`
	Role         string `json:"role"`
	PasswordHash string `json:"passwordHash"`
}

// readStaffUsers returns the stored staff-user list, or empty when unset.
func readStaffUsers(ctx context.Context) ([]staffUser, error) {
	raw, err := getAppSetting(ctx, "staff_users")
	if err != nil {
		return nil, err
	}
	if isJSONNull(raw) {
		return nil, nil
	}
	var users []staffUser
	if err := json.Unmarshal(raw, &users); err != nil {
		return nil, nil
	}
	return users, nil
}

// auditEntry mirrors the fields recordAuditLog accepts.
type auditEntry struct {
	ActorName     *string
	ActorUsername *string
	ActorRole     *string
	Action        string
	Target        *string
	Details       any
	Source        string
	IP            *string
}

// recordAuditLog inserts an audit row, mirroring recordAuditLog in postgres.js.
func recordAuditLog(ctx context.Context, e auditEntry) error {
	if e.Source == "" {
		e.Source = "web"
	}
	var details *string
	if e.Details != nil {
		b, err := json.Marshal(e.Details)
		if err == nil {
			s := string(b)
			details = &s
		}
	}
	_, err := dbPool.Exec(ctx,
		`INSERT INTO audit_logs
       (actor_name, actor_username, actor_role, action, target, details, source, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
		e.ActorName, e.ActorUsername, e.ActorRole, e.Action, e.Target, details, e.Source, e.IP)
	return err
}
