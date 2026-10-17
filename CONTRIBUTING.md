# Contributing to CANOPY

## Build and run

```sh
npm install
npm run compile      # or: npm run watch, then press F5 ("Run CANOPY")
npm test             # unit tests + a real-git integration test
npm run test:e2e     # downloads VS Code into .vscode-test and runs the extension end to end
npm run package      # builds canopy-<version>.vsix for local testing
```

## Project layout

| Path | What |
|---|---|
| `src/git` | Git runner, output parsers, commit graph layout (no `vscode` imports) |
| `src/model` | Folder layout, query language, profiles (no `vscode` imports, unit tested) |
| `src/forge` | GitLab API client, server matching, GitLab service |
| `src/` | VS Code wiring: repository manager, tree view, storage, commands |
| `src/panels`, `media/` | Details and Profiles webviews |
| `test/` | Unit tests (`*.test.ts`) and the end-to-end suite (`test/e2e`) |

Keep `src/git` and `src/model` free of `vscode` imports so they stay testable with plain Node.

## Demo workspace and screenshots

```sh
node scripts/make-demo.mjs demo-canopy        # fictional repos with real git history
code demo-canopy/demo.code-workspace          # try CANOPY on safe data
npm run compile && node scripts/screenshots/render.mjs demo-canopy   # regenerates images/*.png
```

The screenshot script renders the real webview code with data read from the demo repositories, using headless Microsoft Edge or Chrome. GitLab pipeline and merge request data in the screenshots is made up.

## Releasing

See [PUBLISHING.md](PUBLISHING.md).
