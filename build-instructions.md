# DareToSign — Chrome Extension
## Agent Build Instructions (MV3)

> **For the coding agent:** Read this file in full before writing a single line of code. Follow the architecture, file structure, and implementation notes exactly. Do not improvise alternatives unless a noted constraint makes them impossible.

---

## Project Summary

Build a Chrome Extension (Manifest V3) called **DareToSign**. It detects Terms & Conditions / Privacy Policy links on any webpage, fetches the document, sends it to the OpenAI Chat Completions API, and displays a severity-grouped list of potentially harmful clauses in a popup UI. The user provides their own OpenAI API key via an options/settings page.

---

## File & Folder Structure

```
fineprint-ai/
├── manifest.json
├── background/
│   └── service-worker.js        # MV3 background service worker
├── content/
│   └── content-script.js        # DOM scanning + link detection + badge injection
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── options/
│   ├── options.html
│   ├── options.js
│   └── options.css
├── utils/
│   ├── openai.js                 # All OpenAI API interaction logic
│   ├── extractor.js              # HTML → clean plain text extractor
│   ├── chunker.js                # Token-aware text chunker
│   └── prompts.js                # All prompt templates
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## 1. manifest.json

```json
{
  "manifest_version": 3,
  "name": "DareToSign",
  "version": "1.0.0",
  "description": "AI-powered Terms & Conditions analyzer. Spot shady clauses before you click Agree.",
  "permissions": [
    "activeTab",
    "scripting",
    "storage",
    "alarms"
  ],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background/service-worker.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content/content-script.js"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    },
    "default_title": "FinePrint AI"
  },
  "options_page": "options/options.html",
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

---

## 2. Content Script — `content/content-script.js`

### Purpose
Scans the page DOM for T&C/Privacy links, injects visual badges next to them, and reports found links back to the service worker.

### Implementation

- Run on `document_idle`.
- Define a `TC_PATTERNS` array of regex patterns matching link text or href:
  ```js
  const TC_PATTERNS = [
    /terms\s*(of\s*(service|use))?/i,
    /privacy\s*policy/i,
    /terms\s*(&|and)\s*conditions/i,
    /eula/i,
    /user\s*agreement/i,
    /legal/i,
    /cookie\s*policy/i,
    /acceptable\s*use/i
  ];
  ```
- Query all `<a>` elements. For each link, check if `link.innerText` or `link.href` matches any pattern.
- For each matched link, inject a small inline badge `<span class="fp-badge">🔍</span>` immediately after the anchor element. Style it with an injected `<style>` tag (small, non-intrusive, positioned inline).
- Collect all matched links as `{ text, href }` objects.
- Send matched links to the service worker via `chrome.runtime.sendMessage({ type: 'TC_LINKS_FOUND', links })`.
- Also listen for DOM mutations using `MutationObserver` to catch dynamically injected modals/dialogs (e.g., cookie consent boxes with embedded T&C links). Re-run detection on new nodes.
- Listen for `chrome.runtime.onMessage` for a `GET_TC_LINKS` request from the popup, and respond with the current links array.

### Badge Style (inject inline)
```css
.fp-badge {
  display: inline-block;
  font-size: 11px;
  background: #6C63FF;
  color: white;
  border-radius: 4px;
  padding: 1px 5px;
  margin-left: 4px;
  cursor: pointer;
  vertical-align: middle;
  font-family: sans-serif;
}
.fp-badge:hover::after {
  content: " FinePrint AI";
}
```

---

## 3. Background Service Worker — `background/service-worker.js`

### Purpose
Central message bus. Handles fetching T&C documents cross-origin, orchestrates OpenAI calls, stores results, and updates the extension badge count.

### Message Types to Handle

| Message type | Sender | Action |
|---|---|---|
| `TC_LINKS_FOUND` | content-script | Store links for current tab in `chrome.storage.session` keyed by tabId. Update badge. |
| `ANALYZE_URL` | popup | Fetch the URL, extract text, call OpenAI, return findings. |
| `GET_SETTINGS` | popup/content | Return settings from `chrome.storage.local`. |

