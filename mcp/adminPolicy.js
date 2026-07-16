// AI-agent least-privilege policy for the admin escape-hatch (S-5 / section 10).
//
// printfarm_admin_request can issue a raw request to ANY /api/v1 path. Even
// though the web tier enforces the caller's key scope (a printfarm_read/control
// key already can't reach these surfaces), an operator who hands the agent a
// full printfarm_manage key would otherwise let a prompt-injected model mint
// itself a new API key, reset the admin password, create a backdoor staff
// account, approve a manager key, or tamper with security settings — i.e.
// escalate its own privileges or exfiltrate secrets.
//
// This is defense-in-depth in the MCP layer: by default the escape-hatch may
// READ any admin surface but may NOT WRITE to the privilege-escalation /
// credential / secret-minting surfaces below. Dedicated, curated tools
// (printers, queue, maintenance, analytics, notifications, status) are
// unaffected. An operator who genuinely wants the agent to perform these admin
// writes sets MCP_ADMIN_MODE=full to restore the previous behavior.

// Resource segments (first path element after /api/v1/) whose WRITES are the
// crown-jewel escalation vectors.
const RESTRICTED_WRITE_RESOURCES = new Set([
  'slicer-keys', // mint/revoke API keys — returns a one-time secret; self-escalation
  'users', // create/delete staff accounts / set passwords — backdoor accounts
  'admin-credential', // reset the admin password — account takeover
  'manager-requests', // approve → mints a printfarm_manage key
  'settings', // change SAML/SSO/security config — auth tamper
]);

export function adminMode() {
  return (process.env.MCP_ADMIN_MODE || 'restricted').toLowerCase() === 'full'
    ? 'full'
    : 'restricted';
}

// Decide whether the escape-hatch may perform (method, path). Returns
// { allowed: true } or { allowed: false, reason }.
export function classifyAdminRequest(method, path, mode = adminMode()) {
  if (mode === 'full') {
    return { allowed: true };
  }
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD') {
    return { allowed: true }; // reads are allowed (still key-scoped server-side)
  }
  const match = /^\/api\/v1\/([^/?#]+)/.exec(String(path || ''));
  const resource = match ? match[1].toLowerCase() : '';
  if (RESTRICTED_WRITE_RESOURCES.has(resource)) {
    return {
      allowed: false,
      reason:
        `Refusing ${m} ${path}: writing to '${resource}' via the admin escape-hatch is ` +
        `blocked in MCP_ADMIN_MODE=restricted (the default) — it is a privilege-escalation / ` +
        `credential / secret-minting surface. Perform this through the dashboard, or set ` +
        `MCP_ADMIN_MODE=full to allow the agent to do it.`,
    };
  }
  return { allowed: true };
}
