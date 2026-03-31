// sidepanel.js — Full side panel controller
// Handles: findings, LLM activity, context tab (seed/analyze/diff/manual edit), environments, settings

// ─── State ────────────────────────────────────────────────────────────────────
let findings = [];
let activities = [];
let cdpLogs = [];
let activeFilter = "all";
let currentUrl = "";
let currentDomain = "";
let pendingExtraction = null;   // LLM extraction awaiting merge confirm
let pendingMerge = null;        // Merge proposal awaiting user confirm
let editMode = "view";          // "view" | "edit"

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const btnStart = document.getElementById("btnStart");
const btnStop = document.getElementById("btnStop");
const btnExport = document.getElementById("btnExport");
const statusDot = document.getElementById("statusDot");
const statFindings = document.getElementById("statFindings");
const statActions = document.getElementById("statActions");
const envBadge = document.getElementById("envBadge");
const findingsBadge = document.getElementById("findingsBadge");
const findingsList = document.getElementById("findingsList");
const activityFeed = document.getElementById("activityFeed");
const ctxPill = document.getElementById("ctxPill");
const ctxCurrentUrl = document.getElementById("ctxCurrentUrl");
const providerSelect = document.getElementById("providerSelect");
const connStatus = document.getElementById("connStatus");

// Context tab
const seedText = document.getElementById("seedText");
const btnAnalyze = document.getElementById("btnAnalyze");
const btnClearCtx = document.getElementById("btnClearCtx");
const btnViewMode = document.getElementById("btnViewMode");
const btnEditMode = document.getElementById("btnEditMode");
const llmView = document.getElementById("llmView");
const manualFields = document.getElementById("manualFields");
const diffPreview = document.getElementById("diffPreview");
const diffSummary = document.getElementById("diffSummary");
const diffRows = document.getElementById("diffRows");
const btnConfirmMerge = document.getElementById("btnConfirmMerge");
const btnSaveManual = document.getElementById("btnSaveManual");
const btnSavePageCtx = document.getElementById("btnSavePageCtx");
const learningList = document.getElementById("learningList");
const btnClearDynamic = document.getElementById("btnClearDynamic");

// ─── Tab Switching ─────────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add("active");
  });
});

ctxPill.addEventListener("click", () => {
  document.querySelector('[data-tab="context"]').click();
});

// ─── Session Controls ─────────────────────────────────────────────────────────
btnStart.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const maxActions = parseInt(document.getElementById("maxActions").value) || 30;
  const providerConfig = await getProviderConfig();
  findings = []; activities = [];
  renderFindings(); renderActivity();
  await chrome.runtime.sendMessage({
    type: "START_SESSION", tabId: tab.id, tabUrl: tab.url,
    options: { llmEnabled: !!providerConfig, maxActions }
  });
  setRunning(true);
});

btnStop.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP_SESSION" });
  setRunning(false);
});

function setRunning(running) {
  btnStart.disabled = running;
  btnStop.disabled = !running;
  statusDot.className = `status-indicator${running ? " running" : ""}`;
}

// ─── Export ───────────────────────────────────────────────────────────────────
btnExport.addEventListener("click", () => {
  const menu = document.createElement("div");
  menu.style.cssText = `position:fixed;top:88px;right:10px;z-index:999;background:var(--surface2);border:1px solid var(--border);border-radius:6px;overflow:hidden;min-width:150px;box-shadow:0 4px 20px rgba(0,0,0,0.4);`;
  [["Export JSON", exportJSON], ["Export HTML Report", exportHTML]].forEach(([label, fn]) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.style.cssText = `display:block;width:100%;padding:9px 13px;background:none;border:none;color:var(--text-dim);font-family:var(--mono);font-size:11px;text-align:left;cursor:pointer;`;
    btn.onmouseenter = () => btn.style.background = "var(--surface)";
    btn.onmouseleave = () => btn.style.background = "none";
    btn.onclick = () => { fn(); menu.remove(); };
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 50);
});

function exportJSON() {
  const blob = new Blob([JSON.stringify({ findings, activities, exportedAt: new Date().toISOString() }, null, 2)], { type: "application/json" });
  dlBlob(blob, `et-report-${Date.now()}.json`);
}

