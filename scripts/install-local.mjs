import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, cp } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";

const root = process.cwd();
const pluginsDir = path.join(root, "plugins");
const appIdentifier = process.env.CLIPORAX_APP_IDENTIFIER || "com.cliporax.app";
const skipBuild = process.argv.includes("--skip-build");

function runtimePluginDir() {
  switch (platform()) {
    case "linux": {
      const dataHome = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
      return path.join(dataHome, appIdentifier, "plugins");
    }
    case "darwin":
      return path.join(homedir(), "Library", "Application Support", appIdentifier, "plugins");
    case "win32": {
      if (!process.env.APPDATA) {
        throw new Error("APPDATA is not set; cannot resolve the Cliporax plugin directory");
      }
      return path.join(process.env.APPDATA, appIdentifier, "plugins");
    }
    default:
      throw new Error(`Unsupported platform: ${platform()}`);
  }
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function installPlugin(pluginName, runtimeDir) {
  const pluginRoot = path.join(pluginsDir, pluginName);
  const manifestPath = path.join(pluginRoot, "manifest.json");
  const mainPath = path.join(pluginRoot, "main.js");

  if (!(await pathExists(manifestPath)) || !(await pathExists(mainPath))) {
    return false;
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const targetName = manifest.id || pluginName;
  const targetRoot = path.join(runtimeDir, targetName);

  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(targetRoot, { recursive: true });

  const entries = await readdir(pluginRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "src") continue;
    const source = path.join(pluginRoot, entry.name);
    const target = path.join(targetRoot, entry.name);
    await cp(source, target, { recursive: true });
  }

  console.log(`[Plugins] Installed ${targetName}`);
  return {
    id: targetName,
    permissions: Array.isArray(manifest.permissions)
      ? manifest.permissions
          .map((entry) => entry?.permission)
          .filter((permission) => typeof permission === "string" && permission)
      : [],
  };
}

async function syncLocalPermissions(runtimeDir, installedPlugins) {
  const statePath = path.join(runtimeDir, ".plugin_state.json");
  const state = (await pathExists(statePath))
    ? JSON.parse(await readFile(statePath, "utf8"))
    : { active_plugins: [], granted_permissions: {} };

  state.active_plugins = Array.isArray(state.active_plugins) ? state.active_plugins : [];
  state.granted_permissions =
    state.granted_permissions && typeof state.granted_permissions === "object"
      ? state.granted_permissions
      : {};

  for (const plugin of installedPlugins) {
    const granted = new Set(state.granted_permissions[plugin.id] || []);
    for (const permission of plugin.permissions) {
      granted.add(permission);
    }
    state.granted_permissions[plugin.id] = Array.from(granted).sort();
  }

  await mkdir(runtimeDir, { recursive: true });
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`),
  );
  console.log(`[Plugins] Synced local development permissions in ${statePath}`);
}

async function main() {
  if (!skipBuild) {
    execFileSync(process.execPath, [path.join("scripts", "build-market.mjs"), "build"], {
      cwd: root,
      stdio: "inherit",
    });
  }

  const runtimeDir = runtimePluginDir();
  await mkdir(runtimeDir, { recursive: true });

  const pluginEntries = await readdir(pluginsDir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });

  const installedPlugins = [];
  for (const entry of pluginEntries) {
    if (!entry.isDirectory()) continue;
    const installed = await installPlugin(entry.name, runtimeDir);
    if (installed) {
      installedPlugins.push(installed);
    }
  }

  await syncLocalPermissions(runtimeDir, installedPlugins);

  console.log(`[Plugins] Installed ${installedPlugins.length} plugin(s) to ${runtimeDir}`);
}

main().catch((error) => {
  console.error("[Plugins] Local install failed:", error);
  process.exitCode = 1;
});
