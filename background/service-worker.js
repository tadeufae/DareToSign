import { extractText } from "../utils/extractor.js";
import { analyzeCombinedDocuments } from "../utils/openai.js";

const DOCUMENT_FETCH_TIMEOUT_MS = 30_000;
const MAX_DOCUMENT_CHARS = 16_000;
const MAX_TOTAL_ANALYSIS_CHARS = 48_000;

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
  model: "gpt-4.1-mini",
  sensitivity: "balanced",
  autoScan: false,
  showInlineBadges: true,
  language: "English",
  debugMode: false
};

const PUBLIC_SETTINGS_KEYS = ["model", "sensitivity", "autoScan", "showInlineBadges", "language", "debugMode"];

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(DEFAULT_SETTINGS);
  await chrome.storage.local.set({
    ...DEFAULT_SETTINGS,
    ...current,
    model:
      !current.model || ["gpt-4o-mini", "gpt-5-mini", "gpt-5-nano"].includes(current.model)
        ? DEFAULT_SETTINGS.model
        : current.model
  });
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
    const targetUrls = links.map((link) => link.href);
    const currentAnalysis = await getAnalysisState(tabId);
    const shouldStartAutoAnalysis =
      currentAnalysis?.status !== "running" &&
      !(
        currentAnalysis?.status === "complete" &&
        JSON.stringify(currentAnalysis.urls ?? [currentAnalysis.url].filter(Boolean)) ===
          JSON.stringify(targetUrls)
      ) &&
      !(
        currentAnalysis?.status === "ready" &&
        JSON.stringify(currentAnalysis.suggestedUrls ?? [currentAnalysis.suggestedUrl].filter(Boolean)) ===
          JSON.stringify(targetUrls)
      );

    if (shouldStartAutoAnalysis) {
      if (settings.apiKey) {
        await startAnalysisJob(
          {
            urls: targetUrls,
            tabId,
            requestId: crypto.randomUUID(),
            autoTriggered: true
          },
          tabId
        );
      } else {
        await chrome.storage.session.set({
          [SESSION_KEYS.analysis(tabId)]: {
            status: "ready",
            progress: 0,
            suggestedUrls: targetUrls,
            findings: [],
            log: [
              {
                message: "Auto-scan is on, but an OpenAI API key is still required.",
                level: "error",
                timestamp: Date.now()
              }
            ]
          }
        });
      }
    }
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

  const urls = Array.isArray(message.urls) && message.urls.length > 0 ? dedupeUrlList(message.urls) : [message.url].filter(Boolean);
  if (urls.length === 0) {
    return { error: true, message: "No legal document URLs were provided for analysis." };
  }

  const requestId = message.requestId || crypto.randomUUID();
  const initialState = {
    requestId,
    sourceTabId,
    url: urls[0],
    urls,
    status: "running",
    progress: 2,
    findings: [],
    log: [
      {
        message: message.autoTriggered ? "Auto-analysis queued." : "Background analysis queued.",
        level: "info",
        timestamp: Date.now()
      }
    ],
    startedAt: Date.now()
  };

  await chrome.storage.session.set({ [SESSION_KEYS.analysis(sourceTabId)]: initialState });
  void runAnalysisJob({ ...message, requestId, urls }, sourceTabId);

  return { ok: true, requestId };
}

