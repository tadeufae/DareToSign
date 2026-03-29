const CATEGORY_MAP = {
  lenient: [
    "Data sale to third parties",
    "Binding arbitration or class-action waiver",
    "Auto-renewal or hidden subscription",
    "Broad IP or content ownership grant",
    "Child data collection"
  ],
  balanced: [
    "Data sale to third parties",
    "Binding arbitration or class-action waiver",
    "Auto-renewal or hidden subscription",
    "Broad IP or content ownership grant",
    "Child data collection",
    "Unilateral terms changes without notice",
    "Account termination at will without refund",
    "Vague or indefinite data retention",
    "Broad indemnification clause",
    "Governing law in unfavorable jurisdiction"
  ],
  paranoid: [
    "Data sale to third parties",
    "Binding arbitration or class-action waiver",
    "Auto-renewal or hidden subscription",
    "Broad IP or content ownership grant",
    "Child data collection",
    "Unilateral terms changes without notice",
    "Account termination at will without refund",
    "Vague or indefinite data retention",
    "Broad indemnification clause",
    "Governing law in unfavorable jurisdiction",
    "Targeted advertising consent",
    "Cookie and fingerprinting tracking consent",
    "No warranty or as-is service clause",
    "Limitation of liability beyond legal minimums",
    "Any clause that reduces user rights or increases company rights"
  ]
};

export const SYSTEM_PROMPT =
  "You are a consumer-rights analyst, not a lawyer. Identify clauses that may disadvantage a user, and respond strictly as JSON.";

export function buildPrompt(text, sensitivity, language = "English") {
  const categories = CATEGORY_MAP[sensitivity] ?? CATEGORY_MAP.balanced;

  return `You are reviewing a Terms and Conditions, Privacy Policy, EULA, or legal agreement for an ordinary consumer.

Sensitivity level: ${sensitivity.toUpperCase()}
Respond in: ${language}

Only flag clauses that fit these categories:
${categories.map((category, index) => `${index + 1}. ${category}`).join("\n")}

Return only a JSON object with this shape:
{
  "findings": [
    {
      "category": string,
      "severity": "high" | "medium" | "low",
      "clause_excerpt": string,
      "plain_english": string,
      "why_it_matters": string
    }
  ]
}

Requirements:
- No markdown.
- No explanation outside JSON.
- Keep clause_excerpt under 300 characters.
- If nothing qualifies, return {"findings":[]}.

Document:
---
${text}
---`;
}
