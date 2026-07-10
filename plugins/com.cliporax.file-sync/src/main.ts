const PLUGIN_ID = "com.cliporax.file-sync";
const MAX_BATCH_COPY = 32;
const isChinese = navigator.language.toLowerCase().startsWith("zh");
const messages = isChinese
  ? {
      hostUnavailable: "Cliporax 宿主 API 不可用。",
      notSynced: "尚未同步",
      unknown: "未知",
      addToSync: "添加到文件同步",
      refresh: "刷新",
      copySelected: "复制所选",
      chooseProfile: "选择同步配置…",
      noProfile: "尚未配置云同步",
      encrypted: "已加密",
      empty: "请在本地文件或文件夹的剪贴板条目上点击同步按钮。",
      loading: "正在加载文件同步…",
      loadFailed: "文件同步加载失败。",
      files: "个文件",
      device: "设备",
      largeWarning: "这是大型快照，确认后才会占用磁盘并开始上传。",
      confirmSync: "确认同步",
      retry: "重试",
      copy: "复制",
      cancel: "取消",
      delete: "删除",
      deleteConfirm: "确认删除？",
      batchLimit: `一次最多复制 ${MAX_BATCH_COPY} 项`,
    }
  : {
      hostUnavailable: "Cliporax host API is unavailable.",
      notSynced: "Not synced",
      unknown: "Unknown",
      addToSync: "Add to File Sync",
      refresh: "Refresh",
      copySelected: "Copy selected",
      chooseProfile: "Choose sync profile…",
      noProfile: "No cloud sync profile configured",
      encrypted: "encrypted",
      empty: "Use the sync action on a local file or folder clipboard item.",
      loading: "Loading File Sync…",
      loadFailed: "File Sync failed to load.",
      files: "files",
      device: "device",
      largeWarning: "Large snapshot: disk staging and upload start only after confirmation.",
      confirmSync: "Confirm sync",
      retry: "Retry",
      copy: "Copy",
      cancel: "Cancel",
      delete: "Delete",
      deleteConfirm: "Delete?",
      batchLimit: `Select at most ${MAX_BATCH_COPY} entries`,
    };

interface FileSyncConfig {
  default_profile_id: string | null;
  confirmation_threshold_bytes: number;
  chunk_size: number;
}

interface ProfileOption {
  id: string;
  name: string;
  provider: string;
  encryption_enabled: boolean;
}

interface FileSyncEntry {
  id: string;
  profile_id: string;
  origin_device_id: string;
  kind: "file" | "folder";
  display_name: string;
  total_size: number;
  file_count: number;
  revision: number;
  status: string;
  confirmed: boolean;
  progress_bytes: number;
  error: string | null;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
}

interface FileSyncClipboardItemStatus {
  visible: boolean;
  can_enqueue: boolean;
  reason: string | null;
}

interface ExtensionProps {
  data?: {
    item?: {
      id: number;
      type: string;
    };
  };
  context?: {
    theme?: "light" | "dark";
  };
}

