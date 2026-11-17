# Security

If you find a vulnerability in Sunlight, please do not open a public issue with
exploit details. Use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability) or contact the repository owner privately.
Include the affected version/commit, a minimal reproduction, and the impact.

The public deployment exposes seeded-city reads to anonymous users. The
operator should:
- keep `RATE_LIMIT_PER_MIN` and the read endpoint limits enabled;
- set `TRUST_PROXY=1` only when a trusted reverse proxy terminates TLS and
  injects `X-Forwarded-For`;
- keep the container bound to loopback and front it with TLS/HSTS (see
  `deploy/Caddyfile`);
- rotate/deploy from pinned image digests and review the CI test gate before
  publishing;
- report abuse to the operator rather than testing load against production.
