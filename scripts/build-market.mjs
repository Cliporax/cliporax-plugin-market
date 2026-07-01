import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const pluginsDir = path.join(root, "plugins");
const thirdPartyDir = path.join(root, "third-party");
const distDir = path.join(root, "dist");
const marketDir = path.join(root, "market");
const indexPath = path.join(marketDir, "index.json");
const schemaPath = path.join(root, "schemas", "market-index.schema.json");

const command = process.argv[2] ?? "build";

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const pluginIdPattern = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;
const allowedTypes = new Set(["utility", "integration", "viewer", "automation", "sync", "other"]);
const allowedPlatforms = new Set(["linux", "macos", "windows"]);
const allowedIconTypes = new Map([
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"]
]);
const maxIconSize = 64 * 1024;
const dosTime = 0;
const dosDate = (0 << 9) | (1 << 5) | 1;

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  if (!["build", "validate", "pack"].includes(command)) {
    throw new Error(`Unknown command "${command}". Use build, validate, or pack.`);
  }

  if (command === "validate") {
    const index = await readJson(indexPath);
    validateMarketIndex(index);
    console.log(`Validated ${index.plugins.length} market plugin(s).`);
    return;
  }

  await compilePluginSources();
  const plugins = await loadPlugins();
  if (plugins.length === 0) {
    throw new Error("No plugins found. Add plugins/<plugin_id>/manifest.json before building the market.");
  }

  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  await mkdir(marketDir, { recursive: true });

  const entries = [];
  for (const plugin of plugins) {
    const archive = await createPluginArchive(plugin);
    entries.push(toMarketEntry(plugin, archive));
  }
  entries.push(...(await loadThirdPartyEntries()));

  const index = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    marketVersion: getMarketVersion(),
    plugins: entries.sort((a, b) => a.id.localeCompare(b.id))
  };

  validateMarketIndex(index);
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  if (command === "pack") {
    console.log(`Packed ${plugins.length} official plugin package(s) and ${entries.length} market entry(s).`);
  } else {
    console.log(`Built ${plugins.length} official plugin package(s), ${entries.length} market entry(s), and market/index.json.`);
  }
}

