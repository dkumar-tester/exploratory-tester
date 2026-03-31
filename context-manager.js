// context-manager.js
// Manages three-layer context: App → Page → Dynamic
// Handles: seed from pasted text, LLM extraction, smart merge with diff, manual edit

import { dispatchLLM, getActiveProviderConfig } from "./llm/registry.js";

// ─── Storage Keys ─────────────────────────────────────────────────────────────
const CONTEXT_KEY = "et_contexts";      // app + page contexts
const ENV_KEY     = "et_environments";  // named environments

// ─── Context Structure ────────────────────────────────────────────────────────
// {
//   [domain]: {
//     app: { userDescription, llmSummary, keyFlows[], businessRules[], riskyAreas[], lastUpdated },
//     pages: {
//       [path]: { userDescription, llmSummary, lastUpdated }
//     },
//     dynamic: {
//       sessionLearnings[], confirmedBehaviors[], unexpectedBehaviors[]
//     }
//   }
// }

// ─── Load / Save ──────────────────────────────────────────────────────────────

export async function loadAllContexts() {
  return new Promise(resolve => {
    chrome.storage.local.get([CONTEXT_KEY], r => resolve(r[CONTEXT_KEY] || {}));
  });
}

export async function saveAllContexts(contexts) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [CONTEXT_KEY]: contexts }, resolve);
  });
}

export async function loadEnvironments() {
  return new Promise(resolve => {
    chrome.storage.local.get([ENV_KEY], r => resolve(r[ENV_KEY] || []));
  });
}

export async function saveEnvironments(envs) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [ENV_KEY]: envs }, resolve);
  });
}

// ─── Domain / Path Helpers ────────────────────────────────────────────────────

