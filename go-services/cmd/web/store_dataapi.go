package main

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
)

// store_dataapi.go ports the server/postgres.js functions the key-gated /api/v1
// data API needs that weren't required by the frontend phases: queue
// upsert/migration, Discord webhook CRUD, slicer-key CRUD, and the manager-request
// store. Each runs the same SQL as its Node counterpart so results stay
// byte-identical; the JSON-shaped reads scan a single json column straight into
// json.RawMessage (emitted verbatim), the typed reads scan named columns.

// ── Queue: upsert / migration ────────────────────────────────────────────────

// upsertQueueJobs mirrors postgres.js upsertQueueJobs: insert-or-update a batch
// of jobs and return the JSON array of the rows that were newly created (the
// `added` payload). An empty input yields the empty array.
func upsertQueueJobs(ctx context.Context, jobs json.RawMessage) (json.RawMessage, error) {
	if !allArraysHasElems(jobs) {
		return json.RawMessage("[]"), nil
	}
	return scanJSON(ctx, `
    WITH input AS (
      SELECT jsonb_array_elements($1::jsonb) AS data
    ),
    normalized AS (
      SELECT
        data->>'id' AS id,
        COALESCE(data->>'filename', '') AS filename,
        COALESCE((data->>'fileCount')::integer, 1) AS file_count,
        NULLIF(data->>'stlFileUrl', '') AS stl_file_url,
        NULLIF(data->>'submitterName', '') AS submitter_name,
        NULLIF(data->>'submitterEmail', '') AS submitter_email,
        NULLIF(data->>'notes', '') AS notes,
        CASE
          WHEN COALESCE(data->>'submittedAt', '') = '' THEN NULL
          ELSE (data->>'submittedAt')::timestamptz
        END AS submitted_at,
        COALESCE(data->>'priority', 'low') AS priority,
        COALESCE((data->>'estimatedTime')::integer, 0) AS estimated_time,
        COALESCE(data->>'formType', '') AS form_type,
        COALESCE((data->>'printedStatus')::integer, 0) AS printed_status
      FROM input
    ),
    existing AS (
      SELECT id
      FROM queue_jobs
      WHERE id IN (SELECT id FROM normalized)
    ),
    upserted AS (
    INSERT INTO queue_jobs (
      id, filename, file_count, stl_file_url, submitter_name, submitter_email,
      notes, submitted_at, priority, estimated_time, form_type, printed_status
    )
    SELECT
      id, filename, file_count, stl_file_url, submitter_name, submitter_email,
      notes, submitted_at, priority, estimated_time, form_type, printed_status
    FROM normalized
    ON CONFLICT (id) DO UPDATE SET
      filename = EXCLUDED.filename,
      file_count = EXCLUDED.file_count,
      stl_file_url = EXCLUDED.stl_file_url,
      submitter_name = EXCLUDED.submitter_name,
      submitter_email = EXCLUDED.submitter_email,
      notes = EXCLUDED.notes,
      submitted_at = EXCLUDED.submitted_at,
      priority = EXCLUDED.priority,
      estimated_time = EXCLUDED.estimated_time,
      form_type = EXCLUDED.form_type,
      updated_at = NOW()
    RETURNING
      id, filename, file_count, stl_file_url, submitter_name, submitter_email,
      notes, submitted_at, priority, estimated_time, form_type, printed_status
    )
    SELECT COALESCE(
      json_agg(
        json_build_object(
          'id', id,
          'filename', filename,
          'fileCount', file_count,
          'printedStatus', printed_status,
          'status', CASE WHEN printed_status = 1 THEN 'completed' ELSE 'queued' END,
          'progress', 0,
          'estimatedTime', estimated_time,
          'timeRemaining', estimated_time,
          'filamentUsed', 0,
          'priority', priority,
          'stlFileUrl', stl_file_url,
          'submitterName', submitter_name,
          'submitterEmail', submitter_email,
          'notes', notes,
          'submittedAt', CASE WHEN submitted_at IS NULL THEN NULL ELSE to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
        )
        ORDER BY submitted_at ASC NULLS LAST
      ),
      '[]'::json
    ) AS data
    FROM upserted
    WHERE id NOT IN (SELECT id FROM existing);
  `, string(jobs))
}

