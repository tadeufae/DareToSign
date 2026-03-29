const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "gpt-4.1-mini",
  sensitivity: "balanced",
  autoScan: false,
  showInlineBadges: true,
  language: "English",
  debugMode: false
};
const OPENAI_TIMEOUT_MS = 60_000;

const form = document.getElementById("settings-form");
const statusEl = document.getElementById("status");

void init();

async function init() {
  const settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(DEFAULT_SETTINGS)) };
  document.getElementById("api-key").value = settings.apiKey;
  document.getElementById("model").value = settings.model;
  document.getElementById("sensitivity").value = settings.sensitivity;
  document.getElementById("auto-scan").checked = settings.autoScan;
  document.getElementById("show-inline-badges").checked = settings.showInlineBadges;
  document.getElementById("debug-mode").checked = settings.debugMode;
  document.getElementById("language").value = settings.language;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const settings = {
    apiKey: document.getElementById("api-key").value.trim(),
    model: document.getElementById("model").value,
    sensitivity: document.getElementById("sensitivity").value,
    autoScan: document.getElementById("auto-scan").checked,
    showInlineBadges: document.getElementById("show-inline-badges").checked,
    debugMode: document.getElementById("debug-mode").checked,
    language: document.getElementById("language").value
  };

  statusEl.textContent = "Validating API key…";

  try {
    if (settings.apiKey) {
      await validateApiKey(settings.apiKey, settings.model);
    }

    await chrome.storage.local.set(settings);
    statusEl.textContent = "Settings saved.";
  } catch (error) {
    statusEl.textContent = error instanceof Error ? error.message : "Could not save settings.";
  }
});

async function validateApiKey(apiKey, model) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort("timeout");
  }, OPENAI_TIMEOUT_MS);

  let response;

  try {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: "Reply with the single word VALID."
          }
        ],
        max_completion_tokens: 5
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("OpenAI API key validation timed out after 60 seconds.");
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error("OpenAI API key validation failed.");
  }
}
