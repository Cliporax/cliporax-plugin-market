const PLUGIN_ID = "com.cliporax.todo";
const STORAGE_KEY = `${PLUGIN_ID}:items`;

interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
  createdAt: string;
  completedAt: string | null;
}

interface ExtensionProps {
  context?: {
    theme?: "light" | "dark";
  };
}

interface RuntimePlugin {
  meta: { id: string; name: string; version: string };
  onActivate(): void;
  onDeactivate(): void;
  extensions: Record<
    string,
    {
      render(props: ExtensionProps): HTMLElement;
    }
  >;
}

interface CliporaxWindow extends Window {
  CliporaxPlugins?: Record<string, RuntimePlugin>;
}

const hostWindow = window as CliporaxWindow;

function normalizeText(value: string): string {
  return value.trim();
}

function duplicateKey(value: string): string {
  return normalizeText(value).toLocaleLowerCase();
}

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function sanitizeItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: TodoItem[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Partial<TodoItem>;
    const text = normalizeText(String(record.text ?? ""));
    const key = duplicateKey(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    items.push({
      id: typeof record.id === "string" && record.id ? record.id : createId(),
      text,
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
    });
  }
  return sortItems(items);
}

function sortItems(items: TodoItem[]): TodoItem[] {
  return [...items].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function loadItems(): TodoItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return sanitizeItems(raw ? JSON.parse(raw) : []);
  } catch {
    return [];
  }
}

function saveItems(items: TodoItem[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sortItems(items)));
}

function renderTodoView(props: ExtensionProps): HTMLElement {
  const dark = props.context?.theme === "dark";
  const colors = {
    background: dark ? "#111827" : "#f8fafc",
    panel: dark ? "#1f2937" : "#ffffff",
    border: dark ? "#374151" : "#e5e7eb",
    text: dark ? "#e5e7eb" : "#1f2937",
    muted: dark ? "#9ca3af" : "#6b7280",
    primary: "#2563eb",
    complete: dark ? "#6b7280" : "#9ca3af",
    error: "#dc2626",
  };

  let items = loadItems();

  const root = document.createElement("section");
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
    font-family: system-ui, sans-serif;
  `;

  const form = document.createElement("form");
  form.style.cssText = "display:flex;align-items:center;gap:8px;min-width:0;";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Add TODO item";
  input.setAttribute("aria-label", "Add TODO item");
  input.style.cssText = `
    min-width: 0;
    flex: 1;
    border: 1px solid ${colors.border};
    border-radius: 7px;
    padding: 7px 9px;
    color: ${colors.text};
    background: ${colors.panel};
    font-size: 12px;
  `;

  const addButton = document.createElement("button");
  addButton.type = "submit";
  addButton.textContent = "Add";
  addButton.style.cssText = `
    border: 0;
    border-radius: 6px;
    padding: 7px 12px;
    font-size: 12px;
    font-weight: 650;
    cursor: pointer;
    color: white;
    background: ${colors.primary};
  `;

  const message = document.createElement("div");
  message.style.cssText = `min-height:16px;font-size:11px;color:${colors.muted};`;

  const list = document.createElement("div");
  list.style.cssText = "flex:1;overflow:auto;display:flex;flex-direction:column;gap:6px;";

  form.append(input, addButton);
  root.append(form, message, list);

  function persistAndRender(nextItems: TodoItem[]): void {
    items = sortItems(nextItems);
    saveItems(items);
    renderList();
  }

  function setMessage(text: string, error = false): void {
    message.textContent = text;
    message.style.color = error ? colors.error : colors.muted;
  }

  function renderList(): void {
    list.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No TODO items yet.";
      empty.style.cssText = `padding:24px 8px;text-align:center;font-size:12px;color:${colors.muted};`;
      list.append(empty);
      return;
    }

    for (const item of items) {
      const row = document.createElement("label");
      row.style.cssText = `
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 9px;
        align-items: center;
        padding: 9px 10px;
        border: 1px solid ${colors.border};
        border-radius: 8px;
        background: ${colors.panel};
        cursor: pointer;
      `;

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = item.completed;
      checkbox.setAttribute("aria-label", item.completed ? `Mark incomplete: ${item.text}` : `Mark complete: ${item.text}`);
      checkbox.onchange = () => {
        persistAndRender(
          items.map((existing) =>
            existing.id === item.id
              ? {
                  ...existing,
                  completed: checkbox.checked,
                  completedAt: checkbox.checked ? new Date().toISOString() : null,
                }
              : existing,
          ),
        );
        setMessage("");
      };

      const text = document.createElement("span");
      text.textContent = item.text;
      text.title = item.text;
      text.style.cssText = `
        min-width: 0;
        overflow-wrap: anywhere;
        font-size: 12px;
        line-height: 1.35;
        color: ${item.completed ? colors.complete : colors.text};
        text-decoration: ${item.completed ? "line-through" : "none"};
      `;

      row.append(checkbox, text);
      list.append(row);
    }
  }

  form.onsubmit = (event) => {
    event.preventDefault();
    const text = normalizeText(input.value);
    if (!text) {
      setMessage("Enter a non-empty TODO item.", true);
      return;
    }
    if (items.some((item) => duplicateKey(item.text) === duplicateKey(text))) {
      setMessage("That TODO item already exists.", true);
      return;
    }
    persistAndRender([
      ...items,
      {
        id: createId(),
        text,
        completed: false,
        createdAt: new Date().toISOString(),
        completedAt: null,
      },
    ]);
    input.value = "";
    input.focus();
    setMessage("");
  };

  renderList();
  return root;
}

const plugin: RuntimePlugin = {
  meta: { id: PLUGIN_ID, name: "TODO", version: "0.1.0" },
  onActivate() {},
  onDeactivate() {},
  extensions: {
    TodoView: {
      render: renderTodoView,
    },
  },
};

hostWindow.CliporaxPlugins = hostWindow.CliporaxPlugins ?? {};
hostWindow.CliporaxPlugins[PLUGIN_ID] = plugin;
