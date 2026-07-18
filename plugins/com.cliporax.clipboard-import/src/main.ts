const PLUGIN_ID = "com.cliporax.clipboard-import";
const MAX_IMPORT_ITEMS = 5_000;
const MAX_TEXT_BYTES = 1_048_576;

type ImportSource = "ditto" | "klipper" | "maccy" | "raycast" | "custom";
type StatusKind = "idle" | "running" | "success" | "error";

interface Host { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>; }
interface Tab { id: number; name: string; is_trash?: boolean; }
interface ImportRecord { text: string; tab?: string; }
interface ParsedRecords { records: ImportRecord[]; skipped: number; }
interface Report { imported: number; skipped: number; failed: number; firstError?: string; }
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

async function createText(text: string, tabId: number, source: string, sourceTab?: string): Promise<void> {
  await invoke("clipboard_create", {
    item: {
      type: "text",
      content: text,
      metadata: JSON.stringify({ source, source_tab: sourceTab ?? null }),
      tags: [],
      tab_id: tabId,
      is_sensitive: false,
      is_pinned: false,
    },
  });
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
        text: record.text,
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
    records.push({ text });
  }
  return { records, skipped };
}

async function importRecords(
  parsed: ParsedRecords,
  tabId: number,
  source: string,
  onProgress?: (completed: number, total: number) => void,
): Promise<Report> {
  const accepted = parsed.records.slice(0, MAX_IMPORT_ITEMS);
  const ordered = accepted.reverse();
  let skipped = parsed.skipped + Math.max(0, parsed.records.length - accepted.length);
  let imported = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let firstError: string | undefined;
  onProgress?.(0, ordered.length);

  // Source tools list newest first. Insert oldest first so Cliporax keeps the same visible order.
  for (let index = 0; index < ordered.length; index += 1) {
    const record = ordered[index];
    if (new TextEncoder().encode(record.text).byteLength > MAX_TEXT_BYTES) {
      skipped += 1;
      continue;
    }
    try {
      await createText(record.text, tabId, source, record.tab);
      imported += 1;
      consecutiveFailures = 0;
    } catch (error) {
      failed += 1;
      consecutiveFailures += 1;
      firstError = firstError ?? (error instanceof Error ? error.message : String(error)).slice(0, 300);
      if (consecutiveFailures >= 5) {
        failed += ordered.length - index - 1;
        onProgress?.(ordered.length, ordered.length);
        break;
      }
    }
    if ((index + 1) % 25 === 0 || index + 1 === ordered.length) {
      onProgress?.(index + 1, ordered.length);
    }
  }
  return { imported, skipped, failed, firstError };
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
      return "Windows · Ditto has no supported history-export CLI. Use a read-only exporter for your local Ditto database.";
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
    .ci-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .ci-card,.ci-advanced{border:1px solid var(--ci-border);border-radius:10px;background:var(--ci-surface)}
    .ci-card{padding:14px;display:grid;align-content:start;gap:10px}.ci-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
    .ci-card h3{margin:0;font-size:14px}.ci-badge{padding:2px 7px;border-radius:999px;background:color-mix(in srgb,var(--ci-accent) 14%,transparent);color:var(--ci-accent);font-size:11px;font-weight:600}
    .ci-input{width:100%;min-height:36px;padding:7px 9px;border:1px solid var(--ci-border);border-radius:8px;background:transparent;color:inherit;font:inherit;outline:none;transition:border-color 150ms ease,box-shadow 150ms ease}
    .ci-input:focus-visible{border-color:var(--ci-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--ci-accent) 24%,transparent)}
    .ci-button{min-height:36px;padding:7px 11px;border:0;border-radius:8px;background:var(--ci-accent);color:white;font:600 13px/1.2 inherit;cursor:pointer;transition:filter 150ms ease,opacity 150ms ease}
    .ci-button:hover:not(:disabled){filter:brightness(1.08)}.ci-button:focus-visible{outline:2px solid var(--ci-accent);outline-offset:2px}.ci-button:disabled{cursor:not-allowed;opacity:.5}
    .ci-advanced{overflow:hidden}.ci-advanced summary{padding:12px 14px;cursor:pointer;font-weight:600}.ci-advanced summary:focus-visible{outline:2px solid var(--ci-accent);outline-offset:-2px}
    .ci-advanced-body{padding:2px 14px 14px;display:grid;gap:12px}.ci-note{padding:10px 12px;border-left:3px solid var(--ci-accent);background:color-mix(in srgb,var(--ci-accent) 8%,transparent);color:var(--ci-muted)}
    .ci-status{min-height:40px;margin:0;padding:10px 12px;border:1px solid var(--ci-border);border-radius:8px;color:var(--ci-muted)}
    .ci-status[data-kind=running]{color:var(--ci-accent)}.ci-status[data-kind=success]{color:var(--ci-success)}.ci-status[data-kind=error]{color:var(--ci-danger)}
    @media(max-width:620px){.cliporax-import{padding:14px}.ci-grid{grid-template-columns:1fr}}
    @media(prefers-reduced-motion:reduce){.cliporax-import *{transition:none!important}}
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
  intro.textContent = "Move text history into Cliporax locally. No clipboard content is uploaded.";
  header.append(title, intro);

  const destination = document.createElement("div");
  destination.className = "ci-field";
  const destinationLabel = document.createElement("span");
  destinationLabel.className = "ci-label";
  destinationLabel.textContent = "Destination tab";
  const destinationHost = document.createElement("div");
  const destinationHelp = document.createElement("p");
  destinationHelp.className = "ci-help";
  destinationHelp.textContent = "Imported items are added oldest-first so the source's newest item remains on top.";
  destination.append(destinationLabel, destinationHost, destinationHelp);

  let targetTabId = "";
  let tabsReady = false;
  const comboboxes: ComboboxInstance[] = [];
  let destinationCombobox: ComboboxInstance | undefined;
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

  const status = document.createElement("p");
  status.className = "ci-status";
  status.dataset.kind = "idle";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "Choose a source to begin.";
  const buttons: HTMLButtonElement[] = [];
  let isBusy = false;

  const setStatus = (message: string, kind: StatusKind) => {
    status.textContent = message;
    status.dataset.kind = kind;
    status.setAttribute("role", kind === "error" ? "alert" : "status");
  };
  const showProgress = (completed: number, total: number) => {
    setStatus(total ? `Writing items… ${completed.toLocaleString()} / ${total.toLocaleString()}` : "No importable items found.", "running");
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
  };
  const actionButton = (label: string, action: () => Promise<Report>) => {
    const button = document.createElement("button");
    button.className = "ci-button";
    button.type = "button";
    button.textContent = label;
    button.disabled = !tabsReady;
    button.onclick = async () => {
      setBusy(true);
      setStatus(`Importing from ${label.replace("Import ", "")}…`, "running");
      try {
        const report = await action();
        const failures = report.failed
          ? ` ${report.failed} not written.${report.firstError ? ` First error: ${report.firstError}` : ""}`
          : "";
        setStatus(`Imported ${report.imported}; skipped ${report.skipped}.${failures}`, report.failed ? "error" : "success");
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

  const grid = document.createElement("div");
  grid.className = "ci-grid";
  const sourceCard = (name: string, platform: string, description: string, defaultExecutable: string, run: (executable: string) => Promise<Report>) => {
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
    card.append(cardHead, copy, executable.field, button);
    return card;
  };

  const copyqScript = "var tabs=tab();for(var t=0;t<tabs.length;t++){tab(tabs[t]);for(var i=0;i<size();i++)print(JSON.stringify({tab:tabs[t],text:str(read(i))})+'\\n');}";
  grid.append(
    sourceCard("CopyQ", "All platforms", "Uses CopyQ's supported scripting API. CopyQ must be running.", "copyq", async (executable) => {
      const tabId = getTargetTab();
      const output = await invoke<ProcessOutput>("plugin_run_process", { executable, args: ["eval", copyqScript] });
      return importRecords(parseNdjson(output), tabId, "copyq", showProgress);
    }),
    sourceCard("GPaste", "Linux", "Uses NUL-separated raw output so multi-line entries stay intact.", "gpaste-client", async (executable) => {
      const tabId = getTargetTab();
      const output = await invoke<ProcessOutput>("plugin_run_process", { executable, args: ["history", "--raw", "--zero"] });
      return importRecords(parseNulSeparated(output), tabId, "gpaste", showProgress);
    }),
  );

  const advanced = document.createElement("details");
  advanced.className = "ci-advanced";
  const summary = document.createElement("summary");
  summary.textContent = "Ditto, Klipper, Maccy, Raycast, or custom exporter";
  const advancedBody = document.createElement("div");
  advancedBody.className = "ci-advanced-body";
  let selectedSource: ImportSource = "ditto";
  const sourceHost = document.createElement("div");
  const sourceField = document.createElement("div");
  sourceField.className = "ci-field";
  const sourceFieldLabel = document.createElement("span");
  sourceFieldLabel.className = "ci-label";
  sourceFieldLabel.textContent = "Source";
  const exporterHint = document.createElement("p");
  exporterHint.className = "ci-note";
  exporterHint.textContent = sourceHint(selectedSource);
  sourceField.append(sourceFieldLabel, sourceHost);
  if (createCombobox) {
    const sourceCombobox = createCombobox({
      options: (["ditto", "klipper", "maccy", "raycast", "custom"] as ImportSource[]).map((value) => ({ value, label: sourceLabel(value) })),
      value: selectedSource,
      theme,
      ariaLabel: "Clipboard source",
      onChange: (value) => {
        selectedSource = value as ImportSource;
        exporterHint.textContent = sourceHint(selectedSource);
      },
    });
    comboboxes.push(sourceCombobox);
    sourceHost.append(sourceCombobox.element);
  }
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
  advancedBody.append(sourceField, exporterHint, exporter.field, exporterArgs.field, exporterButton);
  advanced.append(summary, advancedBody);

  const privacy = document.createElement("p");
  privacy.className = "ci-note";
  privacy.textContent = `Safety limits: text only, up to ${MAX_IMPORT_ITEMS.toLocaleString()} items and 1 MiB per item. Exporters run without a shell and stop after 60 seconds.`;
  shell.append(header, destination, grid, advanced, privacy, status);
  root.append(style, shell);

  void invoke<Tab[]>("tabs_get_all").then((tabs) => {
    if (!destinationCombobox) {
      setStatus("Update Cliporax before using this plugin.", "error");
      return;
    }
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
  meta: { id: PLUGIN_ID, name: "Clipboard Import", version: "0.2.0" },
  onActivate() {},
  onDeactivate() {},
  extensions: { ClipboardImportView: { render } },
};

hostWindow.CliporaxPlugins = hostWindow.CliporaxPlugins ?? {};
hostWindow.CliporaxPlugins[PLUGIN_ID] = plugin;
