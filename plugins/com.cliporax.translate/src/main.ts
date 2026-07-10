type Theme = "light" | "dark";
type ProviderId =
  | "mymemory"
  | "youdao_public"
  | "microsoft_edge"
  | "google_public"
  | "libretranslate"
  | "deepl";
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
const MYMEMORY_ENDPOINT = "https://api.mymemory.translated.net/get";
const YOUDAO_PUBLIC_ENDPOINT = "https://aidemo.youdao.com/trans";
const MICROSOFT_EDGE_ENDPOINT = "https://api-edge.cognitive.microsofttranslator.com/translate";
const GOOGLE_PUBLIC_ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const LIBRETRANSLATE_ENDPOINT = "https://libretranslate.com/translate";
const DEEPL_ENDPOINT = "https://api-free.deepl.com/v2/translate";

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
  provider: "mymemory",
  endpoint: MYMEMORY_ENDPOINT,
  apiKey: "",
  sourceLanguage: "auto",
  targetLanguage:
    typeof navigator !== "undefined" &&
    navigator.language.toLowerCase().startsWith("zh")
      ? "en"
      : "zh",
  maxCharsPerRequest: 500,
  preserveFormatting: true,
});

function isProviderId(value: unknown): value is ProviderId {
  return (
    value === "mymemory" ||
    value === "youdao_public" ||
    value === "microsoft_edge" ||
    value === "google_public" ||
    value === "libretranslate" ||
    value === "deepl"
  );
}

function loadSettings(config: Record<string, unknown> = {}): TranslateSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const localSettings =
      raw && raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return normalizeSettings({ ...defaultSettings(), ...localSettings, ...config });
  } catch {
    return normalizeSettings({ ...defaultSettings(), ...config });
  }
}

function normalizeSettings(value: Record<string, unknown>): TranslateSettings {
  const rawProvider = isProviderId(value.provider) ? value.provider : "mymemory";
  const rawEndpoint = typeof value.endpoint === "string" ? value.endpoint.trim() : "";
  const provider =
    rawProvider === "libretranslate" && rawEndpoint.includes("localhost:5000")
      ? "mymemory"
      : rawProvider;
  const endpoint = normalizeEndpoint(
    provider,
    rawEndpoint,
  );
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
        : provider === "mymemory"
          ? 500
          : 4000,
    preserveFormatting: value.preserveFormatting !== false,
  };
}

function normalizeEndpoint(provider: ProviderId, endpoint: string): string {
  if (provider === "youdao_public") {
    if (!endpoint || isKnownProviderEndpoint(endpoint, ["youdao"])) {
      return YOUDAO_PUBLIC_ENDPOINT;
    }
    return endpoint;
  }
  if (provider === "microsoft_edge") {
    if (!endpoint || isKnownProviderEndpoint(endpoint, ["microsoft"])) {
      return MICROSOFT_EDGE_ENDPOINT;
    }
    return endpoint;
  }
  if (provider === "google_public") {
    if (!endpoint || isKnownProviderEndpoint(endpoint, ["google"])) {
      return GOOGLE_PUBLIC_ENDPOINT;
    }
    return endpoint;
  }
  if (provider === "mymemory") {
    if (!endpoint || isKnownProviderEndpoint(endpoint, ["mymemory"])) {
      return MYMEMORY_ENDPOINT;
    }
    return endpoint;
  }
  if (provider === "deepl") {
    if (!endpoint || isKnownProviderEndpoint(endpoint, ["deepl"])) {
      return DEEPL_ENDPOINT;
    }
    return endpoint;
  }
  if (!endpoint || isKnownProviderEndpoint(endpoint, ["libretranslate"])) {
    return LIBRETRANSLATE_ENDPOINT;
  }
  return endpoint;
}

