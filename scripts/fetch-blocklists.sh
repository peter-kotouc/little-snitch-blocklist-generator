#!/bin/bash
set -euo pipefail

# =============================================================================
# fetch-blocklists.sh — DNS Blocklist Fetch, Validate, and Preprocess Pipeline
# =============================================================================
#
# DESCRIPTION:
#   Downloads raw DNS domain blocklists from upstream sources defined in a JSON
#   configuration file, validates their format, strips comments/whitespace,
#   deduplicates entries, sorts them alphabetically, and injects standardized
#   metadata headers. The output files are ready for the Cloudflare Worker's
#   k-way merge algorithm.
#
# USAGE:
#   ./scripts/fetch-blocklists.sh [config_file] [output_dir]
#   ./scripts/fetch-blocklists.sh blocklist_sources.json blocklists
#
# PRECONDITIONS:
#   - jq, curl, sort, grep, sed, tr, diff must be installed and in $PATH.
#   - The config file must be a valid JSON array of objects, each containing
#     at minimum: { "name": string, "url": string }.
#   - Each "name" must match /^[a-zA-Z0-9_-]+$/ (path traversal prevention).
#   - Each "url" must point to a plain-text file with one domain per line.
#     Supported line formats:
#       • Pure domains:         example.com
#       • With inline comments: example.com # ad server
#       • Full-line comments:   # This is a comment
#       • Blank/whitespace-only lines (ignored)
#
# POSTCONDITIONS (per blocklist entry):
#   - On success: Creates {output_dir}/{name}_preprocessed_sorted.txt containing:
#       1. Metadata header (4 lines): blocklist name, source URL, license, timestamp
#       2. Byte-order sorted, deduplicated domain entries (one per line)
#       3. No comments, no blank lines, no leading/trailing whitespace
#       4. No Windows CRLF line endings (stripped during preprocessing)
#   - If the new content is identical to the existing file (ignoring the
#     "# Processed:" timestamp header), the existing file is kept untouched.
#     This prevents the daily CI cron from committing timestamp-only changes.
#   - On any failure (curl error, non-200, empty payload, invalid syntax, or
#     zero domains after comment stripping): the existing processed file is
#     left untouched — downloads happen in a temp file, so a previously good
#     list is never clobbered. Temp files are removed, the entry is skipped,
#     and a GitHub Issue is opened in CI.
#
# ERROR HANDLING:
#   - `set -euo pipefail` enables Bash strict mode with three protections:
#       • `-e` (errexit):   Exit immediately on any unhandled non-zero exit code.
#       • `-u` (nounset):   Treat references to unset variables as errors (prevents
#                           silent bugs from typos like `$NAEM` instead of `$NAME`).
#       • `-o pipefail`:    If any command in a pipeline fails, the pipeline's exit
#                           code is the failing command's code (not just the last one).
#   - Individual blocklist failures are caught and logged but do NOT abort the
#     entire pipeline. Every failure path ends in `continue`, including
#     curl-level failures (DNS errors, timeouts) that never produce an HTTP
#     status code.
#
# LOCALE:
#   - Validation requires a UTF-8 locale so grep's [[:alnum:]] accepts
#     internationalized domains (münchen.de, 中国.cn). A plain "C" locale
#     rejects every multi-byte character.
#   - Sorting must be plain byte order (LC_ALL=C) because the Cloudflare
#     Worker's k-way merge compares domains with JavaScript's `<` operator.
#     Locale collation (e.g. en_US.UTF-8 sorting "ñ" before "s") would
#     silently violate the merge's sort precondition.
#
# CI-SPECIFIC BEHAVIOR (when CI=true):
#   - Automatically creates GitHub Issues for fetch failures and format errors.
#   - Deduplicates issues: checks for existing open issues before creating new ones.
#   - Automatically closes resolved issues when a previously failing list recovers.
#
# PIPELINE STAGES (per blocklist):
#   1. Download      — curl to a TEMP file with 120s timeout, capture HTTP status
#   2. CRLF Strip    — tr -d '\r' to normalize Windows line endings
#   3. Empty Check   — [ ! -s file ] rejects zero-byte payloads
#   4. Regex Validation — grep rejects non-domain formats (Adblock, Hosts, IPs)
#   5. Comment Strip — sed removes inline and full-line # comments
#   6. Sort & Dedup  — LC_ALL=C sort -u (byte order, matches the Worker's merge)
#   7. Blank Strip   — grep -v removes residual empty lines; zero domains = reject
#   8. Header Inject — prepend metadata (name, source, license, timestamp)
#   9. Change Check  — skip the file swap if only the timestamp would change
# =============================================================================

