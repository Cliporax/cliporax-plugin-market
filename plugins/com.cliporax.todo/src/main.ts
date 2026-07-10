const PLUGIN_ID = "com.cliporax.todo";
const STORAGE_KEY = `${PLUGIN_ID}:items`;
const DEFAULT_GROUP_ID = "inbox";
const TODO_ICON = "list-todo";

interface TodoGroup {
  id: string;
  name: string;
  collapsed: boolean;
  createdAt: string;
}

interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
  groupId: string;
  createdAt: string;
  completedAt: string | null;
  updatedAt: string | null;
}

interface TodoState {
  groups: TodoGroup[];
  items: TodoItem[];
}

interface ExtensionProps {
  data?: unknown;
  context?: {
    theme?: "light" | "dark";
  };
  config?: Record<string, unknown>;
}

interface RuntimePlugin {
  meta: { id: string; name: string; version: string };
  onActivate(): void;
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
}

const hostWindow = window as CliporaxWindow;

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
  };
}

function sortGroups(groups: TodoGroup[]): TodoGroup[] {
  return [...groups].sort((a, b) => {
    if (a.id === DEFAULT_GROUP_ID) return -1;
    if (b.id === DEFAULT_GROUP_ID) return 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function sortItems(items: TodoItem[]): TodoItem[] {
  return [...items].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
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
    });
  }

  return {
    groups: sortGroups([...groupMap.values()]),
    items: sortItems(items),
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
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      groups: sortGroups(state.groups),
      items: sortItems(state.items),
    }),
  );
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
  let itemMenu:
    | {
        itemId: string;
        x: number;
        y: number;
      }
    | null = null;

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
    .todo-pro-input-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(128px, 180px) auto;
      align-items: end;
      gap: 8px;
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
    .todo-pro-combobox {
      position: relative;
      min-width: 0;
    }
    .todo-pro-combobox-trigger {
      width: 100%;
      min-height: 36px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      border: 1px solid ${colors.subtleBorder};
      border-radius: 7px;
      padding: 7px 9px;
      cursor: pointer;
      color: ${colors.text};
      background: ${colors.raised};
      font-size: 12px;
      text-align: left;
    }
    .todo-pro-combobox-menu {
      position: absolute;
      z-index: 70;
      left: 0;
      right: 0;
      top: calc(100% + 4px);
      max-height: 220px;
      overflow: auto;
      border: 1px solid ${colors.subtleBorder};
      border-radius: 7px;
      padding: 4px;
      background: ${colors.surface};
      box-shadow: 0 14px 34px rgba(15,23,42,.24);
    }
    .todo-pro-combobox-option {
      width: 100%;
      min-height: 30px;
      border: 0;
      border-radius: 6px;
      padding: 6px 8px;
      cursor: pointer;
      color: ${colors.text};
      background: transparent;
      text-align: left;
      font-size: 12px;
    }
    .todo-pro-combobox-option:hover,
    .todo-pro-combobox-option[aria-selected="true"] {
      background: ${colors.primarySoft};
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
      .todo-pro-input-grid {
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
  form.className = "todo-pro-input-grid";
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

  const groupSelect = renderCombobox(
    addGroupValue,
    state.groups.map((group) => [group.id, group.name]),
    "TODO group",
    (value) => {
      addGroupValue = value;
    },
  );

  const selectLabel = document.createElement("label");
  selectLabel.className = "todo-pro-label";
  selectLabel.textContent = "Group";
  selectLabel.append(groupSelect);

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
  sidebar.append(groupRailTitle, groupRail, groupForm);
  contentPanel.append(message, list);
  shell.append(sidebar, contentPanel);
  root.append(style, header, form, shell);

  function closeItemMenu(): void {
    itemMenu = null;
    renderList();
  }

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

  function renderControls(): void {
    if (!state.groups.some((group) => group.id === addGroupValue)) {
      addGroupValue = DEFAULT_GROUP_ID;
    }
    renderComboboxOptions(
      groupSelect,
      addGroupValue,
      state.groups.map((group) => [group.id, group.name]),
      (value) => {
        addGroupValue = value;
      },
    );

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
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", `Show TODO group ${name}`);
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
    button.onclick = () => {
      activeGroupId = groupId;
      renderControls();
      renderList();
    };
    return button;
  }

  type TodoCombobox = HTMLDivElement & {
    value: string;
    trigger: HTMLButtonElement;
    menu: HTMLDivElement;
  };

  function renderCombobox(
    value: string,
    options: Array<[string, string]>,
    ariaLabel: string,
    onChange: (value: string) => void,
  ): TodoCombobox {
    const root = document.createElement("div") as TodoCombobox;
    root.className = "todo-pro-combobox";
    root.value = value;
    root.trigger = document.createElement("button");
    root.trigger.type = "button";
    root.trigger.className = "todo-pro-combobox-trigger";
    root.trigger.setAttribute("aria-label", ariaLabel);
    root.trigger.setAttribute("aria-haspopup", "listbox");
    root.trigger.setAttribute("aria-expanded", "false");
    root.menu = document.createElement("div");
    root.menu.className = "todo-pro-combobox-menu";
    root.menu.setAttribute("role", "listbox");
    root.menu.hidden = true;
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
    renderComboboxOptions(root, value, options, onChange);
    return root;
  }

  function renderComboboxOptions(
    root: TodoCombobox,
    value: string,
    options: Array<[string, string]>,
    onChange: (value: string) => void,
  ): void {
    root.value = value;
    const selectedLabel = options.find(([optionValue]) => optionValue === value)?.[1] ?? "";
    root.trigger.replaceChildren(
      document.createTextNode(selectedLabel),
      document.createTextNode(" v"),
    );
    root.menu.replaceChildren();
    for (const [optionValue, optionLabel] of options) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "todo-pro-combobox-option";
      option.textContent = optionLabel;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", optionValue === value ? "true" : "false");
      option.onclick = () => {
        root.value = optionValue;
        root.menu.hidden = true;
        root.trigger.setAttribute("aria-expanded", "false");
        onChange(optionValue);
        root.dispatchEvent(new Event("change"));
        renderComboboxOptions(root, optionValue, options, onChange);
      };
      root.menu.append(option);
    }
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
    itemMenu = null;
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

  function moveItemToGroup(item: TodoItem, targetGroupId: string): boolean {
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

    persistAndRender({
      ...state,
      items: state.items.map((existing) =>
        existing.id === item.id
          ? {
              ...existing,
              groupId: targetGroupId,
              updatedAt: new Date().toISOString(),
            }
          : existing,
      ),
    });
    setMessage("");
    return true;
  }

  function renderItem(item: TodoItem): HTMLElement {
    const row = document.createElement("div");
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
    row.oncontextmenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
      itemMenu = {
        itemId: item.id,
        x: event.clientX,
        y: event.clientY,
      };
      renderList();
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
    content.style.cssText = "min-width:0;";

    if (editingItemId === item.id) {
      const editor = document.createElement("textarea");
      editor.value = item.text;
      editor.rows = Math.min(8, Math.max(2, item.text.split(/\r\n|\r|\n/).length));
      editor.setAttribute("aria-label", `Edit TODO: ${item.text}`);
      editor.style.cssText = `
        box-sizing: border-box;
        width: 100%;
        min-height: 56px;
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
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          updateItemText(item, editor.value);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          editingItemId = null;
          renderList();
        }
      };
      content.append(editor);
      const editorActions = document.createElement("div");
      editorActions.style.cssText = `
        display: flex;
        justify-content: flex-end;
        gap: 6px;
        margin-top: 6px;
      `;
      const cancelEdit = document.createElement("button");
      cancelEdit.type = "button";
      cancelEdit.textContent = "Cancel";
      cancelEdit.setAttribute("aria-label", `Cancel editing TODO: ${item.text}`);
      cancelEdit.className = "todo-pro-secondary";
      cancelEdit.onclick = () => {
        editingItemId = null;
        renderList();
      };
      const saveEdit = document.createElement("button");
      saveEdit.type = "button";
      saveEdit.textContent = "Save";
      saveEdit.setAttribute("aria-label", `Save TODO: ${item.text}`);
      saveEdit.className = "todo-pro-primary";
      saveEdit.style.minHeight = "32px";
      saveEdit.onclick = () => {
        updateItemText(item, editor.value);
      };
      editorActions.append(cancelEdit, saveEdit);
      content.append(editorActions);
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
        cursor: text;
        color: ${item.completed ? colors.complete : colors.text};
        text-decoration: ${item.completed ? "line-through" : "none"};
      `;
      text.ondblclick = () => {
        editingItemId = item.id;
        renderList();
      };
      content.append(text);
    }

    const menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.textContent = "...";
    menuButton.setAttribute("aria-label", `Open TODO actions: ${item.text}`);
    menuButton.className = "todo-pro-secondary";
    menuButton.style.cssText = `
      min-width: 32px;
      min-height: 30px;
      padding: 4px 8px;
      line-height: 1;
    `;
    menuButton.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = menuButton.getBoundingClientRect();
      itemMenu = {
        itemId: item.id,
        x: rect.left,
        y: rect.bottom + 4,
      };
      renderList();
    };

    row.append(checkbox, content, menuButton);

    if (itemMenu?.itemId === item.id) {
      row.append(renderItemContextMenu(item));
    }
    return row;
  }

  function renderMenuButton(label: string, danger = false): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.cssText = `
      width: 100%;
      min-height: 30px;
      border: 0;
      padding: 7px 9px;
      cursor: pointer;
      color: ${danger ? colors.error : colors.text};
      background: transparent;
      text-align: left;
      font-size: 12px;
    `;
    button.onmouseenter = () => {
      button.style.background = colors.primarySoft;
    };
    button.onmouseleave = () => {
      button.style.background = "transparent";
    };
    return button;
  }

  function renderItemContextMenu(item: TodoItem): HTMLElement {
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.style.cssText = `
      position: fixed;
      z-index: 60;
      left: ${Math.max(8, itemMenu?.x ?? 8)}px;
      top: ${Math.max(8, itemMenu?.y ?? 8)}px;
      min-width: 168px;
      max-width: calc(100vw - 16px);
      padding: 4px;
      border: 1px solid ${colors.subtleBorder};
      border-radius: 8px;
      background: ${colors.surface};
      box-shadow: 0 12px 28px rgba(15, 23, 42, 0.22);
    `;
    menu.onclick = (event) => {
      event.stopPropagation();
    };

    const edit = renderMenuButton("Edit");
    edit.setAttribute("aria-label", `Edit TODO: ${item.text}`);
    edit.onclick = () => {
      editingItemId = item.id;
      itemMenu = null;
      renderList();
    };
    menu.append(edit);

    const targetGroups = state.groups.filter((group) => group.id !== item.groupId);
    if (targetGroups.length > 0) {
      const moveWrap = document.createElement("div");
      moveWrap.style.cssText = "position:relative;";
      const moveTrigger = renderMenuButton("Move to >");
      moveTrigger.setAttribute("aria-label", `Move TODO to group submenu: ${item.text}`);
      moveTrigger.style.display = "flex";
      moveTrigger.style.justifyContent = "space-between";
      moveTrigger.onfocus = () => {
        submenu.style.display = "block";
      };
      moveTrigger.onmouseenter = () => {
        submenu.style.display = "block";
      };

      const submenu = document.createElement("div");
      submenu.setAttribute("role", "menu");
      submenu.style.cssText = `
        display: none;
        position: absolute;
        left: calc(100% + 6px);
        top: 0;
        min-width: 148px;
        max-width: calc(100vw - 16px);
        padding: 4px;
        border: 1px solid ${colors.subtleBorder};
        border-radius: 8px;
        background: ${colors.surface};
        box-shadow: 0 12px 28px rgba(15, 23, 42, 0.22);
      `;
      moveWrap.onmouseleave = () => {
        submenu.style.display = "none";
      };

      for (const group of targetGroups) {
        const move = renderMenuButton(group.name);
        move.setAttribute("aria-label", `Move TODO to group ${group.name}: ${item.text}`);
        move.onclick = () => {
          moveItemToGroup(item, group.id);
        };
        submenu.append(move);
      }

      moveWrap.append(moveTrigger, submenu);
      menu.append(moveWrap);
    }

    const divider = document.createElement("div");
    divider.style.cssText = `
      margin: 4px 0;
      border-top: 1px solid ${colors.subtleBorder};
    `;
    menu.append(divider);

    const deleteButton = renderMenuButton("Delete", true);
    deleteButton.setAttribute("aria-label", `Delete TODO: ${item.text}`);
    deleteButton.onclick = () => {
      editingItemId = null;
      itemMenu = null;
      persistAndRender({
        ...state,
        items: state.items.filter((existing) => existing.id !== item.id),
      });
      setMessage("");
    };
    menu.append(deleteButton);

    return menu;
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
      return;
    }

    const activeGroupName =
      activeGroupId === "all"
        ? "All tasks"
        : state.groups.find((group) => group.id === activeGroupId)?.name ?? "Tasks";
    const listHeader = document.createElement("div");
    listHeader.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 32px;
      color: ${colors.muted};
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    `;
    const title = document.createElement("span");
    title.textContent = activeGroupName;
    const count = document.createElement("span");
    count.textContent = `${visibleItems.filter((item) => !item.completed).length}/${visibleItems.length}`;
    count.style.fontVariantNumeric = "tabular-nums";
    listHeader.append(title, count);
    list.append(listHeader);

    for (const item of visibleItems) {
      list.append(renderItem(item));
    }
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
  const handleOutsidePointer = (event: PointerEvent) => {
    if (!itemMenu) return;
    const target = event.target;
    if (target instanceof Element && target.closest("[role='menu']")) return;
    closeItemMenu();
  };
  const handleEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && itemMenu) {
      closeItemMenu();
    }
  };
  document.addEventListener("pointerdown", handleOutsidePointer, true);
  document.addEventListener("keydown", handleEscape);
  const cleanupObserver = new MutationObserver(() => {
    if (root.isConnected) return;
    window.removeEventListener(
      `${PLUGIN_ID}:items-changed`,
      handleExternalItemsChanged,
    );
    document.removeEventListener("pointerdown", handleOutsidePointer, true);
    document.removeEventListener("keydown", handleEscape);
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
  meta: { id: PLUGIN_ID, name: "TODO", version: "0.1.0" },
  onActivate() {},
  onDeactivate() {},
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
