// llm/claude.js — Anthropic Claude adapter
// Normalizes Claude API calls to the shared LLM interface

export async function callClaude({ apiKey, model = "claude-opus-4-5", prompt, systemPrompt }) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Claude API error: ${err.error?.message || response.status}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || "";
  return parseStructuredResponse(text);
}

// Extract JSON from model response safely
function parseStructuredResponse(text) {
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    // Return raw text as action description if JSON parse fails
    return { action: "observe", reason: text, selector: null };
  }
}
