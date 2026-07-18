# Cliporax Plugin Market Agent Instructions

## Plugin Development Quality Gates

Every new plugin and every plugin behavior, manifest, permission, packaging, or
compatibility change must pass all of the following checks before it is
committed or released:

1. Run `npm run build` and `npm run validate` to compile the plugin, validate
   its runtime manifest and market metadata, and verify the generated package.
2. Run `npm run install:local-dev` to install the built package into the
   isolated `com.cliporax.app.dev` data directory. Confirm that Cliporax can
   discover and load the installed plugin without manifest, permission, entry
   point, or missing-file errors.
3. Run the automated tests that cover the changed plugin behavior, including
   important success and failure paths. Add or update automated tests when the
   changed behavior is not covered; a manual UI check alone is not sufficient.

Do not treat a successful market build as proof that a plugin is installable or
functional. Report the exact install check and automated test commands in the
final handoff. If an environment dependency prevents an install or functional
test, report the blocker explicitly and do not claim the plugin is fully
verified.
