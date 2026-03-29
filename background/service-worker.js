import { extractText } from "../utils/extractor.js";
import { chunkText } from "../utils/chunker.js";
import { analyzeDocumentChunks } from "../utils/openai.js";

const SESSION_KEYS = {
  links: (tabId) => `tab:${tabId}:links`,
  analysis: (tabId) => `tab:${tabId}:analysis`
};

const LOCAL_KEYS = {
  scanHistory: "scanHistory",
  acceptedTerms: "acceptedTerms"
};

const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "gpt-4o-mini",
  sensitivity: "balanced",
  autoScan: false,
  showInlineBadges: true,
  language: "English"
};

const PUBLIC_SETTINGS_KEYS = ["model", "sensitivity", "autoScan", "showInlineBadges", "language"];

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(DEFAULT_SETTINGS);
  await chrome.storage.local.set({ ...DEFAULT_SETTINGS, ...current });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) {
    return undefined;
  }

  if (message.type === "TC_LINKS_FOUND") {
    void handleLinksFound(message.links ?? [], sender.tab?.id);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "GET_SETTINGS") {
    void chrome.storage.local.get(DEFAULT_SETTINGS).then((settings) => {
      const fullSettings = { ...DEFAULT_SETTINGS, ...settings };
      const isPrivilegedContext = !sender.tab;
      sendResponse({
        ok: true,
        settings: isPrivilegedContext ? fullSettings : pickPublicSettings(fullSettings),
        hasApiKey: Boolean(fullSettings.apiKey)
      });
    });
    return true;
  }

  if (message.type === "GET_TAB_LINKS") {
    void getLinksForTab(message.tabId ?? sender.tab?.id).then((links) => {
      sendResponse({ ok: true, links });
    });
    return true;
  }

  if (message.type === "GET_ANALYSIS_STATE") {
    void getAnalysisState(message.tabId ?? sender.tab?.id).then((analysis) => {
      sendResponse({ ok: true, analysis });
    });
    return true;
  }

  if (message.type === "ACCEPT_ANALYSIS") {
    void acceptAnalysisForTab(message.tabId ?? sender.tab?.id).then(sendResponse);
    return true;
  }

  if (message.type === "ANALYZE_URL") {
    void startAnalysisJob(message, sender.tab?.id).then(sendResponse);
    return true;
  }

  return undefined;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    void clearTabPageState(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearTabState(tabId);
});

async function handleLinksFound(rawLinks, tabId) {
  if (!tabId) {
    return;
  }

  const links = dedupeLinks(rawLinks);
  await chrome.storage.session.set({ [SESSION_KEYS.links(tabId)]: links });
  const visibleLinkCount = await getUnacceptedLinkCount(links);
  await updateBadge(tabId, visibleLinkCount);

  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  if (settings.autoScan && links.length > 0) {
    await chrome.storage.session.set({
      [SESSION_KEYS.analysis(tabId)]: {
        status: "ready",
        progress: 0,
        suggestedUrl: links[0].href,
        findings: [],
        log: []
      }
    });
  }
}

async function getLinksForTab(tabId) {
  if (!tabId) {
    return [];
  }

  const stored = await chrome.storage.session.get(SESSION_KEYS.links(tabId));
  return stored[SESSION_KEYS.links(tabId)] ?? [];
}

async function getAnalysisState(tabId) {
  if (!tabId) {
    return null;
  }

  const stored = await chrome.storage.session.get(SESSION_KEYS.analysis(tabId));
  return stored[SESSION_KEYS.analysis(tabId)] ?? null;
}

async function startAnalysisJob(message, senderTabId) {
  const sourceTabId = message.tabId ?? senderTabId;
  if (!sourceTabId) {
    return { error: true, message: "Could not determine which tab this scan belongs to." };
  }

  const requestId = message.requestId || crypto.randomUUID();
  const initialState = {
    requestId,
    sourceTabId,
    url: message.url,
    status: "running",
    progress: 2,
    findings: [],
    log: [
      {
        message: "Background analysis queued.",
        level: "info",
        timestamp: Date.now()
      }
    ],
    startedAt: Date.now()
  };

  await chrome.storage.session.set({ [SESSION_KEYS.analysis(sourceTabId)]: initialState });
  void runAnalysisJob({ ...message, requestId }, sourceTabId);

  return { ok: true, requestId };
}