function exportHTML() {
  const high = findings.filter(f => f.severity === "high").length;
  const medium = findings.filter(f => f.severity === "medium").length;
  const low = findings.filter(f => f.severity === "low").length;
  const rows = findings.map(f => `<tr><td><span class="b ${f.type}">${f.type.replace(/_/g, " ")}</span></td><td>${esc(f.title)}</td><td>${esc(f.detail || "")}</td><td class="${f.severity}">${(f.severity || "").toUpperCase()}</td><td>${f.environment || "—"}</td><td>${new Date(f.timestamp).toLocaleTimeString()}</td></tr>`).join("");
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>ET Report</title><style>body{font-family:sans-serif;background:#0d0f12;color:#e2e8f0;padding:24px}h1{color:#00d4aa;margin-bottom:4px}.meta{color:#64748b;font-size:12px;margin-bottom:20px}.summary{display:flex;gap:14px;margin-bottom:20px}.card{background:#161a20;border:1px solid #2a3140;border-radius:8px;padding:14px 18px}.num{font-size:26px;font-weight:700}.lbl{font-size:10px;color:#64748b;text-transform:uppercase}.num.high{color:#ff4d6a}.num.medium{color:#ffc940}.num.low{color:#4da6ff}table{width:100%;border-collapse:collapse;background:#161a20;border-radius:8px;overflow:hidden}th{background:#1e242d;padding:9px 13px;text-align:left;font-size:10px;color:#64748b;text-transform:uppercase}td{padding:9px 13px;border-bottom:1px solid #2a3140;font-size:12px;vertical-align:top}.b{display:inline-block;padding:2px 6px;border-radius:3px;font-size:9px;font-weight:600;font-family:monospace;text-transform:uppercase}.js_error,.network_failure{background:rgba(255,77,106,.12);color:#ff4d6a}.form_validation{background:rgba(77,166,255,.12);color:#4da6ff}.ui_layout,.broken_link{background:rgba(255,201,64,.12);color:#ffc940}.spell_check{background:rgba(0,212,170,.12);color:#00d4aa}.high{color:#ff4d6a;font-weight:700}.medium{color:#ffc940;font-weight:700}.low{color:#4da6ff}</style></head><body><h1>Exploratory Test Report</h1><div class="meta">Generated: ${new Date().toLocaleString()} | Total: ${findings.length}</div><div class="summary"><div class="card"><div class="num">${findings.length}</div><div class="lbl">Total</div></div><div class="card"><div class="num high">${high}</div><div class="lbl">High</div></div><div class="card"><div class="num medium">${medium}</div><div class="lbl">Medium</div></div><div class="card"><div class="num low">${low}</div><div class="lbl">Low</div></div></div><table><thead><tr><th>Type</th><th>Title</th><th>Detail</th><th>Severity</th><th>Environment</th><th>Time</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
  dlBlob(new Blob([html], { type: "text/html" }), `et-report-${Date.now()}.html`);
}

function dlBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

function esc(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// ─── Filter Chips ─────────────────────────────────────────────────────────────
document.querySelectorAll(".filter-chip").forEach(chip => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".filter-chip").forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    activeFilter = chip.dataset.filter;
    renderFindings();
  });
});