async function compilePluginSources() {
  const children = await readdir(pluginsDir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const tsc = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

  for (const child of children) {
    if (!child.isDirectory()) continue;
    const pluginRoot = path.join(pluginsDir, child.name);
    const sourceEntry = path.join(pluginRoot, "src", "main.ts");
    await ensureRegularFile(sourceEntry, `Plugin ${child.name} must provide TypeScript source at src/main.ts.`);

    execFileSync(
      tsc,
      [
        "--target",
        "ES2022",
        "--module",
        "ES2022",
        "--moduleResolution",
        "Bundler",
        "--rootDir",
        "src",
        "--outDir",
        ".",
        "--strict",
        "--noEmitOnError",
        "--skipLibCheck",
        "--declaration",
        "false",
        "--sourceMap",
        "false",
        "src/main.ts"
      ],
      {
        cwd: pluginRoot,
        stdio: "inherit"
      }
    );
  }
}

async function loadThirdPartyEntries() {
  const children = await readdir(thirdPartyDir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const entries = [];

  for (const child of children) {
    if (!child.isFile() || !child.name.endsWith(".json")) continue;
    const configPath = path.join(thirdPartyDir, child.name);
    const config = await readJson(configPath);
    const plugins = Array.isArray(config) ? config : config.plugins;
    if (!Array.isArray(plugins)) {
      throw new Error(`Third-party config ${child.name} must be an array or an object with a plugins array.`);
    }

    for (const plugin of plugins) {
      const entry = normalizeThirdPartyEntry(plugin, child.name);
      entries.push(entry);
    }
  }

  return entries;
}

function normalizeThirdPartyEntry(plugin, fileName) {
  if (!plugin || typeof plugin !== "object") {
    throw new Error(`Third-party config ${fileName} contains an invalid plugin entry.`);
  }
  if (!plugin.publisher || typeof plugin.publisher !== "object") {
    throw new Error(`Third-party plugin ${plugin.id ?? "(unknown)"} must include publisher metadata.`);
  }
  if (plugin.publisher.official === true) {
    throw new Error(`Third-party plugin ${plugin.id} cannot set publisher.official to true.`);
  }

  return {
    ...plugin,
    publisher: {
      name: plugin.publisher.name,
      url: plugin.publisher.url,
      official: false
    }
  };
}

async function loadPlugins() {
  const children = await readdir(pluginsDir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });

  const plugins = [];
  const seen = new Set();

  for (const child of children) {
    if (!child.isDirectory()) continue;
    const pluginRoot = path.join(pluginsDir, child.name);
    const manifestPath = path.join(pluginRoot, "manifest.json");
    const manifest = await readJson(manifestPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!manifest) continue;

    validateManifest(manifest, child.name);
    if (seen.has(manifest.id)) throw new Error(`Duplicate plugin id: ${manifest.id}`);
    seen.add(manifest.id);

    const mainPath = path.join(pluginRoot, manifest.main);
    await ensureRegularFile(mainPath, `Plugin ${manifest.id} main file does not exist: ${manifest.main}`);
    const iconPath = path.join(pluginRoot, manifest.icon);
    await ensureRegularFile(iconPath, `Plugin ${manifest.id} icon file does not exist: ${manifest.icon}`);
    const icon = await readIcon(iconPath, manifest.icon, manifest.id);

    const files = await collectPackageFiles(pluginRoot);
    const relativeFiles = files.map((file) => path.relative(pluginRoot, file).split(path.sep).join("/"));
    for (const required of ["manifest.json", manifest.main, manifest.icon]) {
      if (!relativeFiles.includes(required)) {
        throw new Error(`Plugin ${manifest.id} package is missing required file: ${required}`);
      }
    }

    plugins.push({ root: pluginRoot, manifest, files, icon });
  }

  return plugins;
}

function validateManifest(manifest, directoryName) {
  const required = [
    "id",
    "name",
    "description",
    "version",
    "author",
    "license",
    "homepage",
    "repository",
    "keywords",
    "type",
    "permissions",
    "minAppVersion",
    "compatibility",
    "icon",
    "main"
  ];

  for (const field of required) {
    if (manifest[field] === undefined || manifest[field] === null) {
      throw new Error(`Plugin manifest ${directoryName} is missing "${field}".`);
    }
  }

  if (manifest.id !== directoryName) {
    throw new Error(`Plugin directory "${directoryName}" must match manifest id "${manifest.id}".`);
  }
  if (!pluginIdPattern.test(manifest.id)) throw new Error(`Invalid plugin id: ${manifest.id}`);
  if (!semverPattern.test(manifest.version)) throw new Error(`Invalid semver for ${manifest.id}: ${manifest.version}`);
  if (!semverPattern.test(manifest.minAppVersion)) {
    throw new Error(`Invalid minAppVersion for ${manifest.id}: ${manifest.minAppVersion}`);
  }
  if (!allowedTypes.has(manifest.type)) throw new Error(`Invalid plugin type for ${manifest.id}: ${manifest.type}`);
  if (!Array.isArray(manifest.keywords)) throw new Error(`keywords must be an array for ${manifest.id}.`);
  if (!Array.isArray(manifest.permissions)) throw new Error(`permissions must be an array for ${manifest.id}.`);
  if (!manifest.compatibility || !Array.isArray(manifest.compatibility.platforms)) {
    throw new Error(`compatibility.platforms must be an array for ${manifest.id}.`);
  }
  for (const platform of manifest.compatibility.platforms) {
    if (!allowedPlatforms.has(platform)) throw new Error(`Invalid platform for ${manifest.id}: ${platform}`);
  }
  validateRelativePath(manifest.main, `main path for ${manifest.id}`);
  validateRelativePath(manifest.icon, `icon path for ${manifest.id}`);
  if (!allowedIconTypes.has(path.extname(manifest.icon).toLowerCase())) {
    throw new Error(`Icon for ${manifest.id} must be svg, png, webp, jpg, or jpeg.`);
  }
  validateUrl(manifest.homepage, `homepage for ${manifest.id}`);
  validateUrl(manifest.repository, `repository for ${manifest.id}`);
}

async function readIcon(iconPath, relativePath, pluginId) {
  const data = await readFile(iconPath);
  if (data.length > maxIconSize) {
    throw new Error(`Icon for ${pluginId} is too large. Maximum size is ${maxIconSize} bytes.`);
  }
  const contentType = allowedIconTypes.get(path.extname(relativePath).toLowerCase());
  const sha256 = createHash("sha256").update(data).digest("hex");
  return {
    path: relativePath,
    contentType,
    size: data.length,
    sha256,
    dataUrl: `data:${contentType};base64,${data.toString("base64")}`
  };
}

async function collectPackageFiles(pluginRoot) {
  const files = [];

  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = path.relative(pluginRoot, absolute).split(path.sep).join("/");
      validateRelativePath(relative, `package path ${relative}`);

      if (child.isSymbolicLink()) throw new Error(`Symlink is not allowed in plugin package: ${relative}`);
      if (shouldSkip(relative, child)) continue;
      if (child.isDirectory()) {
        await visit(absolute);
      } else if (child.isFile()) {
        files.push(absolute);
      }
    }
  }

  await visit(pluginRoot);
  return files.sort((a, b) => a.localeCompare(b));
}