# --- CONFIGURATION ---
# If you fork this repository, update this to your own GitHub username
# so that the automated Issue bot tags YOU when a blocklist fails!
GITHUB_USERNAME="peter-kotouc"
# ---------------------

# Default to blocklist_sources.json if no argument provided
CONFIG_FILE="${1:-blocklist_sources.json}"
OUTPUT_DIR="${2:-blocklists}"

# CI is set by GitHub Actions. Default to "false" for local runs so `set -u`
# does not abort the script when the variable is undefined.
CI="${CI:-false}"

# Pin a UTF-8 locale for validation (see LOCALE section above). The sort
# stage separately forces LC_ALL=C for byte ordering. If no UTF-8 locale is
# available, validation falls back to the current locale and may reject
# internationalized domains.
available_locales=$(locale -a 2>/dev/null || true)
for utf8_locale in C.UTF-8 C.utf8 en_US.UTF-8 en_US.utf8; do
  if printf '%s\n' "$available_locales" | grep -qix "$utf8_locale"; then
    export LC_ALL="$utf8_locale"
    break
  fi
done

# Precondition: Ensure required dependencies are installed
for cmd in jq curl sort grep sed tr diff; do
  if ! command -v "$cmd" &> /dev/null; then
    echo "Error: Required command '$cmd' is not installed." >&2
    exit 1
  fi
done

mkdir -p "$OUTPUT_DIR"

# Precondition: Config file must exist, be non-empty, and contain valid JSON
if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: Config file '$CONFIG_FILE' does not exist." >&2
  exit 1
fi

if [ ! -s "$CONFIG_FILE" ]; then
  echo "Error: Config file '$CONFIG_FILE' is empty." >&2
  exit 1
fi

if ! jq empty "$CONFIG_FILE" 2>/dev/null; then
  echo "Error: Config file '$CONFIG_FILE' contains invalid JSON." >&2
  exit 1
fi

echo "Reading blocklists from $CONFIG_FILE..."

# -----------------------------------------------------------------------------
# Helper: issue_creation
# Precondition:  $1 (title) and $2 (body) are provided. GitHub CLI (`gh`) must be
#                installed and authenticated (this function only runs if CI=true).
# Postcondition: Queries the GitHub repository for open issues matching $title.
#                If none exist, creates a new issue to alert the maintainer.
#                If one exists, logs a message and natively deduplicates the alert.
# -----------------------------------------------------------------------------
create_issue_if_not_exists() {
  local title="$1"
  local body="$2"
  local existing_issue=$(gh issue list --search "in:title \"$title\"" --state open --json number --jq '.[0].number')
  if [ -z "$existing_issue" ]; then
    echo "[CI] Creating a new GitHub Issue for: $title"
    gh issue create --title "$title" --body "$body"
  else
    echo "[CI] An open issue already exists for this topic (#$existing_issue)."
  fi
}

# -----------------------------------------------------------------------------
# Helper: issue_resolution
# Precondition:  $1 (title) and $2 (comment) are provided. GitHub CLI (`gh`) must be
#                installed and authenticated (this function only runs if CI=true).
# Postcondition: Queries the GitHub repository for open issues matching $title.
#                If an open issue exists, it is automatically closed and the
#                given success $comment is posted to alert users of the resolution.
# -----------------------------------------------------------------------------
close_issue_if_exists() {
  local title="$1"
  local comment="$2"
  local existing_issue=$(gh issue list --search "in:title \"$title\"" --state open --json number --jq '.[0].number')
  if [ -n "$existing_issue" ]; then
    echo "[CI] Closing resolved issue #$existing_issue..."
    gh issue close "$existing_issue" --comment "$comment"
  fi
}

