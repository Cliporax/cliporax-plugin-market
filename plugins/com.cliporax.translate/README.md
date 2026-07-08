# Translate

Translate text clipboard items from a card action.

## Providers

- LibreTranslate, including local or self-hosted endpoints.
- DeepL API Free or compatible endpoints.

Clipboard text is sent only when the user clicks Translate. API keys and settings
are stored in browser-local plugin storage on the device.

## Defaults

- Provider: LibreTranslate
- Endpoint: `http://localhost:5000`
- Source language: `auto`
- Target language: `zh` for non-Chinese locales, `en` for Chinese locales
- Maximum text length: 4000 characters

## Changelog

See `CHANGELOG.md`.
