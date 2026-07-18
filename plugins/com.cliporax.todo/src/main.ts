const PLUGIN_ID = "com.cliporax.todo";
const STORAGE_KEY = `${PLUGIN_ID}:items`;
const DEFAULT_GROUP_ID = "inbox";
const TODO_ICON = "list-todo";

interface TodoGroup {
  id: string;
  name: string;
  collapsed: boolean;
  createdAt: string;
  order: number;
}

interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
  groupId: string;
  createdAt: string;
  completedAt: string | null;
  updatedAt: string | null;
  order: number;
}

interface TodoState {
  groups: TodoGroup[];
  items: TodoItem[];
}

interface ExtensionProps {
  data?: unknown;
  context?: {
    theme?: "light" | "dark";
    ui: PluginUi;
    storage?: PluginStorage;
    events?: PluginEvents;
  };
  config?: Record<string, unknown>;
}

interface PluginComboboxOption {
  value: string;
  label: string;
}

interface PluginComboboxInstance {
  element: HTMLDivElement;
  setValue(value: string | undefined): void;
  setOptions(options: PluginComboboxOption[]): void;
}

interface PluginUi {
  createCombobox(options: {
    options: PluginComboboxOption[];
    value?: string;
    onChange(value: string): void;
    placeholder?: string;
    theme?: "light" | "dark";
    ariaLabel?: string;
  }): PluginComboboxInstance;
}

interface RuntimePlugin {
  meta: { id: string; name: string; version: string };
  onActivate(context?: ExtensionProps["context"]): void;
  onDeactivate(): void;
  acceptItems?(items: PluginTransferItem[]): number;
  extensions: Record<
    string,
    {
      render?(props: ExtensionProps): HTMLElement;
      getMenuItems?(props: ExtensionProps): PluginContextMenuItem[];
    }
  >;
}

interface PluginTransferItem {
  id?: number | null;
  type?: string;
  content?: string;
  source?: string;
}

interface PluginItemApi {
  getItems(): PluginTransferItem[];
  deleteItems(ids: number[]): Promise<number>;
}

interface PluginContextMenuItem {
  id: string;
  label: string;
  icon?: string;
  disabled?: boolean;
  action(api: PluginItemApi): void | Promise<void>;
}

interface CliporaxWindow extends Window {
  CliporaxPlugins?: Record<string, RuntimePlugin>;
  CliporaxPluginStorage?: {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
  };
}

interface PluginStorage {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
}

interface PluginEvents {
  onSyncCompleted(
    callback: (payload: { profileId: string; report: unknown }) => void,
  ): Promise<() => void>;
}

const hostWindow = window as CliporaxWindow;
let pluginStorage = hostWindow.CliporaxPluginStorage;
let stopSyncListener: (() => void) | undefined;
let syncListenerGeneration = 0;

function normalizeText(value: string): string {
  return value.trim();
}

function duplicateKey(value: string, groupId: string): string {
  return `${groupId}:${normalizeText(value).toLocaleLowerCase()}`;
}

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function defaultGroup(): TodoGroup {
  return {
    id: DEFAULT_GROUP_ID,
    name: "Inbox",
    collapsed: false,
    createdAt: new Date().toISOString(),
    order: 0,
  };
}

function sortGroups(groups: TodoGroup[]): TodoGroup[] {
  return [...groups].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function sortItems(items: TodoItem[]): TodoItem[] {
  return [...items].sort((a, b) => {
    if (a.groupId !== b.groupId) return a.groupId.localeCompare(b.groupId);
    if (a.order !== b.order) return a.order - b.order;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function sanitizeGroup(value: unknown): TodoGroup | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<TodoGroup>;
  const name = normalizeText(String(record.name ?? ""));
  if (!name) return null;
  return {
    id: typeof record.id === "string" && record.id ? record.id : createId(),
    name,
    collapsed: record.collapsed === true,
    createdAt:
      typeof record.createdAt === "string" && record.createdAt
        ? record.createdAt
        : new Date().toISOString(),
    order: typeof record.order === "number" ? record.order : Number.MAX_SAFE_INTEGER,
  };
}

function sanitizeState(value: unknown): TodoState {
  const fallbackGroup = defaultGroup();
  const rawGroups = Array.isArray((value as Partial<TodoState>)?.groups)
    ? ((value as Partial<TodoState>).groups as unknown[])
    : [];
  const rawItems = Array.isArray(value)
    ? value
    : Array.isArray((value as Partial<TodoState>)?.items)
      ? ((value as Partial<TodoState>).items as unknown[])
      : [];

  const groupMap = new Map<string, TodoGroup>();
  groupMap.set(fallbackGroup.id, fallbackGroup);
  for (const group of rawGroups) {
    const sanitized = sanitizeGroup(group);
    if (sanitized) groupMap.set(sanitized.id, sanitized);
  }

  const seen = new Set<string>();
  const items: TodoItem[] = [];
  for (const candidate of rawItems) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Partial<TodoItem>;
    const text = normalizeText(String(record.text ?? ""));
    const groupId =
      typeof record.groupId === "string" && groupMap.has(record.groupId)
        ? record.groupId
        : DEFAULT_GROUP_ID;
    const key = duplicateKey(text, groupId);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    items.push({
      id: typeof record.id === "string" && record.id ? record.id : createId(),
      text,
      groupId,
      completed: record.completed === true,
      createdAt:
        typeof record.createdAt === "string" && record.createdAt
          ? record.createdAt
          : new Date().toISOString(),
      completedAt:
        typeof record.completedAt === "string" && record.completedAt
          ? record.completedAt
          : record.completed === true
            ? new Date().toISOString()
            : null,
      updatedAt:
        typeof record.updatedAt === "string" && record.updatedAt
          ? record.updatedAt
          : null,
      order: typeof record.order === "number" ? record.order : Number.MAX_SAFE_INTEGER,
    });
  }

  const groups = sortGroups([...groupMap.values()]).map((group, index) => ({
    ...group,
    order: Number.isFinite(group.order) ? group.order : index,
  }));
  const groupIndexById = new Map(groups.map((group, index) => [group.id, index]));
  const normalizedItems = items
    .sort((a, b) => {
      const groupA = groupIndexById.get(a.groupId) ?? 0;
      const groupB = groupIndexById.get(b.groupId) ?? 0;
      if (groupA !== groupB) return groupA - groupB;
      if (a.order !== b.order) return a.order - b.order;
      return a.createdAt.localeCompare(b.createdAt);
    })
    .map((item, index) => ({
      ...item,
      order: Number.isFinite(item.order) ? item.order : index,
    }));

  return {
    groups: groups.map((group, index) => ({ ...group, order: index })),
    items: normalizedItems,
  };
}

function loadState(): TodoState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return sanitizeState(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitizeState(null);
  }
}

function saveState(state: TodoState): void {
  const stored = { groups: sortGroups(state.groups), items: sortItems(state.items) };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  void pluginStorage?.set(STORAGE_KEY, stored).catch(() => {
    // Local storage remains an offline fallback; the next save retries sync.
  });
}

async function hydrateSyncedState(): Promise<void> {
  try {
    const remote = await pluginStorage?.get<TodoState>(STORAGE_KEY);
    if (remote) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(remote));
      window.dispatchEvent(new CustomEvent(`${PLUGIN_ID}:items-changed`));
      return;
    }
    await pluginStorage?.set(STORAGE_KEY, loadState());
  } catch {
    // Offline mode intentionally keeps the local copy usable.
  }
}

