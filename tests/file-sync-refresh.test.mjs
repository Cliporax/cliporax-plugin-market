import assert from "node:assert/strict";
import test from "node:test";

import {
  refreshFileSyncProfile,
  resolveFileSyncProfileId,
} from "../plugins/com.cliporax.file-sync/src/refresh.mjs";

test("uses the configured default File Sync profile", () => {
  assert.equal(
    resolveFileSyncProfileId("profile-2", [
      { id: "profile-1" },
      { id: "profile-2" },
    ]),
    "profile-2",
  );
});

test("selects the only available profile on a new machine", () => {
  assert.equal(
    resolveFileSyncProfileId(null, [{ id: "profile-1" }]),
    "profile-1",
  );
});

test("requires an explicit choice when multiple profiles have no default", () => {
  assert.equal(
    resolveFileSyncProfileId(null, [
      { id: "profile-1" },
      { id: "profile-2" },
    ]),
    "",
  );
});

test("refreshes the selected File Sync profile", async () => {
  const calls = [];
  const refreshed = await refreshFileSyncProfile(async (command, args) => {
    calls.push({ command, args });
  }, "profile-1");

  assert.equal(refreshed, true);
  assert.deepEqual(calls, [
    {
      command: "file_sync_refresh",
      args: { profileId: "profile-1" },
    },
  ]);
});

test("skips remote refresh until a profile is selected", async () => {
  let called = false;
  const refreshed = await refreshFileSyncProfile(async () => {
    called = true;
  }, "");

  assert.equal(refreshed, false);
  assert.equal(called, false);
});

test("propagates refresh failures so the view can show an error", async () => {
  await assert.rejects(
    refreshFileSyncProfile(async () => {
      throw new Error("remote unavailable");
    }, "profile-1"),
    /remote unavailable/,
  );
});