# --- MAIN LOOP ---
# Iterate over each entry in the JSON configuration array.
# Precondition: CONFIG_FILE is a valid JSON array of objects.
# Postcondition: For each entry, either a valid preprocessed file is created
#                (or kept, if unchanged), or the entry is skipped with an error
#                message and optional GitHub Issue. A failure in one entry
#                never prevents the remaining entries from being processed.
jq -c '.[]' "$CONFIG_FILE" | while IFS= read -r i; do
  name=$(echo "$i" | jq -r '.name')
  url=$(echo "$i" | jq -r '.url')
  license=$(echo "$i" | jq -r '.license // "Unknown"')
  license_url=$(echo "$i" | jq -r '.license_url // "Unknown"')

  # Predictable Name validation ensures no Path Traversal (e.g., ../../../../etc/passwd), this is only preventative. The blocklists are still curated.
  if [[ ! "$name" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    echo "Error: Blocklist name '$name' contains invalid characters. Only alphanumeric, hyphens, and underscores are allowed." >&2
    continue
  fi

  processed_file="$OUTPUT_DIR/${name}_preprocessed_sorted.txt"
  raw_file="$OUTPUT_DIR/${name}_raw_temp.txt"
  temp_file="$OUTPUT_DIR/${name}_temp.txt"
  temp_sorted_file="$OUTPUT_DIR/${name}_temp_sorted.txt"

  # Clean up any leftovers from a previously interrupted run
  rm -f "$raw_file" "$temp_file" "$temp_sorted_file"

  echo "Fetching $name from $url..."

  # [STAGE 1: Download]
  # Precondition: $url is a valid HTTP(S) URL pointing to a plaintext file.
  # Postcondition: Payload is saved to $raw_file (NOT $processed_file — the
  #                existing good file is never clobbered by an error page or
  #                partial download) and $http_code contains the HTTP status.
  # Timeout: 120 seconds to prevent hanging on infinite streams.
  # The `|| http_code="000"` catches curl-level failures (DNS errors,
  # timeouts, TLS problems) that never produce an HTTP status — without it,
  # `set -e` would abort the entire pipeline on the first unreachable host.
  http_code=$(curl -sL --max-time 120 -w "%{http_code}" "$url" -o "$raw_file") || http_code="000"

  if [ "$http_code" -ne 200 ]; then
    echo "Error: Failed to download $name. HTTP Status: $http_code" >&2

    if [ "$CI" = "true" ]; then
      # [CI ONLY] Check if an issue already exists to prevent spamming the GitHub repo
      # This block will NEVER run locally (e.g. from `npm test` or `./scripts/`)
      create_issue_if_not_exists \
        "Error fetching blocklist: $name" \
        "Failed to download the \`$name\` blocklist. @$GITHUB_USERNAME please investigate.<br><br>URL: \`$url\`<br>HTTP Status: $http_code (000 = connection-level failure)<br><br>Please check the source URL and update \`blocklist_sources.json\` if necessary."
    fi

    rm -f "$raw_file"
    continue
  fi

  # [STAGE 2: CRLF Normalization]
  # Precondition: Raw downloaded file may contain Windows \r\n line endings.
  # Postcondition: File contains only POSIX \n line endings.
  # Note: We use tr + temp file because sed -i syntax differs between macOS (BSD) and Ubuntu (GNU).
  tr -d '\r' < "$raw_file" > "$temp_file"
  mv "$temp_file" "$raw_file"

  # [STAGE 3: Empty Payload Check]
  # Precondition: File has been CRLF-normalized.
  # Postcondition: A zero-byte payload (200 OK but gutted upstream file) is
  #                rejected, an Issue is opened in CI, and the entry skipped.
  if [ ! -s "$raw_file" ]; then
    echo "Error: Downloaded file is empty for $name." >&2

    if [ "$CI" = "true" ]; then
      create_issue_if_not_exists \
        "Error fetching blocklist: $name" \
        "The \`$name\` blocklist returned HTTP 200 but the payload was empty (0 bytes). @$GITHUB_USERNAME please investigate.<br><br>URL: \`$url\`<br><br>Please check the source URL and update \`blocklist_sources.json\` if necessary."
    fi

    rm -f "$raw_file"
    continue
  fi

  # [STAGE 4: Format Validation]
  # Precondition: File is non-empty and CRLF-normalized.
  # Postcondition: If ANY line fails the regex, the entire list is rejected.
  # Valid line patterns:
  #   • Empty lines or whitespace only:            ^[[:space:]]*$
  #   • Full-line comments:                        ^[[:space:]]*#.*
  #   • Pure domains (alphanums, dots, hyphens):   ^[[:alnum:]._-]+
  #   • Domains with optional inline comments:     ^[[:alnum:]._-]+[[:space:]]*(#.*)?
  # Rejected formats: Adblock (||domain^), Hosts (0.0.0.0 domain), IP addresses, URLs with paths
  # The sed 's/\./[.]/g' defangs the sample domains so they are not clickable
  # links when embedded in the GitHub Issue body.
  if invalid_lines=$( \
    grep -v -E '^[[:space:]]*(#.*)?$|^[[:space:]]*[[:alnum:]._-]+[[:space:]]*(#.*)?$' \
      "$raw_file" \
    | head -n 5 \
    | sed 's/\./[.]/g' \
  ); [ -n "$invalid_lines" ]; then
    echo "Error: Downloaded file for $name contains invalid syntax formatting (e.g. IPs, Paths, or Adblock rules)." >&2

    if [ "$CI" = "true" ]; then
      # [CI ONLY] Check if an issue already exists for syntax formatting
      create_issue_if_not_exists \
        "Invalid Blocklist Format: $name" \
        "The \`$name\` blocklist contains syntax that is incompatible with the Little Snitch Domain parser. @$GITHUB_USERNAME please investigate.<br><br>URL: \`$url\`<br>Reason: The file contains invalid characters, IP mappings, or Adblock-specific syntax instead of purely raw domains.<br><br>Examples of invalid lines found:<br><pre><code>$invalid_lines</code></pre><br>Please check the source URL and update \`blocklist_sources.json\` if necessary."
    fi

    rm -f "$raw_file"
    continue
  fi

  # [STAGES 5-7: Comment Strip → Sort & Dedup → Blank Strip]
  # Precondition: File passes format validation (only valid domain lines + comments).
  # Pipeline:
  #   sed:    Strip leading/trailing whitespace + remove inline/full-line # comments
  #   sort:   LC_ALL=C forces plain byte ordering to match the JavaScript
  #           string comparison in the Worker's k-way merge; -u deduplicates
  #   grep:   Remove residual empty lines. `|| true` because grep exits 1 when
  #           nothing survives (comments-only file) — that case is handled
  #           explicitly below instead of tripping set -e + pipefail.
  sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/[[:space:]]*#.*$//' "$raw_file" \
    | LC_ALL=C sort -u \
    | { grep -v '^[[:space:]]*$' || true; } > "$temp_file"
  rm -f "$raw_file"

  # A payload that contains only comments/blank lines produces zero domains.
  # Treat it like an invalid list: keep the previous file, alert in CI, skip.
  if [ ! -s "$temp_file" ]; then
    echo "Error: Blocklist $name contains no domains after comment stripping." >&2

    if [ "$CI" = "true" ]; then
      create_issue_if_not_exists \
        "Invalid Blocklist Format: $name" \
        "The \`$name\` blocklist contains only comments or blank lines — no domains survived preprocessing. @$GITHUB_USERNAME please investigate.<br><br>URL: \`$url\`<br><br>Please check the source URL and update \`blocklist_sources.json\` if necessary."
    fi

    rm -f "$temp_file"
    continue
  fi

  echo "Successfully fetched $name."

  # [STAGE 8: Header Injection]
  # Postcondition: $temp_sorted_file contains:
  #   Lines 1-4: Metadata headers (blocklist name, source URL, license, timestamp)
  #   Lines 5+:  Unique, byte-order sorted domain names with no whitespace or comments
  echo "Sorting $name alphabetically, removing upstream comments, and injecting metadata headers..."

  current_date=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  {
    echo "# Blocklist: $name"
    echo "# Source: $url"
    echo "# License: $license ($license_url)"
    echo "# Processed: $current_date"
    cat "$temp_file"
  } > "$temp_sorted_file"
  rm -f "$temp_file"

  # [STAGE 9: Change Check]
  # Compare against the existing file ignoring the "# Processed:" timestamp.
  # Without this, every scheduled CI run would rewrite and commit every file
  # (the timestamp always changes), bloating git history with no-op commits.
  if [ -f "$processed_file" ] \
    && diff -q <(grep -v '^# Processed:' "$processed_file") \
               <(grep -v '^# Processed:' "$temp_sorted_file") > /dev/null 2>&1; then
    echo "$name is unchanged (ignoring timestamp). Keeping existing file."
    rm -f "$temp_sorted_file"
  else
    mv "$temp_sorted_file" "$processed_file"
  fi

  if [ "$CI" = "true" ]; then
    # [CI ONLY] Automatically close an open issue if the URL fetch successfully recovers on scheduled cron runs
    close_issue_if_exists "Error fetching blocklist: $name" "Blocklist fetch succeeded, closing issue."

    # [CI ONLY] Also close any open format/syntax issues if the author fixed the text file and it successfully recovers
    close_issue_if_exists "Invalid Blocklist Format: $name" "Blocklist format was corrected and successfully parsed, closing issue."
  fi
done
