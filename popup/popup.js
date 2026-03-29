const els = {
  statusText: document.getElementById("status-text"),
  linkList: document.getElementById("link-list"),
  analyzeButton: document.getElementById("analyze-button"),
  resultsRoot: document.getElementById("results-root"),
  summaryScore: document.getElementById("summary-score"),
  analysisMeta: document.getElementById("analysis-meta"),
  acceptShell: document.getElementById("accept-shell"),
  acceptButton: document.getElementById("accept-button"),
  acceptStatus: document.getElementById("accept-status"),
  progressPanel: document.getElementById("progress-panel"),
  progressPercent: document.getElementById("progress-percent"),
  progressFill: document.getElementById("progress-fill"),
  progressStatus: document.getElementById("progress-status"),
  progressWait: document.getElementById("progress-wait"),
  progressDetails: document.getElementById("progress-details"),
  progressLog: document.getElementById("progress-log"),
  openOptions: document.getElementById("open-options")
};

let currentLinks = [];
let currentTabId = null;
let activeRequestId = null;
let progressEntries = [];
let waitTimerId = null;
let waitStartedAt = null;
let currentAnalysis = null;

void init();

async function init() {
  bindEvents();
  await refreshLinks();
}

function bindEvents() {
  els.analyzeButton.addEventListener("click", () => {
    void analyzeSelection();
  });

  els.acceptButton.addEventListener("click", () => {
    void acceptCurrentAnalysis();
  });

  els.openOptions.addEventListener("click", () => {
    void chrome.runtime.openOptionsPage();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (
      message?.type !== "ANALYSIS_PROGRESS" ||
      message.tabId !== currentTabId ||
      message.requestId !== activeRequestId
    ) {
      return undefined;
    }

    updateProgressUi(message.progress, message.status, message.level, message.timestamp ?? Date.now());

    if (message.progress >= 100) {
      void restoreAnalysisState(currentTabId);
    }

    return undefined;
  });
}

async function refreshLinks() {
  setStatus("Checking this page…");
  renderResults([], { hasScanResult: false });
  els.analysisMeta.textContent = "";
  hideAcceptance();

  const tab = await getActiveTab();
  if (!tab?.id) {
    setStatus("No active browser tab found.");
    renderLinks([]);
    return;
  }

  currentTabId = tab.id;

  const settings = await getSettings();
  if (!settings.hasApiKey) {
    setStatus("Add an OpenAI API key in Settings to enable scans.");
  }

  let links = [];

  try {
    const contentResponse = await chrome.tabs.sendMessage(tab.id, { type: "GET_TC_LINKS" });
    links = contentResponse?.links ?? [];
  } catch {
    const fallback = await chrome.runtime.sendMessage({ type: "GET_TAB_LINKS", tabId: tab.id });
    links = fallback?.links ?? [];
  }

  currentLinks = links;
  renderLinks(links);
  const hasPersistentAnalysisState = await restoreAnalysisState(tab.id);

  if (links.length === 0) {
    if (!hasPersistentAnalysisState) {
      setStatus("No terms, privacy, or legal links detected on this page.");
    }
    return;
  }

  if (hasPersistentAnalysisState) {
    return;
  }

  const suffix = settings.settings.autoScan ? " Auto-scan is enabled in settings." : "";
  setStatus(
    `${links.length} legal link${links.length === 1 ? "" : "s"} detected. All found terms will be analyzed together.${suffix}`
  );
}

