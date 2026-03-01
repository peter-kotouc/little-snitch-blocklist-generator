#!/bin/bash
set -e

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
#   - jq, curl, sort, grep must be installed and available in $PATH.
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
#       2. Alphabetically sorted, deduplicated domain entries (one per line)
#       3. No comments, no blank lines, no leading/trailing whitespace
#       4. No Windows CRLF line endings (stripped during preprocessing)
#   - On HTTP failure (non-200): No file is created. The previous version is
#     restored via `git checkout` if available. A GitHub Issue is opened in CI.
#   - On empty payload (200 with 0 bytes): Same as HTTP failure behavior.
#   - On invalid syntax (Adblock, Hosts, IPs): Same as HTTP failure behavior.
#     A separate GitHub Issue is opened in CI with sample invalid lines.
#
# ERROR HANDLING:
#   - `set -e` causes the script to exit on any unhandled non-zero exit code.
#   - Individual blocklist failures are caught and logged but do NOT abort the
#     entire pipeline. The `continue` statement skips to the next entry.
#   - `git checkout || true` is used for graceful recovery; it silently passes
#     if the file was never previously committed (new blocklist).
#
# CI-SPECIFIC BEHAVIOR (when CI=true):
#   - Automatically creates GitHub Issues for fetch failures and format errors.
#   - Deduplicates issues: checks for existing open issues before creating new ones.
#   - Automatically closes resolved issues when a previously failing list recovers.
#
# PIPELINE STAGES (per blocklist):
#   1. Download   — curl with 120s timeout, capture HTTP status code
#   2. CRLF Strip — tr -d '\r' to normalize Windows line endings
#   3. Empty Check — [ ! -s file ] rejects zero-byte payloads
#   4. Regex Validation — grep rejects non-domain formats (Adblock, Hosts, IPs)
#   5. Comment Strip — sed removes inline and full-line # comments
#   6. Sort & Dedup — sort -u alphabetizes and deduplicates
#   7. Blank Strip — grep -v removes residual empty lines
#   8. Header Inject — prepend metadata (name, source, license, timestamp)
# =============================================================================

# --- CONFIGURATION ---
# If you fork this repository, update this to your own GitHub username
# so that the automated Issue bot tags YOU when a blocklist fails!
GITHUB_USERNAME="peter-kotouc"
# ---------------------

# Default to blocklist_sources.json if no argument provided
CONFIG_FILE="${1:-blocklist_sources.json}"
OUTPUT_DIR="${2:-blocklists}"

