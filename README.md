# DareToSign

<p align="center">
  <img src="./icons/icon128.png" alt="DareToSign logo" width="96" height="96" />
</p>

<p align="center">
  <strong>Fast AI review for terms, privacy, and legal pages before you click agree.</strong>
</p>

<p align="center">
  DareToSign is a Manifest V3 Chrome extension that detects legal documents on the page you already have open, sends them to OpenAI for structured review, and highlights the clauses most likely to matter to a normal user.
</p>

## Why It Exists

Most legal pages are written to slow people down, bury tradeoffs, and make consent feel automatic. DareToSign is built to do the opposite:

- detect likely legal links on the current page
- analyze terms in the background without blocking the popup
- group findings by severity in plain English
- keep local scan history for future term-change comparisons
- let you accept an exact known version so repeated alerts calm down

## What It Does

- Scans the current tab for Terms, Privacy, EULA, and related legal pages
- Reviews all detected legal documents together in one flow
- Shows live status, progress, wait time, and detailed debug logs when enabled
- Stores your OpenAI API key locally in `chrome.storage.local`
- Persists completed scan history and accepted document fingerprints locally

## Quick Start

```bash
./scripts/install-git-hooks.sh
zsh scripts/test.sh
```

Then load the extension:

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this repository root
5. Open DareToSign Settings
6. Add your OpenAI API key
7. Choose a model and sensitivity level

## Recommended Model

`gpt-4.1-mini` is the current default because it is a better fit for fast, structured extraction in this extension than the smaller GPT-5 reasoning models. Those GPT-5 models are still available in Settings, but they can spend output budget on reasoning before returning the JSON payload the popup needs.

## Local Storage

DareToSign keeps user-specific data local to the Chrome profile:

- OpenAI API key
- selected settings
- completed scan history
- accepted exact-document fingerprints

The extension sends legal-page content directly to OpenAI from the background worker. There is no separate backend in this repo.

## Debugging

If a live scan fails, enable `Debug mode` in Settings and inspect the extension service worker from `chrome://extensions`.

Debug mode logs:

- document fetch timing
- trimmed document sizes
- OpenAI request metadata
- finish reasons, refusals, and parse failures
- fallback model retries

## Development Workflow

- Run `zsh scripts/test.sh` before commits
- Keep local git hooks installed with `./scripts/install-git-hooks.sh`
- Increment `manifest.json` on every change: `1.0.1`, `1.0.2`, `1.0.3`, and so on

## Project Structure

- `manifest.json` defines the MV3 extension entrypoints and version
- `background/` contains the service worker and scan lifecycle
- `content/` detects legal links inside web pages
- `popup/` contains the extension UI and live review state
- `options/` contains local settings and debug controls
- `utils/` contains extraction, prompting, chunking, and OpenAI helpers
- `icons/` contains the extension icon assets and editable SVG source

## License

MIT
