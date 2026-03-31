// llm/custom.js — Generic REST adapter for custom LLM endpoints
// Supports any OpenAI-compatible API (Ollama, LM Studio, Azure OpenAI, etc.)

export async function callCustom({ baseUrl, authKey, authHeader = "Authorization", model = "default", prompt, systemPrompt }) {
  // Normalize base URL — remove trailing slash
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  const headers = {
    "Content-Type": "application/json"
  };

  // Support Bearer token or raw key depending on authHeader config
  if (authKey) {
    headers[authHeader] = authHeader === "Authorization"
      ? `Bearer ${authKey}`
      : authKey;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`Custom LLM API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  // Try OpenAI-compatible response shape first, then fallback
  const text =
    data.choices?.[0]?.message?.content ||
    data.content?.[0]?.text ||
    data.response ||
    data.output ||
    "";

  return parseStructuredResponse(text);
}

function parseStructuredResponse(text) {
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return { action: "observe", reason: text, selector: null };
  }
}