function shouldSkip(relative, entry) {
  const parts = relative.split("/");
  if (parts.some((part) => part.startsWith(".") && part !== ".")) return true;
  if (parts.includes("node_modules") || parts.includes("dist") || parts.includes("target") || parts.includes("src")) return true;
  return entry.isDirectory() && parts.length === 1 && parts[0] === "build";
}

async function createPluginArchive(plugin) {
  const fileName = `${plugin.manifest.id}-${plugin.manifest.version}.cliporax-plugin.zip`;
  const archivePath = path.join(distDir, fileName);
  const zipEntries = [];

  for (const file of plugin.files) {
    const relative = path.relative(plugin.root, file).split(path.sep).join("/");
    zipEntries.push({
      name: relative,
      data: await readFile(file)
    });
  }

  const archiveData = createZip(zipEntries);
  await writeFile(archivePath, archiveData);

  const info = await stat(archivePath);
  const sha256 = createHash("sha256").update(archiveData).digest("hex");

  return {
    name: fileName,
    path: archivePath,
    size: info.size,
    sha256
  };
}

function toMarketEntry(plugin, archive) {
  const baseUrl = getReleaseBaseUrl();
  const downloadUrl = `${baseUrl}/${encodeURIComponent(archive.name)}`;
  const apiUrl = getReleaseApiAssetUrl(archive.name);

  return {
    id: plugin.manifest.id,
    name: plugin.manifest.name,
    description: plugin.manifest.description,
    version: plugin.manifest.version,
    author: plugin.manifest.author,
    license: plugin.manifest.license,
    homepage: plugin.manifest.homepage,
    repository: plugin.manifest.repository,
    keywords: plugin.manifest.keywords,
    type: plugin.manifest.type,
    permissions: plugin.manifest.permissions,
    minAppVersion: plugin.manifest.minAppVersion,
    compatibility: plugin.manifest.compatibility,
    icon: plugin.icon,
    publisher: {
      name: "Cliporax",
      url: getOfficialPublisherUrl(),
      official: true
    },
    asset: {
      name: archive.name,
      downloadUrl,
      apiUrl,
      size: archive.size,
      sha256: archive.sha256,
      githubAssetId: null,
      contentType: "application/zip"
    }
  };
}

