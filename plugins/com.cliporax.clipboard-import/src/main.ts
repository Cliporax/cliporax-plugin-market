import {
  COPYQ_PAGE_ITEMS,
  type CopyqCursor,
  createCopyqPageArguments,
  parseCopyqPage,
} from "./copyq";
import {
  DITTO_PAGE_ITEMS,
  createDittoPowerShellArguments,
  parseDittoPage,
} from "./ditto";

const PLUGIN_ID = "com.cliporax.clipboard-import";
const TAB_LIST_CHANGED_EVENT = "tabs:list-changed";
const MAX_IMPORT_ITEMS = 50_000;
const MAX_TEXT_BYTES = 1_048_576;
const MAX_IMAGE_CONTENT_BYTES = 52_428_800;

type ImportSource = "ditto" | "klipper" | "maccy" | "raycast" | "custom";
type ImportViewSource = "copyq" | "gpaste" | ImportSource;
type CopyqLayout = "source-tabs" | "single-tab";
type StatusKind = "idle" | "running" | "success" | "error";

interface Host { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>; }
interface Tab { id: number; name: string; is_trash?: boolean; }
interface ImportRecord { type: "text" | "image"; content: string; tab?: string; }
interface ParsedRecords { records: ImportRecord[]; skipped: number; truncated?: boolean; }
interface Report { imported: number; skipped: number; failed: number; firstError?: string; truncated?: boolean; }
interface ProcessOutput { success: boolean; exit_code: number | null; stdout: string; stderr: string; }
interface ComboboxOption { value: string; label: string; disabled?: boolean; }
interface ComboboxInstance {
  element: HTMLDivElement;
  setValue(value: string | undefined): void;
  setOptions(options: ComboboxOption[]): void;
  setDisabled(disabled: boolean): void;
  destroy(): void;
}
interface Props {
  context?: {
    theme?: "light" | "dark";
    ui?: {
      createCombobox(options: {
        options: ComboboxOption[];
        value?: string;
        onChange(value: string): void;
        placeholder?: string;
        disabled?: boolean;
        searchable?: boolean;
        theme?: "light" | "dark";
        ariaLabel?: string;
      }): ComboboxInstance;
    };
  };
}
interface Plugin {
  meta: { id: string; name: string; version: string };
  onActivate(): void;
  onDeactivate(): void;
  extensions: Record<string, { render(props: Props): HTMLElement }>;
}
interface PluginWindow extends Window {
  __TAURI_INTERNALS__?: Host;
  CliporaxPlugins?: Record<string, Plugin>;
}

const hostWindow = window as PluginWindow;

function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const host = hostWindow.__TAURI_INTERNALS__;
  if (!host) return Promise.reject(new Error("Cliporax host API is unavailable."));
  return host.invoke<T>(command, { pluginId: PLUGIN_ID, ...args });
}

function toClipboardItem(record: ImportRecord, tabId: number, source: string) {
  return {
    type: record.type,
    content: record.content,
    metadata: JSON.stringify({ source, source_tab: record.tab ?? null }),
    tags: "[]",
    tab_id: tabId,
    is_sensitive: false,
    is_pinned: false,
  };
}

async function createItem(record: ImportRecord, tabId: number, source: string): Promise<void> {
  await invoke("clipboard_create", { item: toClipboardItem(record, tabId, source) });
}

async function createItemBatch(
  records: ImportRecord[],
  tabId: number,
  source: string,
): Promise<{ imported: number; failed: number; firstError?: string }> {
  try {
    const ids = await invoke<number[]>("clipboard_create_batch", {
      items: records.map((record) => toClipboardItem(record, tabId, source)),
    });
    if (ids.length !== records.length) {
      throw new Error("Cliporax returned an incomplete batch result.");
    }
    return { imported: records.length, failed: 0 };
  } catch (error) {
    if (records.length === 1) {
      try {
        // Compatibility fallback for an older host without clipboard_create_batch.
        await createItem(records[0], tabId, source);
        return { imported: 1, failed: 0 };
      } catch (singleError) {
        return {
          imported: 0,
          failed: 1,
          firstError: (singleError instanceof Error ? singleError.message : String(singleError)).slice(0, 300),
        };
      }
    }
    const middle = Math.ceil(records.length / 2);
    const first = await createItemBatch(records.slice(0, middle), tabId, source);
    const second = await createItemBatch(records.slice(middle), tabId, source);
    return {
      imported: first.imported + second.imported,
      failed: first.failed + second.failed,
      firstError: first.firstError ?? second.firstError
        ?? (error instanceof Error ? error.message : String(error)).slice(0, 300),
    };
  }
}

function processError(output: ProcessOutput): string {
  const detail = output.stderr.trim().slice(0, 500);
  return detail || `Importer exited with code ${output.exit_code ?? "unknown"}.`;
}