function isKnownProviderEndpoint(endpoint: string, keep: string[]): boolean {
  const checks: Record<string, string[]> = {
    mymemory: ["mymemory.translated.net"],
    youdao: ["aidemo.youdao.com"],
    microsoft: ["api-edge.cognitive.microsofttranslator.com"],
    google: ["translate.googleapis.com"],
    libretranslate: ["localhost:5000", "libretranslate.com"],
    deepl: ["deepl.com"],
  };
  return Object.entries(checks).some(([provider, fragments]) => {
    if (keep.includes(provider)) return false;
    return fragments.some((fragment) => endpoint.includes(fragment));
  });
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
.cliporax-translate-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-bottom:1px solid var(--translate-border);font-weight:700;cursor:grab;user-select:none;touch-action:none}
.cliporax-translate-header.dragging{cursor:grabbing}
.cliporax-translate-close{border:0;background:transparent;color:var(--translate-muted);font-size:18px;line-height:1;cursor:pointer}
.cliporax-translate-body{display:grid;gap:10px;padding:12px}
.cliporax-translate-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cliporax-translate-field{display:grid;gap:4px}
.cliporax-translate-field label{color:var(--translate-muted);font-size:11px;font-weight:650}
.cliporax-translate-field input,.cliporax-translate-combobox-trigger{min-height:30px;border:1px solid var(--translate-border);border-radius:6px;background:var(--translate-panel);color:var(--translate-text);padding:4px 8px;font:inherit}
.cliporax-translate-combobox{position:relative;min-width:0}
.cliporax-translate-combobox-trigger{width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;text-align:left}
.cliporax-translate-combobox-menu{position:absolute;z-index:2147483641;left:0;right:0;top:calc(100% + 4px);max-height:220px;overflow:auto;border:1px solid var(--translate-border);border-radius:6px;background:var(--translate-bg);box-shadow:0 14px 34px rgba(15,23,42,.26);padding:4px}
.cliporax-translate-combobox-option{width:100%;min-height:30px;border:0;border-radius:5px;background:transparent;color:var(--translate-text);padding:6px 8px;text-align:left;cursor:pointer;font:inherit}
.cliporax-translate-combobox-option:hover,.cliporax-translate-combobox-option[aria-selected="true"]{background:var(--translate-panel)}
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

function myMemoryEndpoint(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  return base.endsWith("/get") ? base : `${base}/get`;
}

function googleEndpoint(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  return base.endsWith("/single") ? base : `${base}/single`;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function toMyMemoryLanguage(language: string): string {
  if (language === "zh") return "zh-CN";
  return language;
}

function inferSourceLanguage(text: string, target: string): string {
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh-CN";
  if (/[\u0400-\u04ff]/.test(text)) return "ru";
  return target === "en" ? "zh-CN" : "en";
}

async function translateWithMyMemory(input: TranslateInput): Promise<TranslateResult> {
  const provider = "MyMemory";
  const byteLength = utf8ByteLength(input.text);
  if (byteLength > 500) {
    throw makeProviderError(
      provider,
      "text_too_long",
      `MyMemory free requests are limited to 500 UTF-8 bytes; this text is ${byteLength} bytes.`,
      false,
    );
  }

  const endpoint = input.endpoint?.trim() || MYMEMORY_ENDPOINT;
  const target = toMyMemoryLanguage(input.target);
  const source =
    input.source && input.source !== "auto"
      ? toMyMemoryLanguage(input.source)
      : inferSourceLanguage(input.text, target);
  const url = new URL(myMemoryEndpoint(endpoint));
  url.searchParams.set("q", input.text);
  url.searchParams.set("langpair", `${source}|${target}`);
  url.searchParams.set("mt", "1");
  if (input.apiKey) url.searchParams.set("key", input.apiKey);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch {
    throw makeProviderError(provider, "network_error", "Could not reach MyMemory. Check the network connection.", true);
  }

  const body = await response.text();
  if (!response.ok) throw mapHttpError(provider, response.status, body);

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(body);
  } catch {
    throw makeProviderError(provider, "provider_error", "MyMemory returned an invalid response.", true);
  }

  if (typeof json.responseStatus === "number" && json.responseStatus >= 400) {
    const detail =
      typeof json.responseDetails === "string" && json.responseDetails.trim()
        ? json.responseDetails
        : `MyMemory returned status ${json.responseStatus}.`;
    throw makeProviderError(provider, json.responseStatus === 429 ? "rate_limited" : "provider_error", detail, json.responseStatus >= 500);
  }

  const responseData = json.responseData;
  const translated =
    responseData && typeof responseData === "object"
      ? (responseData as Record<string, unknown>).translatedText
      : undefined;
  const text =
    typeof translated === "string"
      ? translated
      : undefined;

  if (!text) {
    const detail =
      typeof json.responseDetails === "string" && json.responseDetails.trim()
        ? ` ${json.responseDetails}`
        : "";
    throw makeProviderError(provider, "provider_error", `MyMemory response did not include translated text.${detail}`, true);
  }

  return { text, detectedSource: source, provider };
}