async function runAnalysisJob(message, sourceTabId) {
  const reportProgress = createProgressReporter(message.requestId, sourceTabId);

  try {
    const settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(DEFAULT_SETTINGS)) };
    debugLog(settings, "analysis:start", {
      requestId: message.requestId,
      sourceTabId,
      urlCount: message.urls.length,
      urls: message.urls
    });

    if (!settings.apiKey) {
      throw new Error("Add your OpenAI API key in the extension settings first.");
    }

    reportProgress(
      message.urls.length > 1 ? `Fetching ${message.urls.length} legal documents…` : "Fetching legal document…",
      10
    );

    const preparedDocuments = await Promise.all(
      message.urls.map(async (url, index) => {
        const html = await fetchDocumentHtml(url);
        const extractedText = extractText(html);
        const text = trimDocumentText(extractedText, MAX_DOCUMENT_CHARS);
        const normalizedUrl = normalizeDocumentUrl(url);
        const documentKey = getDocumentKey(normalizedUrl);
        const contentHash = await hashText(extractedText);

        return {
          index,
          title: `Legal document ${index + 1}`,
          url,
          normalizedUrl,
          documentKey,
          contentHash,
          text,
          textLength: extractedText.length,
          chunkCount: 1
        };
      })
    );

    debugLog(settings, "analysis:documents-prepared", preparedDocuments.map((document) => ({
      url: document.url,
      normalizedUrl: document.normalizedUrl,
      textLength: document.textLength,
      trimmedLength: document.text.length
    })));

    reportProgress(
      message.urls.length > 1 ? `Fetched and extracted ${message.urls.length} legal documents.` : "Fetched and extracted legal document.",
      36
    );

    const preparedDocumentsForAnalysis = limitDocumentsForCombinedAnalysis(preparedDocuments, MAX_TOTAL_ANALYSIS_CHARS);
    if (preparedDocumentsForAnalysis.some((document) => document.text.length < document.textLength)) {
      reportProgress("Trimmed long legal documents to keep the combined review responsive.", 40);
    }

    debugLog(settings, "analysis:documents-for-openai", preparedDocumentsForAnalysis.map((document) => ({
      url: document.url,
      sentChars: document.text.length,
      originalChars: document.textLength
    })));

    reportProgress("Preparing one combined AI review…", 44);
    const allFindings = await analyzeCombinedDocuments(
      preparedDocumentsForAnalysis.map((document) => ({
        title: document.title,
        url: document.url,
        text: document.text
      })),
      {
        apiKey: settings.apiKey,
        model: settings.model,
        sensitivity: settings.sensitivity,
        language: settings.language
      },
      (progressMessage, progressValue) => {
        reportProgress(progressMessage, Math.min(94, progressValue));
      }
    );

    const findingsByDocument = new Map(
      preparedDocuments.map((document) => [document.normalizedUrl, []])
    );

    for (const finding of allFindings) {
      const normalizedFindingUrl = normalizeDocumentUrl(finding.document_url ?? "");
      if (findingsByDocument.has(normalizedFindingUrl)) {
        findingsByDocument.get(normalizedFindingUrl).push(finding);
      }
    }

    const analyzedDocuments = preparedDocuments.map((document) => ({
      url: document.url,
      normalizedUrl: document.normalizedUrl,
      documentKey: document.documentKey,
      contentHash: document.contentHash,
      textLength: document.textLength,
      chunkCount: document.chunkCount,
      findings: findingsByDocument.get(document.normalizedUrl) ?? []
    }));

    const scannedAt = Date.now();

    for (const document of preparedDocuments) {
      await persistScanHistory({
        url: document.url,
        sourceTabId,
        text: document.text,
        normalizedUrl: document.normalizedUrl,
        documentKey: document.documentKey,
        contentHash: document.contentHash,
        findings: findingsByDocument.get(document.normalizedUrl) ?? [],
        settings,
        chunkCount: document.chunkCount,
        textLength: document.textLength,
        scannedAt
      });
    }

    reportProgress("Compiling findings for the popup…", 96);

    const primaryDocument = analyzedDocuments[0];
    const combinedContentHash = await hashText(analyzedDocuments.map((doc) => `${doc.documentKey}:${doc.contentHash}`).join("|"));

    const payload = {
      requestId: message.requestId,
      sourceTabId,
      status: "complete",
      progress: 100,
      error: false,
      url: primaryDocument.url,
      urls: analyzedDocuments.map((doc) => doc.url),
      normalizedUrl: primaryDocument.normalizedUrl,
      documentKey: primaryDocument.documentKey,
      contentHash: combinedContentHash,
      findings: allFindings,
      documents: analyzedDocuments,
      scannedAt: Date.now(),
      meta: {
        sensitivity: settings.sensitivity,
        model: settings.model,
        chunkCount: 1,
        textLength: analyzedDocuments.reduce((total, doc) => total + doc.textLength, 0),
        documentCount: analyzedDocuments.length,
        accepted: analyzedDocuments.length === 1
          ? await isAcceptedVersion(primaryDocument.documentKey, primaryDocument.contentHash)
          : false
      }
    };

    debugLog(settings, "analysis:complete", {
      requestId: message.requestId,
      findingCount: allFindings.length,
      documentCount: analyzedDocuments.length,
      model: settings.model
    });

    await mergeAnalysisState(sourceTabId, message.requestId, payload, null, "info");
    reportProgress("Review complete.", 100);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "Unknown analysis error.";
    const settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(DEFAULT_SETTINGS)) };
    debugLog(settings, "analysis:error", {
      requestId: message.requestId,
      sourceTabId,
      message: messageText
    });
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

function dedupeUrlList(urls) {
  return Array.from(new Set(urls.filter(Boolean)));
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

async function fetchDocumentHtml(url) {
  const controller = new AbortController();

  try {
    const response = await withTimeout(
      fetch(url, {
        redirect: "follow",
        headers: {
          Accept: "text/html,application/xhtml+xml"
        },
        signal: controller.signal
      }),
      DOCUMENT_FETCH_TIMEOUT_MS,
      () => {
        controller.abort("timeout");
      }
    );

    if (!response.ok) {
      throw new Error(`Fetch failed with status ${response.status} for ${url}.`);
    }

    return await withTimeout(
      response.text(),
      DOCUMENT_FETCH_TIMEOUT_MS,
      () => {
        controller.abort("timeout");
      }
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Fetching legal document timed out after 30 seconds for ${url}.`);
    }

    if (error instanceof Error && error.message === "TIMEOUT") {
      throw new Error(`Fetching legal document timed out after 30 seconds for ${url}.`);
    }

    throw error;
  }
}

function trimDocumentText(text, maxChars) {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n\n[Document trimmed for faster combined analysis.]`;
}

function limitDocumentsForCombinedAnalysis(documents, maxTotalChars) {
  let remainingChars = maxTotalChars;

  return documents.map((document, index) => {
    const reservedForRemainingDocs = Math.max(0, documents.length - index - 1) * 1000;
    const allowedChars = Math.max(1000, remainingChars - reservedForRemainingDocs);
    const nextText = trimDocumentText(document.text, allowedChars);
    remainingChars = Math.max(0, remainingChars - nextText.length);
    return {
      ...document,
      text: nextText
    };
  });
}

function withTimeout(promise, timeoutMs, onTimeout) {
  let timerId;

  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      onTimeout?.();
      reject(new Error("TIMEOUT"));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timerId);
  });
}

function debugLog(settings, event, payload = {}) {
  if (!settings?.debugMode) {
    return;
  }

  console.debug(`[DareToSign Debug] ${event}`, payload);
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