### Fetch Logic
- When handling `ANALYZE_URL`:
  1. Use `fetch(url)` inside the service worker (bypasses CORS restrictions that apply to content scripts).
  2. Get response text (HTML).
  3. Import and call `extractor.js` to strip HTML → plain text.
  4. Import and call `chunker.js` to split if needed.
  5. Import and call `openai.js` to analyze.
  6. Return structured findings array to popup via `sendResponse`.
- Wrap in try/catch. On failure, return `{ error: true, message: '...' }`.

### Badge Update
- When `TC_LINKS_FOUND` arrives with N links, call:
  ```js
  chrome.action.setBadgeText({ text: String(n), tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#6C63FF', tabId });
  ```
- Clear badge when tab navigates away.

---

## 4. Utilities

### `utils/extractor.js`

Export a function `extractText(html: string): string`.

- Parse using `DOMParser` (available in service workers via import workaround — use a regex-based fallback if DOMParser is unavailable in the worker context).
- Remove tags: `<script>`, `<style>`, `<nav>`, `<header>`, `<footer>`, `<aside>`, `<form>`, `<button>`, `<img>`, `<svg>`.
- Collapse whitespace. Preserve paragraph breaks as `\n\n`.
- Return the resulting string, trimmed.
- If the resulting text is under 200 characters, throw: `"Could not extract meaningful text from this page."`.

### `utils/chunker.js`

Export a function `chunkText(text: string, maxTokens = 12000): string[]`.

- Approximate token count as `text.length / 4` (rough heuristic, safe for English).
- Split at double-newlines (`\n\n`) to preserve paragraph integrity.
- Accumulate paragraphs into chunks until adding the next paragraph would exceed `maxTokens`.
- Return array of chunk strings.
- **Important:** If only one chunk, return `[text]` — no unnecessary processing.

### `utils/prompts.js`

Export a function `buildPrompt(text: string, sensitivity: 'lenient' | 'balanced' | 'paranoid'): string`.

The prompt must:
1. Set the role clearly as a consumer-rights analyst, NOT a lawyer.
2. Provide the sensitivity level and explicitly tell the model what categories to flag at that level (see categories below).
3. Instruct the model to respond **only** with a valid JSON array — no markdown, no preamble, no explanation outside the JSON.
4. Define the exact JSON schema for each finding.

```js
export function buildPrompt(text, sensitivity) {
  const categoryMap = {
    lenient: [
      "Data sale to third parties",
      "Binding arbitration or class-action waiver",
      "Auto-renewal or hidden subscription",
      "Broad IP/content ownership grant",
      "Child data collection"
    ],
    balanced: [
      // All lenient categories, plus:
      "Unilateral terms changes without notice",
      "Account termination at will without refund",
      "Vague or indefinite data retention",
      "Broad indemnification clause",
      "Governing law in unfavorable jurisdiction"
    ],
    paranoid: [
      // All balanced categories, plus:
      "Targeted advertising consent",
      "Cookie and fingerprinting tracking consent",
      "No warranty / as-is service clause",
      "Limitation of liability beyond legal minimums",
      "Any clause that reduces user rights or increases company rights"
    ]
  };

  const categories = categoryMap[sensitivity];

  return `You are a consumer-rights document analyst. Your job is to read Terms & Conditions text and identify clauses that may harm, deceive, or disadvantage the user.

