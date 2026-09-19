import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";

const buildScript = fileURLToPath(new URL("../scripts/build-market.mjs", import.meta.url));

test("market build bundles TypeScript and stops on compilation errors", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cliporax-market-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pluginRoot = path.join(root, "plugins", "com.cliporax.imagepreview");
  await mkdir(path.join(pluginRoot, "src"), { recursive: true });
  await mkdir(path.join(pluginRoot, "assets"));
  await mkdir(path.join(root, "schemas"));
  await copyFile(new URL("../plugins/com.cliporax.imagepreview/manifest.json", import.meta.url), path.join(pluginRoot, "manifest.json"));
  await copyFile(new URL("../plugins/com.cliporax.imagepreview/assets/icon.svg", import.meta.url), path.join(pluginRoot, "assets", "icon.svg"));
  await copyFile(new URL("../schemas/market-index.schema.json", import.meta.url), path.join(root, "schemas", "market-index.schema.json"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.1.9" }));
  await writeFile(path.join(pluginRoot, "src", "value.ts"), "export const value: number = 42;");
  const entry = path.join(pluginRoot, "src", "main.ts");
  await writeFile(entry, 'import { value } from "./value"; globalThis.testValue = value;');

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLIPORAX_MARKET_") || key.startsWith("GITHUB_") || key === "RELEASE_TAG") delete env[key];
  }
  env.RELEASE_TAG = "v0.1.9";
  const run = (command) => spawnSync(process.execPath, [buildScript, command], {
    cwd: root, env, encoding: "utf8", timeout: 30_000,
  });

  const build = run("build");
  assert.equal(build.status, 0, `${build.error || ""}\n${build.stderr}`);
  const context = {};
  vm.runInNewContext(await readFile(path.join(pluginRoot, "main.js"), "utf8"), context);
  assert.equal(context.testValue, 42);
  const index = JSON.parse(await readFile(path.join(root, "market", "index.json"), "utf8"));
  const asset = index.plugins[0].asset;
  const archive = await readFile(path.join(root, "dist", asset.name));
  assert.equal(archive.length, asset.size);
  assert.equal(createHash("sha256").update(archive).digest("hex"), asset.sha256);
  const validation = run("validate");
  assert.equal(validation.status, 0, validation.stderr);

  await writeFile(entry, "const invalid: = ;");
  const failedBuild = run("build");
  assert.notEqual(failedBuild.status, 0);
  assert.match(failedBuild.stderr, /ERROR|Build failed/);
  assert.doesNotMatch(failedBuild.stdout, /Built .* official plugin package/);
});