async function analyzeSelection() {
  if (!currentLinks.length) {
    return;
  }

  activeRequestId = crypto.randomUUID();
  progressEntries = [];
  showProgressPanel();
  updateProgressUi(4, "Queued analysis request.", "info");
  els.analyzeButton.disabled = true;
  els.analyzeButton.textContent = "Analyzing…";
  setStatus("Fetching legal documents and calling OpenAI…");
  els.analysisMeta.textContent = "";
  hideAcceptance();

  try {
    const response = await chrome.runtime.sendMessage({
      type: "ANALYZE_URL",
      urls: currentLinks.map((link) => link.href),
      requestId: activeRequestId,
      tabId: currentTabId
    });

    if (response?.error) {
      throw new Error(response.message);
    }
    activeRequestId = response.requestId || activeRequestId;
    setStatus("Analysis running in the background for this tab.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown analysis error.";
    setStatus(message);
    updateProgressUi(100, message, "error");
    renderResults([], { hasScanResult: false });
    els.analyzeButton.disabled = currentLinks.length === 0;
    els.analyzeButton.textContent = "Analyze Terms Found";
  }
}

function renderLinks(links) {
  els.linkList.innerHTML = "";
  els.analyzeButton.disabled = links.length === 0;

  if (links.length === 0) {
    els.linkList.innerHTML = '<div class="empty-state">Visit a page with a Terms, Privacy, Legal, or EULA link to scan it.</div>';
    return;
  }

  for (const link of links) {
    const wrapper = document.createElement("div");
    wrapper.className = "link-item";
    wrapper.innerHTML = `
      <div class="link-pick">
        <div class="link-copy">
          <p class="link-title">${escapeHtml(link.text || "Untitled document")}</p>
          <details class="link-url-shell">
            <summary class="link-url-toggle">Show link</summary>
            <p class="link-url-full">${escapeHtml(link.href)}</p>
          </details>
          <p class="link-url-preview" title="${escapeHtml(link.href)}">${escapeHtml(link.href)}</p>
        </div>
      </div>
    `;

    els.linkList.appendChild(wrapper);
  }
}

function renderResults(findings, options = {}) {
  const { hasScanResult = true } = options;
  els.resultsRoot.innerHTML = "";
  hideAcceptance();

  if (!findings.length) {
    if (hasScanResult) {
      els.summaryScore.textContent = "No major concerns found at this sensitivity.";
      els.resultsRoot.innerHTML =
        '<div class="empty-state">This review completed, but no clauses met the current sensitivity threshold. Try a stricter sensitivity level if you want a more aggressive scan.</div>';
      return;
    }

    els.summaryScore.textContent = "No analysis yet.";
    els.resultsRoot.innerHTML = '<div class="empty-state">Run an analysis to see grouped clause findings here.</div>';
    return;
  }

  const groups = {
    high: [],
    medium: [],
    low: []
  };

  for (const finding of findings) {
    const severity = String(finding.severity || "low").toLowerCase();
    (groups[severity] ?? groups.low).push(finding);
  }

  els.summaryScore.textContent = summarizeScore(groups);

  for (const severity of ["high", "medium", "low"]) {
    if (groups[severity].length === 0) {
      continue;
    }

    const section = document.createElement("section");
    section.className = "severity-group";

    const title = document.createElement("h3");
    title.className = `severity-title ${severity}`;
    title.textContent = `${severity.toUpperCase()} RISK`;
    section.appendChild(title);

    for (const finding of groups[severity]) {
      const article = document.createElement("article");
      article.className = "finding";
      article.innerHTML = `
        <span class="category-badge">${escapeHtml(finding.category || "Uncategorized")}</span>
        <h4>${escapeHtml(finding.plain_english || "Potentially risky clause detected.")}</h4>
        <p>${escapeHtml(finding.why_it_matters || "")}</p>
        <details>
          <summary>See clause</summary>
          <p>${escapeHtml(finding.clause_excerpt || "No excerpt returned.")}</p>
        </details>
      `;
      section.appendChild(article);
    }

    els.resultsRoot.appendChild(section);
  }
}

function summarizeScore(groups) {
  if (groups.high.length >= 3) {
    return "This T&C reads as Aggressive.";
  }

  if (groups.high.length > 0 || groups.medium.length >= 3) {
    return "This T&C reads as Moderate.";
  }

  return "This T&C reads as Standard.";
}

function setStatus(text) {
  els.statusText.textContent = text;
}

function showProgressPanel() {
  els.progressPanel.hidden = false;
  els.progressLog.innerHTML = "";
  els.progressDetails.open = false;
}

function updateProgressUi(progress, status, level = "info", timestamp = Date.now()) {
  const safeProgress = Math.max(0, Math.min(100, Math.round(progress)));
  els.progressPercent.textContent = `${safeProgress}%`;
  els.progressFill.style.width = `${safeProgress}%`;
  els.progressStatus.textContent = status;

  progressEntries.unshift({ status, level, timestamp });
  progressEntries = progressEntries.slice(0, 6);
  els.progressLog.innerHTML = progressEntries
    .map(
      (entry) =>
        `<div class="progress-entry${entry.level === "error" ? " error" : ""}">${escapeHtml(entry.status)}</div>`
    )
    .join("");

  syncWaitState(status, timestamp);

  if (safeProgress >= 100) {
    stopWaitTimer();
    els.analyzeButton.disabled = currentLinks.length === 0;
    els.analyzeButton.textContent = "Analyze Terms Found";
  }
}

async function getSettings() {
  const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
  return {
    settings: response?.settings ?? {},
    hasApiKey: Boolean(response?.hasApiKey)
  };
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function restoreAnalysisState(tabId) {
  const response = await chrome.runtime.sendMessage({ type: "GET_ANALYSIS_STATE", tabId });
  const analysis = response?.analysis;

  if (!analysis) {
    activeRequestId = null;
    currentAnalysis = null;
    progressEntries = [];
    els.progressPanel.hidden = true;
    stopWaitTimer();
    hideAcceptance();
    return false;
  }

  activeRequestId = analysis.requestId ?? null;
  currentAnalysis = analysis.status === "complete" ? analysis : null;
  showProgressPanel();
  progressEntries = Array.isArray(analysis.log)
    ? analysis.log.map((entry) => ({ status: entry.message, level: entry.level, timestamp: entry.timestamp }))
    : [];
  updateProgressUi(
    analysis.progress ?? 0,
    analysis.status === "ready" ? "Ready to analyze." : getAnalysisStatusLabel(analysis),
    analysis.error ? "error" : "info",
    progressEntries[0]?.timestamp ?? Date.now()
  );

  if (analysis.status === "running") {
    hideAcceptance();
    els.analyzeButton.disabled = true;
    els.analyzeButton.textContent = "Analyzing…";
    setStatus("Analysis running in the background for this tab.");
    return true;
  }

  hideAcceptance();
  els.analyzeButton.disabled = currentLinks.length === 0;
  els.analyzeButton.textContent = "Analyze Terms Found";

  if (analysis.status === "complete") {
    renderResults(analysis.findings ?? [], { hasScanResult: true });
    if (analysis.meta) {
      els.analysisMeta.textContent = `Model: ${analysis.meta.model} · Sensitivity: ${analysis.meta.sensitivity} · Docs: ${analysis.meta.documentCount ?? 1} · Chunks: ${analysis.meta.chunkCount}`;
    }
    renderAcceptance(analysis);
    setStatus("Showing the latest completed analysis for this tab.");
    return true;
  }

  if (analysis.status === "error") {
    renderResults([], { hasScanResult: false });
    hideAcceptance();
    setStatus(analysis.message || "Analysis failed.");
    return true;
  }

  return true;
}

function getAnalysisStatusLabel(analysis) {
  if (progressEntries.length > 0) {
    return progressEntries[0].status;
  }

  if (analysis.status === "complete") {
    return "Review complete.";
  }

  if (analysis.status === "error") {
    return analysis.message || "Analysis failed.";
  }

  return "Background analysis in progress.";
}

function syncWaitState(status, timestamp) {
  if (status.startsWith("API call sent for")) {
    startWaitTimer(timestamp);
    return;
  }

  if (
    status.startsWith("Review returned for") ||
    status.startsWith("Compiling findings") ||
    status.startsWith("Review complete") ||
    status.startsWith("Analysis failed")
  ) {
    stopWaitTimer();
  }
}

function startWaitTimer(timestamp) {
  waitStartedAt = timestamp;
  els.progressWait.hidden = false;
  renderWaitTimer();

  if (waitTimerId) {
    return;
  }

  waitTimerId = window.setInterval(() => {
    renderWaitTimer();
  }, 1000);
}

function stopWaitTimer() {
  if (waitTimerId) {
    window.clearInterval(waitTimerId);
    waitTimerId = null;
  }

  waitStartedAt = null;
  els.progressWait.hidden = true;
  els.progressWait.textContent = "";
}

function renderWaitTimer() {
  if (!waitStartedAt) {
    return;
  }

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - waitStartedAt) / 1000));
  els.progressWait.textContent = `Waiting for model response: ${elapsedSeconds}s`;
}

