type Theme = "light" | "dark";
type ProviderId = "libretranslate" | "deepl";
type TranslateStatus = "idle" | "loading" | "success" | "error";

interface ClipboardItem {
  id: number;
  content: string;
  type: "text" | "image" | "file";
  is_pinned?: boolean;
}

interface ExtensionProps {
  data: {
    item?: ClipboardItem;
  };
  context: {
    theme: Theme;
    plugin: {
      id: string;
      name: string;
      version: string;
    };
  };
  config: Record<string, unknown>;
}

interface TranslateSettings {
  provider: ProviderId;
  endpoint: string;
  apiKey: string;
  sourceLanguage: string;
  targetLanguage: string;
  maxCharsPerRequest: number;
  preserveFormatting: boolean;
}

interface TranslateInput {
  text: string;
  source: string;
  target: string;
  apiKey?: string;
  endpoint?: string;
  preserveFormatting: boolean;
}

interface TranslateResult {
  text: string;
  detectedSource?: string;
  provider: string;
}

interface TranslateError {
  code:
    | "missing_config"
    | "network_error"
    | "rate_limited"
    | "quota_exceeded"
    | "unsupported_language"
    | "text_too_long"
    | "provider_error";
  message: string;
  provider: string;
  retryable: boolean;
}

interface RuntimePlugin {
  onActivate?: () => void;
  onDeactivate?: () => void;
  extensions?: Record<
    string,
    {
      render: (props: ExtensionProps) => HTMLElement | null;
      shouldShow?: (props: ExtensionProps) => boolean;
    }
  >;
}

interface Window {
  CliporaxPlugins?: Record<string, RuntimePlugin>;
}

const PLUGIN_ID = "com.cliporax.translate";
const SETTINGS_KEY = `${PLUGIN_ID}:settings`;

