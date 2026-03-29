# Product Requirements Document
## DareToSign — Chrome Extension
**Version:** 1.0  
**Status:** Draft  
**Last Updated:** March 2026

---

## 1. Overview

### 1.1 Product Summary
FinePrint AI is a Chrome Extension that automatically detects Terms & Conditions (T&C), Privacy Policy, and End-User License Agreement (EULA) links on any webpage the user visits. When triggered — either automatically or manually — it fetches the document, sends it to the OpenAI API, and surfaces a concise, plain-language warning report highlighting potentially harmful, deceptive, or user-hostile clauses. The user can configure how aggressively the tool flags content via a sensitivity dial.

### 1.2 Problem Statement
Terms & Conditions documents are deliberately long, complex, and written in legal language that discourages reading. Most users click "I Agree" without any understanding of what they're consenting to. Hidden within these documents are clauses that may allow companies to sell personal data, opt users into arbitration waivers, auto-enroll in paid subscriptions, or claim rights over user-generated content. No accessible consumer tool currently bridges the gap between raw legal text and actionable user understanding.

### 1.3 Goals
- Make T&C risks immediately visible without the user needing to read a single line of legalese.
- Give users agency through configurable sensitivity.
- Keep the experience frictionless — zero extra steps required for basic use.
- Respect user privacy: no T&C content is stored on any server other than the OpenAI API call (transient).

### 1.4 Non-Goals (v1.0)
- Full legal advice or liability assessment.
- Support for non-English documents (future roadmap).
- Storage or history of past scans.
- Browser support beyond Chrome (Firefox/Safari are roadmap items).

---

## 2. Target Users

| Persona | Description |
|---|---|
| **Privacy-conscious consumer** | Knows data is being harvested, wants to know how badly |
| **Casual shopper** | Signs up for e-commerce sites frequently; unaware of auto-renewal traps |
| **Developer / Tech user** | Uses SaaS tools; cares about IP ownership clauses and data licensing |
| **Parent** | Creating accounts on behalf of children; wants to flag child data clauses |

---

## 3. Features & Requirements

### 3.1 Core Features

#### F1 — T&C Link Detection
- The extension scans the active page's DOM for links whose text or href matches known T&C patterns (e.g., "Terms", "Terms of Service", "Terms & Conditions", "Privacy Policy", "EULA", "Legal", "User Agreement").
- Detection runs passively on page load and on DOM mutation (e.g., modal dialogs that appear dynamically).
- A small, unobtrusive badge or icon appears near detected links indicating "FinePrint AI ready."

#### F2 — Document Fetching
- On trigger (auto or manual), the extension fetches the T&C page content.
- It strips HTML boilerplate (nav, footer, ads) and extracts the plain-text body of the legal document using DOM parsing.
- If the document exceeds the OpenAI token limit, it is chunked intelligently (split at paragraph/section boundaries, not mid-sentence).
- Handles both same-origin and cross-origin documents (via content script fetch or background service worker).

#### F3 — AI Analysis via OpenAI API
- Sends the cleaned text to the OpenAI Chat Completions API (GPT-4o recommended).
- The prompt instructs the model to act as a consumer-rights analyst and identify clauses matching the user's selected sensitivity level.
- Response is structured as a JSON array of findings, each containing: `category`, `severity`, `clause_excerpt`, `plain_english_summary`, and `why_it_matters`.
- The user's OpenAI API key is stored locally in `chrome.storage.local` (never transmitted anywhere except directly to OpenAI).

#### F4 — Results Panel (Popup UI)
- A side panel or popup displays the analysis results, grouped by severity: 🔴 High / 🟡 Medium / 🟢 Low.
- Each finding shows: category badge, a short plain-English headline, an expandable "See clause" section with the original excerpt, and a "Why this matters" explanation.
- A summary score ("This T&C is rated: Aggressive / Moderate / Standard") appears at the top.
- A "Scan another link" button allows manual re-scanning.

#### F5 — Sensitivity Configuration
- Users can set sensitivity via a slider in the extension settings page with three labeled stops:
  - **Lenient:** Only flags clauses that are overtly harmful (e.g., selling data to third parties, binding arbitration, no refund policies).
  - **Balanced (default):** Flags the above plus auto-renewal traps, broad IP grants, vague data retention, and account termination rights.
  - **Paranoid:** Flags everything above plus cookie tracking, targeted advertising consent, change-of-terms-without-notice clauses, and jurisdiction/governing law clauses that disadvantage the user.
- The sensitivity level is passed as a parameter in the AI prompt to calibrate output.

#### F6 — API Key Management
- A settings page (Options page) allows the user to enter and save their OpenAI API key.
- The key is validated with a lightweight test call on save.
- A clear warning is displayed: "Your API key is stored locally on your device only."

---

## 4. Clause Categories & Examples

The AI is instructed to identify and tag clauses in the following categories:

| Category | Severity | Example Warning |
|---|---|---|
| **Data Sale to Third Parties** | 🔴 High | "This T&C allows the company to sell your personal data to unspecified third-party partners for marketing purposes." |
| **Binding Arbitration / Class Action Waiver** | 🔴 High | "By agreeing, you waive your right to sue in court or join a class-action lawsuit. Disputes go to private arbitration." |
| **Auto-Renewal / Hidden Subscription** | 🔴 High | "Your free trial automatically converts to a paid plan at $X/month unless cancelled 48 hours before expiry." |
| **Broad IP / Content Ownership Grant** | 🔴 High | "You grant the company a perpetual, irrevocable, worldwide, royalty-free license to use, modify, and sell any content you upload." |
| **Unilateral Terms Changes** | 🟡 Medium | "The company can change these terms at any time with no obligation to notify you. Continued use = acceptance." |
| **Account Termination at Will** | 🟡 Medium | "The company can suspend or delete your account at any time, for any reason, without notice or refund." |
| **Vague Data Retention** | 🟡 Medium | "Your data may be retained indefinitely even after account deletion for unspecified 'legitimate business purposes'." |
| **Child Data Collection** | 🔴 High | "The service may collect data from users under 13. No explicit COPPA compliance language is present." |
| **Governing Law / Jurisdiction** | 🟡 Medium | "Disputes must be resolved under the laws of [foreign state/country], which may be inconvenient or unfavorable." |
| **Broad Indemnification Clause** | 🟡 Medium | "You agree to cover the company's legal costs if a third party sues them in relation to your use of the service." |
| **Targeted Advertising Consent** | 🟢 Low | "You consent to receiving personalized ads based on your usage behavior and browsing data." |
| **Cookie & Tracking Consent** | 🟢 Low | "Agreeing to this policy consents to the use of tracking cookies, pixels, and fingerprinting technologies." |
| **No Warranty / As-Is Service** | 🟢 Low | "The service is provided 'as-is' with no guarantees. The company is not liable for data loss or service outages." |

---

## 5. User Flow

```
User visits webpage
      │
      ▼
Extension detects T&C/Privacy link on page
      │
      ├─ [Auto mode ON] → Automatically fetches & analyzes
      │
      └─ [Auto mode OFF] → Badge appears on extension icon
                                    │
                                    ▼
                         User clicks extension icon
                                    │
                                    ▼
                         Popup shows detected links
                         User clicks "Analyze"
      │
      ▼
Extension fetches T&C document (strips HTML)
      │
      ▼
Text chunked if needed → Sent to OpenAI API
      │
      ▼
JSON findings returned → Rendered in Results Panel
      │
      ▼
User sees severity-grouped warnings with expandable details
```

---

## 6. Technical Constraints

- **Manifest Version:** MV3 (required for Chrome Web Store)
- **Permissions required:** `activeTab`, `scripting`, `storage`, `alarms` (for auto-scan), `host_permissions` for cross-origin T&C fetching
- **API:** OpenAI Chat Completions (`gpt-4o` or `gpt-4o-mini` for cost efficiency, user-selectable)
- **Token budget:** Max ~120,000 tokens per document (GPT-4o context window). Most T&Cs are 3,000–15,000 tokens.
- **Storage:** `chrome.storage.local` only. No remote database.
- **No backend server.** All logic runs in the extension (content script + service worker).

---

## 7. Settings & Configuration Summary

| Setting | Type | Default | Description |
|---|---|---|---|
| OpenAI API Key | Text input | — | Required. Stored locally. |
| Model | Dropdown | gpt-4o-mini | Choose between gpt-4o-mini (fast/cheap) and gpt-4o (thorough) |
| Sensitivity | Slider (3 stops) | Balanced | Controls AI flagging aggressiveness |
| Auto-scan mode | Toggle | OFF | Automatically scans T&C links on page load |
| Show inline badges | Toggle | ON | Show small badge near detected T&C links |
| Language | Dropdown | English | Target language for AI output |

---

## 8. Success Metrics (Post-Launch)

- % of users who view at least one analysis result per session
- Average number of findings per scan (baseline health check)
- Sensitivity distribution across users (are people going Paranoid mode?)
- User retention at 7 days / 30 days
- OpenAI API error rate (key to reliability)

---

## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| T&C pages block cross-origin fetching | Use background service worker with appropriate host permissions; fall back to asking user to open link |
| OpenAI API cost overruns | Default to gpt-4o-mini; show estimated token count before scan; allow user to cancel |
| Legal liability for analysis accuracy | Clear disclaimer: "FinePrint AI is not legal advice. Results are AI-generated summaries for informational purposes only." |
| API key theft from local storage | Warn users clearly; use `chrome.storage.local` (not accessible to web pages); no logging |
| Very long T&C docs (100k+ tokens) | Chunk and summarize in passes; show "Document was too long — showing top findings from first 50 pages" |

---

## 10. Future Roadmap

- **v1.1:** Scan history & favorites (IndexedDB)
- **v1.2:** Side-by-side comparison ("How does Spotify's T&C compare to Apple Music's?")
- **v1.3:** Firefox + Safari support
- **v1.4:** Multi-language support (detect and translate)
- **v2.0:** Community-sourced T&C database (avoid re-scanning known documents)