async function runAnalysisJob(message, sourceTabId) {
  const reportProgress = createProgressReporter(message.requestId, sourceTabId);

  try {
    const settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(DEFAULT_SETTINGS)) };
    if (!settings.apiKey) {
      throw new Error("Add your OpenAI API key in the extension settings first.");
    }

    reportProgress("Preparing document fetch…", 8);

    const response = await fetch(message.url, {
      redirect: "follow",
      headers: {
        Accept: "text/html,application/xhtml+xml"
      }
    });

    if (!response.ok) {
      throw new Error(`Fetch failed with status ${response.status}.`);
    }

    reportProgress("Document received from target site.", 22);
    const html = await response.text();
    reportProgress("Extracting readable legal text…", 32);
    const text = extractText(html);
    const normalizedUrl = normalizeDocumentUrl(message.url);
    const documentKey = getDocumentKey(normalizedUrl);
    const contentHash = await hashText(text);
    reportProgress("Chunking document for AI review…", 42);
    const chunks = chunkText(text, 12000);
    const findings = await analyzeDocumentChunks(chunks, {
      apiKey: settings.apiKey,
      model: settings.model,
      sensitivity: settings.sensitivity,
      language: settings.language
    }, (progressMessage, progressValue) => {
      reportProgress(progressMessage, progressValue);
    });

    reportProgress("Compiling findings for the popup…", 96);

    const payload = {
      requestId: message.requestId,
      sourceTabId,
      status: "complete",
      progress: 100,
      error: false,
      url: message.url,
      normalizedUrl,
      documentKey,
      contentHash,
      findings,
      scannedAt: Date.now(),
      meta: {
        sensitivity: settings.sensitivity,
        model: settings.model,
        chunkCount: chunks.length,
        textLength: text.length,
        accepted: await isAcceptedVersion(documentKey, contentHash)
      }
    };

    await mergeAnalysisState(sourceTabId, message.requestId, payload, null, "info");
    reportProgress("Review complete.", 100);
    await persistScanHistory({
      url: message.url,
      sourceTabId,
      text,
      normalizedUrl,
      documentKey,
      contentHash,
      findings,
      settings,
      chunkCount: chunks.length,
      textLength: text.length,
      scannedAt: payload.scannedAt
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "Unknown analysis error.";
    reportProgress(`Analysis failed: ${messageText}`, 100, "error");
    await mergeAnalysisState(
      sourceTabId,
      message.requestId,
      {
        requestId: message.requestId,
        sourceTabId,
        status: "error",
        progress: 100,
        error: true,
        message: messageText,
        findings: []
      },
      `Analysis failed: ${messageText}`,
      "error"
    );
  }
}

async function updateBadge(tabId, count) {
  await chrome.action.setBadgeBackgroundColor({ color: "#b24c1b", tabId });
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "", tabId });
}

async function clearTabPageState(tabId) {
  await chrome.storage.session.remove([SESSION_KEYS.links(tabId)]);
  await chrome.action.setBadgeText({ text: "", tabId });
}

async function clearTabState(tabId) {
  await chrome.storage.session.remove([SESSION_KEYS.links(tabId), SESSION_KEYS.analysis(tabId)]);
  await chrome.action.setBadgeText({ text: "", tabId });
}

async function acceptAnalysisForTab(tabId) {
  const analysis = await getAnalysisState(tabId);
  if (!analysis || analysis.status !== "complete" || !analysis.documentKey || !analysis.contentHash) {
    return { error: true, message: "There is no completed analysis to accept for this tab." };
  }

  const stored = await chrome.storage.local.get(LOCAL_KEYS.acceptedTerms);
  const acceptedTerms = stored[LOCAL_KEYS.acceptedTerms] ?? {};
  acceptedTerms[analysis.documentKey] = {
    contentHash: analysis.contentHash,
    url: analysis.url,
    normalizedUrl: analysis.normalizedUrl,
    acceptedAt: Date.now()
  };

  await chrome.storage.local.set({ [LOCAL_KEYS.acceptedTerms]: acceptedTerms });
  await mergeAnalysisState(
    tabId,
    analysis.requestId,
    {
      meta: {
        ...(analysis.meta ?? {}),
        accepted: true
      }
    },
    "Accepted this terms version.",
    "info"
  );

  const links = await getLinksForTab(tabId);
  await updateBadge(tabId, await getUnacceptedLinkCount(links));

  return { ok: true };
}