// ─── Render Findings ──────────────────────────────────────────────────────────
function renderFindings() {
  const filtered = activeFilter === "all" ? findings : findings.filter(f => f.severity === activeFilter || f.type === activeFilter);
  if (filtered.length === 0) {
    findingsList.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><div>${findings.length === 0 ? "No findings yet" : "No findings match filter"}</div><div style="font-size:10px;font-family:var(--mono)">${findings.length === 0 ? "Press START to begin" : ""}</div></div>`;
    return;
  }
  findingsList.innerHTML = filtered.map(f => `
    <div class="finding-card ${f.severity || "low"}">
      <div class="finding-header">
        <span class="finding-type type-${f.type}">${(f.type || "").replace(/_/g, " ")}</span>
        <span class="finding-title">${esc(f.title)}</span>
      </div>
      <div class="finding-detail">${esc(f.detail || "")}</div>
      <div class="finding-meta">
        <span>${new Date(f.timestamp).toLocaleTimeString()}</span>
        ${f.environment ? `<span class="env-tag">${esc(f.environment)}</span>` : ""}
        ${f.selector ? `<span style="color:var(--accent)">${esc(f.selector)}</span>` : ""}
      </div>
    </div>`).join("");
  const highCount = findings.filter(f => f.severity === "high").length;
  findingsBadge.textContent = highCount;
  findingsBadge.style.display = highCount > 0 ? "inline-flex" : "none";
  statFindings.textContent = findings.length;
}

// ─── Render Activity ──────────────────────────────────────────────────────────
function renderActivity() {
  if (activities.length === 0) {
    activityFeed.innerHTML = `<div class="empty-state"><div class="empty-icon">🤖</div><div>No actions yet</div></div>`;
    return;
  }
  activityFeed.innerHTML = [...activities].reverse().map(a => {
    const srcColor = a.source === "heuristic" ? "var(--accent)" : a.source === "system" ? "var(--red)" : "#b47cff";
    const srcLabel = a.source === "heuristic" ? "HEURISTIC" : a.source === "system" ? "SYSTEM" : "LLM";
    return `
    <div class="activity-item">
      <div class="activity-action">
        <span style="font-size:9px;color:${srcColor};font-family:var(--mono);margin-right:5px">[${srcLabel}]</span>
        ${esc(a.action || "")}
        ${a.selector ? `<span style="color:var(--accent)"> → ${esc(a.selector)}</span>` : ""}
        ${a.value ? `<span style="color:var(--text-dim)"> = "${esc(String(a.value).slice(0, 40))}"</span>` : ""}
      </div>
      <div class="activity-reason">${esc(a.reason || "")}</div>
      ${a.learning ? `<div class="activity-learning">💡 ${esc(a.learning)}</div>` : ""}
      <div class="activity-time">${new Date(a.timestamp).toLocaleTimeString()} · ${((a.confidence || 0) * 100).toFixed(0)}% conf · ${esc(a.testType || "")}</div>
    </div>`;
  }).join("");
}

// ─── Action Ticker ────────────────────────────────────────────────────────────
let tickerEl = null;
function showActionTicker(payload) {
  if (!tickerEl) {
    tickerEl = document.createElement("div");
    tickerEl.id = "actionTicker";
    tickerEl.style.cssText = `position:sticky;top:0;z-index:100;background:rgba(0,212,170,0.1);border:1px solid var(--accent);border-radius:5px;padding:6px 10px;font-family:var(--mono);font-size:11px;color:var(--accent);margin-bottom:8px;display:flex;align-items:center;gap:8px;`;
    const feed = document.getElementById("activityFeed");
    if (feed) feed.parentNode.insertBefore(tickerEl, feed);
  }
  tickerEl.innerHTML = `<span class="spinner" style="width:10px;height:10px;border-width:2px"></span> <strong>${esc(payload.action)}</strong>${payload.selector ? ` → ${esc(payload.selector)}` : ""}${payload.value ? ` = "${esc(String(payload.value).slice(0, 30))}"` : ""}`;
}
function clearActionTicker() {
  if (tickerEl) { tickerEl.remove(); tickerEl = null; }
}

// ─── CDP Log Panel ────────────────────────────────────────────────────────────
function renderCdpLogs() {
  const el = document.getElementById("cdpLogList");
  if (!el) return;
  if (cdpLogs.length === 0) {
    el.innerHTML = `<div style="color:var(--text-muted);font-size:11px;font-family:var(--mono)">No DevTools events yet</div>`;
    return;
  }
  el.innerHTML = [...cdpLogs].reverse().slice(0, 30).map(l => {
    const color = l.level === "error" ? "var(--red)" : l.level === "warning" ? "var(--yellow)" : "var(--text-dim)";
    const icon = l.level === "error" ? "✗" : l.level === "warning" ? "⚠" : "ℹ";
    return `<div style="font-family:var(--mono);font-size:10px;padding:3px 0;border-bottom:1px solid var(--border);color:${color}">${icon} <span style="color:var(--text-muted)">[${l.type}]</span> ${esc(l.text.slice(0, 120))}</div>`;
  }).join("");
}

// ─── Status Banner ────────────────────────────────────────────────────────────
function showBanner(text, type) {
  const el = document.createElement("div");
  const color = type === "ok" ? "var(--green)" : type === "warn" ? "var(--yellow)" : "var(--red)";
  el.style.cssText = `background:rgba(0,0,0,0.3);border-left:3px solid ${color};padding:5px 10px;font-size:11px;font-family:var(--mono);color:${color};margin:4px 0;border-radius:3px;`;
  el.textContent = text;
  const feed = document.getElementById("activityFeed");
  if (feed) {
    feed.parentNode.insertBefore(el, feed);
    setTimeout(() => el.remove(), 5000);
  }
}

// ─── Background Messages ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "NEW_FINDING":
      findings.push(msg.payload);
      renderFindings();
      break;
    case "LLM_ACTION":
    case "HEURISTIC_ACTION":
      activities.push({ ...msg.payload, timestamp: Date.now(), source: msg.type === "HEURISTIC_ACTION" ? "heuristic" : "llm" });
      renderActivity();
      break;
    case "ACTION_STARTED":
      showActionTicker(msg.payload);
      break;
    case "ACTION_EXECUTED":
      statActions.textContent = `${msg.payload.count}/${msg.payload.max}`;
      clearActionTicker();
      break;
    case "ACTION_FAILED":
      activities.push({ action: "⚠ failed", reason: msg.detail, confidence: 0, timestamp: Date.now(), source: "system" });
      renderActivity();
      clearActionTicker();
      break;
    case "SESSION_STOPPED":
    case "LLM_LOOP_COMPLETE":
      setRunning(false);
      clearActionTicker();
      break;
    case "SESSION_SUMMARY":
      renderSummary(msg.payload);
      // Auto-switch to SUMMARY tab
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
      const summaryTab = document.querySelector('[data-tab="summary"]');
      const summaryPanel = document.getElementById("panel-summary");
      if (summaryTab) summaryTab.classList.add("active");
      if (summaryPanel) summaryPanel.classList.add("active");
      break;
    case "LLM_ERROR":
      activities.push({ action: "error", reason: msg.detail, confidence: 0, timestamp: Date.now(), source: "system" });
      renderActivity();
      break;
    case "CONTEXT_UPDATED":
      if (msg.payload?.url) {
        currentUrl = msg.payload.url;
        renderContextView(msg.payload.context);
      }
      break;
    case "SESSION_STARTED":
      if (msg.context) renderContextView(msg.context);
      break;
    case "CDP_LOG":
      cdpLogs.push(msg.payload);
      if (cdpLogs.length > 50) cdpLogs.shift();
      renderCdpLogs();
      break;
    case "CDP_ATTACHED":
      showBanner("🔌 DevTools attached (CDP active)", "ok");
      // Update CDP status badge
      const cdpSt = document.getElementById("cdpStatus");
      if (cdpSt) { cdpSt.textContent = "Active"; cdpSt.style.color = "var(--accent)"; }
      break;
    case "CDP_ERROR":
      showBanner(`⚠ ${msg.detail}`, "warn");
      break;
  }
});

// ─── Summary Renderer ─────────────────────────────────────────────────────────
function renderSummary(s) {
  const el = document.getElementById("summaryContent");
  if (!el) return;

  const sev = (label, items, color) => {
    if (!items.length) return "";
    return `<div class="sum-section">
      <div class="sum-section-title" style="color:${color}">${label} (${items.length})</div>
      ${items.map(i => `<div class="sum-item"><span class="sum-bullet" style="color:${color}">▸</span><span><strong>${esc(i.title || i.text || "Issue")}</strong>${i.detail ? ` — ${esc(i.detail)}` : ""}${i.url ? `<div class="sum-url">${esc(i.url)}</div>` : ""}</span></div>`).join("")}
    </div>`;
  };

  const list = (label, items, color = "var(--text-dim)") => {
    if (!items || !items.length) return `<div class="sum-section"><div class="sum-section-title" style="color:${color}">${label}</div><div style="color:var(--text-muted);font-size:10px;font-family:var(--mono)">None ✓</div></div>`;
    return `<div class="sum-section"><div class="sum-section-title" style="color:${color}">${label} (${items.length})</div>${items.map(i => `<div class="sum-item"><span class="sum-bullet" style="color:${color}">▸</span><span>${esc(i.text || i)}${i.url ? `<div class="sum-url">${esc(i.url)}</div>` : ""}</span></div>`).join("")}</div>`;
  };

  el.innerHTML = `
    <div class="sum-header">
      <div class="sum-stat"><span class="sum-stat-val">${esc(s.duration)}</span><span class="sum-stat-lbl">Duration</span></div>
      <div class="sum-stat"><span class="sum-stat-val">${s.pagesVisited.length}</span><span class="sum-stat-lbl">Pages</span></div>
      <div class="sum-stat"><span class="sum-stat-val">${s.totalActions}/${s.maxActions}</span><span class="sum-stat-lbl">Actions</span></div>
      <div class="sum-stat"><span class="sum-stat-val" style="color:${s.totalFindings > 0 ? 'var(--red)' : 'var(--green)'}">${s.totalFindings}</span><span class="sum-stat-lbl">Findings</span></div>
    </div>

    <div class="sum-divider">Pages Explored</div>
    <div class="sum-pages">${s.pagesVisited.map(u => `<div class="sum-page-item">✓ ${esc(u)}</div>`).join("") || "<div style='color:var(--text-muted);font-size:10px;font-family:var(--mono)'>None recorded</div>"}</div>
    ${s.pagesRemaining > 0 ? `<div style="font-family:var(--mono);font-size:9px;color:var(--yellow);margin:4px 0">⚠ ${s.pagesRemaining} URLs still in frontier (action limit reached)</div>` : ""}

    <div class="sum-divider">Issues</div>
    ${sev("🔴 High Severity", s.high, "var(--red)")}
    ${sev("🟡 Medium Severity", s.medium, "var(--yellow)")}
    ${sev("🔵 Low Severity", s.low, "var(--blue)")}
    ${!s.high.length && !s.medium.length && !s.low.length ? "<div style='color:var(--green);font-family:var(--mono);font-size:11px'>✓ No issues found</div>" : ""}

    <div class="sum-divider">JavaScript Errors</div>
    ${s.jsErrors.length ? s.jsErrors.map(e => `<div class="sum-item"><span class="sum-bullet" style="color:var(--red)">▸</span><span>${esc(e.text)}${e.url ? `<div class="sum-url">${esc(e.url)}</div>` : ""}</span></div>`).join("") : "<div style='color:var(--text-muted);font-size:10px;font-family:var(--mono)'>None ✓</div>"}

    <div class="sum-divider">Network Failures</div>
    ${s.networkFailures.length ? s.networkFailures.map(e => `<div class="sum-item"><span class="sum-bullet" style="color:var(--yellow)">▸</span><span>${esc(e.text)}</span></div>`).join("") : "<div style='color:var(--text-muted);font-size:10px;font-family:var(--mono)'>None ✓</div>"}

    ${s.brokenLinks.length ? `<div class="sum-divider">Broken Links</div>${s.brokenLinks.map(e => `<div class="sum-item"><span class="sum-bullet" style="color:var(--red)">▸</span><span>${esc(e.text)}</span></div>`).join("")}` : ""}
    ${s.assertionFailures.length ? `<div class="sum-divider">Assertion Failures</div>${s.assertionFailures.map(e => `<div class="sum-item"><span class="sum-bullet" style="color:var(--red)">▸</span><span>${esc(e.text)}</span></div>`).join("")}` : ""}

    <div class="sum-divider">✓ What Worked (last ${s.passedSample.length})</div>
    <div class="sum-pages">${s.passedSample.length ? s.passedSample.map(a => `<div class="sum-page-item" style="color:var(--green)">✓ ${esc(a)}</div>`).join("") : "<div style='color:var(--text-muted);font-size:10px;font-family:var(--mono)'>None recorded</div>"}</div>
  `;
}

// ─── Context Tab ──────────────────────────────────────────────────────────────

// Edit mode toggle
btnViewMode.addEventListener("click", () => setEditMode("view"));
btnEditMode.addEventListener("click", () => setEditMode("edit"));

function setEditMode(mode) {
  editMode = mode;
  btnViewMode.classList.toggle("active", mode === "view");
  btnEditMode.classList.toggle("active", mode === "edit");
  llmView.classList.toggle("hide", mode === "edit");
  manualFields.classList.toggle("show", mode === "edit");
}

// Analyze seed text
btnAnalyze.addEventListener("click", async () => {
  const text = seedText.value.trim();
  if (!text) return;
  if (!currentUrl) { alert("Navigate to the page you want to test first."); return; }

  btnAnalyze.disabled = true;
  btnAnalyze.innerHTML = '<span class="spinner"></span>Analyzing...';
  diffPreview.classList.remove("show");

  try {
    const extraction = await chrome.runtime.sendMessage({ type: "ANALYZE_SEED_TEXT", text, url: currentUrl });

    if (extraction?.error) throw new Error(extraction.error);

    pendingExtraction = extraction;

    // Load existing context to propose merge
    const existing = await chrome.runtime.sendMessage({ type: "GET_CONTEXT", url: currentUrl });
    const existingApp = existing?.app || null;

    if (existingApp?.keyFlows?.length || existingApp?.businessRules?.length) {
      // Existing context — propose merge
      const merge = await chrome.runtime.sendMessage({
        type: "PROPOSE_MERGE",
        existing: existingApp,
        incoming: {
          appSummary: extraction.appSummary,
          keyFlows: extraction.keyFlows,
          businessRules: extraction.businessRules,
          riskyAreas: extraction.riskyAreas
        },
        url: currentUrl
      });
      pendingMerge = merge;
      renderDiffPreview(merge);
    } else {
      // No existing — auto-apply
      await applyExtraction(extraction, null);
    }

  } catch (err) {
    diffPreview.innerHTML = `< div style = "color:var(--red);font-family:var(--mono);font-size:11px" > Error: ${esc(err.message)}</div > `;
    diffPreview.classList.add("show");
  }

  btnAnalyze.disabled = false;
  btnAnalyze.innerHTML = '⚡ Analyze & Build Context';
});

function renderDiffPreview(merge) {
  diffSummary.textContent = merge.summary || "Review proposed changes below:";
  diffRows.innerHTML = [
    { key: "appSummary", label: "Summary", val: merge.appSummary },
    { key: "keyFlows", label: "Key Flows", val: merge.keyFlows },
    { key: "businessRules", label: "Rules", val: merge.businessRules },
    { key: "riskyAreas", label: "Risky Areas", val: merge.riskyAreas }
  ].map(({ label, val }) => {
    if (!val) return "";
    const action = val.action || "ADD";
    const items = val.added?.length ? `+ ${val.added.join(", ")} ` : (val.value ? val.value.slice(0, 80) : "");
    return `< div class="diff-row" >
      <span class="diff-label ${action}">${action}</span>
      <div class="diff-value">
        <strong>${label}:</strong> ${esc(items)}
        <div class="diff-reason">${esc(val.reason || "")}</div>
      </div>
    </div > `;
  }).join("");
  diffPreview.classList.add("show");
}

btnConfirmMerge.addEventListener("click", async () => {
  if (!pendingExtraction || !currentUrl) return;
  await applyExtraction(pendingExtraction, pendingMerge);
  diffPreview.classList.remove("show");
  pendingExtraction = null;
  pendingMerge = null;
});

async function applyExtraction(extraction, mergeProposal) {
  await chrome.runtime.sendMessage({
    type: "APPLY_MERGE",
    payload: {
      url: currentUrl,
      mergeProposal: mergeProposal || {
        appSummary: { action: "ADD", value: extraction.appSummary },
        keyFlows: { action: "ADD", added: extraction.keyFlows || [], removed: [], kept: [] },
        businessRules: { action: "ADD", added: extraction.businessRules || [], removed: [], kept: [] },
        riskyAreas: { action: "ADD", added: extraction.riskyAreas || [], removed: [], kept: [] }
      },
      seedExtraction: extraction,
      userDescription: seedText.value.trim()
    }
  });

  // Reload context view
  const ctx = await chrome.runtime.sendMessage({ type: "GET_CONTEXT", url: currentUrl });
  renderContextView(ctx);
}

// Save manual context
btnSaveManual.addEventListener("click", async () => {
  const lines = (str) => str.split("\n").map(s => s.trim()).filter(Boolean);
  await chrome.runtime.sendMessage({
    type: "SAVE_MANUAL_CONTEXT",
    payload: {
      url: currentUrl,
      appDescription: document.getElementById("manualAppDesc").value.trim(),
      keyFlows: lines(document.getElementById("manualKeyFlows").value),
      businessRules: lines(document.getElementById("manualRules").value),
      riskyAreas: lines(document.getElementById("manualRiskyAreas").value)
    }
  });
  btnSaveManual.textContent = "Saved ✓";
  setTimeout(() => btnSaveManual.textContent = "Save Manual Context", 1500);
  const ctx = await chrome.runtime.sendMessage({ type: "GET_CONTEXT", url: currentUrl });
  renderContextView(ctx);
  setEditMode("view");
});

// Save page context
btnSavePageCtx.addEventListener("click", async () => {
  const desc = document.getElementById("pageDesc").value.trim();
  if (!desc) return;
  await chrome.runtime.sendMessage({ type: "SAVE_MANUAL_CONTEXT", payload: { url: currentUrl, pageDescription: desc } });
  btnSavePageCtx.textContent = "Saved ✓";
  setTimeout(() => btnSavePageCtx.textContent = "Save Page Context", 1500);
});

// Clear ctx
btnClearCtx.addEventListener("click", () => {
  seedText.value = "";
  diffPreview.classList.remove("show");
  pendingExtraction = null;
  pendingMerge = null;
});

// Clear dynamic
btnClearDynamic.addEventListener("click", async () => {
  if (!currentUrl) return;
  // We call context-manager clearDynamicContext via background
  await chrome.runtime.sendMessage({ type: "SAVE_MANUAL_CONTEXT", payload: { url: currentUrl } });
  renderLearnings([]);
});

// ─── Render Context View ──────────────────────────────────────────────────────
function renderContextView(ctx) {
  if (!ctx) return;

  // URL bar
  ctxCurrentUrl.textContent = currentUrl || "—";
  try { currentDomain = new URL(currentUrl).hostname; } catch { currentDomain = currentUrl; }

  const hasCtx = !!(ctx.app?.llmSummary || ctx.app?.userDescription);

  // Context pill
  ctxPill.textContent = hasCtx ? `✓ ${currentDomain} ` : "NO CONTEXT";
  ctxPill.className = `ctx - pill${hasCtx ? " has-context" : ""} `;

  // Environment badge
  if (ctx.environment) {
    envBadge.textContent = ctx.environment.name;
    envBadge.className = "env-badge show";
  } else {
    envBadge.className = "env-badge";
  }

  // App summary
  const appSummaryView = document.getElementById("appSummaryView");
  const appTagsContainer = document.getElementById("appTagsContainer");

  if (ctx.app?.llmSummary || ctx.app?.userDescription) {
    appSummaryView.textContent = ctx.app.llmSummary || ctx.app.userDescription;
    appSummaryView.className = "ctx-summary-text";

    // Tags
    const renderTags = (containerId, items) => {
      const el = document.getElementById(containerId);
      if (!items?.length) { el.innerHTML = '<span class="ctx-empty">None</span>'; return; }
      el.innerHTML = items.map(i => `< span class="ctx-tag" > ${esc(i)}</span > `).join("");
    };

    renderTags("keyFlowTags", ctx.app.keyFlows);
    renderTags("businessRuleTags", ctx.app.businessRules);
    renderTags("riskyAreaTags", ctx.app.riskyAreas);
    appTagsContainer.style.display = "block";

    // Pre-fill manual fields
    document.getElementById("manualAppDesc").value = ctx.app.userDescription || "";
    document.getElementById("manualKeyFlows").value = (ctx.app.keyFlows || []).join("\n");
    document.getElementById("manualRules").value = (ctx.app.businessRules || []).join("\n");
    document.getElementById("manualRiskyAreas").value = (ctx.app.riskyAreas || []).join("\n");
  } else {
    appSummaryView.textContent = "No context yet — paste a description above and click Analyze.";
    appSummaryView.className = "ctx-summary-text ctx-empty";
    appTagsContainer.style.display = "none";
  }

  // Page context
  const pageSummaryView = document.getElementById("pageSummaryView");
  if (ctx.page?.llmSummary || ctx.page?.userDescription) {
    pageSummaryView.innerHTML = `< div class="ctx-summary-text" > ${esc(ctx.page.llmSummary || ctx.page.userDescription)}</div > `;
  }

  // Dynamic learnings
  renderLearnings(ctx.dynamic?.sessionLearnings || []);
}

function renderLearnings(learnings) {
  if (!learnings.length) {
    learningList.innerHTML = '<div class="ctx-empty">No session learnings yet. Start a test session to build dynamic context.</div>';
    return;
  }
  learningList.innerHTML = learnings.slice().reverse().map(l => `< div class="learning-item" > ${esc(l)}</div > `).join("");
}

// ─── Settings ─────────────────────────────────────────────────────────────────
providerSelect.addEventListener("change", () => {
  document.querySelectorAll(".provider-fields").forEach(f => f.style.display = "none");
  const sel = providerSelect.value;
  if (sel) document.getElementById(`fields - ${sel} `).style.display = "block";
});

document.getElementById("btnSaveSettings").addEventListener("click", async () => {
  const cfg = getProviderConfig();
  const maxActions = parseInt(document.getElementById("maxActions").value) || 30;
  await chrome.storage.local.set({ llmProvider: cfg, maxActions });
  document.getElementById("btnSaveSettings").textContent = "Saved ✓";
  setTimeout(() => document.getElementById("btnSaveSettings").textContent = "Save Settings", 1500);
});

document.getElementById("btnTestConn").addEventListener("click", async () => {
  const cfg = getProviderConfig();
  if (!cfg) { connStatus.textContent = "No provider selected"; connStatus.className = "conn-status err"; return; }
  document.getElementById("btnTestConn").textContent = "Testing...";
  connStatus.textContent = "";
  const result = await chrome.runtime.sendMessage({ type: "TEST_LLM_CONNECTION", config: cfg });
  document.getElementById("btnTestConn").textContent = "Test Connection";
  if (result?.success) { connStatus.textContent = "✓ Connected"; connStatus.className = "conn-status ok"; }
  else { connStatus.textContent = `✗ ${result?.error || "Failed"} `; connStatus.className = "conn-status err"; }
});

function getProviderConfig() {
  const provider = providerSelect.value;
  if (!provider) return null;
  const cfg = { provider };
  if (provider === "claude") { cfg.apiKey = document.getElementById("claude-apiKey").value; cfg.model = document.getElementById("claude-model").value; }
  else if (provider === "openai") { cfg.apiKey = document.getElementById("openai-apiKey").value; cfg.model = document.getElementById("openai-model").value; }
  else if (provider === "gemini") { cfg.apiKey = document.getElementById("gemini-apiKey").value; cfg.model = document.getElementById("gemini-model").value; }
  else if (provider === "custom") { cfg.baseUrl = document.getElementById("custom-baseUrl").value; cfg.authHeader = document.getElementById("custom-authHeader").value || "Authorization"; cfg.authKey = document.getElementById("custom-authKey").value; cfg.model = document.getElementById("custom-model").value; }
  return cfg;
}

async function loadSettings() {
  const result = await chrome.storage.local.get(["llmProvider", "maxActions"]);
  const cfg = result.llmProvider;
  document.getElementById("maxActions").value = result.maxActions || 30;
  if (!cfg) return;
  providerSelect.value = cfg.provider || "";
  providerSelect.dispatchEvent(new Event("change"));
  if (cfg.provider === "claude") { document.getElementById("claude-apiKey").value = cfg.apiKey || ""; document.getElementById("claude-model").value = cfg.model || "claude-sonnet-4-5"; }
  else if (cfg.provider === "openai") { document.getElementById("openai-apiKey").value = cfg.apiKey || ""; document.getElementById("openai-model").value = cfg.model || "gpt-4o"; }
  else if (cfg.provider === "gemini") { document.getElementById("gemini-apiKey").value = cfg.apiKey || ""; document.getElementById("gemini-model").value = cfg.model || "gemini-1.5-pro"; }
  else if (cfg.provider === "custom") { document.getElementById("custom-baseUrl").value = cfg.baseUrl || ""; document.getElementById("custom-authHeader").value = cfg.authHeader || "Authorization"; document.getElementById("custom-authKey").value = cfg.authKey || ""; document.getElementById("custom-model").value = cfg.model || ""; }
}

// ─── Environments ─────────────────────────────────────────────────────────────
const ENV_COLORS = ["#00d4aa", "#4da6ff", "#ffc940", "#ff4d6a", "#b47cff", "#5cdb95"];

async function loadAndRenderEnvs() {
  const envs = await chrome.runtime.sendMessage({ type: "GET_ENVIRONMENTS" });
  const envList = document.getElementById("envList");
  if (!envs?.length) { envList.innerHTML = '<div style="font-size:11px;color:var(--text-muted);font-family:var(--mono)">No environments yet</div>'; return; }
  envList.innerHTML = envs.map((e, i) => `
    < div class="env-item" >
      <div class="env-dot" style="background:${ENV_COLORS[i % ENV_COLORS.length]}"></div>
      <div class="env-info">
        <div class="env-name">${esc(e.name)}</div>
        <div class="env-url">${esc(e.baseUrl)}</div>
      </div>
      <button class="btn-env-remove" data-id="${e.id}" title="Remove">×</button>
    </div > `).join("");
  envList.querySelectorAll(".btn-env-remove").forEach(btn => {
    btn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "REMOVE_ENVIRONMENT", id: btn.dataset.id });
      loadAndRenderEnvs();
    });
  });
}

document.getElementById("btnAddEnv").addEventListener("click", async () => {
  const name = document.getElementById("envName").value.trim();
  const baseUrl = document.getElementById("envBaseUrl").value.trim();
  const desc = document.getElementById("envDesc").value.trim();
  if (!name || !baseUrl) { alert("Name and Base URL are required."); return; }
  await chrome.runtime.sendMessage({ type: "ADD_ENVIRONMENT", env: { name, baseUrl, description: desc } });
  document.getElementById("envName").value = "";
  document.getElementById("envBaseUrl").value = "";
  document.getElementById("envDesc").value = "";
  loadAndRenderEnvs();
});

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  await loadSettings();
  await loadAndRenderEnvs();

  // Load context for current active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) {
    currentUrl = tab.url;
    ctxCurrentUrl.textContent = currentUrl;
    const ctx = await chrome.runtime.sendMessage({ type: "GET_CONTEXT", url: currentUrl });
    if (ctx) renderContextView(ctx);
  }
}

init();
