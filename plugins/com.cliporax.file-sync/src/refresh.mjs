export function resolveFileSyncProfileId(defaultProfileId, profiles) {
  if (defaultProfileId) return defaultProfileId;
  return profiles.length === 1 ? profiles[0].id : "";
}

export async function refreshFileSyncProfile(invoke, profileId) {
  if (!profileId) return false;
  await invoke("file_sync_refresh", { profileId });
  return true;
}