function renderAcceptance(analysis) {
  if ((analysis.meta?.documentCount ?? 1) !== 1) {
    hideAcceptance();
    return;
  }

  els.acceptShell.hidden = false;
  els.acceptShell.style.display = "grid";
  const isAccepted = Boolean(analysis.meta?.accepted);
  els.acceptButton.disabled = isAccepted;
  els.acceptButton.textContent = isAccepted ? "Accepted: this exact version" : "That's fine, I don't mind";
  els.acceptStatus.textContent = isAccepted
    ? "You already accepted this exact terms version."
    : "Accept this exact version so DareToSign stops flagging it again.";
}

function hideAcceptance() {
  els.acceptShell.hidden = true;
  els.acceptShell.style.display = "none";
  els.acceptButton.disabled = false;
  els.acceptButton.textContent = "That's fine, I don't mind";
  els.acceptStatus.textContent = "";
}

async function acceptCurrentAnalysis() {
  if (!currentAnalysis || currentAnalysis.status !== "complete" || !currentTabId) {
    return;
  }

  els.acceptButton.disabled = true;
  els.acceptStatus.textContent = "Saving acceptance locally…";

  const response = await chrome.runtime.sendMessage({
    type: "ACCEPT_ANALYSIS",
    tabId: currentTabId
  });

  if (response?.error) {
    els.acceptButton.disabled = false;
    els.acceptStatus.textContent = response.message || "Could not save acceptance.";
    return;
  }

  await restoreAnalysisState(currentTabId);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