const languageOptions = [
  ["auto", "Auto detect"],
  ["zh", "Chinese"],
  ["en", "English"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["fr", "French"],
  ["de", "German"],
  ["es", "Spanish"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["ru", "Russian"],
];

const defaultSettings = (): TranslateSettings => ({
  provider: "libretranslate",
  endpoint: "http://localhost:5000",
  apiKey: "",
  sourceLanguage: "auto",
  targetLanguage:
    typeof navigator !== "undefined" &&
    navigator.language.toLowerCase().startsWith("zh")
      ? "en"
      : "zh",
  maxCharsPerRequest: 4000,
  preserveFormatting: true,
});

function isProviderId(value: unknown): value is ProviderId {
  return value === "libretranslate" || value === "deepl";
}

function loadSettings(config: Record<string, unknown> = {}): TranslateSettings {
  const fallback = { ...defaultSettings(), ...config };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return normalizeSettings(fallback);
    return normalizeSettings({ ...fallback, ...JSON.parse(raw) });
  } catch {
    return normalizeSettings(fallback);
  }
}

function normalizeSettings(value: Record<string, unknown>): TranslateSettings {
  const provider = isProviderId(value.provider) ? value.provider : "libretranslate";
  const endpoint =
    typeof value.endpoint === "string" && value.endpoint.trim()
      ? value.endpoint.trim()
      : provider === "deepl"
        ? "https://api-free.deepl.com/v2/translate"
        : "http://localhost:5000";
  const maxChars = Number(value.maxCharsPerRequest);

  return {
    provider,
    endpoint,
    apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
    sourceLanguage:
      typeof value.sourceLanguage === "string" && value.sourceLanguage
        ? value.sourceLanguage
        : "auto",
    targetLanguage:
      typeof value.targetLanguage === "string" && value.targetLanguage
        ? value.targetLanguage
        : defaultSettings().targetLanguage,
    maxCharsPerRequest:
      Number.isFinite(maxChars) && maxChars > 0
        ? Math.min(Math.floor(maxChars), 50000)
        : 4000,
    preserveFormatting: value.preserveFormatting !== false,
  };
}

function saveSettings(settings: TranslateSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function applyThemeStyles(root: HTMLElement, theme: Theme): void {
  const dark = theme === "dark";
  root.style.setProperty("--translate-bg", dark ? "#111827" : "#ffffff");
  root.style.setProperty("--translate-panel", dark ? "#1f2937" : "#f8fafc");
  root.style.setProperty("--translate-border", dark ? "#374151" : "#e5e7eb");
  root.style.setProperty("--translate-text", dark ? "#e5e7eb" : "#111827");
  root.style.setProperty("--translate-muted", dark ? "#9ca3af" : "#64748b");
  root.style.setProperty("--translate-accent", "#2563eb");
  root.style.setProperty("--translate-danger", "#dc2626");
}

function ensureStyles(): void {
  if (document.getElementById(`${PLUGIN_ID}:styles`)) return;
  const style = el("style");
  style.id = `${PLUGIN_ID}:styles`;
  style.textContent = `
.cliporax-translate-action{width:22px;height:22px;border:0;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:11px;font-weight:700;line-height:1;background:rgba(37,99,235,.14);color:#2563eb}
.cliporax-translate-action:hover{background:rgba(37,99,235,.24)}
.cliporax-translate-popover{position:fixed;z-index:2147483640;width:min(420px,calc(100vw - 24px));max-height:min(620px,calc(100vh - 24px));overflow:auto;border:1px solid var(--translate-border);border-radius:8px;background:var(--translate-bg);color:var(--translate-text);box-shadow:0 20px 50px rgba(15,23,42,.25);font:13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.cliporax-translate-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-bottom:1px solid var(--translate-border);font-weight:700}
.cliporax-translate-close{border:0;background:transparent;color:var(--translate-muted);font-size:18px;line-height:1;cursor:pointer}
.cliporax-translate-body{display:grid;gap:10px;padding:12px}
.cliporax-translate-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cliporax-translate-field{display:grid;gap:4px}
.cliporax-translate-field label{color:var(--translate-muted);font-size:11px;font-weight:650}
.cliporax-translate-field select,.cliporax-translate-field input{min-height:30px;border:1px solid var(--translate-border);border-radius:6px;background:var(--translate-panel);color:var(--translate-text);padding:4px 8px;font:inherit}
.cliporax-translate-text{max-height:120px;overflow:auto;border:1px solid var(--translate-border);border-radius:6px;background:var(--translate-panel);padding:8px;white-space:pre-wrap;overflow-wrap:anywhere}
.cliporax-translate-result{min-height:72px}
.cliporax-translate-muted{color:var(--translate-muted)}
.cliporax-translate-error{color:var(--translate-danger)}
.cliporax-translate-button{border:0;border-radius:6px;background:var(--translate-accent);color:white;padding:7px 10px;font-weight:700;cursor:pointer}
.cliporax-translate-button.secondary{background:var(--translate-panel);color:var(--translate-text);border:1px solid var(--translate-border)}
.cliporax-translate-button:disabled{opacity:.55;cursor:not-allowed}
.cliporax-translate-settings{border-top:1px solid var(--translate-border);padding-top:10px}
.cliporax-translate-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
@media (max-width:420px){.cliporax-translate-grid{grid-template-columns:1fr}}
`;
  document.head.appendChild(style);
}

function closeExistingPopover(): void {
  document.querySelectorAll(".cliporax-translate-popover").forEach((node) => {
    node.remove();
  });
}

function positionPopover(popover: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const margin = 12;
  const width = Math.min(420, window.innerWidth - margin * 2);
  const left = Math.min(
    Math.max(margin, rect.right - width),
    window.innerWidth - width - margin,
  );
  const top =
    rect.bottom + margin + 360 < window.innerHeight
      ? rect.bottom + 8
      : Math.max(margin, rect.top - 420);

  popover.style.width = `${width}px`;
  popover.style.left = `${left}px`;
  popover.style.top = `${Math.max(margin, top)}px`;
}

function makeProviderError(
  provider: string,
  code: TranslateError["code"],
  message: string,
  retryable = false,
): TranslateError {
  return { provider, code, message, retryable };
}

function mapHttpError(provider: string, status: number, body: string): TranslateError {
  const detail = body.trim() ? ` ${body.slice(0, 180)}` : "";
  if (status === 401 || status === 403) {
    return makeProviderError(provider, "missing_config", "API key or endpoint authorization failed.", false);
  }
  if (status === 429) {
    return makeProviderError(provider, "rate_limited", "Translation provider rate limit reached.", true);
  }
  if (status === 456) {
    return makeProviderError(provider, "quota_exceeded", "Translation provider quota exceeded.", false);
  }
  if (status === 400) {
    return makeProviderError(provider, "unsupported_language", `The provider rejected this language pair.${detail}`, false);
  }
  return makeProviderError(provider, "provider_error", `Provider returned HTTP ${status}.${detail}`, status >= 500);
}

function libreEndpoint(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  return base.endsWith("/translate") ? base : `${base}/translate`;
}

async function translateWithLibreTranslate(input: TranslateInput): Promise<TranslateResult> {
  const provider = "LibreTranslate";
  const endpoint = input.endpoint?.trim() || "http://localhost:5000";
  const payload: Record<string, unknown> = {
    q: input.text,
    source: input.source || "auto",
    target: input.target,
    format: input.preserveFormatting ? "text" : "text",
  };
  if (input.apiKey) payload.api_key = input.apiKey;

  let response: Response;
  try {
    response = await fetch(libreEndpoint(endpoint), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw makeProviderError(provider, "network_error", "Could not reach LibreTranslate. Check the endpoint and network connection.", true);
  }

  const body = await response.text();
  if (!response.ok) throw mapHttpError(provider, response.status, body);

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(body);
  } catch {
    throw makeProviderError(provider, "provider_error", "LibreTranslate returned an invalid response.", true);
  }

  const text = json.translatedText;
  if (typeof text !== "string") {
    throw makeProviderError(provider, "provider_error", "LibreTranslate response did not include translated text.", true);
  }

  const detectedSource =
    typeof json.detectedLanguage === "object" &&
    json.detectedLanguage !== null &&
    "language" in json.detectedLanguage &&
    typeof json.detectedLanguage.language === "string"
      ? json.detectedLanguage.language
      : undefined;

  return { text, detectedSource, provider };
}

function toDeepLTarget(language: string): string {
  if (language === "zh") return "ZH";
  if (language === "en") return "EN-US";
  return language.toUpperCase();
}

function toDeepLSource(language: string): string | null {
  if (!language || language === "auto") return null;
  if (language === "zh") return "ZH";
  return language.toUpperCase();
}

async function translateWithDeepL(input: TranslateInput): Promise<TranslateResult> {
  const provider = "DeepL";
  if (!input.apiKey?.trim()) {
    throw makeProviderError(provider, "missing_config", "DeepL requires an API key.", false);
  }

  const endpoint = input.endpoint?.trim() || "https://api-free.deepl.com/v2/translate";
  const params = new URLSearchParams();
  params.set("text", input.text);
  params.set("target_lang", toDeepLTarget(input.target));
  const source = toDeepLSource(input.source);
  if (source) params.set("source_lang", source);
  if (input.preserveFormatting) params.set("preserve_formatting", "1");

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${input.apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
  } catch {
    throw makeProviderError(provider, "network_error", "Could not reach DeepL. Check the endpoint and network connection.", true);
  }

  const body = await response.text();
  if (!response.ok) throw mapHttpError(provider, response.status, body);

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(body);
  } catch {
    throw makeProviderError(provider, "provider_error", "DeepL returned an invalid response.", true);
  }

  const translations = json.translations;
  if (!Array.isArray(translations) || typeof translations[0]?.text !== "string") {
    throw makeProviderError(provider, "provider_error", "DeepL response did not include translated text.", true);
  }

  return {
    text: translations[0].text,
    detectedSource:
      typeof translations[0].detected_source_language === "string"
        ? translations[0].detected_source_language
        : undefined,
    provider,
  };
}

async function translateText(
  settings: TranslateSettings,
  text: string,
): Promise<TranslateResult> {
  if (text.length > settings.maxCharsPerRequest) {
    throw makeProviderError(
      settings.provider,
      "text_too_long",
      `Text is ${text.length} characters; the current limit is ${settings.maxCharsPerRequest}.`,
      false,
    );
  }

  const input: TranslateInput = {
    text,
    source: settings.sourceLanguage,
    target: settings.targetLanguage,
    apiKey: settings.apiKey,
    endpoint: settings.endpoint,
    preserveFormatting: settings.preserveFormatting,
  };

  return settings.provider === "deepl"
    ? translateWithDeepL(input)
    : translateWithLibreTranslate(input);
}

function renderLanguageSelect(value: string, includeAuto: boolean): HTMLSelectElement {
  const select = el("select");
  for (const [code, label] of languageOptions) {
    if (!includeAuto && code === "auto") continue;
    const option = el("option");
    option.value = code;
    option.textContent = label;
    if (code === value) option.selected = true;
    select.appendChild(option);
  }
  return select;
}

function renderField(labelText: string, control: HTMLElement): HTMLElement {
  const field = el("div", "cliporax-translate-field");
  const label = el("label", undefined, labelText);
  field.append(label, control);
  return field;
}

function updateEndpointForProvider(settings: TranslateSettings): TranslateSettings {
  if (settings.provider === "deepl" && settings.endpoint.includes("localhost:5000")) {
    return { ...settings, endpoint: "https://api-free.deepl.com/v2/translate" };
  }
  if (settings.provider === "libretranslate" && settings.endpoint.includes("deepl.com")) {
    return { ...settings, endpoint: "http://localhost:5000" };
  }
  return settings;
}

function createPopover(anchor: HTMLElement, props: ExtensionProps): HTMLElement {
  ensureStyles();
  closeExistingPopover();

  let settings = loadSettings(props.config);
  let status: TranslateStatus = "idle";
  let currentResult: TranslateResult | null = null;
  let currentError: TranslateError | null = null;
  const item = props.data.item;
  const text = item?.content ?? "";

  const popover = el("section", "cliporax-translate-popover");
  applyThemeStyles(popover, props.context.theme);

  const header = el("div", "cliporax-translate-header");
  header.append(el("span", undefined, "Translate"));
  const close = el("button", "cliporax-translate-close", "x");
  close.type = "button";
  close.addEventListener("click", () => popover.remove());
  header.append(close);

  const body = el("div", "cliporax-translate-body");
  popover.append(header, body);

  function render(): void {
    body.replaceChildren();

    const privacy = el(
      "div",
      "cliporax-translate-muted",
      `Text is sent to ${settings.provider === "deepl" ? "DeepL" : "LibreTranslate"} only when you click Translate. Endpoint: ${settings.endpoint}`,
    );
    body.append(privacy);

    const original = el("div", "cliporax-translate-text", text || "No text content.");
    body.append(renderField(`Original (${text.length} chars)`, original));

    const controls = el("div", "cliporax-translate-grid");
    const sourceSelect = renderLanguageSelect(settings.sourceLanguage, true);
    sourceSelect.addEventListener("change", () => {
      settings = { ...settings, sourceLanguage: sourceSelect.value };
      saveSettings(settings);
    });
    const targetSelect = renderLanguageSelect(settings.targetLanguage, false);
    targetSelect.addEventListener("change", () => {
      settings = { ...settings, targetLanguage: targetSelect.value };
      saveSettings(settings);
    });
    controls.append(
      renderField("Source", sourceSelect),
      renderField("Target", targetSelect),
    );
    body.append(controls);

    const resultText =
      status === "loading"
        ? "Translating..."
        : status === "error"
          ? currentError?.message || "Translation failed."
          : currentResult?.text || "Result will appear here.";
    const result = el(
      "div",
      `cliporax-translate-text cliporax-translate-result ${status === "error" ? "cliporax-translate-error" : ""}`,
      resultText,
    );
    body.append(renderField("Translated", result));

    if (currentResult) {
      const meta = el(
        "div",
        "cliporax-translate-muted",
        `Provider: ${currentResult.provider}${currentResult.detectedSource ? ` · Detected: ${currentResult.detectedSource}` : ""}`,
      );
      body.append(meta);
    }

    const actions = el("div", "cliporax-translate-row");
    const translate = el("button", "cliporax-translate-button", status === "loading" ? "Translating" : "Translate");
    translate.type = "button";
    translate.disabled = status === "loading" || !text;
    translate.addEventListener("click", async () => {
      status = "loading";
      currentError = null;
      render();
      try {
        currentResult = await translateText(settings, text);
        status = "success";
      } catch (error) {
        currentResult = null;
        currentError = normalizeError(error, settings.provider);
        status = "error";
      }
      render();
    });

    const copy = el("button", "cliporax-translate-button secondary", "Copy result");
    copy.type = "button";
    copy.disabled = !currentResult?.text;
    copy.addEventListener("click", async () => {
      if (!currentResult?.text) return;
      await navigator.clipboard.writeText(currentResult.text);
      copy.textContent = "Copied";
      window.setTimeout(() => {
        copy.textContent = "Copy result";
      }, 1200);
    });

    const swap = el("button", "cliporax-translate-button secondary", "Swap zh/en");
    swap.type = "button";
    swap.addEventListener("click", () => {
      const nextTarget = settings.targetLanguage === "zh" ? "en" : "zh";
      settings = { ...settings, targetLanguage: nextTarget };
      saveSettings(settings);
      render();
    });

    actions.append(translate, copy, swap);
    body.append(actions);

    body.append(renderSettingsForm());
  }

  function renderSettingsForm(): HTMLElement {
    const panel = el("details", "cliporax-translate-settings");
    const summary = el("summary", undefined, "Provider settings");
    panel.append(summary);

    const form = el("div", "cliporax-translate-grid");
    form.style.marginTop = "8px";

    const provider = el("select");
    for (const [value, label] of [
      ["libretranslate", "LibreTranslate"],
      ["deepl", "DeepL"],
    ]) {
      const option = el("option");
      option.value = value;
      option.textContent = label;
      if (settings.provider === value) option.selected = true;
      provider.appendChild(option);
    }
    provider.addEventListener("change", () => {
      settings = updateEndpointForProvider({
        ...settings,
        provider: provider.value as ProviderId,
      });
      saveSettings(settings);
      render();
    });

    const endpoint = el("input");
    endpoint.value = settings.endpoint;
    endpoint.placeholder = "Provider endpoint";
    endpoint.addEventListener("change", () => {
      settings = { ...settings, endpoint: endpoint.value.trim() };
      saveSettings(settings);
      render();
    });

    const apiKey = el("input");
    apiKey.type = "password";
    apiKey.value = settings.apiKey;
    apiKey.placeholder = settings.provider === "deepl" ? "Required for DeepL" : "Optional";
    apiKey.addEventListener("change", () => {
      settings = { ...settings, apiKey: apiKey.value };
      saveSettings(settings);
    });

    const maxChars = el("input");
    maxChars.type = "number";
    maxChars.min = "1";
    maxChars.max = "50000";
    maxChars.value = String(settings.maxCharsPerRequest);
    maxChars.addEventListener("change", () => {
      settings = normalizeSettings({
        ...settings,
        maxCharsPerRequest: Number(maxChars.value),
      });
      saveSettings(settings);
      render();
    });

    form.append(
      renderField("Provider", provider),
      renderField("Endpoint", endpoint),
      renderField("API key", apiKey),
      renderField("Max chars", maxChars),
    );

    const preserve = el("label", "cliporax-translate-row");
    const preserveCheckbox = el("input");
    preserveCheckbox.type = "checkbox";
    preserveCheckbox.checked = settings.preserveFormatting;
    preserveCheckbox.addEventListener("change", () => {
      settings = { ...settings, preserveFormatting: preserveCheckbox.checked };
      saveSettings(settings);
    });
    preserve.append(preserveCheckbox, document.createTextNode(" Preserve formatting where supported"));

    panel.append(form, preserve);
    return panel;
  }

  render();
  document.body.appendChild(popover);
  positionPopover(popover, anchor);

  const onDocumentClick = (event: MouseEvent) => {
    if (
      event.target instanceof Node &&
      !popover.contains(event.target) &&
      !anchor.contains(event.target)
    ) {
      popover.remove();
      document.removeEventListener("mousedown", onDocumentClick);
    }
  };
  window.setTimeout(() => document.addEventListener("mousedown", onDocumentClick), 0);

  return popover;
}

function normalizeError(error: unknown, provider: string): TranslateError {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error &&
    "provider" in error &&
    "retryable" in error
  ) {
    return error as TranslateError;
  }
  return makeProviderError(
    provider,
    "provider_error",
    error instanceof Error ? error.message : "Translation failed.",
    true,
  );
}