function addTodoTexts(texts: string[], targetGroupId = DEFAULT_GROUP_ID): number {
  const state = loadState();
  const groupId = state.groups.some((group) => group.id === targetGroupId)
    ? targetGroupId
    : DEFAULT_GROUP_ID;
  const seen = new Set(
    state.items.map((item) => duplicateKey(item.text, item.groupId)),
  );
  const now = new Date().toISOString();
  const additions: TodoItem[] = [];

  for (const value of texts) {
    const text = normalizeText(value);
    const key = duplicateKey(text, groupId);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    additions.push({
      id: createId(),
      text,
      groupId,
      completed: false,
      createdAt: now,
      completedAt: null,
      updatedAt: null,
      order: state.items.length + additions.length,
    });
  }

  if (additions.length === 0) return 0;

  saveState({ ...state, items: [...state.items, ...additions] });
  window.dispatchEvent(
    new CustomEvent(`${PLUGIN_ID}:items-changed`, {
      detail: { added: additions.length },
    }),
  );
  return additions.length;
}

function acceptItems(items: PluginTransferItem[]): number {
  return addTodoTexts(items.map((item) => String(item.content ?? "")));
}

function getMoveToTodoMenuItems(): PluginContextMenuItem[] {
  return [
    {
      id: "move-to-todo",
      label: "Move to TODO",
      icon: TODO_ICON,
      action: async (api) => {
        const items = api.getItems();
        const movable = items.filter((item) =>
          normalizeText(String(item.content ?? "")),
        );
        addTodoTexts(movable.map((item) => String(item.content ?? "")));
        const ids = movable
          .map((item) => item.id)
          .filter((id): id is number => typeof id === "number");
        if (ids.length > 0) {
          await api.deleteItems(ids);
        }
      },
    },
  ];
}