function dedupeLinks(links) {
  const seen = new Set();
  const result = [];

  for (const link of links) {
    if (!link?.href) {
      continue;
    }

    const key = `${link.href}::${link.text ?? ""}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push({
      text: (link.text ?? "").trim() || link.href,
      href: link.href
    });
  }

  return result;
}

function pickPublicSettings(settings) {
  return PUBLIC_SETTINGS_KEYS.reduce((accumulator, key) => {
    accumulator[key] = settings[key];
    return accumulator;
  }, {});
}

function createProgressReporter(requestId, sourceTabId) {
  return (message, value, level = "info") => {
    if (!requestId) {
      return;
    }

    const timestamp = Date.now();

    void mergeAnalysisState(
      sourceTabId,
      requestId,
      {
        status: level === "error" ? "error" : value >= 100 ? "complete" : "running",
        progress: value
      },
      message,
      level,
      timestamp
    );

    void chrome.runtime.sendMessage({
      type: "ANALYSIS_PROGRESS",
      requestId,
      tabId: sourceTabId,
      status: message,
      progress: value,
      level,
      timestamp
    });
  };
}

async function mergeAnalysisState(tabId, requestId, patch, logMessage, level, timestamp = Date.now()) {
  const current = await getAnalysisState(tabId);
  if (current?.requestId && current.requestId !== requestId) {
    return;
  }

  const nextLog = logMessage
    ? [
        {
          message: logMessage,
          level,
          timestamp
        },
        ...(current?.log ?? [])
      ].slice(0, 10)
    : (current?.log ?? []);

  await chrome.storage.session.set({
    [SESSION_KEYS.analysis(tabId)]: {
      ...(current ?? {}),
      requestId,
      sourceTabId: tabId,
      ...patch,
      log: nextLog
    }
  });
}

async function persistScanHistory({
  url,
  sourceTabId,
  text,
  normalizedUrl: normalizedUrlInput,
  documentKey: documentKeyInput,
  contentHash: contentHashInput,
  findings,
  settings,
  chunkCount,
  textLength,
  scannedAt
}) {
  const normalizedUrl = normalizedUrlInput ?? normalizeDocumentUrl(url);
  const documentKey = documentKeyInput ?? getDocumentKey(normalizedUrl);
  const contentHash = contentHashInput ?? (await hashText(text));
  const findingsHash = await hashText(JSON.stringify(findings));
  const stored = await chrome.storage.local.get(LOCAL_KEYS.scanHistory);
  const history = stored[LOCAL_KEYS.scanHistory] ?? {};
  const currentEntries = history[documentKey] ?? [];

  const nextEntry = {
    id: crypto.randomUUID(),
    tabId: sourceTabId,
    scannedAt,
    url,
    normalizedUrl,
    hostname: safeHostname(normalizedUrl),
    contentHash,
    findingsHash,
    meta: {
      model: settings.model,
      sensitivity: settings.sensitivity,
      chunkCount,
      textLength,
      findingCount: findings.length
    },
    findings
  };

  const dedupedEntries = currentEntries.filter((entry) => entry.contentHash !== contentHash);
  history[documentKey] = [nextEntry, ...dedupedEntries].slice(0, 10);

  await chrome.storage.local.set({ [LOCAL_KEYS.scanHistory]: history });
}

function normalizeDocumentUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function getDocumentKey(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

async function hashText(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function getUnacceptedLinkCount(links) {
  if (!links.length) {
    return 0;
  }

  const stored = await chrome.storage.local.get([LOCAL_KEYS.scanHistory, LOCAL_KEYS.acceptedTerms]);
  const history = stored[LOCAL_KEYS.scanHistory] ?? {};
  const acceptedTerms = stored[LOCAL_KEYS.acceptedTerms] ?? {};

  return links.filter((link) => {
    const normalizedUrl = normalizeDocumentUrl(link.href);
    const documentKey = getDocumentKey(normalizedUrl);
    const latestEntry = history[documentKey]?.[0];
    const acceptedEntry = acceptedTerms[documentKey];

    if (!latestEntry || !acceptedEntry) {
      return true;
    }

    return latestEntry.contentHash !== acceptedEntry.contentHash;
  }).length;
}

async function isAcceptedVersion(documentKey, contentHash) {
  const stored = await chrome.storage.local.get(LOCAL_KEYS.acceptedTerms);
  const acceptedTerms = stored[LOCAL_KEYS.acceptedTerms] ?? {};
  return acceptedTerms[documentKey]?.contentHash === contentHash;
}
