# Changelog

## 0.1.2

- Use Cliporax's permission-aware network API for every translation provider.
- Require Cliporax 1.2.2 or later.

## 0.1.1

- Change the default provider to the MyMemory public API so translation works without running a local service.
- Add Youdao public demo, Microsoft Edge public, and Google public web provider options with documented limitations.
- Migrate the old default `localhost:5000` endpoint to network endpoints on load.
- Keep LibreTranslate and DeepL as configurable providers.
- Start translation immediately when the card action is clicked.
- Replace the fixed popover with a draggable translation panel and in-panel provider switcher.
- Add provider and language configuration fields to the plugin detail page.

## 0.1.0

- Add text card translation action.
- Add LibreTranslate and DeepL providers.
- Add provider settings, privacy notice, length guard, and copy action.
