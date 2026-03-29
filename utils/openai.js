import { buildPrompt, SYSTEM_PROMPT } from "./prompts.js";

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

async function requestFindings(prompt, settings) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${errorBody}`);
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI returned an empty response.");
  }

  const parsed = JSON.parse(content);
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (Array.isArray(parsed.findings)) {
    return parsed.findings;
  }

  throw new Error("OpenAI returned invalid JSON for findings.");
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
