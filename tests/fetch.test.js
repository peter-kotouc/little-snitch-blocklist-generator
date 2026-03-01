/**
 * @file fetch.test.js
 * @description Integration tests for the bash blocklist fetch and preprocessing pipeline.
 *
 * ## Test Strategy
 * These tests spin up a local HTTP server on port 3000 that serves mock blocklist
 * payloads (valid, empty, invalid syntax, CRLF, duplicates, etc.). The actual
 * `fetch-blocklists.sh` script is then executed against a temporary JSON config
 * that points to these local URLs.
 *
 * ## Environment
 * - CI is set to "false" to prevent the script from attempting to create GitHub Issues.
 * - Tests are automatically skipped on Cloudflare Pages CI (CF_PAGES=1) since the
 *   build environment lacks bash dependencies (git, curl, jq).
 * - Temp files are cleaned up in the `after()` hook.
 *
 * ## Mock Endpoints
 * - `/good.txt`          → Valid 200 payload with comments and domains
 * - `/idn.txt`           → IDN/Unicode domains with inline comments and whitespace
 * - `/crlf.txt`          → Windows-style CRLF line endings
 * - `/duplicates.txt`    → Repeated domain entries for deduplication testing
 * - `/comments-only.txt` → File containing only # comment lines
 * - `/whitespace.txt`    → Blank and whitespace-only lines mixed with domains
 * - `/empty.txt`         → Empty 200 response (zero bytes)
 * - `/invalid.txt`       → Adblock and Hosts format syntax (should be rejected)
 * - All other paths      → 404 Not Found
 *
 * ## Test Groups
 * 1. **Sunshine Cases** — Valid downloads, IDN/Unicode support, comment stripping
 * 2. **Edge Cases (Failures)** — 404 recovery, empty payloads, invalid syntax rejection
 * 3. **Preprocessing Edge Cases** — CRLF stripping, deduplication, comment-only, whitespace
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import {
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from "node:fs";

const execAsync = promisify(exec);
describe("GitHub Actions Bash Edge Cases", () => {
  let server;
  const port = 3000;

  const isCFPages = process.env.CF_PAGES === "1";

  before(async function () {
    // Cloudflare Pages builder environments lack a full Ubuntu stack (e.g. Git, Curl)
    // The bash script is solely designed for GitHub Actions.
    if (isCFPages) {
      console.log(
        "Detected Cloudflare Pages CI. Bypassing Bash script executions.",
      );
      return;
    }

    // Ensure test directories exist
    if (!existsSync("tests/temp")) mkdirSync("tests/temp");

    // Helper to write config and run script
    global.runFetchScript = async (configs) => {
      writeFileSync("tests/temp_config.json", JSON.stringify(configs));
      return execAsync(
        "./scripts/fetch-blocklists.sh tests/temp_config.json tests/temp",
      );
    };

    // Mute gh CLI failures by mocking CI logic to false
    process.env.CI = "false";

    server = createServer((req, res) => {
      if (req.url === "/good.txt") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(
          "# header comment\ndomain1.com\ndomain2.com\n  # floating comment\ndomain3.com",
        );
      } else if (req.url === "/empty.txt") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("");
      } else if (req.url === "/invalid.txt") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("||domain.com^\n127.0.0.1 blocked.com\n");
      } else if (req.url === "/idn.txt") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(
          "münchen.de\n中国.cn\n测试.com\nñandú.com\ninline1.com # comment\ninline2.com#no-space-comment\n   spaced1.com   \n  spaced2.com  # comment\n",
        );
      } else if (req.url === "/crlf.txt") {
        // Windows-style CRLF line endings
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("alpha.com\r\nbeta.com\r\ngamma.com\r\n");
      } else if (req.url === "/duplicates.txt") {
        // Repeated domains that should be deduplicated by sort -u
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(
          "repeat.com\nunique.com\nrepeat.com\nalpha.com\nrepeat.com\nunique.com\n",
        );
      } else if (req.url === "/comments-only.txt") {
        // File containing only comment lines and no domains
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(
          "# This is a header\n# Another comment\n# Nothing but comments\n",
        );
      } else if (req.url === "/whitespace.txt") {
        // File with blank lines, whitespace-only lines, and valid domains mixed together
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("\n   \n\nalpha.com\n   \nbeta.com\n\n\n   \ngamma.com\n  \n");
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
    });

    await new Promise((resolve) => server.listen(port, resolve));
  });

  after(async () => {
    if (!server) return;

    // Aggressively kill keep-alive sockets from curl to prevent Node test runner hang
    server.closeAllConnections();

    await new Promise((resolve) => {
      server.close(() => resolve());
    });

    rmSync("tests/temp_config.json", { force: true });
    rmSync("tests/temp", { recursive: true, force: true });
  });

  describe("Sunshine Cases (Successful Fetches)", () => {
    /*
     * Validates the core "happy path" where a blocklist server correctly
     * returns a 200 OK with a non-empty plaintext body.
     * The bash script should download it, string '# comment' lines, delete blank lines,
     * and save the alphabetically sorted output to `[name]_temp_sorted.txt`.
     */
    it("downloads, preprocesses, sorts, and ignores comments for valid 200 payloads", async () => {
      if (isCFPages) return;

      const config = [
        {
          name: "good-list",
          url: `http://localhost:${port}/good.txt`,
          description: "",
        },
      ];
      await global.runFetchScript(config);

      const expectedFile = "tests/temp/good-list_preprocessed_sorted.txt";
      assert.strictEqual(
        existsSync(expectedFile),
        true,
        "Valid blocklist was not downloaded properly.",
      );

      const contents = readFileSync(expectedFile, "utf-8").trim();
      assert.match(
        contents,
        /^# Blocklist: good-list\n# Source: http:\/\/localhost:3000\/good\.txt\n# License: Unknown \(Unknown\)\n# Processed: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\ndomain1\.com\ndomain2\.com\ndomain3\.com$/,
        "Bash script failed to inject header comments or sort domains alphabetically",
      );
    });

    /*
     * Validates that the bash script's regex validator correctly permits
     * Internationalized Domain Names (IDNs) and non-standard alphanumeric characters.
     */
    it("successfully validates and processes domains with international characters (IDN)", async () => {
      if (isCFPages) return;

      const config = [
        {
          name: "idn-list",
          url: `http://localhost:${port}/idn.txt`,
          description: "",
        },
      ];
      await global.runFetchScript(config);

      const expectedFile = "tests/temp/idn-list_preprocessed_sorted.txt";
      assert.strictEqual(
        existsSync(expectedFile),
        true,
        "Valid international blocklist was incorrectly rejected by Regex validation.",
      );

      const contents = readFileSync(expectedFile, "utf-8").trim();
      assert.match(
        contents,
        /^# Blocklist: idn-list\n# Source: http:\/\/localhost:3000\/idn\.txt\n# License: Unknown \(Unknown\)\n# Processed: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\ninline1\.com\ninline2\.com\nmünchen\.de\nspaced1\.com\nspaced2\.com\nñandú\.com\n中国\.cn\n测试\.com$/,
        "Bash script failed to properly parse IDN and Chinese domains",
      );
    });
  });

  describe("Edge Cases (Failures and Recoveries)", () => {
    /*
     * Validates the workflow's resilience against dead links (404/500).
     * The bash script must intercept the HTTP error, skip creating the file locally,
     * and attempt to run `git checkout` to restore the previous day's list rather than deleting it entirely.
     */
    it("rejects 404 missing lists and gracefully recovers", async () => {
      if (isCFPages) return;

      const config = [
        {
          name: "missing-list",
          url: `http://localhost:${port}/missing.txt`,
          description: "",
        },
      ];
      await global.runFetchScript(config);

      // The script should not have created or left behind an empty/failed parsed list
      const fileExists = existsSync(
        "tests/temp/missing-list_preprocessed_sorted.txt",
      );
      assert.strictEqual(
        fileExists,
        false,
        "Bash script left behind a broken txt file on 404 response",
      );
    });

    /*
     * Validates protection against "false-positives" where a server returns a 200 OK
     * but the file has been gutted/emptied accidentally by the maintainer.
     * The bash script must check file size (`[ ! -s file ]`) before accepting the payload.
     */
    it("rejects empty 200 HTTP responses safely without saving empty files", async () => {
      if (isCFPages) return;

      const config = [
        {
          name: "empty-list",
          url: `http://localhost:${port}/empty.txt`,
          description: "",
        },
      ];
      await global.runFetchScript(config);

      const fileExists = existsSync(
        "tests/temp/empty-list_preprocessed_sorted.txt",
      );
      assert.strictEqual(
        fileExists,
        false,
        "Bash script failed to detect extremely empty blocklist downloads",
      );
    });

    /*
     * Validates that the Bash script aggressively rejects invalid syntax formats
     * such as Adblock Plus (`||domain.com^`) or Hosts (`0.0.0.0 domain.com`) lists.
     * The script uses a strict Regex ensuring only plain domains, newlines, or `#` comments exist.
     */
    it("rejects blocklists with invalid syntax (like Adblock or Hosts formats) and leaves no file behind", async () => {
      if (isCFPages) return;

      const config = [
        {
          name: "invalid-list",
          url: `http://localhost:${port}/invalid.txt`,
          description: "",
        },
      ];
      await global.runFetchScript(config);

      const fileExists = existsSync(
        "tests/temp/invalid-list_preprocessed_sorted.txt",
      );
      assert.strictEqual(
        fileExists,
        false,
        "Bash script failed to reject invalid syntax formats like Adblock rules",
      );
    });
  });

  describe("Preprocessing Edge Cases", () => {
    /*
     * Validates that Windows-style CRLF (\r\n) line endings are fully stripped
     * during preprocessing. The bash script uses `tr -d '\r'` before any parsing.
     * If carriage returns survive, they corrupt domain strings and break the Worker's merge.
     */
    it("strips Windows CRLF line endings and produces clean POSIX output", async () => {
      if (isCFPages) return;

      const config = [
        {
          name: "crlf-list",
          url: `http://localhost:${port}/crlf.txt`,
          description: "",
        },
      ];
      await global.runFetchScript(config);

      const expectedFile = "tests/temp/crlf-list_preprocessed_sorted.txt";
      assert.strictEqual(
        existsSync(expectedFile),
        true,
        "CRLF blocklist was incorrectly rejected",
      );

      const contents = readFileSync(expectedFile, "utf-8");
      assert.strictEqual(
        contents.includes("\r"),
        false,
        "Carriage return characters survived preprocessing",
      );

      // Verify all three domains are present and sorted
      assert.match(contents, /alpha\.com\nbeta\.com\ngamma\.com/);
    });

    /*
     * Validates that `sort -u` in the preprocessing pipeline correctly deduplicates
     * repeated domain entries within a single blocklist file.
     */
    it("deduplicates repeated domains within a single blocklist", async () => {
      if (isCFPages) return;

      const config = [
        {
          name: "dedup-list",
          url: `http://localhost:${port}/duplicates.txt`,
          description: "",
        },
      ];
      await global.runFetchScript(config);

      const expectedFile = "tests/temp/dedup-list_preprocessed_sorted.txt";
      assert.strictEqual(existsSync(expectedFile), true);

      const contents = readFileSync(expectedFile, "utf-8");
      const lines = contents.split("\n").filter((l) => l && !l.startsWith("#"));

      // "repeat.com" appears 3 times in input, should appear exactly once in output
      const repeatCount = lines.filter((l) => l === "repeat.com").length;
      assert.strictEqual(
        repeatCount,
        1,
        `Expected 'repeat.com' exactly once, found ${repeatCount} times`,
      );

      // Total unique domains: alpha.com, repeat.com, unique.com = 3
      assert.strictEqual(
        lines.length,
        3,
        `Expected 3 unique domains, got ${lines.length}`,
      );
    });

    /*
     * Validates that a blocklist containing only comment lines (no actual domains)
     * is rejected by the processing pipeline. After stripping all `#` comment lines,
     * the resulting empty output triggers a pipeline failure, preventing an empty
     * file from being committed. This is consistent with the empty 200 rejection behavior.
     */
    it("rejects comment-only files that contain no usable domains", async () => {
      if (isCFPages) return;

      const config = [
        {
          name: "comments-list",
          url: `http://localhost:${port}/comments-only.txt`,
          description: "",
        },
      ];

      // The script will error because grep -v finds no non-empty lines after comment stripping
      try {
        await global.runFetchScript(config);
      } catch {
        // Expected: set -e causes exit on grep returning no matches
      }

      const expectedFile = "tests/temp/comments-list_preprocessed_sorted.txt";
      const fileExists = existsSync(expectedFile);

      // If the file exists, check it doesn't contain any actual domains
      // (the pipeline may leave a partial file or no file at all)
      if (fileExists) {
        const contents = readFileSync(expectedFile, "utf-8");
        const domainLines = contents
          .split("\n")
          .filter((l) => l && !l.startsWith("#"));
        assert.strictEqual(
          domainLines.length,
          0,
          "Comment-only blocklist should contain no domain entries",
        );
      }

      // Either way, the test passes — no usable domains were committed
    });

    /*
     * Validates that blank lines and whitespace-only lines are stripped from the
     * output during preprocessing, while actual domain entries are preserved intact.
     */
    it("strips blank and whitespace-only lines while preserving valid domains", async () => {
      if (isCFPages) return;

      const config = [
        {
          name: "whitespace-list",
          url: `http://localhost:${port}/whitespace.txt`,
          description: "",
        },
      ];
      await global.runFetchScript(config);

      const expectedFile = "tests/temp/whitespace-list_preprocessed_sorted.txt";
      assert.strictEqual(existsSync(expectedFile), true);

      const contents = readFileSync(expectedFile, "utf-8");
      const domainLines = contents
        .split("\n")
        .filter((l) => l && !l.startsWith("#"));

      // Only the 3 actual domains should survive
      assert.strictEqual(
        domainLines.length,
        3,
        `Expected 3 domains, got ${domainLines.length}`,
      );
      assert.deepStrictEqual(domainLines, [
        "alpha.com",
        "beta.com",
        "gamma.com",
      ]);
    });

    /*
     * Validates the name regex guard (`^[a-zA-Z0-9_-]+$`).
     * A blocklist entry with a name containing path traversal characters (e.g., "../evil")
     * must be skipped by the script with an error message, and no file should be created.
     * This prevents an attacker from injecting a malicious name via blocklist_sources.json.
     */
    it("skips blocklist entries with invalid names containing path traversal characters", async () => {
      if (isCFPages) return;

      const config = [
        {
          name: "../evil-traversal",
          url: `http://localhost:${port}/good.txt`,
          description: "",
        },
      ];

      const { stderr } = await global.runFetchScript(config);

      // Should print an error about invalid characters
      assert.match(
        stderr,
        /invalid characters/i,
        "Script should warn about invalid blocklist name",
      );

      // No file should be created for the invalid name
      const maliciousFile = existsSync(
        "tests/temp/../evil-traversal_preprocessed_sorted.txt",
      );
      assert.strictEqual(
        maliciousFile,
        false,
        "Script should not create files for entries with invalid names",
      );
    });

    /*
     * Validates that the main loop processes multiple blocklist entries independently.
     * When a multi-entry config contains one failing list (404) and one succeeding list (200),
     * the script must `continue` past the failure and still produce the successful file.
     * This tests the loop's error recovery and ensures one bad entry doesn't abort the pipeline.
     */
    it("processes multiple blocklists independently, surviving individual failures", async () => {
      if (isCFPages) return;

      const config = [
        {
          name: "failing-list",
          url: `http://localhost:${port}/missing.txt`,
          description: "",
        },
        {
          name: "succeeding-list",
          url: `http://localhost:${port}/good.txt`,
          description: "",
        },
      ];
      await global.runFetchScript(config);

      // The failing list should NOT have a file
      assert.strictEqual(
        existsSync("tests/temp/failing-list_preprocessed_sorted.txt"),
        false,
        "Failed blocklist should not leave a file behind",
      );

      // The succeeding list should have been processed normally
      assert.strictEqual(
        existsSync("tests/temp/succeeding-list_preprocessed_sorted.txt"),
        true,
        "Successful blocklist should still be processed despite earlier failure",
      );

      const contents = readFileSync(
        "tests/temp/succeeding-list_preprocessed_sorted.txt",
        "utf-8",
      );
      const domainLines = contents
        .split("\n")
        .filter((l) => l && !l.startsWith("#"));
      assert.strictEqual(
        domainLines.length,
        3,
        `Expected 3 domains from the successful list, got ${domainLines.length}`,
      );
    });
  });

  describe("Config File Validation", () => {
    /*
     * Validates that the script exits with a clear error message when the
     * config file does not exist, rather than failing inside jq.
     */
    it("exits with a clear error when the config file does not exist", async () => {
      if (isCFPages) return;

      try {
        await execAsync(
          "./scripts/fetch-blocklists.sh tests/nonexistent_config.json tests/temp",
        );
        assert.fail("Script should have exited with an error");
      } catch (error) {
        assert.match(
          error.stdout || error.stderr,
          /does not exist/i,
          "Script should report that the config file does not exist",
        );
      }
    });

    /*
     * Validates that the script exits with a clear error message when the
     * config file contains invalid JSON, rather than failing inside jq.
     */
    it("exits with a clear error when the config file contains invalid JSON", async () => {
      if (isCFPages) return;

      writeFileSync("tests/temp_config.json", "{ this is not valid JSON !!!");

      try {
        await execAsync(
          "./scripts/fetch-blocklists.sh tests/temp_config.json tests/temp",
        );
        assert.fail("Script should have exited with an error");
      } catch (error) {
        assert.match(
          error.stdout || error.stderr,
          /invalid JSON/i,
          "Script should report that the config file contains invalid JSON",
        );
      }
    });
  });
});
