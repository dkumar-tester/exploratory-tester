// llm/registry.js — LLM provider registry
// Manages provider config, dispatches calls through the right adapter
// All adapters normalize to: { action, reason, selector, confidence, learning }

import { callClaude } from "./claude.js";
import { callOpenAI } from "./openai.js";
import { callGemini } from "./gemini.js";
import { callCustom } from "./custom.js";

// Built-in provider definitions
export const PROVIDERS = {
  claude: {
    id: "claude",
    name: "Claude (Anthropic)",
    models: ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5-20251001"],
    defaultModel: "claude-sonnet-4-5",
    fields: ["apiKey"]
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
    defaultModel: "gpt-4o",
    fields: ["apiKey"]
  },
  gemini: {
    id: "gemini",
    name: "Gemini (Google)",
    models: ["gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.0-flash"],
    defaultModel: "gemini-1.5-pro",
    fields: ["apiKey"]
  },
  custom: {
    id: "custom",
    name: "Custom / Self-hosted",
    models: [],
    defaultModel: "",
    fields: ["baseUrl", "authKey", "authHeader", "model"]
  }
};

// Base system prompt — context layers injected dynamically per session
export const BASE_SYSTEM_PROMPT = `You are an expert QA engineer performing automated exploratory testing on a live web application inside a Chrome extension. You have the same capabilities as Playwright — you can fill forms, click buttons, select dropdowns, check boxes, submit forms, scroll, hover, and assert state.

Your response MUST be valid JSON only — no markdown, no explanation outside the JSON:
{
  "action": "click" | "type" | "select" | "check" | "uncheck" | "submit" | "clear" | "hover" | "focus" | "scroll" | "navigate" | "assert" | "smart_fill" | "observe" | "done",
  "selector": "CSS selector string or null",
  "value": "text to type / URL to navigate / option value / assertion text / scroll pixels — or null",
  "reason": "Why this action is valuable for testing (be specific)",
  "confidence": 0.0 to 1.0,
  "testType": "form_validation" | "navigation" | "ui_state" | "error_trigger" | "boundary_test" | "assertion" | "general",
  "learning": "One sentence observation useful for future steps, or null"
}

## Action Guide
- **click**: Click buttons, links, tabs, toggles. Scroll into view automatically.
- **type**: Type realistic text into text/email/password/textarea fields. Use real-world data.
- **select**: Choose an option in a <select> dropdown. value = the option value attribute.
- **check** / **uncheck**: Toggle checkboxes and radio buttons.
- **submit**: Submit the nearest form (triggers validation). selector = any element inside the form, or null.
- **clear**: Clear a field's value before re-typing.
- **hover**: Hover over element to reveal tooltips, dropdowns, or hidden menus.
- **focus**: Focus a field (useful to trigger validation messages).
- **scroll**: Scroll page down. value = pixels (e.g. "600"). selector = element to scroll into view.
- **navigate**: Go to a URL. value = absolute URL.
- **assert**: Verify element contains expected text. value = expected substring. Reports a finding if assertion fails.
- **smart_fill**: Fill ALL visible form fields at once using intent detection. Use this at the start of a form.
- **observe**: Take no action, just record a learning.
- **done**: Signal testing is complete on this page.

## Test Strategies
- **Form filling**: Use smart_fill first, then submit. Test with invalid data (bad email, too-long strings, XSS: <script>alert(1)</script>).
- **Boundary testing**: For number fields, try min-1, max+1, 0, negative numbers.
- **Error triggering**: Submit empty required forms, submit with invalid formats.
- **State validation**: After clicking, use assert to verify expected text appeared.
- **Navigation coverage**: Visit all unique internal links at least once.
- **Dropdown coverage**: Exercise all select options, not just the first.

## Realistic Test Data
- Email: test@example.com, invalid: notanemail, xss: test+<script>
- Password: Test@12345!, weak: 123, long: A repeated 300 times
- Name: John Doe
- Phone: 5551234567
- URL: https://example.com
- Number: use midpoint of min/max, then boundary values

## Rules
- Never repeat the same action+selector combo from history
- Prefer actions likely to reveal hidden bugs
- Use CDP log data to prioritize investigation of failing network calls
- Use heuristic suggestion as a fallback if uncertain
- If nothing meaningful remains, return action: "done"`;


// Build a context-enriched system prompt from the three-layer context model
export function buildSystemPrompt(mergedContext) {
  if (!mergedContext || !mergedContext.hasContext) return BASE_SYSTEM_PROMPT;

  const sections = [BASE_SYSTEM_PROMPT, "\n\n## Application Context"];

  // Environment layer
  if (mergedContext.environment) {
    sections.push(`**Environment:** ${mergedContext.environment.name} (${mergedContext.environment.baseUrl})`);
  }

  // App layer
  if (mergedContext.app) {
    const app = mergedContext.app;
    if (app.llmSummary || app.userDescription) {
      sections.push(`\n**Application Overview:**\n${app.llmSummary || app.userDescription}`);
    }
    if (app.keyFlows?.length) {
      sections.push(`\n**Key Flows to Test:**\n${app.keyFlows.map(f => `- ${f}`).join("\n")}`);
    }
    if (app.businessRules?.length) {
      sections.push(`\n**Business Rules & Constraints:**\n${app.businessRules.map(r => `- ${r}`).join("\n")}`);
    }
    if (app.riskyAreas?.length) {
      sections.push(`\n**Known Risky Areas (prioritize these):**\n${app.riskyAreas.map(r => `- ${r}`).join("\n")}`);
    }
  }

  // Page layer
  if (mergedContext.page) {
    const page = mergedContext.page;
    const desc = page.llmSummary || page.userDescription;
    if (desc) sections.push(`\n**This Page (${mergedContext.path}):**\n${desc}`);
    if (page.pageRules?.length) {
      sections.push(`**Page Rules:**\n${page.pageRules.map(r => `- ${r}`).join("\n")}`);
    }
  }

  // Dynamic layer — session learnings
  if (mergedContext.dynamic?.sessionLearnings?.length) {
    const recent = mergedContext.dynamic.sessionLearnings.slice(-15);
    sections.push(`\n**Session Learnings So Far:**\n${recent.map(l => `- ${l}`).join("\n")}`);
  }

  return sections.join("\n");
}

// Dispatch call to the correct adapter
// systemPrompt is optional — pass context-enriched one from buildSystemPrompt()
export async function dispatchLLM({ providerConfig, prompt, systemPrompt }) {
  const { provider, apiKey, model, baseUrl, authKey, authHeader } = providerConfig;
  const sp = systemPrompt || BASE_SYSTEM_PROMPT;

  switch (provider) {
    case "claude":
      return callClaude({ apiKey, model, prompt, systemPrompt: sp });
    case "openai":
      return callOpenAI({ apiKey, model, prompt, systemPrompt: sp });
    case "gemini":
      return callGemini({ apiKey, model, prompt, systemPrompt: sp });
    case "custom":
      return callCustom({ baseUrl, authKey, authHeader, model, prompt, systemPrompt: sp });
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}

// Load active provider config from chrome.storage
export async function getActiveProviderConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["llmProvider"], (result) => {
      resolve(result.llmProvider || null);
    });
  });
}

// Save provider config to chrome.storage
export async function saveProviderConfig(config) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ llmProvider: config }, resolve);
  });
}