Sensitivity level: ${sensitivity.toUpperCase()}
At this level, flag clauses in these categories ONLY:
${categories.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Document to analyze:
---
${text}
---

Respond ONLY with a valid JSON array. No markdown. No explanation. No preamble. Just the JSON array.

Each item in the array must follow this exact schema:
{
  "category": string,         // One of the category names listed above
  "severity": "high" | "medium" | "low",
  "clause_excerpt": string,   // The verbatim problematic sentence or phrase from the document (max 300 chars)
  "plain_english": string,    // 1-2 sentence plain English explanation of what it means
  "why_it_matters": string    // 1 sentence on why this is bad for the user
}

If no concerning clauses are found at this sensitivity level, return an empty array: []
`;
}
```

### `utils/openai.js`

Export an async function `analyzeDocument(chunks: string[], settings: object): Promise<Finding[]>`.

- `settings` contains `{ apiKey, model, sensitivity }`.
- For each chunk, call the OpenAI Chat Completions API:
  ```js
  fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model || 'gpt-4o-mini',
      messages: [
        { role: 'user', content: buildPrompt(chunk, settings.sensitivity) }
      ],
      temperature: 0.2,
      max_tokens: 2000
    })
  })
  ```
- Parse `response.choices[0].message.content` as JSON. Strip any accidental markdown fences (` ```json `) before parsing.
- Accumulate findings from all chunks into one array.
- Deduplicate: if two findings have >80% similar `clause_excerpt` text, keep only the higher-severity one.
- Sort by severity: `high` first, then `medium`, then `low`.
- Return the sorted, deduplicated findings array.
- On API error (non-200 status), throw a descriptive error: `"OpenAI API error: ${status} — ${statusText}"`.

---

## 5. Popup — `popup/popup.html` + `popup.js` + `popup.css`

### popup.html structure
```
[Extension Header: FinePrint AI logo + settings gear icon]
[Status bar: "X T&C links found on this page"]
[Detected links list: each as a clickable card]
[Results panel: hidden until analysis runs]
  ├── Summary score badge ("Aggressive / Moderate / Standard")
  ├── Findings list (grouped by severity)
  │    ├── 🔴 HIGH (count)
  │    │    └── Finding cards (expandable)
  │    ├── 🟡 MEDIUM (count)
  │    │    └── Finding cards
  │    └── 🟢 LOW (count)
  │         └── Finding cards
  └── Disclaimer: "AI-generated. Not legal advice."
[Loading state: spinner + "Analyzing document..."]
[Error state: red banner with message]
```

### popup.js behavior
1. On open, send `GET_TC_LINKS` message to content-script of active tab.
2. Render detected links as clickable cards.
3. On card click (or if auto-scan is ON, automatically), send `ANALYZE_URL` to service worker.
4. Show loading spinner while awaiting response.
5. On response, render findings.
6. Each finding card shows: category badge, `plain_english` text, severity dot. Clicking expands to show `clause_excerpt` and `why_it_matters`.
7. "Settings" gear icon opens `chrome.runtime.openOptionsPage()`.

### Finding Card Component (HTML template)
```html
<div class="finding-card severity-{severity}" data-id="{i}">
  <div class="finding-header">
    <span class="severity-dot"></span>
    <span class="category-badge">{category}</span>
    <span class="plain-english">{plain_english}</span>
    <button class="expand-btn">▼</button>
  </div>
  <div class="finding-detail hidden">
    <blockquote class="clause-excerpt">"{clause_excerpt}"</blockquote>
    <p class="why-matters">⚠️ {why_it_matters}</p>
  </div>
</div>
```

### Summary Score Logic (in popup.js)
```js
function scoreTnC(findings) {
  const highCount = findings.filter(f => f.severity === 'high').length;
  const medCount = findings.filter(f => f.severity === 'medium').length;
  if (highCount >= 3 || (highCount >= 1 && medCount >= 3)) return 'Aggressive 🔴';
  if (highCount >= 1 || medCount >= 2) return 'Concerning 🟡';
  return 'Mostly Standard 🟢';
}
```

### CSS Design Guidelines
- Dark theme: background `#1a1a2e`, card surface `#16213e`, accent `#6C63FF`.
- Popup dimensions: `width: 420px`, `max-height: 580px`, `overflow-y: auto`.
- Severity colors: high = `#FF4757`, medium = `#FFA502`, low = `#2ED573`.
- Font: system-ui / sans-serif.
- Smooth expand animation on finding cards (`max-height` transition).

---

## 6. Options Page — `options/options.html` + `options.js`

### Fields
| Field | Type | Key in chrome.storage.local |
|---|---|---|
| OpenAI API Key | Password input | `apiKey` |
| Model | Select: gpt-4o-mini / gpt-4o | `model` |
| Sensitivity | Radio or slider: Lenient / Balanced / Paranoid | `sensitivity` |
| Auto-scan mode | Checkbox toggle | `autoScan` |
| Show inline badges | Checkbox toggle | `showBadges` |

### Behavior
- On load, populate fields from `chrome.storage.local`.
- "Save" button writes all fields to `chrome.storage.local`.
- After saving API key, make a minimal test call:
  ```js
  // Test call: send "Say OK" to gpt-4o-mini with max_tokens: 5
  ```
  Show ✅ "API key valid" or ❌ "Invalid key — check and retry".
- Show a non-dismissable info banner: *"Your API key is stored only on this device and sent only to OpenAI. FinePrint AI never sees your key."*

---

## 7. Key Implementation Constraints

1. **MV3 service worker has no DOM access.** The `extractor.js` HTML parser must be regex-based (not DOMParser). Use this approach:
   ```js
   function extractText(html) {
     return html
       .replace(/<script[\s\S]*?<\/script>/gi, '')
       .replace(/<style[\s\S]*?<\/style>/gi, '')
       .replace(/<nav[\s\S]*?<\/nav>/gi, '')
       .replace(/<footer[\s\S]*?<\/footer>/gi, '')
       .replace(/<header[\s\S]*?<\/header>/gi, '')
       .replace(/<[^>]+>/g, ' ')
       .replace(/\s{2,}/g, '\n\n')
       .trim();
   }
   ```

2. **Service worker lifecycle.** MV3 service workers can be killed at any time. Do not rely on in-memory state between messages. Always read from `chrome.storage.session` or `chrome.storage.local`.

3. **Popup–service worker communication** must use `chrome.runtime.sendMessage` / `sendResponse`. Remember to return `true` from `onMessage` listeners if the response is async.

4. **Content script → popup communication** must go through the background service worker (content scripts cannot message the popup directly in MV3).

5. **Cross-origin fetching:** The service worker can fetch cross-origin URLs freely. The content script cannot. All document fetching must happen in the service worker, not the content script.

6. **JSON parse safety:** Always wrap `JSON.parse` of OpenAI responses in try/catch. If parsing fails, attempt to extract a JSON array using regex: `const match = text.match(/\[[\s\S]*\]/);`.

7. **No eval(), no remote code execution** — Chrome Web Store policy. All logic must be bundled.

---

## 8. Error States to Handle

| Error | User-facing message |
|---|---|
| No API key set | "Add your OpenAI API key in Settings to get started." + link to options |
| No T&C links found | "No Terms & Conditions links detected on this page." |
| Fetch failed (CORS or network) | "Couldn't fetch this document. Try opening the link directly and scanning from that page." |
| OpenAI 401 | "Invalid API key. Please update it in Settings." |
| OpenAI 429 | "Rate limit reached. Wait a moment and try again." |
| OpenAI 500 | "OpenAI is having issues. Try again shortly." |
| JSON parse fail | "Analysis returned an unexpected format. Try again." |
| Document too short | "This document doesn't contain enough text to analyze." |

---

## 9. Testing Checklist

- [ ] Load extension unpacked in `chrome://extensions` with Developer Mode ON
- [ ] Visit `https://www.spotify.com/legal/end-user-agreement/` — should detect link + show badge
- [ ] Click extension icon — detected link appears
- [ ] Click Analyze — spinner shows, results render with at least 3 findings
- [ ] Expand a finding card — excerpt and why-it-matters visible
- [ ] Change sensitivity to Paranoid — re-analyze — more findings appear
- [ ] Change sensitivity to Lenient — re-analyze — fewer findings
- [ ] Enter invalid API key in options — red error shown on save
- [ ] Enter valid API key — green confirmation shown
- [ ] Visit a page with no T&C links — "No links detected" message in popup
- [ ] Test on a dynamically loaded modal (try `https://reddit.com` signup flow)

---

## 10. Suggested Build Order

1. `manifest.json`
2. `utils/extractor.js` + `utils/chunker.js` (pure functions, testable in isolation)
3. `utils/prompts.js`
4. `utils/openai.js`
5. `background/service-worker.js`
6. `options/options.html` + `options.js` (needed before popup works)
7. `content/content-script.js`
8. `popup/popup.html` + `popup.js` + `popup.css`
9. End-to-end test on 3 real T&C pages
10. Error state hardening pass
