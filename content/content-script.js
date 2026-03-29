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

const BADGE_CLASS = "dts-badge";
const STYLE_ID = "dts-badge-style";
const SCANNED_ATTR = "data-dts-scanned";
let detectedLinks = [];
let showInlineBadges = true;

void init();

async function init() {
  const settings = await getSettings();
  showInlineBadges = settings.showInlineBadges !== false;
  injectBadgeStyle();
  scanDocument();
  observeDom();
}

function scanDocument(root = document) {
  const links = Array.from(root.querySelectorAll?.("a[href]") ?? []);
  let changed = false;

  for (const link of links) {
    if (link.getAttribute(SCANNED_ATTR) === "true") {
      continue;
    }

    link.setAttribute(SCANNED_ATTR, "true");

    if (!matchesTermsPattern(link)) {
      continue;
    }

    changed = true;
    const entry = {
      text: normalizeWhitespace(link.innerText || link.textContent || link.href),
      href: link.href
    };

    detectedLinks.push(entry);

    if (showInlineBadges) {
      injectBadge(link);
    }
  }

  if (changed) {
    detectedLinks = dedupeLinks(detectedLinks);
    void chrome.runtime.sendMessage({ type: "TC_LINKS_FOUND", links: detectedLinks });
  }
}

function matchesTermsPattern(link) {
  const candidate = `${link.innerText || ""} ${link.textContent || ""} ${link.href || ""}`;
  return TC_PATTERNS.some((pattern) => pattern.test(candidate));
}

function injectBadge(link) {
  if (link.nextElementSibling?.classList.contains(BADGE_CLASS)) {
    return;
  }

  const badge = document.createElement("span");
  badge.className = BADGE_CLASS;
  badge.textContent = "AI";
  badge.title = "DareToSign detected a legal document link here.";
  link.insertAdjacentElement("afterend", badge);
}

function injectBadgeStyle() {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .${BADGE_CLASS} {
      display: inline-block;
      margin-left: 6px;
      padding: 1px 6px;
      border-radius: 999px;
      background: #b24c1b;
      color: #fff9f4;
      font: 700 10px/1.8 "Arial", sans-serif;
      letter-spacing: 0.08em;
      vertical-align: middle;
      cursor: default;
    }

    .${BADGE_CLASS}::before {
      content: "!";
      margin-right: 4px;
    }
  `;
  document.documentElement.appendChild(style);
}

function observeDom() {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) {
          continue;
        }

        if (node.matches?.("a[href]")) {
          scanDocument(node.parentElement ?? document);
          return;
        }

        if (node.querySelector?.("a[href]")) {
          scanDocument(node);
          return;
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_TC_LINKS") {
    sendResponse({ ok: true, links: detectedLinks });
    return false;
  }

  return undefined;
});

async function getSettings() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
    return response?.settings ?? {};
  } catch {
    return {};
  }
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function dedupeLinks(links) {
  const seen = new Set();
  return links.filter((link) => {
    const key = `${link.href}::${link.text}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}
