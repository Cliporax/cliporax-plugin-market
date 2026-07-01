# Third-Party Plugin Entries

Third-party plugin authors can add JSON files to this directory. Files ending in
`.json` are merged into `market/index.json` during `npm run build`.

Third-party entries must provide complete market metadata, including the
download asset, icon data, and publisher metadata. The build rejects any
third-party entry that sets `publisher.official` to `true`; merged third-party
plugins are always marked as non-official.

Use this shape:

```json
{
  "plugins": [
    {
      "id": "com.example.my-plugin",
      "name": "My Plugin",
      "description": "Adds a third-party Cliporax feature.",
      "version": "1.0.0",
      "author": "Example",
      "license": "MIT",
      "homepage": "https://example.com/my-plugin",
      "repository": "https://github.com/example/my-plugin",
      "keywords": ["example"],
      "type": "utility",
      "permissions": ["clipboard:read"],
      "minAppVersion": "0.1.0",
      "compatibility": {
        "platforms": ["linux", "macos", "windows"]
      },
      "icon": {
        "path": "assets/icon.svg",
        "contentType": "image/svg+xml",
        "size": 512,
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "dataUrl": "data:image/svg+xml;base64,..."
      },
      "publisher": {
        "name": "Example",
        "url": "https://example.com",
        "official": false
      },
      "asset": {
        "name": "com.example.my-plugin-1.0.0.cliporax-plugin.zip",
        "downloadUrl": "https://github.com/example/my-plugin/releases/download/v1.0.0/com.example.my-plugin-1.0.0.cliporax-plugin.zip",
        "apiUrl": "https://api.github.com/repos/example/my-plugin/releases/assets/123456",
        "size": 12345,
        "sha256": "1111111111111111111111111111111111111111111111111111111111111111",
        "githubAssetId": 123456,
        "contentType": "application/zip"
      }
    }
  ]
}
```

The main marketplace UI should display a non-official badge and installation
warning whenever `publisher.official` is `false`.
