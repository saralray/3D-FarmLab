# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in 3D-FarmLab, please report
it privately. **Do not open a public GitHub issue for security problems.**

- Email: **saral@saral.work**
- Use a subject line beginning with `[SECURITY]`.
- Include a description of the issue, the affected component (`web`, `poller`,
  `nginx`, `db`, or a manifest), reproduction steps, and the potential impact.

You can expect an acknowledgement within **3 business days** and a status
update within **10 business days**. Please give us a reasonable window to ship
a fix before any public disclosure. We will credit reporters who request it.

## Supported Versions

This project is deployed from the `main` branch. Only the current `main` is
supported — fixes are applied there and redeployed. Older commits and any
forks are not maintained.

## Scope

In scope:

- The Node `web` API and printer reverse proxy (`server/`).
- The Python `poller` service (`poller/`).
- The `nginx` reverse proxy configuration (`nginx/`).
- Docker (`Dockerfile.*`, `docker-compose.yml`) deployment configuration.
- Authentication, role handling, and public viewer-mode redaction.

Out of scope:

- Vulnerabilities in third-party dependencies that have no available patch
  (report these upstream; we will update once a fix exists).
- Issues that require an already-compromised host.
- Findings against deployments that have not changed the default credentials.

## Deployment Hardening

Operators are responsible for the security of their own deployment. Before
running this software in production:

- **Change every default secret.** `.env.example` ships with placeholder
  values. Replace `POSTGRES_PASSWORD`, `DATABASE_URL`, and any auth password
  hash with strong, unique values.
- **Never commit real secrets.** `.env` is for local use only and must not be
  committed; document defaults in `.env.example`.
- **Generate auth password hashes** with the documented SHA-256 command; do not
  store plaintext passwords.
- **Keep printer connection details private.** Printer IPs, API keys, and
  profiles must not be exposed in public viewer mode — viewer responses are
  redacted server-side, so route untrusted users through viewer mode only.
- **Restrict network exposure.** Expose only `nginx`; keep `db`, `web`, and
  `poller` on the internal network. Terminate TLS in front of `nginx`.
- **Rotate credentials** if a `.env` file, secret manifest, or webhook URL is
  ever committed or leaked.
- **Keep base images current.** Rebuild the `web`, `poller`, and `nginx`
  images regularly to pick up upstream OS and runtime security updates.

## Disclosure Policy

We follow coordinated disclosure. Once a fix is merged to `main` and deployed,
we will publish a brief advisory describing the issue and the remediation.
