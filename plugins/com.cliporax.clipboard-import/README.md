# Clipboard Import

This plugin imports text clipboard history into a selected Cliporax tab. Processing
stays local. It requires the user to grant `system:process`; the plugin starts the
configured executable directly, without a shell, and supplies only the argument
array shown in the UI.

The import is intentionally bounded to 5,000 items, 1 MiB per text item, 8 MiB of
process output, and 60 seconds per exporter run. Items from supported sources are
read newest-first and written oldest-first so their visible ordering is preserved.

## Ready-to-run imports

| Source | Executable | Arguments | Notes |
| --- | --- | --- | --- |
| CopyQ | `copyq` | supplied by the plugin | CopyQ must be running. The plugin asks its CLI to print each tab item as NDJSON. |
| GPaste | `gpaste-client` | `history --raw --zero` | NUL separators preserve embedded line breaks. |

The executable fields accept either an absolute path or a command available on
`PATH`. This keeps the integration independent of install location and package
version wherever the upstream CLI remains compatible.

## NDJSON exporters

Ditto, Klipper, Maccy, Raycast, and Custom all use the **Run selected exporter**
section. Configure an executable and a JSON argument array. The program must write
one JSON object per line to standard output, ordered newest first:

```json
{"text":"clipboard value","tab":"optional source tab name"}
```

Only a non-empty string `text` is imported. Invalid or oversized lines are skipped
and counted in the result. Do not print diagnostics to standard output; write them
to standard error instead. Standard error is shown only when the exporter fails.
Cliporax's normal content deduplication still applies. If five consecutive writes
fail, the run stops early and reports the first error instead of repeatedly calling
the database with the same failing request.

### Source-specific boundaries

- **Ditto:** its documented command-line options do not export clipboard history.
  Use a separately installed, read-only exporter for the local Ditto data.
- **Klipper:** a D-Bus client can query Klipper, but its history menu output is not
  a stable data interchange format. Use an exporter that talks to the installed
  Klipper version and emits the NDJSON contract above.
- **Maccy:** no supported history-export CLI is assumed. Use an explicit exporter.
- **Raycast:** exported `.rayconfig` archives include clipboard history but are
  encrypted. This plugin does not decrypt them or handle passphrases; use a
  Raycast-approved exporter that produces NDJSON.

The external exporter is responsible for source-version compatibility and for
accessing the user's clipboard database only with their permission.

## Evaluation matrix

| Source | First-party interface | v0.2 support | Next safe step |
| --- | --- | --- | --- |
| CopyQ | Scriptable CLI | One-click text import | Add MIME-aware image/file migration later. |
| GPaste | `gpaste-client` | One-click multi-line text import | Add named-history selection after version probing. |
| Ditto | No history-export CLI | Explicit NDJSON exporter | Add a read-only, schema-versioned `Ditto.db` helper. |
| Klipper | Plasma D-Bus, version-sensitive | Explicit NDJSON exporter | Probe the installed D-Bus interface before enabling a preset. |
| Maccy | Local Core Data SQLite store | Explicit NDJSON exporter | Add a signed/read-only helper with schema detection. |
| Raycast | Encrypted `.rayconfig` export | Explicit approved exporter | Integrate only if Raycast publishes a supported decrypt/export API. |