function renderTranslateButton(props: ExtensionProps): HTMLElement | null {
  const item = props.data.item;
  if (!item || item.type !== "text" || !item.content.trim()) return null;

  ensureStyles();
  const button = el("button", "cliporax-translate-action", isChineseLocale() ? "译" : "Tr");
  button.type = "button";
  button.title = "Translate";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    createPopover(button, props);
  });
  return button;
}

function renderSettings(props: ExtensionProps): HTMLElement {
  ensureStyles();
  const wrapper = el("div", "cliporax-translate-popover");
  wrapper.style.position = "static";
  wrapper.style.width = "100%";
  wrapper.style.maxHeight = "none";
  wrapper.style.boxShadow = "none";
  applyThemeStyles(wrapper, props.context.theme);
  wrapper.appendChild(el("div", "cliporax-translate-header", "Translate"));
  const body = el("div", "cliporax-translate-body");
  body.appendChild(
    el(
      "div",
      "cliporax-translate-muted",
      "Configure Translate from any text card using the Translate action.",
    ),
  );
  wrapper.appendChild(body);
  return wrapper;
}

function isChineseLocale(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.language.toLowerCase().startsWith("zh")
  );
}

window.CliporaxPlugins = window.CliporaxPlugins || {};
window.CliporaxPlugins[PLUGIN_ID] = {
  onActivate: () => {
    ensureStyles();
  },
  onDeactivate: () => {
    closeExistingPopover();
  },
  extensions: {
    TranslateButton: {
      shouldShow: (props) => props.data.item?.type === "text",
      render: renderTranslateButton,
    },
    TranslateSettings: {
      render: renderSettings,
    },
  },
};