async function translateWithLibreTranslate(input: TranslateInput): Promise<TranslateResult> {
  const provider = "LibreTranslate";
  const endpoint = input.endpoint?.trim() || LIBRETRANSLATE_ENDPOINT;
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

function toYoudaoLanguage(language: string): string {
  if (language === "auto") return "Auto";
  if (language === "zh") return "zh-CHS";
  return language;
}

async function translateWithYoudaoPublic(input: TranslateInput): Promise<TranslateResult> {
  const provider = "Youdao public";
  const endpoint = input.endpoint?.trim() || YOUDAO_PUBLIC_ENDPOINT;
  const params = new URLSearchParams();
  params.set("q", input.text);
  params.set("from", toYoudaoLanguage(input.source));
  params.set("to", toYoudaoLanguage(input.target));

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: params.toString(),
    });
  } catch {
    throw makeProviderError(provider, "network_error", "Could not reach the Youdao public endpoint. It may be blocked by network or CORS policy.", true);
  }

  const body = await response.text();
  if (!response.ok) throw mapHttpError(provider, response.status, body);

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(body);
  } catch {
    throw makeProviderError(provider, "provider_error", "Youdao returned an invalid response.", true);
  }

  const translation = json.translation;
  const text =
    Array.isArray(translation) && typeof translation[0] === "string"
      ? translation.join("\n")
      : typeof json.translation === "string"
        ? json.translation
        : undefined;
  if (!text) {
    const errorCode = typeof json.errorCode === "string" ? ` Error code: ${json.errorCode}.` : "";
    throw makeProviderError(provider, "provider_error", `Youdao response did not include translated text.${errorCode}`, true);
  }

  return { text, detectedSource: input.source === "auto" ? undefined : input.source, provider };
}

function toMicrosoftLanguage(language: string): string {
  if (language === "zh") return "zh-Hans";
  return language;
}

async function translateWithMicrosoftEdge(input: TranslateInput): Promise<TranslateResult> {
  const provider = "Microsoft Edge";
  const endpoint = input.endpoint?.trim() || MICROSOFT_EDGE_ENDPOINT;
  const url = new URL(endpoint);
  url.searchParams.set("api-version", "3.0");
  url.searchParams.set("to", toMicrosoftLanguage(input.target));
  if (input.source && input.source !== "auto") {
    url.searchParams.set("from", toMicrosoftLanguage(input.source));
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify([{ Text: input.text }]),
    });
  } catch {
    throw makeProviderError(provider, "network_error", "Could not reach the Microsoft Edge translation endpoint. It may be blocked by network or CORS policy.", true);
  }

  const body = await response.text();
  if (!response.ok) throw mapHttpError(provider, response.status, body);

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw makeProviderError(provider, "provider_error", "Microsoft Edge returned an invalid response.", true);
  }

  if (!Array.isArray(json)) {
    throw makeProviderError(provider, "provider_error", "Microsoft Edge response did not include translated text.", true);
  }

  const first = json[0] as Record<string, unknown> | undefined;
  const translations = first?.translations;
  const translated =
    Array.isArray(translations) && translations[0] && typeof translations[0] === "object"
      ? (translations[0] as Record<string, unknown>).text
      : undefined;
  const detected =
    first?.detectedLanguage && typeof first.detectedLanguage === "object"
      ? (first.detectedLanguage as Record<string, unknown>).language
      : undefined;

  if (typeof translated !== "string") {
    throw makeProviderError(provider, "provider_error", "Microsoft Edge response did not include translated text.", true);
  }

  return {
    text: translated,
    detectedSource: typeof detected === "string" ? detected : undefined,
    provider,
  };
}

