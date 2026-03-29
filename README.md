# dare-to-sign

A first-pass Manifest V3 Chrome extension for detecting and analyzing Terms, Privacy, EULA, and related legal pages with the OpenAI API.

## Getting Started

```bash
./scripts/install-git-hooks.sh
zsh scripts/test.sh
```

## Load The Extension

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this repository root

Then open the extension's settings page, add your OpenAI API key, and choose a model and sensitivity level.

The API key is stored locally in `chrome.storage.local` and used by the extension background worker for direct OpenAI requests only.

Completed scans are also stored locally in `chrome.storage.local` with document fingerprints and findings so the extension can support future term-change comparisons.

## First Commit Setup

Before your first GitHub commit, install the local Git hooks:

```bash
./scripts/install-git-hooks.sh
```

This configures `pre-commit` to run `zsh scripts/test.sh`.

## Workflow

- Use `zsh scripts/test.sh` before commits or releases
- Use `./scripts/deploy.sh` to run checks and push the current branch
- Increment `manifest.json` version on every subsequent change: `1.0.1`, `1.0.2`, `1.0.3`, and so on

## Project Structure

- `manifest.json` defines the MV3 extension
- `background/` contains the service worker
- `content/` scans pages for legal links
- `popup/` contains the scan UI
- `options/` contains local settings management
- `utils/` contains extraction, chunking, prompts, and OpenAI helpers

## License

MIT
