# Contributing to Little Snitch Blocklist Generator

Thank you for your interest in contributing! Whether you're adding a new blocklist, fixing a bug, or improving the documentation, your help is appreciated. Opening issues is also appreciated, if you do not want to contribute code (Add requested blocklist with URL, description, license and I will review it).

## 🤝 How to Add a New Blocklist

The most common way to contribute is by adding a new blocklist to the automated pipeline. Additionally, if you do not want to use this repo, you can fork it and use it as your own and create your own blocklist generator. Before you submit a Pull Request, please ensure you follow these steps:

### 1. Check the License

Ensure the blocklist has a permissive open-source license (such as MIT, Unlicense, WTFPL, GPL, etc.) that allows for redistribution and modification. We cannot accept lists with strict non-commercial or proprietary licenses that prohibit redistribution.

### 2. Modify `blocklist_sources.json`

Open the `blocklist_sources.json` file in the root directory and append a new JSON object to the array.

**Format Requirements:**

- `name`: A unique identifier using only alphanumeric characters, hyphens, and underscores. This becomes the generated file name.
- `fullName`: A human-readable display name for the blocklist.
- `url`: Direct link to the raw `.txt` file hosted upstream.
- `description`: A short explanation of what the blocklist covers.
- `license`: The type of license (e.g. "MIT", "Unlicense", "GPL-3.0 license").
- `license_url`: A direct link to the upstream license file or clause.

**Example entry:**

```json
{
  "name": "example-ads",
  "fullName": "Example Ads Blocklist",
  "url": "https://raw.githubusercontent.com/example/lists/main/ads.txt",
  "description": "Blocks domains serving advertisements and ad trackers.",
  "license": "MIT",
  "license_url": "https://github.com/example/lists/blob/main/LICENSE"
}
```

**Domain Requirements:**
The URL must point to a plain text file containing **one domain per line**.

- **No IP Addresses:** Formats like `0.0.0.0 domain.com` are not supported.
- **No Adblock Syntax:** Formats like `||domain.com^` are not supported.
- Lines starting with `#` are treated as comments and automatically ignored.

### 3. Update the README

Add the new blocklist to the **Included Blocklists** markdown table in `README.md` in **alphabetical order**.

- Ensure you link to the original repository under `Source`.
- Ensure you link to the blocklist's license file under `License`.

### 4. Branching Strategy

To keep the repository clean and organized, please create a new branch for your work instead of committing directly to `main`:

- **New blocklists or features:** `feat/add-[name]` (e.g., `feat/add-hagezi-light`)
- **Bug fixes:** `fix/[issue-description]` (e.g., `fix/parse-error`)
- **Documentation:** `docs/[description]` (e.g., `docs/update-readme`)

### 5. Open a Pull Request

Please ensure your commit messages follow the [Conventional Commits specification](https://www.conventionalcommits.org/en/v1.0.0/) (e.g., `feat: add new blocklist`, `fix: parse error`, `docs: update readme`).

Submit your Pull Request against the `main` branch. A [PR template](.github/PULL_REQUEST_TEMPLATE.md) will auto-fill with the required checklist — please complete all applicable items before requesting review.

Once merged, GitHub Actions will automatically:

1. Download your new blocklist.
2. Strip upstream comments and metadata.
3. Sort and deduplicate the domains.
4. Commit the new `_preprocessed_sorted.txt` file.

## 💻 Local Development

If you'd like to run the scripts or the Cloudflare Worker locally to test changes:

1. **Install dependencies:**

   ```bash
   npm install
   ```

2. **Run the preprocess script locally:**

   ```bash
   npm run fetch
   # or manually:
   ./scripts/fetch-blocklists.sh blocklist_sources.json blocklists
   ```

3. **Run the test suite:**
   Ensure your changes pass the formatting and worker tests.

   ```bash
   npm test
   ```

4. **Test the Cloudflare Worker locally:**
   ```bash
   npm run dev
   ```
   _Note: This runs the worker locally via Wrangler._

## 🐛 Reporting Bugs

If you find a bug in the merge algorithm, the parsing script, or the Cloudflare Pages deployment, please open an Issue with as much context as possible, including:

- Steps to reproduce the issue
- Expected behavior vs actual behavior
- If applicable, the URL you tried to fetch through the API

Thanks for contributing!