function ensureSuccess(output: ProcessOutput): void {
  if (!output.success) throw new Error(processError(output));
}

function parseNdjson(output: ProcessOutput): ParsedRecords {
  ensureSuccess(output);
  if (!output.stdout.trim()) {
    throw new Error("Exporter completed without returning any clipboard records.");
  }
  const records: ImportRecord[] = [];
  let skipped = 0;
  for (const line of output.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { text?: unknown; tab?: unknown };
      if (typeof record.text !== "string" || !record.text.trim()) {
        skipped += 1;
        continue;
      }
      records.push({
        type: "text",
        content: record.text,
        tab: typeof record.tab === "string" ? record.tab : undefined,
      });
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

function parseNulSeparated(output: ProcessOutput): ParsedRecords {
  ensureSuccess(output);
  const records: ImportRecord[] = [];
  let skipped = 0;
  for (const text of output.stdout.split("\0")) {
    if (!text) continue;
    if (!text.trim()) {
      skipped += 1;
      continue;
    }
    records.push({ type: "text", content: text });
  }
  return { records, skipped };
}

async function importRecords(
  parsed: ParsedRecords,
  tabId: number,
  source: string,
  onProgress?: (completed: number, total: number) => void,
  newestFirst = true,
): Promise<Report> {
  const accepted = parsed.records.slice(0, MAX_IMPORT_ITEMS);
  const ordered = newestFirst ? accepted.reverse() : accepted;
  let skipped = parsed.skipped + Math.max(0, parsed.records.length - accepted.length);
  let imported = 0;
  let failed = 0;
  let firstError: string | undefined;
  onProgress?.(0, ordered.length);

  // Source tools list newest first. Insert oldest first so Cliporax keeps the same visible order.
  const valid: ImportRecord[] = [];
  for (const record of ordered) {
    const maxBytes = record.type === "image" ? MAX_IMAGE_CONTENT_BYTES : MAX_TEXT_BYTES;
    const contentBytes = record.type === "image"
      ? record.content.length
      : new TextEncoder().encode(record.content).byteLength;
    if (contentBytes > maxBytes) {
      skipped += 1;
      continue;
    }
    valid.push(record);
  }

  for (let index = 0; index < valid.length; index += COPYQ_PAGE_ITEMS) {
    const batch = valid.slice(index, index + COPYQ_PAGE_ITEMS);
    const result = await createItemBatch(batch, tabId, source);
    imported += result.imported;
    failed += result.failed;
    firstError ??= result.firstError;
    onProgress?.(Math.min(index + batch.length, valid.length), valid.length);
  }
  return { imported, skipped, failed, firstError, truncated: parsed.truncated };
}

function parseArgs(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Exporter arguments must be valid JSON, for example [\"--export\"].");
  }
  if (!Array.isArray(parsed) || parsed.some((arg) => typeof arg !== "string")) {
    throw new Error("Exporter arguments must be a JSON string array.");
  }
  return parsed;
}

function sourceLabel(source: ImportSource): string {
  return ({ ditto: "Ditto", klipper: "Klipper", maccy: "Maccy", raycast: "Raycast", custom: "Custom NDJSON" })[source];
}

function sourceHint(source: ImportSource): string {
  switch (source) {
    case "ditto":
      return "Windows · Reads Ditto.db or an official .zdb backup locally and read-only. No separate exporter is required.";
    case "klipper":
      return "Linux/KDE · Use an exporter matched to your Plasma version. Raw history-menu output is not a stable interchange format.";
    case "maccy":
      return "macOS · Maccy stores history in a local Core Data SQLite database. Use a read-only, version-aware exporter.";
    case "raycast":
      return "macOS/Windows · Encrypted .rayconfig archives are not decrypted here. Use a Raycast-approved exporter that emits NDJSON.";
    default:
      return "The exporter must print newest-first NDJSON records: {\"text\":\"…\",\"tab\":\"optional\"}.";
  }
}

function render(props: Props): HTMLElement {
  const theme = props.context?.theme ?? "dark";
  const dark = theme === "dark";
  const createCombobox = props.context?.ui?.createCombobox;
  const root = document.createElement("section");
  root.className = "cliporax-import";
  root.style.setProperty("--ci-bg", dark ? "#111827" : "#f8fafc");
  root.style.setProperty("--ci-surface", dark ? "rgba(255,255,255,.045)" : "rgba(255,255,255,.9)");
  root.style.setProperty("--ci-text", dark ? "#e5e7eb" : "#1f2937");
  root.style.setProperty("--ci-muted", dark ? "#94a3b8" : "#64748b");
  root.style.setProperty("--ci-border", dark ? "rgba(255,255,255,.10)" : "rgba(15,23,42,.10)");
  root.style.setProperty("--ci-accent", dark ? "#60a5fa" : "#2563eb");
  root.style.setProperty("--ci-success", dark ? "#4ade80" : "#15803d");
  root.style.setProperty("--ci-danger", dark ? "#f87171" : "#b91c1c");

  const style = document.createElement("style");
  style.textContent = `
    .cliporax-import{height:100%;box-sizing:border-box;overflow:auto;padding:20px;color:var(--ci-text);background:var(--ci-bg);font:13px/1.5 Inter,ui-sans-serif,system-ui,sans-serif}
    .cliporax-import *{box-sizing:border-box}
    .ci-shell{width:min(760px,100%);margin:0 auto;display:grid;gap:16px}
    .ci-header{display:grid;gap:4px}.ci-title{margin:0;font-size:20px;line-height:1.25}.ci-copy{margin:0;color:var(--ci-muted)}
    .ci-field{display:grid;gap:6px}.ci-label{font-weight:600}.ci-help{margin:0;color:var(--ci-muted);font-size:12px}
    .ci-source-picker{padding:12px;border:1px solid var(--ci-border);border-radius:10px;background:var(--ci-surface)}
    .ci-source-stage{display:grid}.ci-source-stage>[hidden],.ci-field[hidden]{display:none}
    .ci-card{border:1px solid var(--ci-border);border-radius:10px;background:var(--ci-surface)}
    .ci-card{padding:14px;display:grid;align-content:start;gap:10px}.ci-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
    .ci-card h3{margin:0;font-size:14px}.ci-badge{padding:2px 7px;border-radius:999px;background:color-mix(in srgb,var(--ci-accent) 14%,transparent);color:var(--ci-accent);font-size:11px;font-weight:600}
    .ci-input{width:100%;min-height:36px;padding:7px 9px;border:1px solid var(--ci-border);border-radius:8px;background:transparent;color:inherit;font:inherit;outline:none;transition:border-color 150ms ease,box-shadow 150ms ease}
    .ci-input:focus-visible{border-color:var(--ci-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--ci-accent) 24%,transparent)}
    .ci-button{min-height:36px;padding:7px 11px;border:0;border-radius:8px;background:var(--ci-accent);color:white;font:600 13px/1.2 inherit;cursor:pointer;transition:filter 150ms ease,opacity 150ms ease}
    .ci-button:hover:not(:disabled){filter:brightness(1.08)}.ci-button:focus-visible{outline:2px solid var(--ci-accent);outline-offset:2px}.ci-button:disabled{cursor:not-allowed;opacity:.5}
    .ci-note{padding:10px 12px;border-left:3px solid var(--ci-accent);background:color-mix(in srgb,var(--ci-accent) 8%,transparent);color:var(--ci-muted)}
    .ci-status{position:sticky;top:0;z-index:20;display:grid;gap:8px;margin:0;padding:11px 12px;border:1px solid var(--ci-border);border-radius:10px;background:color-mix(in srgb,var(--ci-bg) 92%,transparent);box-shadow:0 8px 24px rgba(15,23,42,.14);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
    .ci-status[hidden]{display:none}.ci-status-head{display:flex;min-width:0;align-items:center;gap:9px}.ci-status-indicator{width:14px;height:14px;flex:0 0 auto;border-radius:999px;background:currentColor}
    .ci-status-title{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:650;color:var(--ci-text)}.ci-status-count{flex:0 0 auto;color:var(--ci-muted);font-variant-numeric:tabular-nums}
    .ci-status-message{margin:0;color:var(--ci-muted);font-size:12px}.ci-progress{height:4px;overflow:hidden;border-radius:999px;background:color-mix(in srgb,var(--ci-accent) 15%,transparent)}
    .ci-progress-bar{height:100%;width:0;border-radius:inherit;background:var(--ci-accent);transition:width 180ms ease-out}.ci-status[data-kind=running]{color:var(--ci-accent)}.ci-status[data-kind=running] .ci-status-indicator{border:2px solid color-mix(in srgb,var(--ci-accent) 25%,transparent);border-top-color:var(--ci-accent);background:transparent;animation:ci-spin .8s linear infinite}
    .ci-status[data-kind=success]{color:var(--ci-success)}.ci-status[data-kind=success] .ci-progress-bar{background:var(--ci-success)}.ci-status[data-kind=error]{color:var(--ci-danger)}.ci-status[data-kind=error] .ci-progress{display:none}
    @keyframes ci-spin{to{transform:rotate(360deg)}}
    @media(max-width:620px){.cliporax-import{padding:14px}}
    @media(max-height:520px){.cliporax-import{padding-top:10px}.ci-shell{gap:12px}.ci-status{top:0}}
    @media(prefers-reduced-motion:reduce){.cliporax-import *{transition:none!important}.ci-status-indicator{animation:none!important}}
  `;

  const shell = document.createElement("div");
  shell.className = "ci-shell";
  const header = document.createElement("header");
  header.className = "ci-header";
  const title = document.createElement("h2");
  title.className = "ci-title";
  title.textContent = "Import clipboard history";
  const intro = document.createElement("p");
  intro.className = "ci-copy";
  intro.textContent = "Move clipboard history into Cliporax locally. No clipboard content is uploaded.";
  header.append(title, intro);

  const destination = document.createElement("div");
  destination.className = "ci-field";
  const destinationLabel = document.createElement("span");
  destinationLabel.className = "ci-label";
  destinationLabel.textContent = "Single destination tab";
  const destinationHost = document.createElement("div");
  const destinationHelp = document.createElement("p");
  destinationHelp.className = "ci-help";
  destinationHelp.textContent = "Used for GPaste, advanced exporters, and CopyQ when “Merge into one tab” is selected.";
  destination.append(destinationLabel, destinationHost, destinationHelp);

  let targetTabId = "";
  let tabsReady = false;
  let availableTabs: Tab[] = [];
  let copyqLayout: CopyqLayout = "source-tabs";
  let selectedViewSource: ImportViewSource = "copyq";
  let selectedSource: ImportSource = "ditto";
  let updateSourceView = () => {};
  const comboboxes: ComboboxInstance[] = [];
  let destinationCombobox: ComboboxInstance | undefined;
  let copyqLayoutCombobox: ComboboxInstance | undefined;
  let sourceCombobox: ComboboxInstance | undefined;
  if (createCombobox) {
    destinationCombobox = createCombobox({
      options: [],
      placeholder: "Loading tabs…",
      searchable: true,
      disabled: true,
      theme,
      ariaLabel: "Destination tab",
      onChange: (value) => { targetTabId = value; },
    });
    comboboxes.push(destinationCombobox);
    destinationHost.append(destinationCombobox.element);
  } else {
    destinationHelp.textContent = "This plugin requires a newer Cliporax version with shared UI controls.";
  }

  const status = document.createElement("aside");
  status.className = "ci-status";
  status.dataset.kind = "idle";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  status.hidden = true;
  const statusHead = document.createElement("div");
  statusHead.className = "ci-status-head";
  const statusIndicator = document.createElement("span");
  statusIndicator.className = "ci-status-indicator";
  statusIndicator.setAttribute("aria-hidden", "true");
  const statusTitle = document.createElement("strong");
  statusTitle.className = "ci-status-title";
  const statusCount = document.createElement("span");
  statusCount.className = "ci-status-count";
  const statusMessage = document.createElement("p");
  statusMessage.className = "ci-status-message";
  const progress = document.createElement("div");
  progress.className = "ci-progress";
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-label", "Import progress");
  const progressBar = document.createElement("div");
  progressBar.className = "ci-progress-bar";
  progress.append(progressBar);
  statusHead.append(statusIndicator, statusTitle, statusCount);
  status.append(statusHead, statusMessage, progress);
  const buttons: HTMLButtonElement[] = [];
  let isBusy = false;
  let activeImportTitle = "Importing clipboard history";

  const setStatus = (
    message: string,
    kind: StatusKind,
    options: { title?: string; completed?: number; total?: number } = {},
  ) => {
    const completed = options.completed;
    const total = options.total;
    const hasProgress = typeof completed === "number" && typeof total === "number" && total > 0;
    const percentage = hasProgress
      ? Math.min(100, Math.max(0, Math.round((completed / total) * 100)))
      : kind === "success" ? 100 : 0;
    status.hidden = kind === "idle";
    status.dataset.kind = kind;
    status.setAttribute("role", kind === "error" ? "alert" : "status");
    statusTitle.textContent = options.title
      ?? (kind === "running" ? "Importing clipboard history"
        : kind === "success" ? "Import complete"
          : "Import needs attention");
    statusMessage.textContent = message;
    statusCount.textContent = hasProgress
      ? `${completed.toLocaleString()} / ${total.toLocaleString()}`
      : "";
    progress.hidden = kind === "error";
    progressBar.style.width = `${percentage}%`;
    if (hasProgress) {
      progress.setAttribute("aria-valuemin", "0");
      progress.setAttribute("aria-valuemax", String(total));
      progress.setAttribute("aria-valuenow", String(completed));
      progress.setAttribute("aria-valuetext", `${completed} of ${total} items`);
    } else {
      progress.removeAttribute("aria-valuemin");
      progress.removeAttribute("aria-valuemax");
      progress.removeAttribute("aria-valuenow");
      progress.removeAttribute("aria-valuetext");
    }
  };
  const showProgress = (completed: number, total: number) => {
    setStatus(
      total ? "Writing items into Cliporax…" : "No importable items found.",
      total ? "running" : "success",
      { title: activeImportTitle, completed, total },
    );
  };
  const getTargetTab = () => {
    const tabId = Number(targetTabId);
    if (!Number.isInteger(tabId) || tabId <= 0) throw new Error("Choose a destination tab first.");
    return tabId;
  };
  const setBusy = (busy: boolean) => {
    isBusy = busy;
    for (const button of buttons) button.disabled = busy || !tabsReady;
    destinationCombobox?.setDisabled(busy || !tabsReady);
    copyqLayoutCombobox?.setDisabled(busy);
    sourceCombobox?.setDisabled(busy);
  };
  const actionButton = (label: string, action: () => Promise<Report>) => {
    const button = document.createElement("button");
    button.className = "ci-button";
    button.type = "button";
    button.textContent = label;
    button.dataset.sourceLabel = label.replace("Import ", "");
    button.disabled = !tabsReady;
    button.onclick = async () => {
      activeImportTitle = `Importing from ${button.dataset.sourceLabel}`;
      setBusy(true);
      setStatus(
        "Reading source history and preparing items…",
        "running",
        { title: activeImportTitle },
      );
      try {
        const report = await action();
        const failures = report.failed
          ? ` ${report.failed} not written.${report.firstError ? ` First error: ${report.firstError}` : ""}`
          : "";
        const limited = report.truncated
          ? ` The source contains more than ${MAX_IMPORT_ITEMS.toLocaleString()} items; the safety limit was applied.`
          : "";
        setStatus(
          `Imported ${report.imported}; skipped ${report.skipped}.${failures}${limited}`,
          report.failed ? "error" : "success",
        );
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), "error");
      } finally {
        setBusy(false);
      }
    };
    buttons.push(button);
    return button;
  };
  const inputField = (labelText: string, value: string, placeholder: string) => {
    const field = document.createElement("label");
    field.className = "ci-field";
    const label = document.createElement("span");
    label.className = "ci-label";
    label.textContent = labelText;
    const input = document.createElement("input");
    input.className = "ci-input";
    input.value = value;
    input.placeholder = placeholder;
    input.autocomplete = "off";
    field.append(label, input);
    return { field, input };
  };

  const sourceStage = document.createElement("div");
  sourceStage.className = "ci-source-stage";
  const sourceCard = (
    name: string,
    platform: string,
    description: string,
    defaultExecutable: string,
    run: (executable: string) => Promise<Report>,
    extraFields: HTMLElement[] = [],
  ) => {
    const card = document.createElement("article");
    card.className = "ci-card";
    const cardHead = document.createElement("div");
    cardHead.className = "ci-card-head";
    const heading = document.createElement("h3");
    heading.textContent = name;
    const badge = document.createElement("span");
    badge.className = "ci-badge";
    badge.textContent = platform;
    cardHead.append(heading, badge);
    const copy = document.createElement("p");
    copy.className = "ci-help";
    copy.textContent = description;
    const executable = inputField("Executable", defaultExecutable, defaultExecutable);
    const button = actionButton(`Import ${name}`, () => {
      const value = executable.input.value.trim();
      if (!value) throw new Error(`Provide the ${name} executable.`);
      return run(value);
    });
    card.append(cardHead, copy, ...extraFields, executable.field, button);
    return card;
  };

  const copyqLayoutField = document.createElement("div");
  copyqLayoutField.className = "ci-field";
  const copyqLayoutLabel = document.createElement("span");
  copyqLayoutLabel.className = "ci-label";
  copyqLayoutLabel.textContent = "Tab layout";
  const copyqLayoutHost = document.createElement("div");
  const copyqLayoutHelp = document.createElement("p");
  copyqLayoutHelp.className = "ci-help";
  copyqLayoutHelp.textContent = "Reuse matching Cliporax tabs and create any source tabs that are missing.";
  copyqLayoutField.append(copyqLayoutLabel, copyqLayoutHost, copyqLayoutHelp);
  if (createCombobox) {
    copyqLayoutCombobox = createCombobox({
      options: [
        { value: "source-tabs", label: "Keep source tab structure" },
        { value: "single-tab", label: "Merge into one tab" },
      ],
      value: copyqLayout,
      theme,
      ariaLabel: "CopyQ tab layout",
      onChange: (value) => {
        copyqLayout = value as CopyqLayout;
        copyqLayoutHelp.textContent = copyqLayout === "source-tabs"
          ? "Reuse matching Cliporax tabs and create any source tabs that are missing."
          : "Put every CopyQ item into the destination tab selected above.";
        updateSourceView();
      },
    });
    comboboxes.push(copyqLayoutCombobox);
    copyqLayoutHost.append(copyqLayoutCombobox.element);
  }

  const copyqCard = sourceCard(
    "CopyQ",
    "All platforms",
    "Imports text and images from every CopyQ tab in bounded pages. CopyQ must be running.",
    "copyq",
    async (executable) => {
      const singleTabId = copyqLayout === "single-tab" ? getTargetTab() : undefined;
      const sourceTabIds = new Map<string, number>();
      let tabListChanged = false;
      const normalizeTabName = (name: string) => {
        const trimmed = name.trim() || "CopyQ";
        return Array.from(trimmed).slice(0, 64).join("");
      };
      const ensureSourceTab = async (sourceName: string) => {
        const cached = sourceTabIds.get(sourceName);
        if (cached) return cached;
        const name = normalizeTabName(sourceName);
        const existing = availableTabs.find((tab) => !tab.is_trash && tab.name === name);
        if (existing) {
          sourceTabIds.set(sourceName, existing.id);
          return existing.id;
        }
        try {
          const id = await invoke<number>("tabs_create", { name });
          availableTabs.push({ id, name, is_trash: false });
          sourceTabIds.set(sourceName, id);
          tabListChanged = true;
          return id;
        } catch (error) {
          throw new Error(
            `Could not create Cliporax tab "${name}": ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };
      let cursor: CopyqCursor | undefined;
      let scanned = 0;
      let sourceTotal = 0;
      const report: Report = { imported: 0, skipped: 0, failed: 0 };

      while (scanned < MAX_IMPORT_ITEMS) {
        const pageLimit = Math.min(COPYQ_PAGE_ITEMS, MAX_IMPORT_ITEMS - scanned);
        setStatus(
          "Reading CopyQ history…",
          "running",
          sourceTotal
            ? { title: activeImportTitle, completed: scanned, total: sourceTotal }
            : { title: activeImportTitle },
        );
        const output = await invoke<ProcessOutput>("plugin_run_process", {
          executable,
          args: createCopyqPageArguments(
            cursor,
            pageLimit,
            MAX_TEXT_BYTES,
            MAX_IMAGE_CONTENT_BYTES,
          ),
        });
        ensureSuccess(output);
        const page = parseCopyqPage(output.stdout);
        sourceTotal = page.total;
        if (copyqLayout === "source-tabs") {
          for (const sourceTab of page.sourceTabs) {
            await ensureSourceTab(sourceTab);
          }
          if (tabListChanged) {
            hostWindow.dispatchEvent(new CustomEvent(TAB_LIST_CHANGED_EVENT));
            tabListChanged = false;
          }
        }
        if (page.scanned <= 0 && !page.done) {
          throw new Error("CopyQ pagination made no progress.");
        }
        const importedBeforePage = report.imported;
        const pageReport: Report = {
          imported: 0,
          skipped: page.skipped,
          failed: 0,
        };
        const groups = new Map<number, ImportRecord[]>();
        for (const record of page.records) {
          const targetId = singleTabId ?? await ensureSourceTab(record.tab ?? "CopyQ");
          const group = groups.get(targetId) ?? [];
          group.push(record);
          groups.set(targetId, group);
        }
        for (const [targetId, records] of groups) {
          const groupReport = await importRecords(
            { records, skipped: 0 },
            targetId,
            "copyq",
            (completed) => {
              setStatus(
                `Writing CopyQ items… ${(importedBeforePage + pageReport.imported + completed).toLocaleString()} imported`,
                "running",
                sourceTotal
                  ? {
                    title: activeImportTitle,
                    completed: Math.min(
                      importedBeforePage + pageReport.imported + completed,
                      sourceTotal,
                    ),
                    total: sourceTotal,
                  }
                  : { title: activeImportTitle },
              );
            },
            false,
          );
          pageReport.imported += groupReport.imported;
          pageReport.skipped += groupReport.skipped;
          pageReport.failed += groupReport.failed;
          pageReport.firstError ??= groupReport.firstError;
        }
        report.imported += pageReport.imported;
        report.skipped += pageReport.skipped;
        report.failed += pageReport.failed;
        report.firstError ??= pageReport.firstError;
        scanned += page.scanned;
        cursor = page.nextCursor;

        if (page.done) return report;
        if (!cursor) throw new Error("CopyQ pagination cursor is missing.");
      }

      report.truncated = true;
      report.skipped += Math.max(0, sourceTotal - scanned);
      return report;
    },
    [copyqLayoutField],
  );
  const gpasteCard = sourceCard(
    "GPaste",
    "Linux",
    "Uses NUL-separated raw output so multi-line entries stay intact.",
    "gpaste-client",
    async (executable) => {
      const tabId = getTargetTab();
      const output = await invoke<ProcessOutput>("plugin_run_process", { executable, args: ["history", "--raw", "--zero"] });
      return importRecords(parseNulSeparated(output), tabId, "gpaste", showProgress);
    },
  );

  const dittoCard = document.createElement("article");
  dittoCard.className = "ci-card";
  const dittoCardHead = document.createElement("div");
  dittoCardHead.className = "ci-card-head";
  const dittoHeading = document.createElement("h3");
  dittoHeading.textContent = "Ditto";
  const dittoBadge = document.createElement("span");
  dittoBadge.className = "ci-badge";
  dittoBadge.textContent = "Windows";
  dittoCardHead.append(dittoHeading, dittoBadge);
  const dittoHelp = document.createElement("p");
  dittoHelp.className = "ci-help";
  dittoHelp.textContent =
    "Reads text history directly from Ditto in read-only pages. Leave the source empty to auto-detect the standard installation, or enter an official .zdb backup path.";
  const dittoSource = inputField(
    "Ditto source (optional)",
    "",
    String.raw`Auto-detect or C:\path\backup.zdb`,
  );
  const dittoButton = actionButton("Import Ditto", async () => {
    const tabId = getTargetTab();
    const sourcePath = dittoSource.input.value.trim() || undefined;
    let offset = 0;
    let scanned = 0;
    let sourceTotal = 0;
    const report: Report = { imported: 0, skipped: 0, failed: 0 };

    while (scanned < MAX_IMPORT_ITEMS) {
      const pageLimit = Math.min(DITTO_PAGE_ITEMS, MAX_IMPORT_ITEMS - scanned);
      setStatus(
        "Reading Ditto history locally and read-only…",
        "running",
        sourceTotal
          ? { title: activeImportTitle, completed: scanned, total: sourceTotal }
          : { title: activeImportTitle },
      );
      const output = await invoke<ProcessOutput>("plugin_run_process", {
        executable: "powershell.exe",
        args: createDittoPowerShellArguments(sourcePath, offset, pageLimit),
      });
      ensureSuccess(output);
      const page = parseDittoPage(output.stdout);
      sourceTotal = page.total;
      if (sourceTotal === 0) {
        throw new Error("The Ditto source contains no text clipboard entries.");
      }
      if (page.scanned <= 0 && !page.done) {
        throw new Error("Ditto pagination made no progress.");
      }

      const importedBeforePage = report.imported;
      const pageReport = await importRecords(
        { records: page.records, skipped: page.skipped },
        tabId,
        "ditto",
        (completed) => {
          setStatus(
            `Writing Ditto items… ${(importedBeforePage + completed).toLocaleString()} imported`,
            "running",
            {
              title: activeImportTitle,
              completed: Math.min(importedBeforePage + completed, sourceTotal),
              total: sourceTotal,
            },
          );
        },
        false,
      );
      report.imported += pageReport.imported;
      report.skipped += pageReport.skipped;
      report.failed += pageReport.failed;
      report.firstError ??= pageReport.firstError;
      scanned += page.scanned;

      if (page.done) return report;
      if (page.nextOffset === undefined || page.nextOffset <= offset) {
        throw new Error("Ditto pagination offset is missing or invalid.");
      }
      offset = page.nextOffset;
    }

    report.truncated = true;
    report.skipped += Math.max(0, sourceTotal - scanned);
    return report;
  });
  dittoCard.append(dittoCardHead, dittoHelp, dittoSource.field, dittoButton);

  sourceStage.append(copyqCard, gpasteCard, dittoCard);

  const exporterCard = document.createElement("article");
  exporterCard.className = "ci-card";
  const exporterCardHead = document.createElement("div");
  exporterCardHead.className = "ci-card-head";
  const exporterHeading = document.createElement("h3");
  const exporterBadge = document.createElement("span");
  exporterBadge.className = "ci-badge";
  exporterCardHead.append(exporterHeading, exporterBadge);
  const exporterHint = document.createElement("p");
  exporterHint.className = "ci-note";
  exporterHint.textContent = sourceHint(selectedSource);
  const exporter = inputField("Exporter executable", "", "Absolute path or command on PATH");
  const exporterArgs = inputField("Arguments (JSON array)", "[]", "[\"--export\"]");
  const exporterButton = actionButton("Run exporter", async () => {
    const executable = exporter.input.value.trim();
    if (!executable) throw new Error("Provide an exporter executable.");
    const tabId = getTargetTab();
    const output = await invoke<ProcessOutput>("plugin_run_process", {
      executable,
      args: parseArgs(exporterArgs.input.value),
    });
    return importRecords(parseNdjson(output), tabId, selectedSource, showProgress);
  });
  exporterCard.append(
    exporterCardHead,
    exporterHint,
    exporter.field,
    exporterArgs.field,
    exporterButton,
  );
  sourceStage.append(exporterCard);

  const sourcePicker = document.createElement("div");
  sourcePicker.className = "ci-field ci-source-picker";
  const sourcePickerLabel = document.createElement("span");
  sourcePickerLabel.className = "ci-label";
  sourcePickerLabel.textContent = "Import source";
  const sourcePickerHost = document.createElement("div");
  const sourcePickerHelp = document.createElement("p");
  sourcePickerHelp.className = "ci-help";
  sourcePickerHelp.textContent =
    "Choose a clipboard manager to show only the settings it needs.";
  sourcePicker.append(sourcePickerLabel, sourcePickerHost, sourcePickerHelp);

  const advancedSources = new Set<ImportViewSource>([
    "klipper",
    "maccy",
    "raycast",
    "custom",
  ]);
  updateSourceView = () => {
    const isCopyq = selectedViewSource === "copyq";
    const isGpaste = selectedViewSource === "gpaste";
    const isDitto = selectedViewSource === "ditto";
    const isExporter = advancedSources.has(selectedViewSource);
    copyqCard.hidden = !isCopyq;
    gpasteCard.hidden = !isGpaste;
    dittoCard.hidden = !isDitto;
    exporterCard.hidden = !isExporter;
    destination.hidden = isCopyq && copyqLayout === "source-tabs";

    if (isExporter) {
      selectedSource = selectedViewSource as ImportSource;
      exporterHeading.textContent = sourceLabel(selectedSource);
      exporterBadge.textContent =
        selectedSource === "ditto" ? "Windows"
          : selectedSource === "klipper" ? "Linux / KDE"
            : selectedSource === "maccy" ? "macOS"
              : selectedSource === "raycast" ? "macOS / Windows"
                : "NDJSON";
      exporterHint.textContent = sourceHint(selectedSource);
      exporterButton.textContent =
        selectedSource === "custom"
          ? "Run custom exporter"
          : `Import ${sourceLabel(selectedSource)}`;
      exporterButton.dataset.sourceLabel = sourceLabel(selectedSource);
    }
  };

  if (createCombobox) {
    sourceCombobox = createCombobox({
      options: [
        { value: "copyq", label: "CopyQ" },
        { value: "gpaste", label: "GPaste" },
        { value: "ditto", label: "Ditto" },
        { value: "klipper", label: "Klipper" },
        { value: "maccy", label: "Maccy" },
        { value: "raycast", label: "Raycast" },
        { value: "custom", label: "Custom NDJSON exporter" },
      ],
      value: selectedViewSource,
      theme,
      ariaLabel: "Import source",
      onChange: (value) => {
        selectedViewSource = value as ImportViewSource;
        updateSourceView();
      },
    });
    comboboxes.push(sourceCombobox);
    sourcePickerHost.append(sourceCombobox.element);
  }
  updateSourceView();

  const privacy = document.createElement("p");
  privacy.className = "ci-note";
  privacy.textContent = `Safety limits: up to ${MAX_IMPORT_ITEMS.toLocaleString()} items, 1 MiB per text item, and 50 MiB per image. CopyQ is read in bounded pages across all tabs. Exporters run without a shell and stop after 60 seconds per page.`;
  shell.append(header, status, sourcePicker, destination, sourceStage, privacy);
  root.append(style, shell);

  void invoke<Tab[]>("tabs_get_all").then((tabs) => {
    if (!destinationCombobox) {
      setStatus("Update Cliporax before using this plugin.", "error");
      return;
    }
    availableTabs = tabs;
    const options = tabs.filter((tab) => !tab.is_trash).map((tab) => ({ value: String(tab.id), label: tab.name }));
    destinationCombobox.setOptions(options);
    if (options.length > 0) {
      tabsReady = true;
      targetTabId = options[0].value;
      destinationCombobox.setValue(targetTabId);
      setBusy(isBusy);
    } else {
      setStatus("Create a non-trash tab before importing.", "error");
    }
  }).catch((error) => setStatus(error instanceof Error ? error.message : String(error), "error"));

  queueMicrotask(() => {
    const observer = new MutationObserver(() => {
      if (root.isConnected) return;
      for (const combobox of comboboxes) combobox.destroy();
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  return root;
}

const plugin: Plugin = {
  meta: { id: PLUGIN_ID, name: "Clipboard Import", version: "0.4.0" },
  onActivate() {},
  onDeactivate() {},
  extensions: { ClipboardImportView: { render } },
};

hostWindow.CliporaxPlugins = hostWindow.CliporaxPlugins ?? {};
hostWindow.CliporaxPlugins[PLUGIN_ID] = plugin;
