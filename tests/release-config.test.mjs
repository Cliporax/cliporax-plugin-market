import assert from "node:assert/strict";
import test from "node:test";
import { resolveReleaseConfig } from "../scripts/release-config.mjs";

const branchEnv = {
  GITHUB_REPOSITORY: "example/market",
  GITHUB_REF_TYPE: "branch",
  GITHUB_REF_NAME: "main",
};

test("manual build uses the requested release instead of main", () => {
  assert.deepEqual(resolveReleaseConfig({ ...branchEnv, RELEASE_TAG: "v0.2.0" }, "0.1.9"), {
    marketVersion: "v0.2.0",
    baseUrl: "https://github.com/example/market/releases/download/v0.2.0",
  });
  assert.equal(
    resolveReleaseConfig({ ...branchEnv, CLIPORAX_MARKET_VERSION: "v0.2.1" }, "0.1.9").marketVersion,
    "v0.2.1",
  );
});

test("tag builds retain their exact release version", () => {
  const result = resolveReleaseConfig({
    ...branchEnv, GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.3.0-beta.1",
  }, "0.1.9");
  assert.equal(result.marketVersion, "v0.3.0-beta.1");
  assert.ok(result.baseUrl.endsWith("/v0.3.0-beta.1"));
});

test("branch and local builds use package version, never main or local", () => {
  for (const env of [{}, branchEnv, { ...branchEnv, GITHUB_REF_TYPE: undefined }]) {
    const result = resolveReleaseConfig(env, "0.1.9");
    assert.equal(result.marketVersion, "v0.1.9");
    assert.ok(result.baseUrl.endsWith("/releases/download/v0.1.9"));
  }
});

test("explicit GitHub base URL provides the market version", () => {
  const result = resolveReleaseConfig({
    ...branchEnv,
    CLIPORAX_MARKET_RELEASE_BASE_URL: "https://github.com/example/market/releases/download/v0.4.0/",
  }, "0.1.9");
  assert.equal(result.marketVersion, "v0.4.0");
  assert.equal(result.baseUrl, "https://github.com/example/market/releases/download/v0.4.0");
});

test("branch names and mismatched release settings fail before packaging", () => {
  for (const env of [
    { RELEASE_TAG: "main" },
    { CLIPORAX_MARKET_VERSION: "main" },
    { RELEASE_TAG: "v0.2.0", CLIPORAX_MARKET_VERSION: "v0.1.9" },
    { CLIPORAX_MARKET_RELEASE_BASE_URL: "https://github.com/example/market/releases/download/main" },
    {
      RELEASE_TAG: "v0.2.0",
      CLIPORAX_MARKET_RELEASE_BASE_URL: "https://github.com/example/market/releases/download/v0.1.9",
    },
    { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "main" },
  ]) {
    assert.throws(() => resolveReleaseConfig(env, "0.1.9"), /release|Release/);
  }
});

test("floating or malformed GitHub base URLs are rejected", () => {
  for (const suffix of ["latest/download", "download/v0.1.9?raw=1", "download/v0.1.9#asset"]) {
    assert.throws(() => resolveReleaseConfig({
      CLIPORAX_MARKET_RELEASE_BASE_URL: `https://github.com/example/market/releases/${suffix}`,
    }, "0.1.9"), /GitHub release base URL/);
  }
});

test("custom hosting remains supported", () => {
  assert.deepEqual(resolveReleaseConfig({
    RELEASE_TAG: "v0.1.9",
    CLIPORAX_MARKET_RELEASE_BASE_URL: "https://plugins.example.com/packages/",
  }, "0.1.9"), {
    marketVersion: "v0.1.9",
    baseUrl: "https://plugins.example.com/packages",
  });
});
