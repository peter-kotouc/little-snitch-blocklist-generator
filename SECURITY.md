# Security Policy

## Supported Versions

This project is a rolling release: only the latest code on the `main` branch
(and the deployment built from it) receives security fixes.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use GitHub's private vulnerability reporting for this repository:

👉 [Report a vulnerability](https://github.com/peter-kotouc/little-snitch-blocklist-generator/security/advisories/new)

Please include as much of the following as you can:

- The type of issue and which component is affected (API endpoint, script, workflow)
- Steps to reproduce or a proof of concept
- The impact you believe it has
- Any suggested fix, if you have one

This is a personal open-source project maintained on a best-effort basis. You
can expect an initial response within roughly a week. Please allow a reasonable
amount of time for a fix to land before any public disclosure.

## Scope

**In scope**

- The Cloudflare Pages Function API (`functions/api/blocklists.js`) — e.g.
  path traversal, injection into the generated JSON ruleset, cache poisoning,
  resource exhaustion
- The fetch/preprocess pipeline (`scripts/fetch-blocklists.sh`) — e.g.
  mishandling of malicious upstream payloads, command injection via
  configuration values
- The GitHub Actions workflows (`.github/workflows/`) — e.g. privilege
  escalation or secret exposure

**Out of scope**

- Which domains are (or are not) blocked by the upstream lists — false
  positives and removals belong to the upstream maintainers (see the
  **Included Blocklists** table in the README)
- Vulnerabilities in Little Snitch itself, Cloudflare, or GitHub
- Availability/uptime of the hosted demo instance

## A Note on Blocklist Integrity

The rulesets served by the API are built from third-party blocklists pinned in
`blocklist_sources.json`. A compromised upstream list could, at worst, cause
additional domains to be denied in subscribers' Little Snitch configurations.
If you notice an upstream source behaving suspiciously, please report that
through the same private channel.
