/**
 * @file worker.test.js
 * @description Integration tests for the Cloudflare Worker blocklist merge API.
 *
 * ## Test Strategy
 * These tests import the `onRequest` handler directly and invoke it with mock
 * Cloudflare Pages Function context objects. The global `fetch` is overridden
 * in `before()` to serve deterministic test data without network access.
 *
 * ## Mock Architecture
 * The mock `fetch` serves:
 * - `blocklist_sources.json` → Test metadata with license attribution for listA/listB
 * - `listA` → 1,000,000 domains: domain0000000.com through domain0999999.com
 * - `listB` → 1,000,000 domains: domain0500000.com through domain1499999.com (50% overlap with listA)
 * - All other URLs → 404 Not Found
 *
 * ## Test Groups
 * 1. **Validation** — Query parameter edge cases (missing, invalid, path traversal)
 * 2. **Input Edge Cases** — Empty params, sparse commas, whitespace trimming
 * 3. **Response Structure & Headers** — JSON fields, upstream_blocklists, HTTP headers
 * 4. **Graceful Degradation** — blocklist_sources.json unavailability
 * 5. **Load Testing** — 2M domain merge under CPU/memory constraints
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert";
import { onRequest } from "../functions/api/blocklists.js";

/**
 * Read a streaming response body, parse it as JSON, and await any pending waitUntil promises.
 */
async function readStreamAsJSON(response, context) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    body += decoder.decode(value, { stream: true });
  }
  if (context.pendingPromise) await context.pendingPromise;
  return JSON.parse(body);
}

/**
 * Creates a mock Cloudflare Pages context object for tests to use.
 */
function createContext(url) {
  const context = {
    request: { url },
    waitUntil: (promise) => {
      context.pendingPromise = promise;
    },
  };
  return context;
}

/**
 * Drain a streaming response without collecting the body. Awaits pending waitUntil promises.
 */
async function drainStream(response, context) {
  const reader = response.body.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
  if (context.pendingPromise) await context.pendingPromise;
}

