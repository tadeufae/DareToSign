import { buildCombinedPrompt, buildPrompt, SYSTEM_PROMPT } from "./prompts.js";

const OPENAI_TIMEOUT_MS = 60_000;
const MAX_COMPLETION_TOKENS = 4000;
const FALLBACK_MODEL = "gpt-4.1-mini";
const FINDINGS_JSON_SCHEMA = {
  name: "terms_findings",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            document_url: { type: "string" },
            category: { type: "string" },
            severity: {
              type: "string",
              enum: ["high", "medium", "low"]
            },
            clause_excerpt: { type: "string" },
            plain_english: { type: "string" },
            why_it_matters: { type: "string" }
          },
          required: [
            "document_url",
            "category",
            "severity",
            "clause_excerpt",
            "plain_english",
            "why_it_matters"
          ]
        }
      }
    },
    required: ["findings"]
  }
};

export async function analyzeDocumentChunks(chunks, settings, onProgress = () => {}) {
  const findings = [];

  onProgress(
    chunks.length > 1 ? `Starting AI review across ${chunks.length} chunks…` : "Starting AI review…",
    48
  );

  for (const [index, chunk] of chunks.entries()) {
    const prompt = buildPrompt(chunk, settings.sensitivity, settings.language);
    const chunkLabel = chunks.length > 1 ? `chunk ${index + 1}/${chunks.length}` : "document";
    const sentProgress = 50 + Math.round((index / chunks.length) * 34);
    onProgress(`API call sent for ${chunkLabel}.`, sentProgress);
    const chunkFindings = await requestFindings(prompt, settings);
    const receivedProgress = 58 + Math.round(((index + 1) / chunks.length) * 30);
    onProgress(`Review returned for ${chunkLabel}.`, receivedProgress);
    findings.push(...chunkFindings);
  }

  onProgress("Deduplicating repeated findings…", 92);
  return dedupeFindings(findings);
}

export async function analyzeCombinedDocuments(documents, settings, onProgress = () => {}) {
  onProgress(
    documents.length > 1
      ? `Starting one combined AI review across ${documents.length} documents…`
      : "Starting one combined AI review…",
    48
  );

  const prompt = buildCombinedPrompt(documents, settings.sensitivity, settings.language);
  onProgress("API call sent for combined review.", 58);
  const findings = await requestFindings(prompt, settings);
  onProgress("Review returned for combined review.", 88);
  onProgress("Deduplicating repeated findings…", 92);
  return dedupeFindings(findings);
}

async function requestFindings(prompt, settings) {
  try {
    return await requestFindingsWithRetry(prompt, settings);
  } catch (error) {
    debugLog(settings, "openai:request-error", {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined
    });

    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("OpenAI review timed out after 60 seconds. Try again or switch to a faster model.");
    }

    if (error instanceof Error && error.message === "TIMEOUT") {
      throw new Error("OpenAI review timed out after 60 seconds. Try again or switch to a faster model.");
    }

    throw error;
  }
}

async function requestFindingsWithRetry(prompt, settings) {
  const primaryAttempt = buildAttemptConfig(settings.model);
  const primaryResult = await executeOpenAiRequest(prompt, settings, primaryAttempt);

  if (primaryResult.ok) {
    return primaryResult.findings;
  }

  const shouldFallback =
    settings.model !== FALLBACK_MODEL &&
    (primaryResult.reason === "empty_length" || primaryResult.reason === "invalid_json");

  if (!shouldFallback) {
    throw new Error(primaryResult.message);
  }

  debugLog(settings, "openai:fallback", {
    fromModel: settings.model,
    toModel: FALLBACK_MODEL,
    reason: primaryResult.reason
  });

  const fallbackResult = await executeOpenAiRequest(prompt, settings, buildAttemptConfig(FALLBACK_MODEL));
  if (fallbackResult.ok) {
    return fallbackResult.findings;
  }

  throw new Error(fallbackResult.message);
}

