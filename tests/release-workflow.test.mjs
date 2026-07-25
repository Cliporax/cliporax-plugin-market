import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/release.yml", import.meta.url);

test("manual releases build market URLs with the requested release tag", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const resolvedTag = "${{ github.ref_type == 'tag' && github.ref_name || inputs.tag }}";

  assert.match(workflow, new RegExp(`RELEASE_TAG: ${escapeRegExp(resolvedTag)}`));
  assert.match(
    workflow,
    new RegExp(
      `CLIPORAX_MARKET_RELEASE_BASE_URL: https://github\\.com/\\$\\{\\{ github\\.repository \\}\\}/releases/download/${escapeRegExp(resolvedTag)}`
    )
  );
  assert.match(workflow, new RegExp(`CLIPORAX_MARKET_VERSION: ${escapeRegExp(resolvedTag)}`));
  assert.match(workflow, /tag_name: \$\{\{ env\.RELEASE_TAG \}\}/);
  assert.match(workflow, /uses: actions\/checkout@v6/);
  assert.match(workflow, /uses: actions\/setup-node@v6/);
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /fail_on_unmatched_files: true/);
  assert.match(workflow, /Release tag must be a version such as v0\.1\.9/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
