# Humble Bundle Downloader (TypeScript/Bun)

This directory contains the Bun-based TypeScript port scaffold for the project. It mirrors the
Python CLI structure while providing a modular TypeScript layout that can be incrementally
implemented.

## What is implemented

- **CLI entrypoint** that wires config, session creation, API client setup, and download orchestration.
- **Config module** that resolves CLI overrides into a typed `AppConfig`.
- **Session module** that prepares auth/session state from config.
- **API client module** that exposes a typed JSON fetch helper.
- **Download module** placeholder for library orchestration.

## Module overview

```
typescript/
  src/
    api/        # API clients and request helpers
    auth/       # session/auth handling
    cli/        # CLI entrypoints
    config/     # config resolution and defaults
    download/   # download orchestration
    utils/      # shared utilities
```

## Types

| Type | Location | Purpose |
| --- | --- | --- |
| `AppConfig` | `src/config/index.ts` | Normalized app configuration used across modules. |
| `Session` | `src/auth/session.ts` | Session/auth state derived from config. |
| `ApiClient` | `src/api/client.ts` | API client contract and JSON helper. |
| `DownloadContext` | `src/download/downloader.ts` | Inputs required for download orchestration. |

## CLI usage

```bash
bun install
bun run hbd --cookie-file cookies.txt --library-path "Downloaded Library" --progress
```

You can also use the CLI entrypoint directly if you prefer:

```bash
bun run cli --cookie-file cookies.txt --library-path "Downloaded Library" --progress
```

To get a pip-style `hbd` command on your PATH with Bun, you can link the package locally:

```bash
bun link
hbd-bun --cookie-file cookies.txt --library-path "Downloaded Library" --progress
```

For Node/npm installs, publish the package and install it globally to access `hbd`:

```bash
npm install -g humblebundle-downloader-ts
hbd --cookie-file cookies.txt --library-path "Downloaded Library" --progress
```

## Next steps

- Implement cookie parsing and authenticated requests.
- Add API calls for library/purchases metadata.
- Implement download queueing, retries, and cache handling.
- Add tests with `bun test` for API and CLI behavior.
