type Theme = "dark" | "light" | "system";

interface PluginContext {
  theme?: Theme;
  [key: string]: unknown;
}

interface ClipboardItem {
  id: string | number;
  type: "text" | "image" | "file";
  content: string;
}

interface ExtensionProps {
  data?: {
    item?: ClipboardItem;
    position?: string;
  };
  context?: PluginContext;
}

interface PluginTransferItem {
  id?: number | null;
  content?: string;
}

interface PluginContextMenuItem {
  id: string;
  label: string;
  icon?: string;
  action(api: { getItems(): PluginTransferItem[] }): void | Promise<void>;
}

interface RuntimePlugin {
  onActivate?: (context: PluginContext) => void;
  onDeactivate?: () => void;
  extensions?: Record<
    string,
    {
      render: (props: ExtensionProps) => HTMLElement | null;
      shouldShow?: (props: ExtensionProps) => boolean;
      getMenuItems?: (props: ExtensionProps) => PluginContextMenuItem[];
    }
  >;
}

interface HostWindow extends Window {
  __TAURI_INTERNALS__?: {
    invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  };
  CliporaxPlugins?: Record<string, RuntimePlugin>;
}

const PLUGIN_ID = "com.cliporax.imagepreview";
const hostWindow = window as HostWindow;

function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const api = hostWindow.__TAURI_INTERNALS__;
  if (!api) return Promise.reject(new Error("Cliporax host API is unavailable."));
  return api.invoke<T>(command, args);
}

function createPreviewButton(item: ClipboardItem, theme: string): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.title = "Preview Image";
  button.setAttribute("aria-label", "Preview Image");
  button.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="8"></circle>
      <path d="m21 21-4.35-4.35"></path>
      <path d="M11 8v6"></path>
      <path d="M8 11h6"></path>
    </svg>
  `;
  button.style.cssText = `
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: 6px;
    background: ${theme === "dark" ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.7)"};
    color: ${theme === "dark" ? "#e2e8f0" : "#52525b"};
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  `;
  button.onclick = async (event) => {
    event.stopPropagation();
    await invoke<string>("preview_create_window", {
      imageData: item.content,
      title: `Image Preview - #${item.id}`,
    });
  };
  return button;
}

hostWindow.CliporaxPlugins = hostWindow.CliporaxPlugins || {};
hostWindow.CliporaxPlugins[PLUGIN_ID] = {
  onActivate: () => {
    console.info("[ImagePreview] activated");
  },
  onDeactivate: () => {
    console.info("[ImagePreview] deactivated");
  },
  extensions: {
    PreviewButton: {
      render: (props: ExtensionProps) => {
        const item = props.data?.item;
        if (!item || item.type !== "image" || props.data?.position !== "action") {
          return null;
        }
        return createPreviewButton(item, props.context?.theme || "dark");
      },
      shouldShow: (props: ExtensionProps) => props.data?.item?.type === "image",
      getMenuItems: () => [
        {
          id: "preview-image",
          label: "Preview Image",
          icon: "image-plus",
          action: async (api) => {
            const item = api.getItems()[0];
            if (!item?.content) return;
            await invoke<string>("preview_create_window", {
              imageData: item.content,
              title: `Image Preview - #${item.id ?? ""}`,
            });
          },
        },
      ],
    },
  },
};