# Precondition: Ensure required dependencies are installed
for cmd in jq curl sort grep; do
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
# Helper: file_recovery
# Precondition:  $1 is the file path that failed processing or validation.
# Postcondition: Any partial/corrupted file is securely deleted (`rm -f`).
#                If the file existed in previous git commits, it is restored.
#                If it is a brand new configuration item, the `|| true` prevents a crash.
# -----------------------------------------------------------------------------
recover_previous() {
  local file="$1"
  rm -f "$file"
  git checkout -- "$file" 2>/dev/null || true
}

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
# Postcondition: For each entry, either a valid preprocessed file is created,
#                or the entry is skipped with an error message and optional GitHub Issue.
jq -c '.[]' "$CONFIG_FILE" | while IFS= read -r i; do
  name=$(echo "$i" | jq -r '.name')
  url=$(echo "$i" | jq -r '.url')
  license=$(echo "$i" | jq -r '.license // "Unknown"')
  license_url=$(echo "$i" | jq -r '.license_url // "Unknown"')

  processed_file="$OUTPUT_DIR/${name}_preprocessed_sorted.txt"
  temp_file="$OUTPUT_DIR/${name}_temp.txt"
  temp_sorted_file="$OUTPUT_DIR/${name}_temp_sorted.txt"
  
  # Predictable Name validation ensures no Path Traversal (e.g., ../../../../etc/passwd), this is only preventative. The blocklists are still curated.
  if [[ ! "$name" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    echo "Error: Blocklist name '$name' contains invalid characters. Only alphanumeric, hyphens, and underscores are allowed." >&2
    continue
  fi
  
  echo "Fetching $name from $url..."
  
  # [STAGE 1: Download]
  # Precondition: $url is a valid HTTP(S) URL pointing to a plaintext file.
  # Postcondition: File is saved to $processed_file
  #                and $http_code contains the HTTP response status.
  # Timeout: 120 seconds to prevent hanging on infinite streams.
  http_code=$(curl -sL --max-time 120 -w "%{http_code}" "$url" -o "$processed_file")
  
  if [ "$http_code" -ne 200 ]; then
    echo "Error: Failed to download $name. HTTP Status: $http_code" >&2
    
    if [ "$CI" = "true" ]; then
      # [CI ONLY] Check if an issue already exists to prevent spamming the GitHub repo
      # This block will NEVER run locally (e.g. from `npm test` or `./scripts/`)
      create_issue_if_not_exists \
        "Error fetching blocklist: $name" \
        "Failed to download the \`$name\` blocklist. @$GITHUB_USERNAME please investigate.<br><br>URL: \`$url\`<br>HTTP Status: $http_code<br><br>Please check the source URL and update \`blocklist_sources.json\` if necessary."
    fi
    
    # Remove the partial/failed file so we don't commit a 404/500 HTML error page to the blocklists array
    # Recover the old version of the list if it existed in the repository previously.
    # The `|| true` prevents the script from crashing if this is a brand new configuration item in the JSON.
    recover_previous "$processed_file"
  else
    # [STAGE 2: CRLF Normalization]
    # Precondition: Raw downloaded file may contain Windows \r\n line endings.
    # Postcondition: File contains only POSIX \n line endings.
    # Note: We use tr + temp file because sed -i syntax differs between macOS (BSD) and Ubuntu (GNU).
    tr -d '\r' < "$processed_file" > "$temp_file"
    mv "$temp_file" "$processed_file"

    # [STAGE 3: Empty Payload Check]
    # Precondition: File has been CRLF-normalized.
    # Postcondition: If file is zero bytes, it is removed and the old version is recovered.
    if [ ! -s "$processed_file" ]; then
      echo "Error: Downloaded file is empty for $name." >&2
      recover_previous "$processed_file"
      # [STAGE 4: Format Validation]
      # Precondition: File is non-empty and CRLF-normalized.
      # Postcondition: If ANY line fails the regex, the entire list is rejected.
      # Valid line patterns:
      #   • Empty lines or whitespace only:            ^[[:space:]]*$
      #   • Full-line comments:                        ^[[:space:]]*#.*
      #   • Pure domains (alphanums, dots, hyphens):   ^[[:alnum:]._-]+
      #   • Domains with optional inline comments:     ^[[:alnum:]._-]+[[:space:]]*(#.*)?
      # Rejected formats: Adblock (||domain^), Hosts (0.0.0.0 domain), IP addresses, URLs with paths
    elif invalid_lines=$( \
      grep -v -E '^[[:space:]]*(#.*)?$|^[[:space:]]*[[:alnum:]._-]+[[:space:]]*(#.*)?$' \
        "$processed_file" \
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

      recover_previous "$processed_file"
    else
      echo "Successfully fetched $name."
      
      # [STAGES 5-8: Comment Strip → Sort → Dedup → Header Injection]
      # Precondition: File passes format validation (contains only valid domain lines + comments).
      # Pipeline:
      #   sed:    Strip leading/trailing whitespace + remove inline/full-line # comments
      #   sort -u: Alphabetize entries and deduplicate identical domains
      #   grep -v: Remove any residual empty lines left after comment stripping
      # Postcondition: Output file contains:
      #   Lines 1-4: Metadata headers (blocklist name, source URL, license, timestamp)
      #   Lines 5+:  Unique, alphabetically sorted domain names with no whitespace or comments
      echo "Sorting $name alphabetically, removing upstream comments, and injecting metadata headers..."
      
      current_date=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
      {
        echo "# Blocklist: $name"
        echo "# Source: $url"
        echo "# License: $license ($license_url)"
        echo "# Processed: $current_date"
        sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/[[:space:]]*#.*$//' "$processed_file" | sort -u | grep -v '^[[:space:]]*$'
      } > "$temp_sorted_file"
      
      mv "$temp_sorted_file" "$processed_file"
      
      if [ "$CI" = "true" ]; then
        # [CI ONLY] Automatically close an open issue if the URL fetch successfully recovers on scheduled cron runs
        close_issue_if_exists "Error fetching blocklist: $name" "Blocklist fetch succeeded, closing issue."

        # [CI ONLY] Also close any open format/syntax issues if the author fixed the text file and it successfully recovers
        close_issue_if_exists "Invalid Blocklist Format: $name" "Blocklist format was corrected and successfully parsed, closing issue."
      fi
    fi
  fi
done
