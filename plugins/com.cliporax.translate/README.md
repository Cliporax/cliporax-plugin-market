# Translate

Translate text clipboard items from a card action.

Clicking the card action opens a movable translation panel and starts
translation immediately. Provider and language can be changed in the panel;
provider, endpoint, API key, language, and length defaults are configured from
the plugin detail page.

## Providers

- MyMemory public API, enabled by default and usable without an API key for
  short text.
- Youdao public demo endpoint for short text. This is not a paid official API
  integration and may throttle, change, or reject requests.
- Microsoft Edge public translation endpoint. This is an unofficial free
  endpoint and may change, throttle, or reject requests.
- Google public web translation endpoint. This uses an undocumented public
  endpoint and may change, throttle, or be blocked by CORS.
- LibreTranslate, including public, local, or self-hosted endpoints. Public
  hosts may require a key or apply limits.
- DeepL API Free or compatible endpoints. DeepL requires your own API key.

Clipboard text is sent only when the user uses Translate from a text card. API
keys and settings are stored in browser-local plugin storage on the device.
Public providers receive the text being translated.

## Defaults

- Provider: MyMemory
- Endpoint: `https://api.mymemory.translated.net/get`
- Source language: `auto`
- Target language: `zh` for non-Chinese locales, `en` for Chinese locales
- Maximum text length: 500 characters

## UI

The translation panel is not a native dialog. Drag its header to move it away
from clipboard content, then close it with the `x` button or by clicking outside
the panel.

## Changelog

See `CHANGELOG.md`.