export function parseDomain(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

export function parsePath(url) {
  try {
    const u = new URL(url);
    return u.pathname || "/";
  } catch { return "/"; }
}

// Get or create context shell for a domain
function ensureDomainContext(contexts, domain) {
  if (!contexts[domain]) {
    contexts[domain] = {
      app: { userDescription: "", llmSummary: "", keyFlows: [], businessRules: [], riskyAreas: [], lastUpdated: null },
      pages: {},
      dynamic: { sessionLearnings: [], confirmedBehaviors: [], unexpectedBehaviors: [] }
    };
  }
  return contexts[domain];
}

// ─── Get Merged Context for LLM Prompt ───────────────────────────────────────
// Returns a flat merged object with all three layers for injection into prompts

export async function getMergedContext(url) {
  const contexts = await loadAllContexts();
  const domain = parseDomain(url);
  const path = parsePath(url);
  const envs = await loadEnvironments();

  const domainCtx = contexts[domain] || null;
  const pageCtx = domainCtx?.pages?.[path] || null;
  const dynamic = domainCtx?.dynamic || null;

  // Match environment
  const env = envs.find(e => url.startsWith(e.baseUrl));

  return {
    domain,
    path,
    environment: env ? { name: env.name, baseUrl: env.baseUrl } : null,
    app: domainCtx?.app || null,
    page: pageCtx || null,
    dynamic: dynamic || null,
    hasContext: !!(domainCtx?.app?.llmSummary || domainCtx?.app?.userDescription)
  };
}

// ─── Seed: Analyze Pasted Text ────────────────────────────────────────────────
// Takes raw pasted text (PRD, spec, user story, etc.)
// Returns structured extraction for user to review before saving

export async function analyzeSeedText({ text, url }) {
  const providerConfig = await getActiveProviderConfig();
  if (!providerConfig) throw new Error("No LLM provider configured");

  const domain = parseDomain(url);
  const path = parsePath(url);

  const prompt = `
You are a QA expert. Analyze the following document/text about a web application and extract structured testing context.

Current URL being tested: ${url}
Domain: ${domain}
Path: ${path}

--- DOCUMENT START ---
${text.slice(0, 6000)}
--- DOCUMENT END ---

Return ONLY valid JSON (no markdown, no explanation) in this exact structure:
{
  "appSummary": "2-3 sentence description of the application purpose",
  "keyFlows": ["list of main user flows to test"],
  "businessRules": ["list of business rules, validations, constraints"],
  "riskyAreas": ["list of areas most likely to have bugs"],
  "pageSpecific": {
    "summary": "what this specific page (${path}) does, or empty string if not mentioned",
    "rules": ["page-specific rules or behaviors"]
  },
  "suggestedTestCases": ["3-5 specific test cases derived from the document"]
}
`.trim();

  const result = await dispatchLLM({ providerConfig, prompt });
  return result;
}

// ─── Smart Merge ──────────────────────────────────────────────────────────────
// Compares new LLM extraction with existing context
// Returns a diff proposal for user review

export async function proposeContextMerge({ existing, incoming, url }) {
  const providerConfig = await getActiveProviderConfig();
  if (!providerConfig) {
    // No LLM — just return incoming as full replacement proposal
    return buildSimpleDiff(existing, incoming);
  }

  const prompt = `
You are a QA knowledge manager. Compare existing context with new information and propose a smart merge.

EXISTING CONTEXT:
${JSON.stringify(existing, null, 2)}

NEW INFORMATION:
${JSON.stringify(incoming, null, 2)}

Rules:
- ADD: new information not in existing
- UPDATE: existing item that should be replaced with more accurate info
- KEEP: existing item that remains valid
- REMOVE: existing item contradicted by new info

Return ONLY valid JSON:
{
  "appSummary": { "action": "ADD|UPDATE|KEEP", "value": "merged summary", "reason": "why" },
  "keyFlows": { "action": "ADD|UPDATE|KEEP", "added": [], "removed": [], "kept": [], "reason": "why" },
  "businessRules": { "action": "ADD|UPDATE|KEEP", "added": [], "removed": [], "kept": [], "reason": "why" },
  "riskyAreas": { "action": "ADD|UPDATE|KEEP", "added": [], "removed": [], "kept": [], "reason": "why" },
  "summary": "One sentence describing what changed overall"
}
`.trim();

  try {
    const result = await dispatchLLM({ providerConfig, prompt });
    return result;
  } catch {
    return buildSimpleDiff(existing, incoming);
  }
}

// Fallback diff when LLM unavailable
function buildSimpleDiff(existing, incoming) {
  const existingFlows = existing?.keyFlows || [];
  const incomingFlows = incoming?.keyFlows || [];
  const added = incomingFlows.filter(f => !existingFlows.includes(f));
  const kept = existingFlows;

  return {
    appSummary: { action: incoming.appSummary ? "UPDATE" : "KEEP", value: incoming.appSummary || existing?.appSummary, reason: "Direct replacement" },
    keyFlows: { action: "ADD", added, removed: [], kept, reason: "Appended new flows" },
    businessRules: { action: "ADD", added: incoming.businessRules || [], removed: [], kept: existing?.businessRules || [], reason: "Appended new rules" },
    riskyAreas: { action: "ADD", added: incoming.riskyAreas || [], removed: [], kept: existing?.riskyAreas || [], reason: "Appended new areas" },
    summary: "Merged new input with existing context"
  };
}

// ─── Apply Merge ──────────────────────────────────────────────────────────────
// Takes approved merge proposal and writes to storage

export async function applyMerge({ url, mergeProposal, seedExtraction, userDescription }) {
  const contexts = await loadAllContexts();
  const domain = parseDomain(url);
  const path = parsePath(url);
  const ctx = ensureDomainContext(contexts, domain);

  // Apply app-level merge
  ctx.app.userDescription = userDescription || ctx.app.userDescription;
  ctx.app.llmSummary = mergeProposal.appSummary?.value || ctx.app.llmSummary;

  // Merge arrays
  const mergeArray = (existing, proposal) => {
    const kept = proposal?.kept || existing || [];
    const added = proposal?.added || [];
    const removed = new Set(proposal?.removed || []);
    return [...kept.filter(i => !removed.has(i)), ...added];
  };

  ctx.app.keyFlows = mergeArray(ctx.app.keyFlows, mergeProposal.keyFlows);
  ctx.app.businessRules = mergeArray(ctx.app.businessRules, mergeProposal.businessRules);
  ctx.app.riskyAreas = mergeArray(ctx.app.riskyAreas, mergeProposal.riskyAreas);
  ctx.app.lastUpdated = Date.now();

  // Apply page-level if present
  if (seedExtraction?.pageSpecific?.summary) {
    if (!ctx.pages[path]) ctx.pages[path] = { userDescription: "", llmSummary: "", lastUpdated: null };
    ctx.pages[path].llmSummary = seedExtraction.pageSpecific.summary;
    ctx.pages[path].pageRules = seedExtraction.pageSpecific.rules || [];
    ctx.pages[path].lastUpdated = Date.now();
  }

  await saveAllContexts(contexts);
  return ctx;
}

// ─── Manual Save (direct edit, no merge) ─────────────────────────────────────

export async function saveManualContext({ url, appDescription, pageDescription, keyFlows, businessRules, riskyAreas }) {
  const contexts = await loadAllContexts();
  const domain = parseDomain(url);
  const path = parsePath(url);
  const ctx = ensureDomainContext(contexts, domain);

  if (appDescription !== undefined) ctx.app.userDescription = appDescription;
  if (keyFlows !== undefined) ctx.app.keyFlows = keyFlows;
  if (businessRules !== undefined) ctx.app.businessRules = businessRules;
  if (riskyAreas !== undefined) ctx.app.riskyAreas = riskyAreas;
  ctx.app.lastUpdated = Date.now();

  if (pageDescription !== undefined) {
    if (!ctx.pages[path]) ctx.pages[path] = { userDescription: "", llmSummary: "", lastUpdated: null };
    ctx.pages[path].userDescription = pageDescription;
    ctx.pages[path].lastUpdated = Date.now();
  }

  await saveAllContexts(contexts);
  return ctx;
}

// ─── Dynamic Context: Append Session Learnings ───────────────────────────────

export async function appendSessionLearning({ url, learning }) {
  const contexts = await loadAllContexts();
  const domain = parseDomain(url);
  const ctx = ensureDomainContext(contexts, domain);

  if (!ctx.dynamic.sessionLearnings.includes(learning)) {
    ctx.dynamic.sessionLearnings.push(learning);
    // Cap at 50 learnings to avoid token bloat
    if (ctx.dynamic.sessionLearnings.length > 50) {
      ctx.dynamic.sessionLearnings = ctx.dynamic.sessionLearnings.slice(-50);
    }
    await saveAllContexts(contexts);
  }
}

export async function clearDynamicContext(url) {
  const contexts = await loadAllContexts();
  const domain = parseDomain(url);
  if (contexts[domain]) {
    contexts[domain].dynamic = { sessionLearnings: [], confirmedBehaviors: [], unexpectedBehaviors: [] };
    await saveAllContexts(contexts);
  }
}

// ─── Environment Helpers ──────────────────────────────────────────────────────

export async function matchEnvironment(url) {
  const envs = await loadEnvironments();
  return envs.find(e => url.startsWith(e.baseUrl)) || null;
}

export async function addEnvironment({ name, baseUrl, description }) {
  const envs = await loadEnvironments();
  const existing = envs.findIndex(e => e.baseUrl === baseUrl);
  const env = { id: `env_${Date.now()}`, name, baseUrl, description: description || "", createdAt: Date.now() };

  if (existing >= 0) envs[existing] = env;
  else envs.push(env);

  await saveEnvironments(envs);
  return env;
}

export async function removeEnvironment(id) {
  const envs = await loadEnvironments();
  await saveEnvironments(envs.filter(e => e.id !== id));
}