async function translateWithGooglePublic(input: TranslateInput): Promise<TranslateResult> {
  const provider = "Google public";
  const endpoint = input.endpoint?.trim() || GOOGLE_PUBLIC_ENDPOINT;
  const url = new URL(googleEndpoint(endpoint));
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", input.source || "auto");
  url.searchParams.set("tl", input.target);
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", input.text);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
  } catch {
    throw makeProviderError(provider, "network_error", "Could not reach the Google public endpoint. It may be blocked by network or CORS policy.", true);
  }

  const body = await response.text();
  if (!response.ok) throw mapHttpError(provider, response.status, body);

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw makeProviderError(provider, "provider_error", "Google returned an invalid response.", true);
  }

  if (!Array.isArray(json) || !Array.isArray(json[0])) {
    throw makeProviderError(provider, "provider_error", "Google response did not include translated text.", true);
  }

  const text = json[0]
    .map((part: unknown) => Array.isArray(part) && typeof part[0] === "string" ? part[0] : "")
    .join("");
  const detectedSource = typeof json[2] === "string" ? json[2] : undefined;
  if (!text) {
    throw makeProviderError(provider, "provider_error", "Google response did not include translated text.", true);
  }

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

  const endpoint = input.endpoint?.trim() || DEEPL_ENDPOINT;
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

  if (settings.provider === "google_public") return translateWithGooglePublic(input);
  if (settings.provider === "microsoft_edge") return translateWithMicrosoftEdge(input);
  if (settings.provider === "youdao_public") return translateWithYoudaoPublic(input);
  if (settings.provider === "deepl") return translateWithDeepL(input);
  if (settings.provider === "libretranslate") return translateWithLibreTranslate(input);
  return translateWithMyMemory(input);
}

type ComboboxElement = HTMLDivElement & { value: string };

function renderCombobox(
  value: string,
  options: Array<[string, string]>,
  ariaLabel: string,
): ComboboxElement {
  const root = el("div", "cliporax-translate-combobox") as ComboboxElement;
  root.value = value;

  const trigger = el("button", "cliporax-translate-combobox-trigger");
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", ariaLabel);
  const label = el("span");
  const chevron = el("span", undefined, "v");
  trigger.append(label, chevron);

  const menu = el("div", "cliporax-translate-combobox-menu");
  menu.setAttribute("role", "listbox");
  menu.hidden = true;

  const syncLabel = () => {
    label.textContent =
      options.find(([code]) => code === root.value)?.[1] ??
      options[0]?.[1] ??
      "";
  };
  const close = () => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };
  const open = () => {
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
  };

  for (const [code, optionLabel] of options) {
    const option = el("button", "cliporax-translate-combobox-option", optionLabel);
    option.type = "button";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", code === value ? "true" : "false");
    option.onclick = () => {
      root.value = code;
      for (const child of Array.from(menu.children)) {
        child.setAttribute(
          "aria-selected",
          child === option ? "true" : "false",
        );
      }
      syncLabel();
      close();
      root.dispatchEvent(new Event("change"));
    };
    menu.append(option);
  }

  trigger.onclick = () => {
    if (menu.hidden) open();
    else close();
  };
  trigger.onkeydown = (event) => {
    if (event.key === "Escape") close();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      open();
      (menu.querySelector("button") as HTMLButtonElement | null)?.focus();
    }
  };
  root.addEventListener("focusout", (event) => {
    if (event.relatedTarget instanceof Node && root.contains(event.relatedTarget)) {
      return;
    }
    close();
  });

  syncLabel();
  root.append(trigger, menu);
  return root;
}

function renderLanguageSelect(value: string, includeAuto: boolean): ComboboxElement {
  return renderCombobox(
    value,
    languageOptions.filter(([code]) => includeAuto || code !== "auto"),
    includeAuto ? "Source language" : "Target language",
  );
}

function renderProviderSelect(value: ProviderId): ComboboxElement {
  const options: Array<[ProviderId, string]> = [
    ["mymemory", "MyMemory free"],
    ["youdao_public", "Youdao public"],
    ["microsoft_edge", "Microsoft Edge public"],
    ["google_public", "Google public"],
    ["libretranslate", "LibreTranslate"],
    ["deepl", "DeepL API Free"],
  ];
  return renderCombobox(value, options, "Translation provider");
}

function renderField(labelText: string, control: HTMLElement): HTMLElement {
  const field = el("div", "cliporax-translate-field");
  const label = el("label", undefined, labelText);
  field.append(label, control);
  return field;
}