function validateMarketIndex(index) {
  const schema = readFileSync(schemaPath, "utf8");
  if (index.schemaVersion !== 1) throw new Error("index.schemaVersion must be 1.");
  if (!isIsoDate(index.generatedAt)) throw new Error("index.generatedAt must be an ISO date-time string.");
  if (typeof index.marketVersion !== "string" || index.marketVersion.length === 0) {
    throw new Error("index.marketVersion must be a non-empty string.");
  }
  if (!Array.isArray(index.plugins)) throw new Error("index.plugins must be an array.");

  const ids = new Set();
  for (const plugin of index.plugins) {
    const icon = plugin.icon;
    if (!icon || typeof icon !== "object") throw new Error(`Missing icon for ${plugin.id}.`);
    validateManifest({ ...plugin, main: "main.js", icon: icon.path }, plugin.id);
    if (ids.has(plugin.id)) throw new Error(`Duplicate market plugin id: ${plugin.id}`);
    ids.add(plugin.id);

    const asset = plugin.asset;
    if (!asset || typeof asset !== "object") throw new Error(`Missing asset for ${plugin.id}.`);
    const expectedName = `${plugin.id}-${plugin.version}.cliporax-plugin.zip`;
    if (asset.name !== expectedName) {
      throw new Error(`Asset name for ${plugin.id} must be ${expectedName}.`);
    }
    if (!Number.isInteger(asset.size) || asset.size < 1) throw new Error(`Invalid asset size for ${plugin.id}.`);
    if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error(`Invalid sha256 for ${plugin.id}.`);
    if (asset.contentType !== "application/zip") throw new Error(`Invalid contentType for ${plugin.id}.`);
    if (asset.githubAssetId !== null && !Number.isInteger(asset.githubAssetId)) {
      throw new Error(`githubAssetId must be an integer or null for ${plugin.id}.`);
    }
    validateUrl(asset.downloadUrl, `downloadUrl for ${plugin.id}`);
    validateUrl(asset.apiUrl, `apiUrl for ${plugin.id}`);

    validateRelativePath(icon.path, `icon path for ${plugin.id}`);
    if (!allowedIconTypes.has(path.extname(icon.path).toLowerCase())) {
      throw new Error(`Invalid icon file type for ${plugin.id}.`);
    }
    if (icon.contentType !== allowedIconTypes.get(path.extname(icon.path).toLowerCase())) {
      throw new Error(`Invalid icon contentType for ${plugin.id}.`);
    }
    if (!Number.isInteger(icon.size) || icon.size < 1 || icon.size > maxIconSize) {
      throw new Error(`Invalid icon size for ${plugin.id}.`);
    }
    if (!/^[a-f0-9]{64}$/.test(icon.sha256)) throw new Error(`Invalid icon sha256 for ${plugin.id}.`);
    if (typeof icon.dataUrl !== "string" || !icon.dataUrl.startsWith(`data:${icon.contentType};base64,`)) {
      throw new Error(`Invalid icon dataUrl for ${plugin.id}.`);
    }

    const publisher = plugin.publisher;
    if (!publisher || typeof publisher !== "object") throw new Error(`Missing publisher for ${plugin.id}.`);
    if (typeof publisher.name !== "string" || publisher.name.trim().length === 0) {
      throw new Error(`publisher.name is required for ${plugin.id}.`);
    }
    validateUrl(publisher.url, `publisher.url for ${plugin.id}`);
    if (typeof publisher.official !== "boolean") throw new Error(`publisher.official must be boolean for ${plugin.id}.`);
  }

  if (!schema.includes("Cliporax Plugin Market Index")) {
    throw new Error("Schema file is missing or invalid.");
  }
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const localHeader = Buffer.alloc(30);
    const centralHeader = Buffer.alloc(46);

    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    const localEntry = Buffer.concat([localHeader, name, compressed]);
    localParts.push(localEntry);
    centralParts.push(Buffer.concat([centralHeader, name]));
    offset += localEntry.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, central, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function getReleaseBaseUrl() {
  if (process.env.CLIPORAX_MARKET_RELEASE_BASE_URL) {
    return process.env.CLIPORAX_MARKET_RELEASE_BASE_URL.replace(/\/$/, "");
  }
  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REF_NAME) {
    return `https://github.com/${process.env.GITHUB_REPOSITORY}/releases/download/${process.env.GITHUB_REF_NAME}`;
  }
  return "https://github.com/Cliporax/cliporax-plugin-market/releases/download/local";
}

function getReleaseApiAssetUrl(assetName) {
  if (process.env.CLIPORAX_MARKET_RELEASE_API_BASE_URL) {
    return `${process.env.CLIPORAX_MARKET_RELEASE_API_BASE_URL.replace(/\/$/, "")}/${encodeURIComponent(assetName)}`;
  }
  if (process.env.GITHUB_REPOSITORY) {
    return `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases/assets/${encodeURIComponent(assetName)}`;
  }
  return `https://api.github.com/repos/Cliporax/cliporax-plugin-market/releases/assets/${encodeURIComponent(assetName)}`;
}

function getOfficialPublisherUrl() {
  if (process.env.CLIPORAX_MARKET_PUBLISHER_URL) {
    return process.env.CLIPORAX_MARKET_PUBLISHER_URL;
  }
  if (process.env.GITHUB_REPOSITORY) {
    return `https://github.com/${process.env.GITHUB_REPOSITORY}`;
  }
  return "https://github.com/Cliporax/cliporax-plugin-market";
}

function getMarketVersion() {
  return process.env.CLIPORAX_MARKET_VERSION ?? process.env.GITHUB_REF_NAME ?? "local";
}

function validateRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid ${label}.`);
  if (path.isAbsolute(value)) throw new Error(`${label} must not be absolute.`);
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${label} must not escape the plugin directory.`);
  }
}

function validateUrl(value, label) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported protocol");
  } catch {
    throw new Error(`Invalid URL in ${label}: ${value}`);
  }
}

function isIsoDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && value.includes("T");
}

async function ensureRegularFile(file, message) {
  const info = await stat(file).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info || !info.isFile()) throw new Error(message);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
