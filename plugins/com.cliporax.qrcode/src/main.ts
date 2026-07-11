import QRCode from "qrcode";

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
  type?: string;
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
  CliporaxPlugins?: Record<string, RuntimePlugin>;
}

const PLUGIN_ID = "com.cliporax.qrcode";
const hostWindow = window as HostWindow;

async function generateQRCode(text: string, size = 256): Promise<string> {
  return QRCode.toDataURL(text, {
    width: size,
    margin: 4,
    color: {
      dark: "#000000",
      light: "#ffffff",
    },
    errorCorrectionLevel: "M",
  });
}

function createButton(label: string, theme: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.style.cssText = `
    border: 0;
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    background: ${label === "Download" ? "#2563eb" : theme === "dark" ? "#374151" : "#e5e7eb"};
    color: ${label === "Download" ? "#ffffff" : theme === "dark" ? "#f9fafb" : "#111827"};
  `;
  return button;
}

function showQRCodeModal(content: string, theme: string): void {
  document.getElementById("cliporax-qrcode-modal")?.remove();
  const dark = theme === "dark";

  const overlay = document.createElement("div");
  overlay.id = "cliporax-qrcode-modal";
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(0,0,0,0.6);
    backdrop-filter: blur(4px);
  `;

  const panel = document.createElement("section");
  panel.style.cssText = `
    width: min(340px, 100%);
    border-radius: 12px;
    padding: 20px;
    background: ${dark ? "#111827" : "#ffffff"};
    color: ${dark ? "#f9fafb" : "#111827"};
    box-shadow: 0 24px 70px rgba(0,0,0,0.32);
  `;

  const title = document.createElement("h3");
  title.textContent = "QR Code";
  title.style.cssText = "margin: 0 0 14px; font-size: 17px; font-weight: 700;";

  const imageFrame = document.createElement("div");
  imageFrame.style.cssText = `
    width: 224px;
    height: 224px;
    margin: 0 auto 14px;
    padding: 12px;
    border-radius: 10px;
    background: #ffffff;
    display: flex;
    align-items: center;
    justify-content: center;
  `;
  imageFrame.textContent = "Generating...";

  const preview = document.createElement("p");
  preview.textContent = content.length > 140 ? `${content.slice(0, 140)}...` : content;
  preview.style.cssText = `
    margin: 0 0 16px;
    max-height: 64px;
    overflow: hidden;
    color: ${dark ? "#9ca3af" : "#6b7280"};
    font-size: 12px;
    line-height: 1.45;
    word-break: break-word;
  `;

  const actions = document.createElement("div");
  actions.style.cssText = "display: flex; justify-content: center; gap: 8px;";
  const download = createButton("Download", theme);
  download.disabled = true;
  const close = createButton("Close", theme);
  close.onclick = () => overlay.remove();
  actions.append(download, close);

  let dataUrl = "";
  generateQRCode(content)
    .then((url) => {
      dataUrl = url;
      const image = document.createElement("img");
      image.src = url;
      image.alt = "Generated QR code";
      image.style.cssText = "width: 100%; height: 100%; object-fit: contain;";
      imageFrame.replaceChildren(image);
      download.disabled = false;
    })
    .catch((error) => {
      console.error("[QRCode] Failed to generate QR code:", error);
      imageFrame.textContent = "Failed";
    });

  download.onclick = () => {
    if (!dataUrl) return;
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = "cliporax-qrcode.png";
    link.click();
  };

  panel.append(title, imageFrame, preview, actions);
  overlay.append(panel);
  overlay.onclick = (event) => {
    if (event.target === overlay) overlay.remove();
  };
  document.body.appendChild(overlay);
}

function createQRCodeButton(item: ClipboardItem, theme: string): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.title = "Generate QR Code";
  button.setAttribute("aria-label", "Generate QR Code");
  button.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="3" width="7" height="7"></rect>
      <rect x="14" y="3" width="7" height="7"></rect>
      <rect x="3" y="14" width="7" height="7"></rect>
      <path d="M14 14h3v3h-3zM19 14h2v2h-2zM19 19h2v2h-2zM14 19h3v2h-3z"></path>
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
  button.onclick = (event) => {
    event.stopPropagation();
    showQRCodeModal(item.content, theme);
  };
  return button;
}

hostWindow.CliporaxPlugins = hostWindow.CliporaxPlugins || {};
hostWindow.CliporaxPlugins[PLUGIN_ID] = {
  onActivate: () => {
    console.info("[QRCode] activated");
  },
  onDeactivate: () => {
    document.getElementById("cliporax-qrcode-modal")?.remove();
  },
  extensions: {
    QRCodeButton: {
      render: (props: ExtensionProps) => {
        const item = props.data?.item;
        if (!item || props.data?.position !== "action") return null;
        if (item.type !== "text" && item.type !== "file") return null;
        if (!item.content) return null;
        return createQRCodeButton(item, props.context?.theme || "dark");
      },
      shouldShow: (props: ExtensionProps) => {
        const item = props.data?.item;
        return Boolean(
          item &&
            (item.type === "text" || item.type === "file") &&
            (props.data?.position !== "action" || item.content),
        );
      },
      getMenuItems: (props: ExtensionProps) => [
        {
          id: "generate-qr-code",
          label: "Generate QR Code",
          icon: "qr-code",
          action: (api) => {
            const content = api.getItems()[0]?.content?.trim();
            if (content) showQRCodeModal(content, props.context?.theme || "dark");
          },
        },
      ],
    },
  },
};