interface TauriInternals {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

interface RuntimePlugin {
  meta: { id: string; name: string; version: string };
  onActivate(): void;
  onDeactivate(): void;
  extensions: Record<
    string,
    {
      render(props: ExtensionProps): HTMLElement | null;
      shouldShow?(props: ExtensionProps): boolean;
    }
  >;
}

interface CliporaxWindow extends Window {
  __TAURI_INTERNALS__?: TauriInternals;
  CliporaxPlugins?: Record<string, RuntimePlugin>;
}

const hostWindow = window as CliporaxWindow;

function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const api = hostWindow.__TAURI_INTERNALS__;
  if (!api) return Promise.reject(new Error(messages.hostUnavailable));
  return api.invoke<T>(command, { pluginId: PLUGIN_ID, ...args });
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatTime(value: string | null): string {
  if (!value) return messages.notSynced;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? messages.unknown : date.toLocaleString();
}

function createButton(label: string, action: () => Promise<void>, destructive = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.style.cssText = `
    border: 0;
    border-radius: 6px;
    padding: 5px 9px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    color: white;
    background: ${destructive ? "#dc2626" : "#4f46e5"};
  `;
  button.onclick = async (event) => {
    event.stopPropagation();
    button.disabled = true;
    try {
      await action();
    } finally {
      button.disabled = false;
    }
  };
  return button;
}

function renderFileSyncButton(props: ExtensionProps): HTMLElement | null {
  const item = props.data?.item;
  if (!item || item.type !== "file") return null;
  const button = document.createElement("button");
  button.type = "button";
  button.title = messages.addToSync;
  button.setAttribute("aria-label", messages.addToSync);
  button.textContent = "⇧";
  button.style.cssText = `
    display: none;
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: 6px;
    cursor: pointer;
    color: inherit;
    background: rgba(99, 102, 241, 0.18);
    font-size: 14px;
    line-height: 22px;
  `;
  void invoke<FileSyncClipboardItemStatus>("file_sync_clipboard_item_status", {
    itemId: item.id,
  })
    .then((status) => {
      if (!status.visible) return;
      button.style.display = "inline-block";
      button.disabled = !status.can_enqueue;
      button.title = status.reason || messages.addToSync;
    })
    .catch(() => {
      button.style.display = "none";
    });
  button.onclick = async (event) => {
    event.stopPropagation();
    button.disabled = true;
    button.textContent = "…";
    let completed = false;
    try {
      await invoke("file_sync_enqueue_clipboard_item", { itemId: item.id });
      button.textContent = "✓";
      completed = true;
    } catch (error) {
      button.textContent = "!";
      button.title = error instanceof Error ? error.message : String(error);
    } finally {
      if (!completed) {
        window.setTimeout(() => {
          button.disabled = false;
          button.textContent = "⇧";
        }, 1600);
      }
    }
  };
  return button;
}

function renderFileSyncView(props: ExtensionProps): HTMLElement {
  const dark = props.context?.theme === "dark";
  const colors = {
    background: dark ? "#111827" : "#f8fafc",
    panel: dark ? "#1f2937" : "#ffffff",
    border: dark ? "#374151" : "#e5e7eb",
    text: dark ? "#e5e7eb" : "#1f2937",
    muted: dark ? "#9ca3af" : "#6b7280",
  };
  const root = document.createElement("section");
  root.style.cssText = `
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    color: ${colors.text};
    background: ${colors.background};
    font-family: system-ui, sans-serif;
  `;

  const toolbar = document.createElement("div");
  toolbar.style.cssText = "display:flex;align-items:center;gap:8px;min-width:0;";
  const selectedEntries = new Set<string>();
  const profileSelect = createCombobox("", [], messages.chooseProfile);
  profileSelect.style.flex = "1";
  const refreshButton = createButton(messages.refresh, async () => {
    if (profileSelect.value) {
      await invoke("file_sync_refresh", { profileId: profileSelect.value });
    }
    await loadEntries();
  });
  const copySelectedButton = createButton(messages.copySelected, async () => {
    if (selectedEntries.size === 0) return;
    await run(() =>
      invoke("file_sync_copy", { entryIds: Array.from(selectedEntries) }),
    );
    selectedEntries.clear();
    copySelectedButton.disabled = true;
  });
  copySelectedButton.disabled = true;
  toolbar.append(profileSelect, refreshButton, copySelectedButton);

  const message = document.createElement("div");
  message.style.cssText = `min-height:16px;font-size:11px;color:${colors.muted};`;
  const list = document.createElement("div");
  list.style.cssText = "flex:1;overflow:auto;display:flex;flex-direction:column;gap:6px;";
  root.append(toolbar, message, list);
  renderStatus(messages.loading);

  function renderStatus(text: string, tone: "muted" | "error" = "muted", action?: HTMLButtonElement): void {
    list.replaceChildren();
    const state = document.createElement("div");
    state.style.cssText = `
      margin:auto;
      max-width:420px;
      padding:24px 14px;
      text-align:center;
      font-size:12px;
      line-height:1.5;
      color:${tone === "error" ? "#ef4444" : colors.muted};
    `;
    const label = document.createElement("div");
    label.textContent = text;
    state.append(label);
    if (action) {
      action.style.marginTop = "10px";
      state.append(action);
    }
    list.append(state);
  }

  function renderError(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    message.textContent = messages.loadFailed;
    renderStatus(detail || messages.loadFailed, "error", createButton(messages.retry, refreshView));
  }

  async function refreshView(): Promise<void> {
    message.textContent = "";
    renderStatus(messages.loading);
    try {
      await loadProfiles();
      await loadEntries();
    } catch (error) {
      renderError(error);
    }
  }

  async function run(action: () => Promise<void>): Promise<void> {
    message.textContent = "";
    try {
      await action();
      await loadEntries();
    } catch (error) {
      renderError(error);
    }
  }

  async function loadProfiles(): Promise<void> {
    const [profiles, config] = await Promise.all([
      invoke<ProfileOption[]>("file_sync_profile_options"),
      invoke<FileSyncConfig>("file_sync_get_config"),
    ]);
    renderComboboxOptions(
      profileSelect,
      config.default_profile_id ?? "",
      profiles.map((profile) => [
        profile.id,
        `${profile.name} · ${profile.provider}${profile.encryption_enabled ? ` · ${messages.encrypted}` : ""}`,
      ]),
      profiles.length ? messages.chooseProfile : messages.noProfile,
    );
    profileSelect.onchange = () =>
      run(async () => {
        if (profileSelect.value) {
          await invoke("file_sync_set_profile", { profileId: profileSelect.value });
        }
      });
  }

  type DomCombobox = HTMLDivElement & {
    value: string;
    trigger: HTMLButtonElement;
    menu: HTMLDivElement;
  };

  function createCombobox(
    value: string,
    options: Array<[string, string]>,
    placeholder: string,
  ): DomCombobox {
    const root = document.createElement("div") as DomCombobox;
    root.value = value;
    root.style.cssText = "position:relative;min-width:0;";
    root.trigger = document.createElement("button");
    root.trigger.type = "button";
    root.trigger.setAttribute("aria-label", messages.chooseProfile);
    root.trigger.setAttribute("aria-haspopup", "listbox");
    root.trigger.setAttribute("aria-expanded", "false");
    root.trigger.style.cssText = `
      width: 100%;
      min-height: 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      border: 1px solid ${colors.border};
      border-radius: 7px;
      padding: 6px 8px;
      color: ${colors.text};
      background: ${colors.panel};
      font-size: 12px;
      text-align: left;
      cursor: pointer;
    `;
    root.menu = document.createElement("div");
    root.menu.setAttribute("role", "listbox");
    root.menu.hidden = true;
    root.menu.style.cssText = `
      position: absolute;
      z-index: 50;
      left: 0;
      right: 0;
      top: calc(100% + 4px);
      max-height: 220px;
      overflow: auto;
      border: 1px solid ${colors.border};
      border-radius: 7px;
      padding: 4px;
      background: ${colors.panel};
      box-shadow: 0 14px 34px rgba(15,23,42,.24);
    `;
    root.trigger.onclick = () => {
      root.menu.hidden = !root.menu.hidden;
      root.trigger.setAttribute("aria-expanded", String(!root.menu.hidden));
    };
    root.addEventListener("focusout", (event) => {
      if (event.relatedTarget instanceof Node && root.contains(event.relatedTarget)) {
        return;
      }
      root.menu.hidden = true;
      root.trigger.setAttribute("aria-expanded", "false");
    });
    root.append(root.trigger, root.menu);
    renderComboboxOptions(root, value, options, placeholder);
    return root;
  }

  function renderComboboxOptions(
    root: DomCombobox,
    value: string,
    options: Array<[string, string]>,
    placeholder: string,
  ): void {
    root.value = value;
    const selectedLabel = options.find(([id]) => id === value)?.[1] ?? placeholder;
    root.trigger.replaceChildren(
      document.createTextNode(selectedLabel),
      document.createTextNode(" v"),
    );
    root.menu.replaceChildren();
    for (const [optionValue, optionLabel] of [["", placeholder], ...options]) {
      const option = document.createElement("button");
      option.type = "button";
      option.textContent = optionLabel;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", optionValue === value ? "true" : "false");
      option.style.cssText = `
        width: 100%;
        min-height: 30px;
        border: 0;
        border-radius: 6px;
        padding: 6px 8px;
        color: ${colors.text};
        background: ${optionValue === value ? colors.background : "transparent"};
        text-align: left;
        cursor: pointer;
        font-size: 12px;
      `;
      option.onclick = () => {
        root.value = optionValue;
        root.menu.hidden = true;
        root.trigger.setAttribute("aria-expanded", "false");
        renderComboboxOptions(root, optionValue, options, placeholder);
        root.dispatchEvent(new Event("change"));
      };
      root.menu.append(option);
    }
  }

  async function loadEntries(): Promise<void> {
    const entries = await invoke<FileSyncEntry[]>("file_sync_list", {
      profileId: profileSelect.value || null,
    });
    const copyableIds = new Set(
      entries
        .filter((entry) => ["synced", "remote", "ready"].includes(entry.status))
        .map((entry) => entry.id),
    );
    for (const selectedId of selectedEntries) {
      if (!copyableIds.has(selectedId)) selectedEntries.delete(selectedId);
    }
    copySelectedButton.disabled = selectedEntries.size === 0;
    list.replaceChildren();
    if (entries.length === 0) {
      renderStatus(messages.empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement("article");
      row.style.cssText = `
        display:grid;
        grid-template-columns:minmax(0,1fr) auto;
        gap:8px;
        align-items:center;
        padding:8px 10px;
        border:1px solid ${colors.border};
        border-radius:8px;
        background:${colors.panel};
      `;
      const details = document.createElement("div");
      details.style.cssText = "min-width:0;";
      const name = document.createElement("div");
      name.textContent = entry.display_name;
      name.title = entry.display_name;
      name.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:650;";
      const metadata = document.createElement("div");
      const progress =
        entry.total_size > 0 && ["preparing", "uploading", "downloading"].includes(entry.status)
          ? ` · ${Math.min(100, Math.round((entry.progress_bytes / entry.total_size) * 100))}%`
          : "";
      metadata.textContent = `${entry.kind} · ${entry.kind === "folder" ? `${entry.file_count} ${messages.files} · ` : ""}${formatSize(entry.total_size)} · ${formatTime(entry.synced_at)} · ${messages.device} ${entry.origin_device_id} · ${entry.status}${progress}`;
      metadata.style.cssText = `margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:${colors.muted};`;
      details.append(name, metadata);
      if (entry.status === "awaiting_confirmation") {
        const warning = document.createElement("div");
        warning.textContent = messages.largeWarning;
        warning.style.cssText = "margin-top:3px;font-size:10px;color:#d97706;";
        details.append(warning);
      }
      if (entry.error) {
        const error = document.createElement("div");
        error.textContent = entry.error;
        error.style.cssText = "margin-top:3px;font-size:10px;color:#ef4444;";
        details.append(error);
      }

      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;align-items:center;gap:5px;";
      if (copyableIds.has(entry.id)) {
        const select = document.createElement("input");
        select.type = "checkbox";
        select.checked = selectedEntries.has(entry.id);
        select.setAttribute("aria-label", `${messages.copySelected}: ${entry.display_name}`);
        select.onchange = () => {
          if (select.checked && selectedEntries.size >= MAX_BATCH_COPY) {
            select.checked = false;
            message.textContent = messages.batchLimit;
            return;
          }
          if (select.checked) selectedEntries.add(entry.id);
          else selectedEntries.delete(entry.id);
          copySelectedButton.disabled = selectedEntries.size === 0;
        };
        actions.append(select);
      }
      if (entry.status === "awaiting_confirmation") {
        actions.append(
          createButton(messages.confirmSync, () =>
            run(() => invoke("file_sync_confirm", { entryId: entry.id })),
          ),
        );
      } else if (entry.status === "failed" || entry.status === "cancelled") {
        actions.append(
          createButton(messages.retry, () => run(() => invoke("file_sync_retry", { entryId: entry.id }))),
        );
      } else if (["synced", "remote", "ready"].includes(entry.status)) {
        actions.append(
          createButton(messages.copy, () =>
            run(() => invoke("file_sync_copy", { entryIds: [entry.id] })),
          ),
        );
      }
      if (["queued", "scanning", "preparing", "uploading", "downloading"].includes(entry.status)) {
        actions.append(
          createButton(
            messages.cancel,
            () => run(() => invoke("file_sync_cancel", { entryId: entry.id })),
            true,
          ),
        );
      }
      if (!["queued", "scanning", "preparing", "uploading", "downloading"].includes(entry.status)) {
        const deleteButton = createButton(
          messages.delete,
          async () => {
            if (deleteButton.dataset.armed !== "true") {
              deleteButton.dataset.armed = "true";
              deleteButton.textContent = messages.deleteConfirm;
              window.setTimeout(() => {
                deleteButton.dataset.armed = "false";
                deleteButton.textContent = messages.delete;
              }, 3000);
              return;
            }
            await run(() => invoke("file_sync_delete", { entryId: entry.id }));
          },
          true,
        );
        actions.append(deleteButton);
      }
      row.append(details, actions);
      row.ondblclick = () => {
        if (["synced", "remote", "ready"].includes(entry.status)) {
          void run(() => invoke("file_sync_copy", { entryIds: [entry.id] }));
        }
      };
      list.append(row);
    }
  }

  void refreshView();
  const poll = window.setInterval(() => {
    if (!root.isConnected) {
      window.clearInterval(poll);
      return;
    }
    void loadEntries().catch(() => {});
  }, 1500);
  return root;
}

const plugin: RuntimePlugin = {
  meta: { id: PLUGIN_ID, name: "File Sync", version: "0.1.0" },
  onActivate() {},
  onDeactivate() {},
  extensions: {
    FileSyncButton: {
      shouldShow: (props) => props.data?.item?.type === "file",
      render: renderFileSyncButton,
    },
    FileSyncView: {
      render: renderFileSyncView,
    },
  },
};

hostWindow.CliporaxPlugins = hostWindow.CliporaxPlugins ?? {};
hostWindow.CliporaxPlugins[PLUGIN_ID] = plugin;