function renderTodoView(props: ExtensionProps): HTMLElement {
  pluginStorage = props.context?.storage ?? pluginStorage;
  const dark = props.context?.theme === "dark";
  const colors = {
    background: dark ? "#0f172a" : "#f0fdfa",
    surface: dark ? "#111827" : "#ffffff",
    panel: dark ? "#172033" : "#f8fafc",
    raised: dark ? "#1f2937" : "#ffffff",
    border: dark ? "#334155" : "#99f6e4",
    subtleBorder: dark ? "#243244" : "#d8f3ef",
    text: dark ? "#f8fafc" : "#134e4a",
    muted: dark ? "#94a3b8" : "#5f7f7b",
    primary: "#0d9488",
    primarySoft: dark ? "rgba(20, 184, 166, 0.14)" : "#ccfbf1",
    accent: "#ea580c",
    complete: dark ? "#64748b" : "#7f9f9a",
    error: "#dc2626",
    focus: "#14b8a6",
  };

  let state = loadState();
  let editingItemId: string | null = null;
  let activeGroupId: string | "all" = "all";
  let addGroupValue = DEFAULT_GROUP_ID;
  let creatingItem = false;
  let creatingGroup = false;
  let editingGroupId: string | null = null;
  let draggedItemId: string | null = null;
  let draggedGroupId: string | null = null;

  const root = document.createElement("section");
  root.className = "todo-pro";
  root.style.cssText = `
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px;
    color: ${colors.text};
    background: ${colors.background};
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  `;

  const style = document.createElement("style");
  style.textContent = `
    .todo-pro, .todo-pro * { box-sizing: border-box; }
    .todo-pro button, .todo-pro input, .todo-pro select, .todo-pro textarea {
      font: inherit;
    }
    .todo-pro button {
      touch-action: manipulation;
      transition: background 160ms ease, border-color 160ms ease, color 160ms ease, opacity 160ms ease;
    }
    .todo-pro button:focus-visible,
    .todo-pro input:focus-visible,
    .todo-pro select:focus-visible,
    .todo-pro textarea:focus-visible {
      outline: 2px solid ${colors.focus};
      outline-offset: 2px;
    }
    .todo-pro-shell {
      min-height: 0;
      flex: 1;
      display: grid;
      grid-template-columns: minmax(168px, 220px) minmax(0, 1fr);
      gap: 10px;
    }
    .todo-pro-label {
      display: grid;
      gap: 4px;
      min-width: 0;
      color: ${colors.muted};
      font-size: 11px;
      font-weight: 650;
    }
    .todo-pro-control {
      min-height: 36px;
      min-width: 0;
      border: 1px solid ${colors.subtleBorder};
      border-radius: 7px;
      padding: 7px 9px;
      color: ${colors.text};
      background: ${colors.raised};
      font-size: 12px;
    }
    .todo-pro-inline-control {
      height: 32px !important;
      min-height: 32px !important;
      padding: 5px 8px !important;
      font-size: 12px !important;
      line-height: 1.35 !important;
    }
    textarea.todo-pro-inline-control {
      height: 40px !important;
      min-height: 40px !important;
      max-height: 96px;
    }
    .todo-pro-primary {
      min-height: 36px;
      border: 0;
      border-radius: 7px;
      padding: 7px 12px;
      cursor: pointer;
      color: #ffffff;
      background: ${colors.primary};
      font-size: 12px;
      font-weight: 750;
    }
    .todo-pro-secondary {
      min-height: 32px;
      border: 1px solid ${colors.subtleBorder};
      border-radius: 7px;
      padding: 6px 9px;
      cursor: pointer;
      color: ${colors.text};
      background: transparent;
      font-size: 11px;
      font-weight: 650;
    }
    .todo-pro-icon-button {
      min-width: 30px;
      min-height: 30px;
      border: 1px solid ${colors.subtleBorder};
      border-radius: 7px;
      padding: 0;
      cursor: pointer;
      color: ${colors.muted};
      background: transparent;
      font-size: 14px;
      font-weight: 800;
      line-height: 1;
    }
    .todo-pro-icon-button:hover {
      color: ${colors.text};
      background: ${colors.primarySoft};
    }
    .todo-pro-add-tile {
      width: 100%;
      height: 28px;
      min-height: 28px;
      flex: 0 0 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px dashed ${colors.primary};
      border-radius: 8px;
      cursor: pointer;
      color: ${colors.primary};
      background: ${colors.primarySoft};
      font-size: 12px;
      font-weight: 750;
      line-height: 1;
    }
    .todo-pro-add-tile:hover { background: ${dark ? "rgba(20, 184, 166, 0.24)" : "#bff5ee"}; }
    .todo-pro-add-mark { font-size: 16px; font-weight: 800; }
    .todo-pro-item:focus,
    .todo-pro-item:focus-within {
      border-color: ${colors.primary} !important;
      background: ${colors.primarySoft} !important;
    }
    .todo-pro-drag-over {
      border-color: ${colors.primary} !important;
      background: ${colors.primarySoft} !important;
    }
    .todo-pro-danger {
      color: ${colors.error};
    }
    .todo-pro-muted {
      color: ${colors.muted};
    }
    @media (max-width: 720px) {
      .todo-pro-shell {
        grid-template-columns: 1fr;
      }
    }
  `;

  const header = document.createElement("header");
  header.style.cssText = `
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 12px;
    align-items: start;
  `;

  const heading = document.createElement("div");
  const title = document.createElement("div");
  title.textContent = "TODO";
  title.style.cssText = `
    font-size: 16px;
    line-height: 1.2;
    font-weight: 800;
    color: ${colors.text};
  `;
  const subtitle = document.createElement("div");
  subtitle.textContent = "Grouped clipboard tasks";
  subtitle.style.cssText = `
    margin-top: 2px;
    color: ${colors.muted};
    font-size: 11px;
    line-height: 1.35;
  `;
  heading.append(title, subtitle);

  const summary = document.createElement("div");
  summary.style.cssText = `
    display: grid;
    grid-auto-flow: column;
    gap: 6px;
    align-items: stretch;
  `;
  header.append(heading, summary);

  const form = document.createElement("form");
  form.style.cssText = `
    padding: 10px;
    border: 1px solid ${colors.subtleBorder};
    border-radius: 8px;
    background: ${colors.surface};
  `;

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Add TODO item";
  input.setAttribute("aria-label", "Add TODO item");
  input.className = "todo-pro-control";

  const inputLabel = document.createElement("label");
  inputLabel.className = "todo-pro-label";
  inputLabel.textContent = "Task";
  inputLabel.append(input);

  const groupCombobox = props.context?.ui.createCombobox({
    options: state.groups.map((group) => ({ value: group.id, label: group.name })),
    value: addGroupValue,
    theme: props.context?.theme ?? "dark",
    ariaLabel: "TODO group",
    onChange: (value) => {
      addGroupValue = value;
    },
  });
  if (!groupCombobox) throw new Error("Cliporax host UI is unavailable.");
  const groupSelect = groupCombobox;

  const selectLabel = document.createElement("label");
  selectLabel.className = "todo-pro-label";
  selectLabel.textContent = "Group";
  selectLabel.append(groupSelect.element);

  const addButton = document.createElement("button");
  addButton.type = "submit";
  addButton.textContent = "Add";
  addButton.className = "todo-pro-primary";

  const groupForm = document.createElement("form");
  groupForm.style.cssText =
    "display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:7px;";

  const groupInput = document.createElement("input");
  groupInput.type = "text";
  groupInput.placeholder = "New group";
  groupInput.setAttribute("aria-label", "New TODO group");
  groupInput.className = "todo-pro-control";

  const groupInputLabel = document.createElement("label");
  groupInputLabel.className = "todo-pro-label";
  groupInputLabel.textContent = "Create group";
  groupInputLabel.append(groupInput);

  const addGroupButton = document.createElement("button");
  addGroupButton.type = "submit";
  addGroupButton.textContent = "Add group";
  addGroupButton.className = "todo-pro-secondary";

  const message = document.createElement("div");
  message.setAttribute("aria-live", "polite");
  message.style.cssText = `
    min-height: 16px;
    font-size: 11px;
    line-height: 1.35;
    color: ${colors.muted};
  `;

  const shell = document.createElement("div");
  shell.className = "todo-pro-shell";

  const sidebar = document.createElement("aside");
  sidebar.style.cssText = `
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 9px;
    padding: 10px;
    border: 1px solid ${colors.subtleBorder};
    border-radius: 8px;
    background: ${colors.surface};
    overflow: hidden;
  `;

  const groupRailTitle = document.createElement("div");
  groupRailTitle.textContent = "Groups";
  groupRailTitle.style.cssText = `
    font-size: 11px;
    font-weight: 800;
    color: ${colors.muted};
    text-transform: uppercase;
  `;

  const groupRail = document.createElement("div");
  groupRail.style.cssText =
    "min-height:0;overflow:auto;display:flex;flex-direction:column;gap:5px;";

  const list = document.createElement("div");
  list.style.cssText =
    `min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px;padding-right:2px;`;

  const contentPanel = document.createElement("main");
  contentPanel.style.cssText = `
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border: 1px solid ${colors.subtleBorder};
    border-radius: 8px;
    background: ${colors.panel};
    overflow: hidden;
  `;

  form.append(inputLabel, selectLabel, addButton);
  groupForm.append(groupInputLabel, addGroupButton);
  sidebar.append(groupRailTitle, groupRail);
  contentPanel.append(message, list);
  shell.append(sidebar, contentPanel);
  root.append(style, header, shell);

  function persistAndRender(nextState: TodoState): void {
    state = sanitizeState(nextState);
    saveState(state);
    window.dispatchEvent(new CustomEvent(`${PLUGIN_ID}:items-changed`));
    renderControls();
    renderSummary();
    renderList();
  }

  function setMessage(text: string, error = false): void {
    message.textContent = text;
    message.style.color = error ? colors.error : colors.muted;
  }

  function nextOrder(items: Array<{ order: number }>): number {
    return items.reduce((max, item) => Math.max(max, item.order), -1) + 1;
  }

  function activeTargetGroupId(): string {
    return activeGroupId === "all" ? DEFAULT_GROUP_ID : activeGroupId;
  }

  function addItem(textValue: string, groupId = activeTargetGroupId()): boolean {
    const text = normalizeText(textValue);
    const targetGroupId = state.groups.some((group) => group.id === groupId)
      ? groupId
      : DEFAULT_GROUP_ID;
    if (!text) {
      setMessage("Enter a non-empty TODO item.", true);
      return false;
    }
    if (
      state.items.some(
        (item) =>
          duplicateKey(item.text, item.groupId) === duplicateKey(text, targetGroupId),
      )
    ) {
      setMessage("That TODO item already exists in this group.", true);
      return false;
    }
    persistAndRender({
      ...state,
      items: [
        ...state.items,
        {
          id: createId(),
          text,
          groupId: targetGroupId,
          completed: false,
          createdAt: new Date().toISOString(),
          completedAt: null,
          updatedAt: null,
          order: nextOrder(state.items.filter((item) => item.groupId === targetGroupId)),
        },
      ],
    });
    creatingItem = false;
    setMessage("");
    return true;
  }

  function deleteItem(item: TodoItem): void {
    editingItemId = null;
    persistAndRender({
      ...state,
      items: state.items.filter((existing) => existing.id !== item.id),
    });
    setMessage("");
  }

  function addGroup(nameValue: string): boolean {
    const name = normalizeText(nameValue);
    if (!name) {
      setMessage("Enter a non-empty group name.", true);
      return false;
    }
    if (state.groups.some((group) => group.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setMessage("That group already exists.", true);
      return false;
    }
    const group: TodoGroup = {
      id: createId(),
      name,
      collapsed: false,
      createdAt: new Date().toISOString(),
      order: nextOrder(state.groups),
    };
    activeGroupId = group.id;
    addGroupValue = group.id;
    creatingGroup = false;
    persistAndRender({ ...state, groups: [...state.groups, group] });
    setMessage("");
    return true;
  }

  function renameGroup(group: TodoGroup, nameValue: string): boolean {
    const name = normalizeText(nameValue);
    if (!name) {
      setMessage("Enter a non-empty group name.", true);
      return false;
    }
    if (
      state.groups.some(
        (candidate) =>
          candidate.id !== group.id &&
          candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    ) {
      setMessage("That group already exists.", true);
      return false;
    }
    editingGroupId = null;
    persistAndRender({
      ...state,
      groups: state.groups.map((candidate) =>
        candidate.id === group.id ? { ...candidate, name } : candidate,
      ),
    });
    setMessage("");
    return true;
  }

  function deleteGroup(group: TodoGroup): void {
    if (group.id === DEFAULT_GROUP_ID) {
      setMessage("Inbox cannot be deleted.", true);
      return;
    }
    const fallbackGroupId = DEFAULT_GROUP_ID;
    let fallbackOrder = nextOrder(state.items.filter((candidate) => candidate.groupId === fallbackGroupId));
    activeGroupId = fallbackGroupId;
    addGroupValue = fallbackGroupId;
    persistAndRender({
      groups: state.groups.filter((existing) => existing.id !== group.id),
      items: state.items.map((item) =>
        item.groupId === group.id
          ? {
              ...item,
              groupId: fallbackGroupId,
              order: fallbackOrder++,
              updatedAt: new Date().toISOString(),
            }
          : item,
      ),
    });
    setMessage("");
  }

  function reorderGroups(sourceId: string, targetId: string): void {
    if (sourceId === targetId) return;
    const groups = sortGroups(state.groups);
    const sourceIndex = groups.findIndex((group) => group.id === sourceId);
    const targetIndex = groups.findIndex((group) => group.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [moved] = groups.splice(sourceIndex, 1);
    groups.splice(targetIndex, 0, moved);
    persistAndRender({
      ...state,
      groups: groups.map((group, index) => ({ ...group, order: index })),
    });
  }

  function reorderItems(sourceId: string, targetId: string): void {
    if (sourceId === targetId) return;
    const source = state.items.find((item) => item.id === sourceId);
    const target = state.items.find((item) => item.id === targetId);
    if (!source || !target) return;
    if (!moveItemToGroup(source, target.groupId, false)) return;
    const groupItems = sortItems(
      state.items.map((item) =>
        item.id === source.id
          ? { ...item, groupId: target.groupId, updatedAt: new Date().toISOString() }
          : item,
      ).filter((item) => item.groupId === target.groupId),
    );
    const currentIndex = groupItems.findIndex((item) => item.id === source.id);
    const targetIndex = groupItems.findIndex((item) => item.id === target.id);
    if (currentIndex < 0 || targetIndex < 0) return;
    const [moved] = groupItems.splice(currentIndex, 1);
    groupItems.splice(targetIndex, 0, moved);
    const orderById = new Map(groupItems.map((item, index) => [item.id, index]));
    persistAndRender({
      ...state,
      items: state.items.map((item) => {
        const order = orderById.get(item.id);
        if (item.id === source.id) {
          return {
            ...item,
            groupId: target.groupId,
            order: order ?? item.order,
            updatedAt: new Date().toISOString(),
          };
        }
        return order === undefined ? item : { ...item, order };
      }),
    });
    setMessage("");
  }

  function renderControls(): void {
    if (!state.groups.some((group) => group.id === addGroupValue)) {
      addGroupValue = DEFAULT_GROUP_ID;
    }
    groupSelect.setOptions(state.groups.map((group) => ({ value: group.id, label: group.name })));
    groupSelect.setValue(addGroupValue);

    groupRail.replaceChildren();
    const allButton = renderGroupRailButton(
      "all",
      "All tasks",
      state.items.length,
      state.items.filter((item) => !item.completed).length,
    );
    groupRail.append(allButton);
    for (const group of state.groups) {
      const groupItems = state.items.filter((item) => item.groupId === group.id);
      groupRail.append(
        renderGroupRailButton(
          group.id,
          group.name,
          groupItems.length,
          groupItems.filter((item) => !item.completed).length,
        ),
      );
    }
    groupRail.append(renderAddGroupTile());
  }

  function renderSummary(): void {
    summary.replaceChildren();
    const total = state.items.length;
    const open = state.items.filter((item) => !item.completed).length;
    const done = total - open;
    for (const stat of [
      ["Open", String(open)],
      ["Done", String(done)],
      ["Groups", String(state.groups.length)],
    ]) {
      const pill = document.createElement("div");
      pill.style.cssText = `
        min-width: 62px;
        padding: 7px 9px;
        border: 1px solid ${colors.subtleBorder};
        border-radius: 8px;
        background: ${colors.surface};
        text-align: right;
      `;
      const value = document.createElement("div");
      value.textContent = stat[1];
      value.style.cssText = `
        color: ${colors.text};
        font-size: 14px;
        font-weight: 800;
        line-height: 1;
      `;
      const label = document.createElement("div");
      label.textContent = stat[0];
      label.style.cssText = `
        margin-top: 3px;
        color: ${colors.muted};
        font-size: 10px;
        font-weight: 700;
      `;
      pill.append(value, label);
      summary.append(pill);
    }
  }

  function renderGroupRailButton(
    groupId: string | "all",
    name: string,
    total: number,
    open: number,
  ): HTMLElement {
    const group = groupId === "all" ? null : state.groups.find((candidate) => candidate.id === groupId) ?? null;
    if (group && editingGroupId === group.id) {
      const form = document.createElement("form");
      form.style.cssText = `
        display:grid;
        grid-template-columns:minmax(0, 1fr) auto auto;
        gap:5px;
        align-items:center;
        padding:5px;
        border:2px solid ${colors.primary};
        border-radius:8px;
        background:${colors.primarySoft};
      `;
      const input = document.createElement("input");
      input.type = "text";
      input.value = group.name;
      input.setAttribute("aria-label", `Rename TODO group ${group.name}`);
      input.className = "todo-pro-control";
      input.style.minHeight = "32px";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.className = "todo-pro-secondary";
      cancel.onclick = () => {
        editingGroupId = null;
        renderControls();
      };
      const save = document.createElement("button");
      save.type = "submit";
      save.textContent = "Save";
      save.className = "todo-pro-primary";
      save.style.minHeight = "32px";
      form.onsubmit = (event) => {
        event.preventDefault();
        renameGroup(group, input.value);
      };
      input.onkeydown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          editingGroupId = null;
          renderControls();
        }
      };
      form.append(input, cancel, save);
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
      return form;
    }

    const row = document.createElement("div");
    row.style.cssText = `
      display:grid;
      grid-template-columns:minmax(0, 1fr) ${group ? "auto" : ""};
      gap:5px;
      align-items:stretch;
    `;
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", `Show TODO group ${name}`);
    if (group) button.draggable = true;
    const active = activeGroupId === groupId;
    button.style.cssText = `
      width: 100%;
      min-height: 38px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      border: 1px solid ${active ? colors.primary : "transparent"};
      border-radius: 7px;
      padding: 7px 8px;
      cursor: pointer;
      color: ${active ? colors.text : colors.muted};
      background: ${active ? colors.primarySoft : "transparent"};
      font-weight: ${active ? "800" : "inherit"};
      text-align: left;
    `;
    const label = document.createElement("span");
    label.textContent = name;
    label.style.cssText =
      "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:700;";
    const count = document.createElement("span");
    count.textContent = `${open}/${total}`;
    count.style.cssText = `
      color: ${active ? colors.primary : colors.muted};
      font-size: 11px;
      font-weight: 800;
      font-variant-numeric: tabular-nums;
    `;
    button.append(label, count);
    row.append(button);
    if (group) {
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:4px;align-items:center;";
      const renameButton = document.createElement("button");
      renameButton.type = "button";
      renameButton.textContent = "✏️";
      renameButton.setAttribute("aria-label", `Rename TODO group ${name}`);
      renameButton.className = "todo-pro-secondary";
      renameButton.style.cssText = "width:30px;min-width:30px;min-height:30px;padding:0;";
      renameButton.onclick = () => {
        editingGroupId = group.id;
        creatingGroup = false;
        renderControls();
      };
      actions.append(renameButton);
      if (group.id !== DEFAULT_GROUP_ID) {
        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.setAttribute("aria-label", `Delete TODO group ${name}`);
        deleteButton.textContent = "×";
        deleteButton.className = "todo-pro-secondary todo-pro-danger";
        deleteButton.style.cssText = `
          min-width:32px;
          min-height:38px;
          padding:0;
          font-size:16px;
        `;
        deleteButton.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          deleteGroup(group);
        };
        actions.append(deleteButton);
      }
      row.append(actions);
    }
    button.onclick = () => {
      activeGroupId = groupId;
      renderControls();
      renderList();
    };
    button.ondragstart = (event) => {
      if (!group) return;
      draggedGroupId = group.id;
      event.dataTransfer?.setData("text/plain", group.id);
      event.dataTransfer?.setData("application/x-cliporax-todo-group", group.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    };
    button.ondragover = (event) => {
      if (!group) return;
      if (draggedItemId || (draggedGroupId && draggedGroupId !== group.id)) {
        event.preventDefault();
        button.classList.add("todo-pro-drag-over");
      }
    };
    button.ondragleave = () => {
      button.classList.remove("todo-pro-drag-over");
    };
    button.ondrop = (event) => {
      if (!group) return;
      event.preventDefault();
      button.classList.remove("todo-pro-drag-over");
      if (draggedItemId) {
        const item = state.items.find((candidate) => candidate.id === draggedItemId);
        if (item) moveItemToGroup(item, group.id);
      } else if (draggedGroupId) {
        reorderGroups(draggedGroupId, group.id);
      }
      draggedItemId = null;
      draggedGroupId = null;
    };
    button.ondragend = () => {
      draggedGroupId = null;
      button.classList.remove("todo-pro-drag-over");
    };
    return row;
  }

  function renderAddGroupTile(): HTMLElement {
    if (creatingGroup) {
      const form = document.createElement("form");
      form.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr);";
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "New group";
      input.setAttribute("aria-label", "New TODO group");
      input.className = "todo-pro-control todo-pro-inline-control";
      form.onsubmit = (event) => {
        event.preventDefault();
        addGroup(input.value);
      };
      input.onkeydown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          creatingGroup = false;
          renderControls();
        }
      };
      form.append(input);
      setTimeout(() => input.focus(), 0);
      return form;
    }
    const add = document.createElement("button");
    add.type = "button";
    const mark = document.createElement("span");
    mark.textContent = "+";
    mark.className = "todo-pro-add-mark";
    add.append(mark);
    add.setAttribute("aria-label", "Create TODO group");
    add.className = "todo-pro-add-tile";
    add.onclick = () => {
      creatingGroup = true;
      renderControls();
    };
    return add;
  }

  function updateItemText(item: TodoItem, nextText: string): boolean {
    const text = normalizeText(nextText);
    if (!text) {
      setMessage("Enter a non-empty TODO item.", true);
      return false;
    }
    if (
      state.items.some(
        (existing) =>
          existing.id !== item.id &&
          duplicateKey(existing.text, existing.groupId) ===
            duplicateKey(text, item.groupId),
      )
    ) {
      setMessage("That TODO item already exists in this group.", true);
      return false;
    }

    editingItemId = null;
    persistAndRender({
      ...state,
      items: state.items.map((existing) =>
        existing.id === item.id
          ? { ...existing, text, updatedAt: new Date().toISOString() }
          : existing,
      ),
    });
    setMessage("");
    return true;
  }

  function moveItemToGroup(item: TodoItem, targetGroupId: string, shouldPersist = true): boolean {
    if (item.groupId === targetGroupId) return true;
    if (!state.groups.some((group) => group.id === targetGroupId)) return false;
    if (
      state.items.some(
        (existing) =>
          existing.id !== item.id &&
          duplicateKey(existing.text, existing.groupId) ===
            duplicateKey(item.text, targetGroupId),
      )
    ) {
      setMessage("That TODO item already exists in the target group.", true);
      renderList();
      return false;
    }

    if (shouldPersist) {
      persistAndRender({
        ...state,
        items: state.items.map((existing) =>
          existing.id === item.id
            ? {
                ...existing,
                groupId: targetGroupId,
                order: nextOrder(state.items.filter((candidate) => candidate.groupId === targetGroupId)),
                updatedAt: new Date().toISOString(),
              }
            : existing,
        ),
      });
    }
    setMessage("");
    return true;
  }

  function renderItem(item: TodoItem): HTMLElement {
    const row = document.createElement("div");
    row.className = "todo-pro-item";
    row.tabIndex = 0;
    row.draggable = editingItemId !== item.id;
    row.setAttribute("aria-label", `TODO item: ${item.text}`);
    row.style.cssText = `
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      position: relative;
      padding: 8px 8px;
      border: 1px solid ${colors.subtleBorder};
      border-radius: 8px;
      background: ${colors.raised};
    `;
    row.onkeydown = (event) => {
      if (
        editingItemId !== item.id &&
        (event.key === "Delete" || event.key === "Backspace")
      ) {
        event.preventDefault();
        deleteItem(item);
      }
    };
    row.ondragstart = (event) => {
      if (editingItemId === item.id) {
        event.preventDefault();
        return;
      }
      draggedItemId = item.id;
      event.dataTransfer?.setData("text/plain", item.id);
      event.dataTransfer?.setData("application/x-cliporax-todo-item", item.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    };
    row.ondragover = (event) => {
      if (draggedItemId && draggedItemId !== item.id) {
        event.preventDefault();
        row.classList.add("todo-pro-drag-over");
      }
    };
    row.ondragleave = () => {
      row.classList.remove("todo-pro-drag-over");
    };
    row.ondrop = (event) => {
      event.preventDefault();
      row.classList.remove("todo-pro-drag-over");
      if (draggedItemId && draggedItemId !== item.id) {
        reorderItems(draggedItemId, item.id);
      }
      draggedItemId = null;
      draggedGroupId = null;
    };
    row.ondragend = () => {
      draggedItemId = null;
      row.classList.remove("todo-pro-drag-over");
    };

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = item.completed;
    checkbox.setAttribute(
      "aria-label",
      item.completed ? `Mark incomplete: ${item.text}` : `Mark complete: ${item.text}`,
    );
    checkbox.style.marginTop = "2px";
    checkbox.onchange = () => {
      persistAndRender({
        ...state,
        items: state.items.map((existing) =>
          existing.id === item.id
            ? {
                ...existing,
                completed: checkbox.checked,
                completedAt: checkbox.checked ? new Date().toISOString() : null,
                updatedAt: new Date().toISOString(),
              }
            : existing,
        ),
      });
      setMessage("");
    };

    const content = document.createElement("div");
    content.style.cssText = editingItemId === item.id
      ? "grid-column: 2 / -1; min-width:0;"
      : "min-width:0;";

    if (editingItemId === item.id) {
      const editor = document.createElement("textarea");
      editor.value = item.text;
      editor.rows = Math.min(8, Math.max(2, item.text.split(/\r\n|\r|\n/).length));
      editor.setAttribute("aria-label", `Edit TODO: ${item.text}`);
      editor.style.cssText = `
        box-sizing: border-box;
        width: 100%;
        height: clamp(88px, 24dvh, 180px);
        min-height: 88px;
        max-height: 34dvh;
        resize: vertical;
        border: 1px solid ${colors.primary};
        border-radius: 7px;
        padding: 7px 8px;
        color: ${colors.text};
        background: ${colors.surface};
        font-size: 12px;
        line-height: 1.5;
      `;
      editor.onkeydown = (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          updateItemText(item, editor.value);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          editingItemId = null;
          renderList();
        }
      };
      content.append(editor);
      setTimeout(() => {
        editor.focus();
        editor.setSelectionRange(editor.value.length, editor.value.length);
      }, 0);
    } else {
      const text = document.createElement("button");
      text.type = "button";
      text.textContent = item.text;
      text.title = item.text;
      text.style.cssText = `
        display: block;
        width: 100%;
        min-width: 0;
        padding: 0;
        border: 0;
        background: transparent;
        text-align: left;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
        font: inherit;
        font-size: 12px;
        line-height: 1.35;
        cursor: default;
        color: ${item.completed ? colors.complete : colors.text};
        text-decoration: ${item.completed ? "line-through" : "none"};
      `;
      text.ondblclick = () => {
        editingItemId = item.id;
        renderList();
      };
      content.append(text);
    }

    row.append(checkbox, content);

    if (editingItemId !== item.id) {
      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.textContent = "✏️";
      editButton.setAttribute("aria-label", `Edit TODO: ${item.text}`);
      editButton.className = "todo-pro-secondary";
      editButton.style.cssText = "width:30px;min-width:30px;min-height:30px;padding:0;";
      editButton.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        editingItemId = item.id;
        renderList();
      };
      row.append(editButton);
    }
    return row;
  }

  function renderList(): void {
    list.replaceChildren();
    const visibleItems = state.items.filter(
      (item) => activeGroupId === "all" || item.groupId === activeGroupId,
    );

    if (visibleItems.length === 0) {
      const empty = document.createElement("div");
      empty.textContent =
        activeGroupId === "all" ? "No TODO items yet." : "No TODO items in this group.";
      empty.style.cssText = `
        min-height: 160px;
        display: grid;
        place-items: center;
        padding: 24px 8px;
        border: 1px dashed ${colors.subtleBorder};
        border-radius: 8px;
        text-align: center;
        font-size: 12px;
        color: ${colors.muted};
        background: ${colors.surface};
      `;
      list.append(empty);
      list.append(renderAddItemTile());
      return;
    }

    for (const item of visibleItems) {
      list.append(renderItem(item));
    }
    list.append(renderAddItemTile());
  }

  function renderAddItemTile(): HTMLElement {
    if (creatingItem) {
      const form = document.createElement("form");
      form.style.cssText = `
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        align-items: start;
        padding: 6px;
        border: 1px solid ${colors.subtleBorder};
        border-radius: 8px;
        background: ${colors.raised};
      `;
      const input = document.createElement("textarea");
      input.rows = 1;
      input.placeholder = "Add TODO item";
      input.setAttribute("aria-label", "Add TODO item");
      input.className = "todo-pro-control todo-pro-inline-control";
      input.style.resize = "vertical";
      form.onsubmit = (event) => {
        event.preventDefault();
        addItem(input.value);
      };
      input.onkeydown = (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          addItem(input.value);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          creatingItem = false;
          renderList();
        }
      };
      form.append(input);
      setTimeout(() => input.focus(), 0);
      return form;
    }
    const add = document.createElement("button");
    add.type = "button";
    const mark = document.createElement("span");
    mark.textContent = "+";
    mark.className = "todo-pro-add-mark";
    add.append(mark);
    add.setAttribute("aria-label", "Create TODO item");
    add.className = "todo-pro-add-tile";
    add.onclick = () => {
      creatingItem = true;
      renderList();
    };
    return add;
  }

  form.onsubmit = (event) => {
    event.preventDefault();
    const text = normalizeText(input.value);
    const groupId = addGroupValue || DEFAULT_GROUP_ID;
    if (!text) {
      setMessage("Enter a non-empty TODO item.", true);
      return;
    }
    if (
      state.items.some(
        (item) => duplicateKey(item.text, item.groupId) === duplicateKey(text, groupId),
      )
    ) {
      setMessage("That TODO item already exists in this group.", true);
      return;
    }
    persistAndRender({
      ...state,
      items: [
        ...state.items,
        {
          id: createId(),
          text,
          groupId,
          completed: false,
          createdAt: new Date().toISOString(),
          completedAt: null,
          updatedAt: null,
          order: nextOrder(state.items.filter((item) => item.groupId === groupId)),
        },
      ],
    });
    input.value = "";
    input.focus();
    setMessage("");
  };

  groupForm.onsubmit = (event) => {
    event.preventDefault();
    const name = normalizeText(groupInput.value);
    if (!name) {
      setMessage("Enter a non-empty group name.", true);
      return;
    }
    if (state.groups.some((group) => group.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setMessage("That group already exists.", true);
      return;
    }
    const group: TodoGroup = {
      id: createId(),
      name,
      collapsed: false,
      createdAt: new Date().toISOString(),
      order: nextOrder(state.groups),
    };
    persistAndRender({ ...state, groups: [...state.groups, group] });
    groupInput.value = "";
    activeGroupId = group.id;
    addGroupValue = group.id;
    setMessage("");
  };

  const handleExternalItemsChanged = () => {
    state = loadState();
    renderControls();
    renderSummary();
    renderList();
  };

  window.addEventListener(`${PLUGIN_ID}:items-changed`, handleExternalItemsChanged);
  void hydrateSyncedState();
  const cleanupObserver = new MutationObserver(() => {
    if (root.isConnected) return;
    window.removeEventListener(
      `${PLUGIN_ID}:items-changed`,
      handleExternalItemsChanged,
    );
    cleanupObserver.disconnect();
  });
  cleanupObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  renderControls();
  renderSummary();
  renderList();
  return root;
}

const plugin: RuntimePlugin = {
  meta: { id: PLUGIN_ID, name: "TODO", version: "0.1.1" },
  onActivate(context) {
    pluginStorage = context?.storage ?? pluginStorage;
    const generation = ++syncListenerGeneration;
    stopSyncListener?.();
    stopSyncListener = undefined;
    void context?.events?.onSyncCompleted(() => {
      void hydrateSyncedState();
    }).then((unlisten) => {
      if (generation === syncListenerGeneration) stopSyncListener = unlisten;
      else unlisten();
    });
    void hydrateSyncedState();
  },
  onDeactivate() {
    syncListenerGeneration += 1;
    stopSyncListener?.();
    stopSyncListener = undefined;
  },
  acceptItems,
  extensions: {
    TodoView: {
      render: renderTodoView,
    },
    MoveToTodoAction: {
      getMenuItems: getMoveToTodoMenuItems,
    },
  },
};

hostWindow.CliporaxPlugins = hostWindow.CliporaxPlugins ?? {};
hostWindow.CliporaxPlugins[PLUGIN_ID] = plugin;
