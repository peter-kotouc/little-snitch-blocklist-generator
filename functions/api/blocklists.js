/**
 * @module blocklists
 * @description Cloudflare Pages Function that dynamically merges, deduplicates, and streams
 * multiple DNS blocklists into a single Little Snitch-compatible JSON ruleset.
 *
 * ## Request Lifecycle
 * 1. Parse and validate the `?lists=` query parameter
 * 2. Fetch `blocklist_sources.json` for upstream license attribution
 * 3. Fetch all requested `_preprocessed_sorted.txt` files in parallel
 * 4. Perform an O(N) k-way merge across sorted lists using pointer iteration
 * 5. Stream the deduplicated JSON rules via TransformStream to avoid memory limits
 *
 * ## Algorithm: K-Way Merge with Deduplication
 * Each blocklist file is pre-sorted alphabetically by the GitHub Actions pipeline.
 * The merge uses one pointer per list, advancing the smallest value at each step.
 * When the same domain appears in multiple lists, ALL pointers advance simultaneously,
 * emitting the domain exactly once.
 *
 * ## Streaming Strategy
 * The response is streamed via a TransformStream to stay within Cloudflare's 128MB
 * memory limit. Rules are buffered in chunks of 5,000 before flushing to the stream,
 * balancing between memory efficiency and minimizing expensive await microtasks.
 *
 * ## Security
 * - List names are validated against `/^[a-zA-Z0-9_-]+$/` to prevent path traversal
 * - All responses include `X-Content-Type-Options: nosniff` and `X-Robots-Tag` headers
 * - The `cf` fetch options cache internal reads at the edge for 1 hour
 *
 * @see {@link https://help.obdev.at/littlesnitch5/lsc-rule-group-subscriptions} Little Snitch Rule Format
 */

// --- CONFIGURATION ---
// If you fork this repository, please update these variables to your own details:
const AUTHOR_NAME = "Peter";
const REPOSITORY_URL =
  "https://github.com/peter-kotouc/little-snitch-blocklist-generator";
// ---------------------

// Shared security headers for all error responses
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
};

/**
 * Build a standardized error response with security headers.
 * @param {string} body - Response body (plain text or JSON string).
 * @param {number} status - HTTP status code.
 * @param {string} [contentType="text/plain"] - Content-Type header value.
 * @returns {Response}
 */
function errorResponse(body, status, contentType = "text/plain") {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType, ...SECURITY_HEADERS },
  });
}

/**
 * Handles incoming HTTP requests to the blocklist merge API.
 *
 * @async
 * @function onRequest
 * @param {object} context - Cloudflare Pages Function context object.
 * @param {object} context.request - The incoming HTTP Request object.
 * @param {function} context.waitUntil - Cloudflare lifecycle hook to extend the request beyond the return.
 * @returns {Promise<Response>} A streaming JSON Response containing merged Little Snitch rules.
 *
 * @precondition The request URL must contain a `lists` query parameter with comma-separated blocklist names.
 * @precondition Each blocklist name must match `/^[a-zA-Z0-9_-]+$/` (no special characters or path segments).
 * @precondition The corresponding `_preprocessed_sorted.txt` files must exist under `/blocklists/` on the same domain.
 * @precondition Each `.txt` file must be pre-sorted alphabetically (guaranteed by the GitHub Actions pipeline).
 *
 * @postcondition On success (200): Returns a streaming JSON response with Content-Type `application/json`.
 * @postcondition On success (200): The `rules` array contains exactly one entry per unique domain across all input lists.
 * @postcondition On success (200): The `upstream_blocklists` array contains license attribution for each requested list.
 * @postcondition On success (200): Rules are sorted alphabetically (natural consequence of the k-way merge).
 * @postcondition On client error (400): Returned when `lists` param is missing, empty, or contains invalid characters.
 * @postcondition On not found (404): Returned as JSON when one or more requested blocklist files do not exist.
 * @postcondition On server error (500): Returned as plaintext when an unexpected exception occurs.
 * @postcondition All responses include `X-Content-Type-Options: nosniff` and `X-Robots-Tag` security headers.
 *
 * @invariant Duplicate domains across multiple lists are emitted exactly once in the output.
 * @invariant The output JSON is always syntactically valid (header + rules array + closing braces).
 * @invariant Memory usage stays bounded regardless of input size due to chunk-based stream flushing.
 *
 * @example
 * // Request:
 * GET /api/blocklists?lists=hagezi-light,blocklistproject-ads
 *
 * // Response (200, streaming JSON):
 * {
 *   "description": "Merged blocklist containing: hagezi-light, blocklistproject-ads",
 *   "name": "Dynamic Blocklist provided by Peter",
 *   "upstream_blocklists": [
 *     { "name": "Hagezi Light", "license": "GPL-3.0 license", "license_url": "..." },
 *     { "name": "BlocklistProject Ads", "license": "Unlicense", "license_url": "..." }
 *   ],
 *   "rules": [
 *     { "action": "deny", "process": "any", "remote-domains": "ads.example.com" },
 *     ...
 *   ]
 * }
 */
