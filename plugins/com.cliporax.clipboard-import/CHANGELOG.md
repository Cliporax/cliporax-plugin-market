# Changelog

## 0.4.0

- Preserve the complete CopyQ tab structure by default, including empty tabs.
- Reuse matching non-trash Cliporax tabs and create missing tabs before writing
  their records.
- Add an explicit CopyQ layout choice to merge everything into one destination
  tab when preferred.

## 0.3.1

- Write up to 250 imported records per host call and SQLite transaction while
  preserving deduplication, display order, and sync outbox records.
- Fall back to smaller batches and finally single-item writes if a batch fails.

## 0.3.0

- Import every CopyQ tab through cursor-based pages instead of stopping after
  the first 7 MiB of output.
- Import CopyQ PNG, JPEG, WebP, BMP, and SVG image items.
- Raise the total import safety limit to 50,000 items while keeping each CopyQ
  process response below the host's 8 MiB output limit.

## 0.2.2

- Serialize the Cliporax `tags` field as the JSON string required by the
  `clipboard_create` IPC contract, allowing imported records to be written.

## 0.2.1

- Bound CopyQ output inside the CopyQ process so large histories no longer fail
  Cliporax's 8 MiB process-output limit.
- Prevent CopyQ command-line escape expansion from corrupting the eval script.
- Report when CopyQ history was truncated by the safe transfer budget.

## 0.2.0

- Add a dense, keyboard-accessible import view using Cliporax shared comboboxes.
- Preserve multi-line GPaste entries with NUL-separated output.
- Fix CopyQ NDJSON record separation and preserve source ordering.
- Add bounded item size/count handling and per-run write failure reporting.
- Document explicit Ditto, Klipper, Maccy, and Raycast compatibility boundaries.