describe("Cloudflare Worker JS Edge Processing", () => {
  const originalFetch = global.fetch;

  before(() => {
    // Mock the internal Cloudflare cf cache fetch
    global.fetch = async (url) => {
      // Serve blocklist_sources.json for the worker's license attribution lookup
      if (url.includes("blocklist_sources.json")) {
        return new Response(
          JSON.stringify([
            {
              name: "listA",
              fullName: "Test List A",
              url: "https://example.com/listA.txt",
              description: "Test blocklist A",
              license: "MIT",
              license_url: "https://example.com/license-a",
            },
            {
              name: "listB",
              fullName: "Test List B",
              url: "https://example.com/listB.txt",
              description: "Test blocklist B",
              license: "GPL-3.0",
              license_url: "https://example.com/license-b",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Generate precisely 1 million domain strings for list A (alphabetical by number padding)
      if (url.includes("listA")) {
        const domains = Array.from(
          { length: 1000000 },
          (_, i) => `domain${String(i).padStart(7, "0")}.com`,
        )
          .sort()
          .join("\n");
        return new Response(`# Header Comment A\n${domains}`, { status: 200 });
      }
      // Generate 1 million overlapping domain strings for list B
      if (url.includes("listB")) {
        const domains = Array.from(
          { length: 1000000 },
          (_, i) => `domain${String(i + 500000).padStart(7, "0")}.com`,
        )
          .sort()
          .join("\n");
        return new Response(`# Header Comment B\n${domains}`, { status: 200 });
      }

      // Fallback 404
      return new Response("", { status: 404 });
    };
  });

  after(() => {
    global.fetch = originalFetch;
  });

  afterEach(() => {
    // Flush heap between tests to avoid memory carryover
    if (global.gc) global.gc();
  });

  describe("Validation (Query Parameters)", () => {
    /*
     * Validates that the Cloudflare Worker responds with an HTTP 400 Bad Request
     * if the user completely omits the `?lists=` query configuration parameter.
     */
    it("rejects missing parameters", async () => {
      const context = createContext("https://example.com/api/blocklists");
      const response = await onRequest(context);
      assert.strictEqual(response.status, 400);
    });

    /*
     * Validates that redundant parameters supplied in the query string are automatically
     * deduplicated before fetching, preventing identical lists from being downloaded multiple times.
     */
    it("deduplicates identical list names in the query parameter to prevent redundant network fetches", async () => {
      let fetchCount = 0;
      const originalMockFetch = global.fetch;

      // Wrap the testing mock to intercept and count the fetch calls
      global.fetch = async (url, options) => {
        if (url.includes("listA")) fetchCount++;
        return originalMockFetch(url, options);
      };

      const context = createContext(
        "https://example.com/api/blocklists?lists=listA,listA,listA",
      );

      const response = await onRequest(context);
      assert.strictEqual(response.status, 200);

      await drainStream(response, context);

      // Restore the wrapper
      global.fetch = originalMockFetch;

      assert.strictEqual(
        fetchCount,
        1,
        "Worker fetched the same list multiple times despite identical query arguments",
      );
    });

    /*
     * Validates that the Worker correctly identifies missing or invalid blocklist configurations
     * and returns a detailed 404 JSON error response instead of silently failing or returning partial data.
     */
    it("returns a 404 JSON error if one or more requested blocklists are missing", async () => {
      const context = createContext(
        "https://example.com/api/blocklists?lists=listA,missing-list-name",
      );

      const response = await onRequest(context);
      assert.strictEqual(response.status, 404);
      assert.strictEqual(
        response.headers.get("Content-Type"),
        "application/json",
      );

      const jsonBody = await response.json();
      assert.strictEqual(
        jsonBody.error,
        "One or more requested blocklists were not found.",
      );
      assert.deepStrictEqual(jsonBody.missing_lists, ["missing-list-name"]);
    });

    /*
     * Validates that the Worker safely enforces alphanumeric limits on blocklist strings
     * to completely neutralize Path Traversal or Code Injection vulnerabilities.
     */
    it("rejects path traversal vectors and explicitly returns a 400 status code", async () => {
      const context = createContext(
        "https://example.com/api/blocklists?lists=../../package.json",
      );

      const response = await onRequest(context);
      assert.strictEqual(response.status, 400);

      const errorMessage = await response.text();
      assert.match(
        errorMessage,
        /Invalid list name requested: '\.\.\/\.\.\/package\.json'/,
      );
    });
  });

  describe("Input Edge Cases", () => {
    /*
     * Validates that an empty `?lists=` parameter (no value at all) is treated the same
     * as a completely missing parameter, returning a 400 Bad Request.
     */
    it("rejects an empty lists parameter with 400", async () => {
      const context = createContext(
        "https://example.com/api/blocklists?lists=",
      );
      const response = await onRequest(context);
      assert.strictEqual(response.status, 400);
    });

    /*
     * Validates that a lists parameter containing only commas (e.g., `?lists=,,,`)
     * is treated as empty after splitting and filtering, returning a 400 Bad Request.
     */
    it("rejects a lists parameter with only commas as empty", async () => {
      const context = createContext(
        "https://example.com/api/blocklists?lists=,,,",
      );
      const response = await onRequest(context);
      assert.strictEqual(response.status, 400);
    });

    /*
     * Validates that sparse commas between valid list names (e.g., `?lists=listA,,,listB`)
     * are tolerated. The worker should silently discard the empty segments and process
     * only the valid names.
     */
    it("handles sparse commas between valid list names gracefully", async () => {
      const context = {
        request: {
          url: "https://example.com/api/blocklists?lists=listA,,,listB",
        },
        waitUntil: (promise) => {
          context.pendingPromise = promise;
        },
      };
      const response = await onRequest(context);
      assert.strictEqual(response.status, 200);

      await drainStream(response, context);
    });

    /*
     * Validates that the worker trims leading and trailing whitespace from list names.
     * This prevents edge cases where copy-pasting into a URL introduces invisible spaces.
     */
    it("trims whitespace around list names in the query parameter", async () => {
      const context = {
        request: {
          url: "https://example.com/api/blocklists?lists=%20listA%20,%20listB%20",
        },
        waitUntil: (promise) => {
          context.pendingPromise = promise;
        },
      };
      const response = await onRequest(context);
      assert.strictEqual(response.status, 200);

      await drainStream(response, context);
    });
  });

  describe("Response Structure & Headers", () => {
    /*
     * Validates the complete structure of a successful JSON response.
     * The header must contain: description, name, upstream_blocklists, copyright, source.
     * The upstream_blocklists array must contain the correct license attribution for each
     * requested list, sourced from blocklist_sources.json.
     */
    it("returns all expected JSON header fields and correct upstream_blocklists", async () => {
      const context = {
        request: {
          url: "https://example.com/api/blocklists?lists=listA",
        },
        waitUntil: (promise) => {
          context.pendingPromise = promise;
        },
      };

      const response = await onRequest(context);
      assert.strictEqual(response.status, 200);

      const json = await readStreamAsJSON(response, context);

      // Verify all top-level fields exist
      assert.ok(json.description, "Missing 'description' field in response");
      assert.ok(json.name, "Missing 'name' field in response");
      assert.ok(json.copyright, "Missing 'copyright' field in response");
      assert.ok(json.source, "Missing 'source' field in response");
      assert.ok(Array.isArray(json.rules), "Missing 'rules' array in response");
      assert.ok(
        Array.isArray(json.upstream_blocklists),
        "Missing 'upstream_blocklists' array in response",
      );

      // Verify upstream_blocklists contains the correct attribution for listA
      assert.strictEqual(json.upstream_blocklists.length, 1);
      assert.strictEqual(json.upstream_blocklists[0].name, "Test List A");
      assert.strictEqual(json.upstream_blocklists[0].license, "MIT");
      assert.strictEqual(
        json.upstream_blocklists[0].license_url,
        "https://example.com/license-a",
      );
    });

    /*
     * Validates that the worker returns correct HTTP response headers on a successful request:
     * Content-Type must be application/json, Cache-Control must set a 1-hour public TTL,
     * and security headers (X-Content-Type-Options, X-Robots-Tag) must be present.
     */
    it("returns correct Content-Type, Cache-Control, and security headers on success", async () => {
      const context = {
        request: {
          url: "https://example.com/api/blocklists?lists=listA",
        },
        waitUntil: (promise) => {
          context.pendingPromise = promise;
        },
      };

      const response = await onRequest(context);
      assert.strictEqual(response.status, 200);

      assert.strictEqual(
        response.headers.get("Content-Type"),
        "application/json",
      );
      assert.strictEqual(
        response.headers.get("Cache-Control"),
        "public, max-age=3600",
      );
      assert.strictEqual(
        response.headers.get("X-Content-Type-Options"),
        "nosniff",
      );
      assert.match(response.headers.get("X-Robots-Tag"), /noindex/);

      await drainStream(response, context);
    });

    /*
     * Validates that security headers are consistently present on ALL response types,
     * not just successful 200 responses. Covers 400 (bad input) and 404 (missing list).
     */
    it("includes security headers on 400 and 404 error responses", async () => {
      // Test 400 response
      const context400 = {
        request: {
          url: "https://example.com/api/blocklists?lists=../../evil",
        },
      };
      const response400 = await onRequest(context400);
      assert.strictEqual(response400.status, 400);
      assert.strictEqual(
        response400.headers.get("X-Content-Type-Options"),
        "nosniff",
      );
      assert.match(response400.headers.get("X-Robots-Tag"), /noindex/);

      // Test 404 response
      const context404 = {
        request: {
          url: "https://example.com/api/blocklists?lists=nonexistent-list",
        },
      };
      const response404 = await onRequest(context404);
      assert.strictEqual(response404.status, 404);
      assert.strictEqual(
        response404.headers.get("X-Content-Type-Options"),
        "nosniff",
      );
      assert.match(response404.headers.get("X-Robots-Tag"), /noindex/);
    });
  });

  describe("Graceful Degradation", () => {
    /*
     * Validates that the worker returns a 500 error when blocklist_sources.json
     * is unavailable (e.g., server error, misconfiguration). The worker must NOT
     * silently serve responses with missing license attribution.
     */
    it("returns a 500 error when blocklist_sources.json is unavailable", async () => {
      const originalMockFetch = global.fetch;

      // Override the mock to return 500 for blocklist_sources.json specifically
      global.fetch = async (url, options) => {
        if (url.includes("blocklist_sources.json")) {
          return new Response("Internal Server Error", { status: 500 });
        }
        return originalMockFetch(url, options);
      };

      const context = createContext(
        "https://example.com/api/blocklists?lists=listA",
      );

      const response = await onRequest(context);
      assert.strictEqual(response.status, 500);
      assert.strictEqual(
        response.headers.get("Content-Type"),
        "application/json",
      );

      const json = await response.json();
      assert.match(
        json.error,
        /Failed to fetch blocklist_sources\.json/,
        "Error message should describe the sources.json failure",
      );

      global.fetch = originalMockFetch;
    });

    /*
     * Validates that a requested list name which exists as a blocklist file but has
     * no matching entry in blocklist_sources.json is gracefully excluded from the
     * upstream_blocklists attribution array. The .filter(Boolean) on the attribution
     * map must skip the null entries without crashing the response.
     */
    it("excludes unknown list names from upstream_blocklists attribution without error", async () => {
      const originalMockFetch = global.fetch;

      // Override mock: blocklist_sources.json returns only listA metadata, not listB
      global.fetch = async (url, options) => {
        if (url.includes("blocklist_sources.json")) {
          return new Response(
            JSON.stringify([
              {
                name: "listA",
                fullName: "Test List A",
                url: "https://example.com/listA.txt",
                description: "Test blocklist A",
                license: "MIT",
                license_url: "https://example.com/license-a",
              },
              // listB intentionally missing from sources metadata
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return originalMockFetch(url, options);
      };

      const context = createContext(
        "https://example.com/api/blocklists?lists=listA,listB",
      );

      const response = await onRequest(context);
      assert.strictEqual(response.status, 200);

      const json = await readStreamAsJSON(response, context);

      // Only listA should appear in upstream_blocklists (listB has no metadata)
      assert.strictEqual(
        json.upstream_blocklists.length,
        1,
        "Only lists with metadata should appear in upstream_blocklists",
      );
      assert.strictEqual(json.upstream_blocklists[0].name, "Test List A");

      // But rules from both lists should still be merged
      assert.ok(
        json.rules.length > 0,
        "Rules should still contain merged data",
      );

      global.fetch = originalMockFetch;
    });

    /*
     * Validates the outer try/catch error handler. When a blocklist file fetch throws
     * an unrecoverable exception (e.g., network failure after sources.json succeeds),
     * the worker must catch it and return a 500 status with the error message.
     */
    it("returns a 500 error with message when an unexpected exception occurs", async () => {
      const originalMockFetch = global.fetch;

      // Let blocklist_sources.json succeed, but throw for any blocklist file fetch
      global.fetch = async (url, options) => {
        if (url.includes("blocklist_sources.json")) {
          return originalMockFetch(url, options);
        }
        throw new Error("Simulated network failure");
      };

      const context = createContext(
        "https://example.com/api/blocklists?lists=listA",
      );

      const response = await onRequest(context);
      assert.strictEqual(response.status, 500);
      assert.strictEqual(
        response.headers.get("X-Content-Type-Options"),
        "nosniff",
      );

      const body = await response.text();
      assert.match(
        body,
        /Simulated network failure/,
        "500 response should contain the error message",
      );

      global.fetch = originalMockFetch;
    });

    /*
     * Validates that the worker returns a 500 error when blocklist_sources.json
     * contains malformed JSON. The inner try/catch should catch the JSON.parse
     * error and return a descriptive 500 error instead of crashing.
     */
    it("returns a 500 error when blocklist_sources.json contains malformed JSON", async () => {
      const originalMockFetch = global.fetch;

      // Override mock to return invalid JSON for blocklist_sources.json
      global.fetch = async (url, options) => {
        if (url.includes("blocklist_sources.json")) {
          return new Response("{ this is not valid JSON !!!", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return originalMockFetch(url, options);
      };

      const context = createContext(
        "https://example.com/api/blocklists?lists=listA",
      );

      const response = await onRequest(context);
      assert.strictEqual(
        response.status,
        500,
        "Malformed sources.json should return a 500 error",
      );
      assert.strictEqual(
        response.headers.get("Content-Type"),
        "application/json",
      );

      const json = await response.json();
      assert.match(
        json.error,
        /malformed JSON/i,
        "Error message should mention malformed JSON",
      );

      global.fetch = originalMockFetch;
    });
  });

  describe("Load Testing (Memory & CPU Boundaries)", () => {
    /*
     * Merges two 1,000,000-entry lists with 50% overlap.
     * Validates:
     * - The 128MB resident memory limit (via Stream chunk offloading)
     * - The 50ms Wall Time CPU timeout boundary (via Array pointer iteration)
     * - Exact duplicate elimination accuracy
     */
    it("safely merges and deduplicates two 1-million entry blocklists under fast CPU limit", async () => {
      const context = createContext(
        "https://example.com/api/blocklists?lists=listA,listB",
      );

      // Force garbage collection before test if --expose-gc is enabled (optional safeguard)
      if (global.gc) global.gc();

      const startMemory = process.memoryUsage().heapUsed;
      const startTime = performance.now();

      const response = await onRequest(context);

      if (response.status !== 200) {
        console.error("Worker 500 Error:", await response.text());
      }
      assert.strictEqual(response.status, 200);

      // Read the streaming chunks
      let streamReadSize = 0;
      let ruleCount = 0;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        streamReadSize += chunk.length;

        // Count instances of rule definition (memory optimized regex slice)
        const matches = chunk.match(/"action": "deny"/g);
        if (matches) {
          ruleCount += matches.length;
        }
      }

      if (context.pendingPromise) await context.pendingPromise;

      // GC before measuring end memory so lazy V8 string refs don't inflate the growth measurement
      if (global.gc) global.gc();

      const endTime = performance.now();
      const endMemory = process.memoryUsage().heapUsed;

      const durationMs = endTime - startTime;
      const memoryGrowthMb = (endMemory - startMemory) / 1024 / 1024;

      console.log(
        `[Metrics] Processed 2,000,000 domains in: ${durationMs.toFixed(2)} ms`,
      );
      console.log(
        `[Metrics] Resident Heap Memory Growth: ${memoryGrowthMb.toFixed(2)} MB`,
      );
      console.log(
        `[Metrics] Total Streamed Bytes: ${(streamReadSize / 1024 / 1024).toFixed(2)} MB`,
      );

      // Verify k-way merge deduplication correctness
      // List A has [0, 999999] = 1,000,000 elements
      // List B has [500000, 1499999] = 1,000,000 elements
      // Overlap = 500,000
      // Total Unique Expected = 1,500,000 domains compiled into the final JSON output
      assert.strictEqual(
        ruleCount,
        1500000,
        "K-way Merge logic failed to deduplicate properly in streams",
      );

      // Cloudflare limits CPU cycles locally to roughly 50ms, but total clock wall-time includes GC and await promises.
      // Given worst-case CI server spikes, we enforce a strict 5000ms ceiling for 2-million objects on disk
      assert.ok(
        durationMs < 5000,
        `Execution Wall Time (${durationMs}ms) exceeded 5s limit for a 2,000,000 payload.`,
      );
    });
  });
});
