import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { after, test } from "node:test";
import { build } from "esbuild";

const buildDirectory = await mkdtemp(path.join(tmpdir(), "cliporax-copyq-test-"));
const outputPath = path.join(buildDirectory, "copyq.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../plugins/com.cliporax.clipboard-import/src/copyq.ts", import.meta.url))],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outputPath,
});
const {
  COPYQ_OUTPUT_BUDGET_BYTES,
  createCopyqPageArguments,
  createCopyqPageScript,
  parseCopyqPage,
} = await import(pathToFileURL(outputPath));

after(() => rm(buildDirectory, { recursive: true, force: true }));

class FakeByteArray {
  constructor(value = "") {
    this.buffer = Buffer.isBuffer(value)
      ? value
      : Buffer.from(value instanceof FakeByteArray ? value.buffer : String(value));
  }

  size() {
    return this.buffer.byteLength;
  }

  toBase64() {
    return new FakeByteArray(this.buffer.toString("base64"));
  }

  toString() {
    return this.buffer.toString();
  }
}

function runCopyqScript(script, tabs, cursor) {
  const names = Object.keys(tabs);
  let currentTab = names[0];
  let stdout = "";
  const context = {
    arguments: [{}, cursor ? String(cursor.tab) : "", cursor ? String(cursor.row) : ""],
    ByteArray: FakeByteArray,
    JSON,
    print(value) {
      stdout += String(value);
    },
    read(mimeOrIndex, index) {
      const row = index === undefined ? mimeOrIndex : index;
      const item = tabs[currentTab][row];
      if (index === undefined) {
        return typeof item === "string" ? item : (item.text ?? "");
      }
      return new FakeByteArray(
        typeof item === "string" ? "" : (item.images?.[mimeOrIndex] ?? ""),
      );
    },
    size() {
      return tabs[currentTab].length;
    },
    str(value) {
      return String(value);
    },
    tab(name) {
      if (name === undefined) return names;
      currentTab = name;
      return names;
    },
  };
  vm.runInNewContext(script, context);
  return stdout;
}

test("CopyQ pagination imports a history larger than one process-output page", () => {
  const largeHistory = Array.from({ length: 100 }, (_, index) => `${index}:${"x".repeat(100_000)}`);
  const script = createCopyqPageScript(250, 1_048_576, 52_428_800);
  const records = [];
  let cursor;
  let pages = 0;
  let done = false;

  while (!done) {
    const stdout = runCopyqScript(script, { Clipboard: largeHistory }, cursor);
    const page = parseCopyqPage(stdout);
    assert.ok(Buffer.byteLength(stdout) < 8 * 1024 * 1024);
    assert.ok(Buffer.byteLength(stdout) < COPYQ_OUTPUT_BUDGET_BYTES + 1_000);
    records.push(...page.records);
    cursor = page.nextCursor;
    done = page.done;
    pages += 1;
  }

  assert.ok(pages > 1);
  assert.equal(records.length, largeHistory.length);
  assert.deepEqual(records.map((record) => record.content), [...largeHistory].reverse());
});

test("CopyQ eval arguments disable command-line escape expansion", () => {
  const args = createCopyqPageArguments(undefined, 250, 1_048_576, 52_428_800);

  assert.deepEqual(args.slice(0, 2), ["eval", "--"]);
  assert.match(args[2], /JSON\.stringify/);
  assert.match(args[2], /'\\n'/);
});

