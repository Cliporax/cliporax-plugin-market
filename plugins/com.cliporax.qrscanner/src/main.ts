import jsQR from "jsqr";

type Theme = "dark" | "light" | "system";
type ToastKind = "info" | "success" | "warning" | "error";

interface PluginContext {
  theme?: Theme;
  [key: string]: unknown;
}

interface ExtensionProps {
  data?: {
    position?: string;
  };
  context?: PluginContext;
}

interface RuntimePlugin {
  onActivate?: (context: PluginContext) => void;
  onDeactivate?: () => void;
  extensions?: Record<
    string,
    {
      render: (props: ExtensionProps) => HTMLElement | null;
      shouldShow?: (props: ExtensionProps) => boolean;
    }
  >;
}

interface HostWindow extends Window {
  __TAURI_INTERNALS__?: {
    invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  };
  CliporaxPlugins?: Record<string, RuntimePlugin>;
}

const PLUGIN_ID = "com.cliporax.qrscanner";
const SENSITIVE_PATTERN = /(password|code|otp|验证码|secret|key)/i;
const hostWindow = window as HostWindow;
let activeTheme = "dark";
let shortcutListener: ((event: Event) => void) | null = null;

function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const api = hostWindow.__TAURI_INTERNALS__;
  if (!api) return Promise.reject(new Error("Cliporax host API is unavailable."));
  return api.invoke<T>(command, args);
}