async function executeOpenAiRequest(prompt, settings, attempt) {
  const controller = new AbortController();
  debugLog(settings, "openai:request-start", {
    model: attempt.model,
    promptChars: prompt.length,
    estimatedPromptTokens: Math.ceil(prompt.length / 4),
    maxCompletionTokens: attempt.maxCompletionTokens,
    reasoningEffort: attempt.reasoningEffort ?? null
  });

  const requestBody = {
    model: attempt.model,
    response_format: {
      type: "json_schema",
      json_schema: FINDINGS_JSON_SCHEMA
    },
    max_completion_tokens: attempt.maxCompletionTokens,
    messages: [
      {
        role: "developer",
        content: SYSTEM_PROMPT
      },
      {
        role: "user",
        content: prompt
      }
    ]
  };

  if (attempt.reasoningEffort) {
    requestBody.reasoning_effort = attempt.reasoningEffort;
  }

  const response = await withTimeout(
    fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    }),
    OPENAI_TIMEOUT_MS,
    () => {
      controller.abort("timeout");
    }
  );

  if (!response.ok) {
    const errorBody = await withTimeout(
      response.text(),
      OPENAI_TIMEOUT_MS,
      () => {
        controller.abort("timeout");
      }
    );
    debugLog(settings, "openai:response-error", {
      model: attempt.model,
      status: response.status,
      bodyPreview: errorBody.slice(0, 800)
    });
    return {
      ok: false,
      reason: "http_error",
      message: `OpenAI request failed: ${response.status} ${errorBody}`
    };
  }

  debugLog(settings, "openai:response-headers", {
    model: attempt.model,
    status: response.status,
    contentType: response.headers.get("content-type"),
    requestId: response.headers.get("x-request-id")
  });

  const payload = await withTimeout(
    response.json(),
    OPENAI_TIMEOUT_MS,
    () => {
      controller.abort("timeout");
    }
  );
  const choice = payload.choices?.[0];
  const refusal = choice?.message?.refusal;
  debugLog(settings, "openai:response-body", {
    model: attempt.model,
    id: payload.id,
    usage: payload.usage ?? null,
    finishReason: choice?.finish_reason ?? null,
    refusal: refusal ?? null,
    contentType: Array.isArray(choice?.message?.content) ? "array" : typeof choice?.message?.content,
    hasContent: Boolean(choice?.message?.content)
  });

  if (refusal) {
    return {
      ok: false,
      reason: "refusal",
      message: `OpenAI refused the review: ${refusal}`
    };
  }

  const content = extractMessageContent(choice?.message?.content);
  if (!content) {
    return {
      ok: false,
      reason: choice?.finish_reason === "length" ? "empty_length" : "empty",
      message: `OpenAI returned an empty response. Finish reason: ${choice?.finish_reason ?? "unknown"}.`
    };
  }

  debugLog(settings, "openai:content-preview", {
    model: attempt.model,
    preview: content.slice(0, 500)
  });

  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return { ok: true, findings: parsed };
    }

    if (Array.isArray(parsed.findings)) {
      return { ok: true, findings: parsed.findings };
    }
  } catch (error) {
    debugLog(settings, "openai:parse-error", {
      model: attempt.model,
      message: error instanceof Error ? error.message : String(error)
    });
    return {
      ok: false,
      reason: "invalid_json",
      message: "OpenAI returned invalid JSON for findings."
    };
  }

  return {
    ok: false,
    reason: "invalid_json",
    message: "OpenAI returned invalid JSON for findings."
  };
}

function buildAttemptConfig(model) {
  if (isReasoningModel(model)) {
    return {
      model,
      maxCompletionTokens: MAX_COMPLETION_TOKENS,
      reasoningEffort: "low"
    };
  }

  return {
    model,
    maxCompletionTokens: 1800,
    reasoningEffort: null
  };
}

function isReasoningModel(model) {
  return typeof model === "string" && model.startsWith("gpt-5");
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

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.category}::${finding.severity}::${finding.clause_excerpt}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function extractMessageContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (part?.type === "text" && typeof part.text === "string") {
        return part.text;
      }

      return "";
    })
    .join("")
    .trim();
}