test("CopyQ pagination traverses every tab and includes images", () => {
  const script = createCopyqPageScript(10, 1_048_576, 52_428_800);
  const stdout = runCopyqScript(script, {
    Clipboard: [
      "clipboard newest",
      { images: { "image/png": Buffer.from("png bytes") } },
      "clipboard oldest",
    ],
    Notes: ["notes newest", "notes oldest"],
    Empty: [],
  });
  const page = parseCopyqPage(stdout);

  assert.equal(page.done, true);
  assert.deepEqual(page.sourceTabs, ["Clipboard", "Notes", "Empty"]);
  assert.deepEqual(
    page.records.map((record) => [record.tab, record.type, record.content]),
    [
      ["Notes", "text", "notes oldest"],
      ["Notes", "text", "notes newest"],
      ["Clipboard", "text", "clipboard oldest"],
      ["Clipboard", "image", "data:image/png;base64,cG5nIGJ5dGVz"],
      ["Clipboard", "text", "clipboard newest"],
    ],
  );
});

test("CopyQ parser preserves multiline records and counts malformed output", () => {
  const parsed = parseCopyqPage([
    JSON.stringify({ tab: "Clipboard", type: "text", content: "line 1\nline 2" }),
    "not-json",
    JSON.stringify({
      __cliporax_copyq: 2,
      tabs: ["Clipboard"],
      skipped: 4,
      scanned: 5,
      total: 10,
      done: false,
      nextTab: 0,
      nextRow: 4,
    }),
    "",
  ].join("\n"));

  assert.deepEqual(parsed.records, [{
    tab: "Clipboard",
    type: "text",
    content: "line 1\nline 2",
  }]);
  assert.equal(parsed.skipped, 5);
  assert.equal(parsed.done, false);
  assert.deepEqual(parsed.sourceTabs, ["Clipboard"]);
  assert.deepEqual(parsed.nextCursor, { tab: 0, row: 4 });
});

test("clipboard writes use batch IPC and serialized tags", async () => {
  const sourcePath = fileURLToPath(new URL(
    "../plugins/com.cliporax.clipboard-import/src/main.ts",
    import.meta.url,
  ));
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /clipboard_create_batch/);
  assert.match(source, /records\.map\(\(record\) => toClipboardItem/);
  assert.match(source, /tags:\s*"\[\]"/);
  assert.doesNotMatch(source, /tags:\s*\[\]/);
});

test("CopyQ source-tab layout is the default and creates missing tabs", async () => {
  const sourcePath = fileURLToPath(new URL(
    "../plugins/com.cliporax.clipboard-import/src/main.ts",
    import.meta.url,
  ));
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /let copyqLayout: CopyqLayout = "source-tabs"/);
  assert.match(source, /Keep source tab structure/);
  assert.match(source, /Merge into one tab/);
  assert.match(source, /invoke<number>\("tabs_create"/);
  assert.match(source, /TAB_LIST_CHANGED_EVENT/);
});

test("import progress is rendered as a sticky accessible status card", async () => {
  const sourcePath = fileURLToPath(new URL(
    "../plugins/com.cliporax.clipboard-import/src/main.ts",
    import.meta.url,
  ));
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /\.ci-status\{position:sticky;top:0;z-index:20/);
  assert.match(source, /progress\.setAttribute\("role", "progressbar"\)/);
  assert.match(source, /status\.setAttribute\("aria-live", "polite"\)/);
  assert.match(source, /shell\.append\(header, status, sourcePicker, destination/);
});

test("import source combobox progressively reveals one source card", async () => {
  const sourcePath = fileURLToPath(new URL(
    "../plugins/com.cliporax.clipboard-import/src/main.ts",
    import.meta.url,
  ));
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /sourcePickerLabel\.textContent = "Import source"/);
  assert.match(source, /\{ value: "copyq", label: "CopyQ" \}/);
  assert.match(source, /\{ value: "custom", label: "Custom NDJSON exporter" \}/);
  assert.match(source, /copyqCard\.hidden = !isCopyq/);
  assert.match(source, /gpasteCard\.hidden = !isGpaste/);
  assert.match(source, /exporterCard\.hidden = !isExporter/);
  assert.match(source, /destination\.hidden = isCopyq && copyqLayout === "source-tabs"/);
  assert.doesNotMatch(source, /document\.createElement\("details"\)/);
});