function showToast(message: string, theme: string, kind: ToastKind = "info"): void {
  document.getElementById("cliporax-qrscanner-toast")?.remove();
  const colors = {
    info: "#2563eb",
    success: "#059669",
    warning: "#d97706",
    error: "#dc2626",
  };
  const toast = document.createElement("div");
  toast.id = "cliporax-qrscanner-toast";
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    right: 16px;
    top: 16px;
    z-index: 10001;
    max-width: min(420px, calc(100vw - 32px));
    padding: 12px 14px;
    border-radius: 8px;
    border-left: 4px solid ${colors[kind]};
    background: ${theme === "dark" ? "#111827" : "#ffffff"};
    color: ${theme === "dark" ? "#f3f4f6" : "#111827"};
    box-shadow: 0 16px 40px rgba(0,0,0,0.28);
    font-size: 13px;
    line-height: 1.45;
    word-break: break-word;
  `;
  document.body.appendChild(toast);
  window.setTimeout(() => toast.remove(), kind === "error" ? 7000 : 4200);
}

function imageDataUrlToCanvas(dataUrl: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        reject(new Error("Cannot create scanner canvas."));
        return;
      }
      context.drawImage(image, 0, 0);
      resolve(canvas);
    };
    image.onerror = () => reject(new Error("Failed to load captured image."));
    image.src = dataUrl;
  });
}

function cloneCanvas(source: HTMLCanvasElement, scale = 1, padding = 0): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale + padding * 2));
  canvas.height = Math.max(1, Math.round(source.height * scale + padding * 2));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return canvas;
  context.imageSmoothingEnabled = false;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(
    source,
    padding,
    padding,
    Math.round(source.width * scale),
    Math.round(source.height * scale),
  );
  return canvas;
}

function thresholdCanvas(source: HTMLCanvasElement, threshold: number): HTMLCanvasElement {
  const canvas = cloneCanvas(source);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return canvas;
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let index = 0; index < data.length; index += 4) {
    const luminance = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
    const value = luminance < threshold ? 0 : 255;
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
    data[index + 3] = 255;
  }
  context.putImageData(imageData, 0, 0);
  return canvas;
}

async function scanWithBarcodeDetector(canvas: HTMLCanvasElement): Promise<string | null> {
  const detectorCtor = (
    window as unknown as {
      BarcodeDetector?: new (options?: { formats?: string[] }) => {
        detect: (source: HTMLCanvasElement) => Promise<Array<{ rawValue?: string }>>;
      };
    }
  ).BarcodeDetector;
  if (!detectorCtor) return null;

  try {
    const detector = new detectorCtor({ formats: ["qr_code"] });
    const codes = await detector.detect(canvas);
    return codes.find((code) => code.rawValue)?.rawValue || null;
  } catch (error) {
    console.warn("[QRScanner] BarcodeDetector failed:", error);
    return null;
  }
}

async function scanCanvas(canvas: HTMLCanvasElement): Promise<string | null> {
  const native = await scanWithBarcodeDetector(canvas);
  if (native) return native;

  const variants = [
    canvas,
    cloneCanvas(canvas, 1, 24),
    cloneCanvas(canvas, 2, 48),
    cloneCanvas(canvas, 3, 72),
    thresholdCanvas(canvas, 96),
    thresholdCanvas(canvas, 128),
    thresholdCanvas(canvas, 160),
  ];

  for (const variant of variants) {
    const context = variant.getContext("2d", { willReadFrequently: true });
    if (!context) continue;
    const imageData = context.getImageData(0, 0, variant.width, variant.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: "attemptBoth",
    });
    if (code?.data) return code.data;
  }

  return null;
}

async function copyTextToClipboard(text: string): Promise<void> {
  await invoke("clipboard_write_text_and_create", {
    content: text,
    metadata: JSON.stringify({
      source: "QR Scanner",
      source_app: "Cliporax",
      window_title: "QR Code Scanner",
      timestamp: new Date().toISOString(),
    }),
    tags: JSON.stringify(["qrscanner"]),
    isSensitive: SENSITIVE_PATTERN.test(text) ? 1 : 0,
  });
}

async function scanSelectedRegion(theme: string): Promise<void> {
  showToast("Drag to select the QR code region...", theme, "info");
  try {
    const dataUrl = await invoke<string>("qrscanner_capture_region");
    const canvas = await imageDataUrlToCanvas(dataUrl);
    const result = await scanCanvas(canvas);
    if (!result) {
      showToast("No QR code found in the selected region.", theme, "warning");
      return;
    }
    await copyTextToClipboard(result);
    showToast(`QR code copied: ${result}`, theme, "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[QRScanner] Scan failed:", error);
    showToast(`QR scan failed: ${message}`, theme, "error");
  }
}

function createScannerButton(theme: string): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.title = "Select a screen region and scan QR code";
  button.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M3 7V5a2 2 0 0 1 2-2h2"></path>
      <path d="M17 3h2a2 2 0 0 1 2 2v2"></path>
      <path d="M21 17v2a2 2 0 0 1-2 2h-2"></path>
      <path d="M7 21H5a2 2 0 0 1-2-2v-2"></path>
      <rect x="7" y="7" width="10" height="10" rx="1"></rect>
    </svg>
    <span>Scan QR Region</span>
  `;
  button.style.cssText = `
    width: 100%;
    min-height: 40px;
    border: 0;
    border-radius: 8px;
    padding: 10px 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    cursor: pointer;
    background: ${theme === "dark" ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.05)"};
    color: ${theme === "dark" ? "#e2e8f0" : "#374151"};
    font-size: 13px;
    font-weight: 600;
  `;
  button.onclick = (event) => {
    event.stopPropagation();
    scanSelectedRegion(theme);
  };
  return button;
}

hostWindow.CliporaxPlugins = hostWindow.CliporaxPlugins || {};
hostWindow.CliporaxPlugins[PLUGIN_ID] = {
  onActivate: (context: PluginContext) => {
    activeTheme = context.theme || "dark";
    if (!shortcutListener) {
      shortcutListener = (event: Event) => {
        const detail = (event as CustomEvent).detail;
        if (detail?.pluginId === PLUGIN_ID) {
          scanSelectedRegion(activeTheme);
        }
      };
      window.addEventListener("cliporax:plugin-shortcut", shortcutListener);
    }
  },
  onDeactivate: () => {
    if (shortcutListener) {
      window.removeEventListener("cliporax:plugin-shortcut", shortcutListener);
      shortcutListener = null;
    }
    document.getElementById("cliporax-qrscanner-toast")?.remove();
  },
  extensions: {
    QRScannerPanel: {
      render: (props: ExtensionProps) => {
        if (props.data?.position !== "sidebar") return null;
        activeTheme = props.context?.theme || "dark";
        return createScannerButton(activeTheme);
      },
      shouldShow: (props: ExtensionProps) => props.data?.position === "sidebar",
    },
  },
};