export async function onRequest(context) {
  const request = context.request;
  const url = new URL(request.url);
  const listsParam = url.searchParams.get("lists") || "";

  // Parse, trim, deduplicate: "listA, listA,,listB" → ["listA", "listB"]
  // Postcondition: listNames contains only unique, non-empty, trimmed strings
  const listNames = [
    ...new Set(
      listsParam
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];

  // Reject requests where the lists parameter is missing or contains no valid names (e.g., ?lists= or ?lists=,,,)
  if (listNames.length === 0) {
    return errorResponse(
      "Missing 'lists' query parameter. Example: ?lists=hagezi-light,blocklistproject-ads",
      400,
    );
  }

  // Security: Prevent path traversal vulnerabilities (e.g. ?lists=../../package.json)
  const invalidName = listNames.find((name) => !/^[a-zA-Z0-9_-]+$/.test(name));
  if (invalidName) {
    return errorResponse(
      `Invalid list name requested: '${invalidName}'. Only alphanumeric characters, hyphens, and underscores are allowed.`,
      400,
    );
  }

  // Construct the URLs to fetch the blocklists from the same domain
  // Assuming the worker is deployed to the same domain where the /blocklists/ directory is served
  const baseUrl = url.origin;

  try {
    // Fetch the blocklist sources metadata to include upstream license attribution in the response
    const sourcesUrl = `${baseUrl}/blocklist_sources.json`;
    let allSources;
    try {
      const sourcesResponse = await fetch(sourcesUrl, {
        cf: { cacheEverything: true, cacheTtl: 3600 },
      });
      if (!sourcesResponse.ok) {
        return errorResponse(
          JSON.stringify({
            error: `Failed to fetch blocklist_sources.json (HTTP ${sourcesResponse.status}). Cannot build license attribution.`,
          }),
          500,
          "application/json",
        );
      }
      allSources = await sourcesResponse.json();
    } catch (parseError) {
      return errorResponse(
        JSON.stringify({
          error: `blocklist_sources.json is unreachable or contains malformed JSON: ${parseError.message}`,
        }),
        500,
        "application/json",
      );
    }

    // Build the upstream_blocklists attribution array for only the requested lists
    const upstreamBlocklists = listNames
      .map((name) => {
        const source = allSources.find((s) => s.name === name);
        if (!source) return null;
        return {
          name: source.fullName || source.name,
          license: source.license,
          license_url: source.license_url,
        };
      })
      .filter(Boolean);

    // Fetch all requested lists in parallel
    const fetchPromises = listNames.map(async (name) => {
      const blocklistUrl = `${baseUrl}/blocklists/${name}_preprocessed_sorted.txt`;
      // Cache blocklist files at the edge for 1 hour via Cloudflare's cf fetch options
      const response = await fetch(blocklistUrl, {
        cf: {
          cacheEverything: true,
          cacheTtl: 3600,
        },
      });

      if (!response.ok) {
        return { error: true, name: name };
      }
      return { error: false, text: await response.text() };
    });

    const results = await Promise.all(fetchPromises);

    // If any blocklists failed to download (e.g., 404 Not Found), intercept and return a JSON error
    const missingLists = results.filter((r) => r.error);
    if (missingLists.length > 0) {
      return errorResponse(
        JSON.stringify({
          error: "One or more requested blocklists were not found.",
          missing_lists: missingLists.map((r) => r.name),
        }),
        404,
        "application/json",
      );
    }

    const texts = results.map((r) => r.text);

    // Parse each text into an array of domain strings.
    // Precondition: Each text blob is a newline-delimited, alphabetically sorted domain list
    //               with optional `#` comment headers injected by the preprocessing script.
    // Postcondition: parsedLists[i] is a string[] of pure domain names, sorted alphabetically,
    //                with all comments and blank lines removed.
    const parsedLists = texts.filter(Boolean).map((text) =>
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")),
    );

    // --- K-WAY MERGE ENGINE ---
    // Precondition: All parsedLists[i] are individually sorted in ascending lexicographic order.
    // Invariant: At each iteration, `minVal` holds the smallest unprocessed domain across all lists.
    // Invariant: Each domain is written to the stream exactly once, regardless of how many lists contain it.
    // Postcondition: The output stream contains all unique domains in sorted order.
    //
    // Complexity: O(N * K) where N = total domains across all lists, K = number of lists.
    // Memory:     O(K) pointers + chunk buffer (flushed every 5,000 entries).
    //             The TransformStream avoids buffering the entire output in memory.
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Start generating response asynchronously so we can return the readable stream immediately
    context.waitUntil(
      (async () => {
        try {
          const headerObj = {
            description: `Merged blocklist containing: ${listNames.join(", ")}`,
            name: `Dynamic Blocklist provided by ${AUTHOR_NAME}`,
            upstream_blocklists: upstreamBlocklists,
            copyright:
              "Upstream blocklist data is provided by their respective authors under the licenses listed in upstream_blocklists. This tool's code is MIT-licensed. See source repo for details.",
            source: REPOSITORY_URL,
            rules: [], // We'll truncate this and stream the array contents
          };

          let headerStr = JSON.stringify(headerObj, null, 2);
          // Manually cut off the closing `[]\n}` so we can inject the rules
          headerStr =
            headerStr.substring(0, headerStr.lastIndexOf("[]")) + "[\n";
          await writer.write(encoder.encode(headerStr));

          const pointers = new Array(parsedLists.length).fill(0);
          let isFirstRule = true;

          let chunkBuffer = "";
          let chunkCount = 0;

          while (true) {
            let minVal = null;

            // Find the alphabetically smallest string among all current pointers
            for (let i = 0; i < parsedLists.length; i++) {
              if (pointers[i] < parsedLists[i].length) {
                const val = parsedLists[i][pointers[i]];
                if (minVal === null || val < minVal) {
                  minVal = val;
                }
              }
            }

            // If we found no minimum, all lists are exhausted
            if (minVal === null) break;

            const ruleStr = `    { "action": "deny", "process": "any", "remote-domains": "${minVal}" }`;

            if (!isFirstRule) {
              chunkBuffer += ",\n" + ruleStr;
            } else {
              chunkBuffer += ruleStr;
              isFirstRule = false;
            }

            chunkCount++;

            // Flush the buffer to the stream every 5,000 domains
            // This prevents the Cloudflare Worker from hitting CPU limits due to hundreds of thousands of await microtasks
            if (chunkCount >= 5000) {
              await writer.write(encoder.encode(chunkBuffer));
              chunkBuffer = "";
              chunkCount = 0;
            }

            // Advance pointers for ALL lists that have this exact minimum value.
            // THIS IS WHERE DUPLICATES ARE DELETED: If domain exists in 3 different lists,
            // all 3 pointers advance past it simultaneously, but it was only written to the stream once.
            for (let i = 0; i < parsedLists.length; i++) {
              if (
                pointers[i] < parsedLists[i].length &&
                parsedLists[i][pointers[i]] === minVal
              ) {
                pointers[i]++;
              }
            }
          }

          // Flush any remaining rules
          if (chunkBuffer.length > 0) {
            await writer.write(encoder.encode(chunkBuffer));
          }

          // Close the JSON arrays
          await writer.write(encoder.encode("\n  ]\n}"));
          await writer.close();
        } catch (err) {
          console.error("Stream generation error:", err);
          await writer.abort(err);
        }
      })(),
    );

    return new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
        ...SECURITY_HEADERS,
      },
    });
  } catch (error) {
    return errorResponse(`Error processing lists: ${error.message}`, 500);
  }
}