// deleteQueueJobsBulk mirrors postgres.js deleteQueueJobs (the plural, id-array
// form): soft-delete a set of jobs and return how many rows were affected.
func deleteQueueJobsBulk(ctx context.Context, ids []string) (int, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	tag, err := dbPool.Exec(ctx, `
    UPDATE queue_jobs
    SET deleted_at = NOW(), updated_at = NOW()
    WHERE id = ANY($1::text[]) AND deleted_at IS NULL;
  `, ids)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// exportQueueJobs mirrors postgres.js exportQueueJobs: a metadata-only manifest
// of stored jobs for host→host migration. Pending only unless includePrinted; a
// non-empty ids selection overrides the printed filter.
func exportQueueJobs(ctx context.Context, includePrinted bool, ids []string) (json.RawMessage, error) {
	var idFilter any
	if len(ids) > 0 {
		idFilter = ids
	}
	return scanJSON(ctx, `
    SELECT COALESCE(
      json_agg(
        json_build_object(
          'id', id,
          'filename', filename,
          'fileCount', file_count,
          'printedStatus', printed_status,
          'estimatedTime', estimated_time,
          'priority', priority,
          'stlFileUrl', stl_file_url,
          'submitterName', submitter_name,
          'submitterEmail', submitter_email,
          'notes', notes,
          'submittedAt', CASE WHEN submitted_at IS NULL THEN NULL ELSE to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
          'hasFile', COALESCE(file_size_bytes, 0) > 0,
          'fileMime', file_mime,
          'fileSize', COALESCE(file_size_bytes, 0)
        )
        ORDER BY submitted_at ASC NULLS LAST, created_at ASC
      ),
      '[]'::json
    ) AS data
    FROM queue_jobs
    WHERE form_type = $1
      AND deleted_at IS NULL
      AND (
        CASE
          WHEN $3::text[] IS NOT NULL THEN id = ANY($3::text[])
          ELSE ($2::boolean OR printed_status = 0)
        END
      );
  `, queueFormType, includePrinted, idFilter)
}

// importQueueJobs mirrors postgres.js importQueueJobs: recreate rows from a
// migration manifest (preserving ids/printedStatus/submittedAt) and return the
// number of rows written.
func importQueueJobs(ctx context.Context, jobs json.RawMessage) (int, error) {
	if !allArraysHasElems(jobs) {
		return 0, nil
	}
	var count int
	err := dbPool.QueryRow(ctx, `
    WITH input AS (
      SELECT jsonb_array_elements($1::jsonb) AS data
    ),
    normalized AS (
      SELECT
        data->>'id' AS id,
        COALESCE(data->>'filename', '') AS filename,
        COALESCE((data->>'fileCount')::integer, 1) AS file_count,
        NULLIF(data->>'stlFileUrl', '') AS stl_file_url,
        NULLIF(data->>'submitterName', '') AS submitter_name,
        NULLIF(data->>'submitterEmail', '') AS submitter_email,
        NULLIF(data->>'notes', '') AS notes,
        CASE
          WHEN COALESCE(data->>'submittedAt', '') = '' THEN NULL
          ELSE (data->>'submittedAt')::timestamptz
        END AS submitted_at,
        COALESCE(data->>'priority', 'low') AS priority,
        COALESCE((data->>'estimatedTime')::integer, 0) AS estimated_time,
        COALESCE((data->>'printedStatus')::integer, 0) AS printed_status
      FROM input
      WHERE COALESCE(data->>'id', '') <> ''
    ),
    upserted AS (
      INSERT INTO queue_jobs (
        id, filename, file_count, stl_file_url, submitter_name, submitter_email,
        notes, submitted_at, priority, estimated_time, form_type, printed_status
      )
      SELECT
        id, filename, file_count, stl_file_url, submitter_name, submitter_email,
        notes, submitted_at, priority, estimated_time, $2, printed_status
      FROM normalized
      ON CONFLICT (id) DO UPDATE SET
        filename = EXCLUDED.filename,
        file_count = EXCLUDED.file_count,
        stl_file_url = EXCLUDED.stl_file_url,
        submitter_name = EXCLUDED.submitter_name,
        submitter_email = EXCLUDED.submitter_email,
        notes = EXCLUDED.notes,
        submitted_at = EXCLUDED.submitted_at,
        priority = EXCLUDED.priority,
        estimated_time = EXCLUDED.estimated_time,
        printed_status = EXCLUDED.printed_status,
        form_type = EXCLUDED.form_type,
        deleted_at = NULL,
        updated_at = NOW()
      RETURNING id
    )
    SELECT COUNT(*)::int AS count FROM upserted;
  `, string(jobs), queueFormType).Scan(&count)
	if err != nil {
		return 0, err
	}
	return count, nil
}

// setQueueJobFile mirrors postgres.js setQueueJobFile: attach model bytes to an
// existing (non-deleted) job. Returns true when a row was updated.
func setQueueJobFile(ctx context.Context, id string, content []byte, mime string) (bool, error) {
	if mime == "" {
		mime = "application/octet-stream"
	}
	tag, err := dbPool.Exec(ctx, `
    UPDATE queue_jobs
    SET file_content = $2, file_mime = $3, file_size_bytes = $4, updated_at = NOW()
    WHERE id = $1 AND deleted_at IS NULL;
  `, id, content, mime, len(content))
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// ── Discord webhooks ─────────────────────────────────────────────────────────

func listDiscordWebhooksJSON(ctx context.Context) (json.RawMessage, error) {
	return scanJSON(ctx, `
    SELECT COALESCE(
      json_agg(
        json_build_object(
          'id', id,
          'name', name,
          'webhookUrl', webhook_url,
          'events', events,
          'enabled', enabled,
          'tts', tts,
          'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
        ORDER BY created_at ASC
      ),
      '[]'::json
    ) AS data
    FROM discord_webhooks;`)
}

func createDiscordWebhook(ctx context.Context, webhook json.RawMessage) error {
	_, err := dbPool.Exec(ctx, `
    WITH input AS (
      SELECT $1::jsonb AS data
    )
    INSERT INTO discord_webhooks (id, name, webhook_url, events, enabled, tts)
    SELECT
      data->>'id',
      data->>'name',
      data->>'webhookUrl',
      CASE WHEN jsonb_typeof(data->'events') = 'array' THEN data->'events' ELSE NULL END,
      COALESCE((data->>'enabled')::boolean, TRUE),
      COALESCE((data->>'tts')::boolean, FALSE)
    FROM input
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      webhook_url = EXCLUDED.webhook_url,
      events = EXCLUDED.events,
      enabled = EXCLUDED.enabled,
      tts = EXCLUDED.tts;
  `, string(webhook))
	return err
}

func deleteDiscordWebhook(ctx context.Context, id string) error {
	_, err := dbPool.Exec(ctx, `DELETE FROM discord_webhooks WHERE id = $1;`, id)
	return err
}

// ── Slicer API keys ──────────────────────────────────────────────────────────

// slicerKeyRecord mirrors the row findSlicerApiKeyByHash returns (id/name plus
// the permission scopes).
type slicerKeyRecord struct {
	ID          string
	Name        string
	Permissions []string
}

func listSlicerApiKeysJSON(ctx context.Context) (json.RawMessage, error) {
	return scanJSON(ctx, `
    SELECT COALESCE(
      json_agg(
        json_build_object(
          'id', id,
          'name', name,
          'keyPrefix', key_prefix,
          'permissions', permissions,
          'lastUsedAt', to_char(last_used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
        ORDER BY created_at ASC
      ),
      '[]'::json
    ) AS data
    FROM slicer_api_keys
    WHERE session_token_hash IS NULL;`)
}

func createSlicerApiKey(ctx context.Context, id, name, keyHash, keyPrefix string, permissions []string, sessionTokenHash *string) error {
	if permissions == nil {
		permissions = []string{}
	}
	permJSON, _ := json.Marshal(permissions)
	_, err := dbPool.Exec(ctx,
		`INSERT INTO slicer_api_keys (id, name, key_hash, key_prefix, permissions, session_token_hash)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6);`,
		id, name, keyHash, keyPrefix, string(permJSON), sessionTokenHash)
	return err
}

func deleteSlicerApiKey(ctx context.Context, id string) error {
	_, err := dbPool.Exec(ctx, `DELETE FROM slicer_api_keys WHERE id = $1;`, id)
	return err
}

// deleteSlicerApiKeysBySession drops any session-bound slicer key for a session
// token (used by the slicer-token mint/revoke). A blank hash is a no-op, matching
// the Node guard.
func deleteSlicerApiKeysBySession(ctx context.Context, sessionTokenHash string) error {
	if sessionTokenHash == "" {
		return nil
	}
	_, err := dbPool.Exec(ctx, `DELETE FROM slicer_api_keys WHERE session_token_hash = $1;`, sessionTokenHash)
	return err
}

func findSlicerApiKeyByHash(ctx context.Context, keyHash string) (*slicerKeyRecord, error) {
	var rec slicerKeyRecord
	var perms json.RawMessage
	err := dbPool.QueryRow(ctx,
		`SELECT id, name, permissions FROM slicer_api_keys WHERE key_hash = $1;`, keyHash).
		Scan(&rec.ID, &rec.Name, &perms)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(perms) > 0 {
		_ = json.Unmarshal(perms, &rec.Permissions)
	}
	return &rec, nil
}

func touchSlicerApiKey(ctx context.Context, id string) error {
	_, err := dbPool.Exec(ctx, `UPDATE slicer_api_keys SET last_used_at = NOW() WHERE id = $1;`, id)
	return err
}

// ── Manager requests ─────────────────────────────────────────────────────────

// managerRequestRow mirrors the typed row getManagerRequest returns (used both
// for control-flow checks and for the GET response, which emits it verbatim with
// the SQL's snake_case column names — incl. key_secret, since the key is the
// guard here).
type managerRequestRow struct {
	ID          string
	Name        string
	Description *string
	Status      string
	APIKeyID    *string
	KeySecret   *string
	CreatedAt   *string
	UpdatedAt   *string
}

// asOrderedJSON emits the row the way Node's sendJson(res, 200, mgr) does: the
// raw pg row, keys in SELECT order.
func (r *managerRequestRow) asOrderedJSON() ojson {
	return ojson{
		{"id", r.ID},
		{"name", r.Name},
		{"description", r.Description},
		{"status", r.Status},
		{"api_key_id", r.APIKeyID},
		{"key_secret", r.KeySecret},
		{"created_at", r.CreatedAt},
		{"updated_at", r.UpdatedAt},
	}
}

func createManagerRequest(ctx context.Context, id, name string, description *string) error {
	_, err := dbPool.Exec(ctx,
		`INSERT INTO manager_requests (id, name, description) VALUES ($1, $2, $3)`,
		id, name, description)
	return err
}

func getManagerRequest(ctx context.Context, id string) (*managerRequestRow, error) {
	var r managerRequestRow
	err := dbPool.QueryRow(ctx,
		`SELECT id, name, description, status, api_key_id, key_secret,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
     FROM manager_requests WHERE id = $1`, id).
		Scan(&r.ID, &r.Name, &r.Description, &r.Status, &r.APIKeyID, &r.KeySecret, &r.CreatedAt, &r.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func listManagerRequestsJSON(ctx context.Context) (json.RawMessage, error) {
	return scanJSON(ctx, `
    SELECT COALESCE(
      json_agg(
        json_build_object(
          'id', id,
          'name', name,
          'description', description,
          'status', status,
          'apiKeyId', api_key_id,
          'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'updatedAt', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )
        ORDER BY created_at DESC
      ),
      '[]'::json
    ) AS data
    FROM manager_requests
    WHERE status != 'revoked';`)
}

func approveManagerRequest(ctx context.Context, id, apiKeyID, keySecret string) error {
	_, err := dbPool.Exec(ctx,
		`UPDATE manager_requests
     SET status = 'approved', api_key_id = $2, key_secret = $3, updated_at = NOW()
     WHERE id = $1`, id, apiKeyID, keySecret)
	return err
}

// clearManagerRequestKeySecret blanks the one-time key after the status poll has
// revealed it (mirrors postgres.js clearManagerRequestKeySecret).
func clearManagerRequestKeySecret(ctx context.Context, id string) error {
	_, err := dbPool.Exec(ctx,
		`UPDATE manager_requests SET key_secret = NULL, updated_at = NOW() WHERE id = $1`, id)
	return err
}

func denyManagerRequest(ctx context.Context, id string) error {
	_, err := dbPool.Exec(ctx,
		`UPDATE manager_requests SET status = 'denied', updated_at = NOW() WHERE id = $1`, id)
	return err
}

func deleteManagerRequest(ctx context.Context, id string) error {
	_, err := dbPool.Exec(ctx, `DELETE FROM manager_requests WHERE id = $1`, id)
	return err
}

// allArraysHasElems reports whether raw is a JSON array with at least one
// element — mirroring Node's `Array.isArray(jobs) && jobs.length > 0` short
// circuit before the upsert/import SQL runs.
func allArraysHasElems(raw json.RawMessage) bool {
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		return false
	}
	return len(arr) > 0
}