function updateEndpointForProvider(settings: TranslateSettings): TranslateSettings {
  const providerLimit =
    settings.provider === "mymemory" && settings.maxCharsPerRequest > 500
      ? 500
      : settings.maxCharsPerRequest;
  return {
    ...settings,
    endpoint: normalizeEndpoint(settings.provider, settings.endpoint),
    maxCharsPerRequest: providerLimit,
  };
}

function providerLabel(provider: ProviderId): string {
  if (provider === "deepl") return "DeepL";
  if (provider === "libretranslate") return "LibreTranslate";
  if (provider === "google_public") return "Google public";
  if (provider === "microsoft_edge") return "Microsoft Edge public";
  if (provider === "youdao_public") return "Youdao public";
  return "MyMemory";
}

function providerNote(provider: ProviderId): string {
  if (provider === "deepl") return "DeepL API Free requires your own API key.";
  if (provider === "libretranslate") return "LibreTranslate availability depends on the configured public or self-hosted endpoint.";
  if (provider === "google_public") return "Google public uses an undocumented web endpoint and may be rate limited or blocked.";
  if (provider === "microsoft_edge") return "Microsoft Edge public uses an unofficial free endpoint and may change or reject requests.";
  if (provider === "youdao_public") return "Youdao public uses a demo endpoint that works best for short text and may change.";
  return "MyMemory public API works without a key for short text and has strict free limits.";
}

function makeDraggable(popover: HTMLElement, handle: HTMLElement): void {
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;
  let pointerId = 0;

  const clampPosition = (left: number, top: number) => {
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - popover.offsetWidth - margin);
    const maxTop = Math.max(margin, window.innerHeight - popover.offsetHeight - margin);
    popover.style.left = `${Math.min(Math.max(margin, left), maxLeft)}px`;
    popover.style.top = `${Math.min(Math.max(margin, top), maxTop)}px`;
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.target instanceof HTMLElement && event.target.closest("button,input,.cliporax-translate-combobox,textarea,a")) return;
    const rect = popover.getBoundingClientRect();
    dragging = true;
    pointerId = event.pointerId;
    offsetX = event.clientX - rect.left;
    offsetY = event.clientY - rect.top;
    handle.classList.add("dragging");
    handle.setPointerCapture(event.pointerId);
  });

  handle.addEventListener("pointermove", (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    event.preventDefault();
    clampPosition(event.clientX - offsetX, event.clientY - offsetY);
  });

  const stopDragging = (event: PointerEvent) => {
    if (!dragging || event.pointerId !== pointerId) return;
    dragging = false;
    handle.classList.remove("dragging");
    if (handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
  };
  handle.addEventListener("pointerup", stopDragging);
  handle.addEventListener("pointercancel", stopDragging);
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
  header.title = "Drag to move";
  header.append(el("span", undefined, "Translate"));
  const close = el("button", "cliporax-translate-close", "x");
  close.type = "button";
  close.addEventListener("click", () => popover.remove());
  header.append(close);

  const body = el("div", "cliporax-translate-body");
  popover.append(header, body);
  makeDraggable(popover, header);

  async function runTranslation(): Promise<void> {
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
  }

  function render(): void {
    body.replaceChildren();

    const privacy = el(
      "div",
      "cliporax-translate-muted",
      `Text is sent to ${providerLabel(settings.provider)} only when you use Translate from a text card. Endpoint: ${settings.endpoint}`,
    );
    body.append(privacy);

    const providerSelect = renderProviderSelect(settings.provider);
    providerSelect.addEventListener("change", () => {
      settings = updateEndpointForProvider({
        ...settings,
        provider: providerSelect.value as ProviderId,
      });
      saveSettings(settings);
      currentError = null;
      currentResult = null;
      status = "idle";
      render();
    });
    body.append(renderField("Provider", providerSelect));
    body.append(el("div", "cliporax-translate-muted", providerNote(settings.provider)));

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
    translate.addEventListener("click", () => {
      void runTranslation();
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
  }

  render();
  document.body.appendChild(popover);
  positionPopover(popover, anchor);
  if (text) {
    void runTranslation();
  }

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
