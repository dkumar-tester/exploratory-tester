// content.js — Injected into every page
// Responsibilities:
//   1. Observe JS errors, network failures (via fetch/XHR patch), navigation
//   2. DOM crawler — discover all interactive elements with rich metadata
//   3. Heuristic engine — form tests, link checks, layout checks, spell check
//   4. Action executor — Playwright-like: click, type, select, check, submit, scroll, hover, assert, clear, focus
//   5. Smart form filler — detects field intent and fills with realistic data
//   6. Report findings back to background via chrome.runtime.sendMessage

(function () {
  if (window.__exploratoryTesterInjected) return;
  window.__exploratoryTesterInjected = true;

  // ─── State ──────────────────────────────────────────────────────────────────
  const findings = [];
  const visitedSelectors = new Set();
  let isRunning = false;

  // ─── Utilities ──────────────────────────────────────────────────────────────

  function report(finding) {
    findings.push({ ...finding, timestamp: Date.now(), url: location.href });
    chrome.runtime.sendMessage({ type: "FINDING", payload: finding });
  }

  function cssSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.getAttribute("data-testid")) return `[data-testid="${el.getAttribute("data-testid")}"]`;
    if (el.getAttribute("data-cy")) return `[data-cy="${el.getAttribute("data-cy")}"]`;
    if (el.name) return `[name="${CSS.escape(el.name)}"]`;
    const tag = el.tagName.toLowerCase();
    const cls = [...el.classList]
      .filter(c => !/^(ng-|js-|is-|has-|active|disabled|hover|focus|selected|open|closed|show|hide|visible|hidden|[\d])/.test(c))
      .slice(0, 2).map(c => `.${CSS.escape(c)}`).join("");
    return `${tag}${cls}`;
  }

  function uniqueSelector(el) {
    try { return cssSelector(el); } catch { return el.tagName.toLowerCase(); }
  }

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    if (el.offsetParent === null && el.tagName !== "BODY") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function getFieldLabel(el) {
    // Try explicit <label for="...">
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim();
    }
    // Try aria-label / aria-labelledby
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
    if (el.getAttribute("aria-labelledby")) {
      const ref = document.getElementById(el.getAttribute("aria-labelledby"));
      if (ref) return ref.textContent.trim();
    }
    // Try wrapping label
    const parent = el.closest("label");
    if (parent) return parent.textContent.replace(el.value || "", "").trim();
    // Try preceding sibling label
    const prev = el.previousElementSibling;
    if (prev && prev.tagName === "LABEL") return prev.textContent.trim();
    return el.name || el.placeholder || "";
  }

  // ─── 1. JS Error Observer ───────────────────────────────────────────────────

  window.addEventListener("error", (e) => {
    if (!isRunning) return;
    report({ type: "js_error", severity: "high", title: "JavaScript Error", detail: e.message, source: `${e.filename}:${e.lineno}:${e.colno}` });
  });

  window.addEventListener("unhandledrejection", (e) => {
    if (!isRunning) return;
    report({ type: "js_error", severity: "high", title: "Unhandled Promise Rejection", detail: String(e.reason) });
  });

  const _consoleError = console.error.bind(console);
  console.error = (...args) => {
    if (isRunning) report({ type: "js_error", severity: "medium", title: "Console Error", detail: args.map(String).join(" ") });
    _consoleError(...args);
  };

  // ─── 2. Network Observer ────────────────────────────────────────────────────

  const _fetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
    try {
      const res = await _fetch(...args);
      if (isRunning && res.status >= 400) {
        report({ type: "network_failure", severity: res.status >= 500 ? "high" : "medium", title: `Network Error ${res.status}`, detail: `${res.status} ${res.statusText} — ${url}` });
      }
      return res;
    } catch (err) {
      if (isRunning) report({ type: "network_failure", severity: "high", title: "Network Request Failed", detail: `${url} — ${err.message}` });
      throw err;
    }
  };

  const _XHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._url = url;
    this.addEventListener("load", function () {
      if (isRunning && this.status >= 400) {
        report({ type: "network_failure", severity: this.status >= 500 ? "high" : "medium", title: `XHR Error ${this.status}`, detail: `${this.status} — ${this._url}` });
      }
    });
    return _XHROpen.call(this, method, url, ...rest);
  };

  // ─── 3. DOM Crawler ─────────────────────────────────────────────────────────

  function crawlInteractiveElements() {
    const selectors = [
      "a[href]", "button", "input", "textarea", "select",
      "[role='button']", "[role='link']", "[role='checkbox']",
      "[role='menuitem']", "[role='tab']", "[role='switch']",
      "[tabindex]", "form"
    ];

    const seen = new Set();
    const elements = [];

    selectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        if (!isVisible(el)) return;
        const key = uniqueSelector(el);
        if (seen.has(key)) return;
        seen.add(key);

        elements.push({
          tag: el.tagName.toLowerCase(),
          type: el.type || null,
          selector: key,
          text: (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || "").slice(0, 100),
          href: el.href || null,
          required: el.required || false,
          role: el.getAttribute("role") || null,
          label: getFieldLabel(el).slice(0, 80),
          checked: el.checked !== undefined ? el.checked : null,
          disabled: el.disabled || false,
          options: el.tagName === "SELECT" ? [...el.options].map(o => ({ value: o.value, text: o.text })).slice(0, 10) : null,
          value: el.value !== undefined ? String(el.value).slice(0, 50) : null,
          inViewport: isInViewport(el)
        });
      });
    });

    return elements;
  }

  function isInViewport(el) {
    const rect = el.getBoundingClientRect();
    return rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;
  }

  // ─── 4. Heuristic Engine ────────────────────────────────────────────────────

  function testFormValidation() {
    document.querySelectorAll("form").forEach(form => {
      form.querySelectorAll("input, textarea, select").forEach(input => {
        const sel = uniqueSelector(input);
        if (visitedSelectors.has(`form_test_${sel}`)) return;
        visitedSelectors.add(`form_test_${sel}`);
        const type = input.type?.toLowerCase();

        if (input.required && !input.value) {
          report({ type: "form_validation", severity: "medium", title: "Empty Required Field", detail: `Field "${getFieldLabel(input) || sel}" is required but empty`, selector: sel });
        }
        if (type === "email") {
          const orig = input.value; input.value = "notanemail";
          if (input.validity && !input.validity.valid) report({ type: "form_validation", severity: "low", title: "Email Validation Present", detail: `${sel} rejects invalid email`, selector: sel, pass: true });
          input.value = orig;
        }
        if (type === "number" && input.min !== "" && input.max !== "") {
          report({ type: "form_validation", severity: "medium", title: "Number Boundary Test", detail: `${sel} has min=${input.min}, max=${input.max}. Boundary: ${parseFloat(input.min) - 1}, ${parseFloat(input.max) + 1}`, selector: sel });
        }
        if (input.maxLength > 0) {
          report({ type: "form_validation", severity: "low", title: "Max Length Constraint", detail: `${sel} has maxLength=${input.maxLength}`, selector: sel });
        }
      });
    });
  }

  async function checkLinks() {
    const links = [...document.querySelectorAll("a[href]")];
    const internal = links.filter(a => { try { return new URL(a.href, location.origin).origin === location.origin; } catch { return false; } });
    for (const link of internal.slice(0, 20)) {
      if (visitedSelectors.has(`link_${link.href}`)) continue;
      visitedSelectors.add(`link_${link.href}`);
      if (!link.href || link.href === "#" || link.href.startsWith("javascript:")) continue;
      try {
        const res = await fetch(link.href, { method: "HEAD", cache: "no-store" });
        if (res.status === 404) report({ type: "broken_link", severity: "high", title: "Broken Link (404)", detail: `"${link.innerText.slice(0, 50)}" → ${link.href}`, selector: uniqueSelector(link) });
      } catch { }
    }
  }

  function checkLayoutIssues() {
    const interactives = document.querySelectorAll("button, a, input, [role='button']");
    const rects = [];
    interactives.forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        report({ type: "ui_layout", severity: "medium", title: "Zero-Size Interactive Element", detail: `${uniqueSelector(el)} has zero width or height`, selector: uniqueSelector(el) });
        return;
      }
      rects.push({ el, rect });
    });
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i].rect, b = rects[j].rect;
        if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
          report({ type: "ui_layout", severity: "low", title: "Overlapping Elements", detail: `${uniqueSelector(rects[i].el)} overlaps ${uniqueSelector(rects[j].el)}` });
        }
      }
    }
    document.querySelectorAll("img").forEach(img => {
      if (!img.complete || img.naturalWidth === 0) report({ type: "ui_layout", severity: "medium", title: "Broken Image", detail: `Failed to load: ${img.src}`, selector: uniqueSelector(img) });
    });
    document.querySelectorAll("*").forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.right > window.innerWidth + 10) report({ type: "ui_layout", severity: "low", title: "Horizontal Overflow", detail: `${uniqueSelector(el)} overflows viewport`, selector: uniqueSelector(el) });
    });
  }

  function checkSpelling() {
    const commonMisspellings = { "recieve": "receive", "occured": "occurred", "seperate": "separate", "definately": "definitely", "accomodate": "accommodate", "occassion": "occasion", "embarass": "embarrass", "existance": "existence", "independant": "independent", "maintainance": "maintenance", "neccessary": "necessary", "occurance": "occurrence", "privelege": "privilege", "reccommend": "recommend", "relevent": "relevant", "succesful": "successful", "tommorow": "tomorrow", "wierd": "weird", "untill": "until", "teh": "the", "adn": "and", "thier": "their" };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const words = new Set();
    let node;
    while ((node = walker.nextNode())) {
      if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(node.parentElement?.tagName)) continue;
      const wordList = node.textContent.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
      wordList.forEach(word => {
        if (!words.has(word) && commonMisspellings[word]) {
          words.add(word);
          report({ type: "spell_check", severity: "low", title: "Possible Spelling Error", detail: `"${word}" may be misspelled. Suggestion: "${commonMisspellings[word]}"` });
        }
      });
    }
  }

  // ─── 5. Smart Form Filler ───────────────────────────────────────────────────

  const FIELD_DATA = {
    email: "sarah.mitchell92@gmail.com",
    password: "Maple#7291!",
    confirm_password: "Maple#7291!",
    confirmpassword: "Maple#7291!",
    first: "Sarah",
    firstname: "Sarah",
    last: "Mitchell",
    lastname: "Mitchell",
    name: "Sarah Mitchell",
    username: "sarah.mitchell",
    user: "sarah.mitchell",
    phone: "4085559312",
    tel: "4085559312",
    mobile: "4085559312",
    zip: "94103",
    postal: "94103",
    address: "1847 Oakwood Drive",
    city: "San Francisco",
    state: "CA",
    country: "US",
    company: "Brightline Solutions Inc.",
    website: "https://brightlinesolutions.com",
    url: "https://brightlinesolutions.com",
    age: "31",
    quantity: "2",
    amount: "149.99",
    price: "49",
    message: "Hi, I came across your platform and I'm interested in learning more. Could someone from your team follow up with me at the email provided? Thanks in advance.",
    comment: "Really appreciate the clean interface. Would love to see dark mode and bulk export added in a future update.",
    description: "We're a mid-sized team looking for a project management solution that integrates with our existing tools.",
    subject: "Question about enterprise pricing",
    title: "Senior Product Manager",
    search: "project management software",
    query: "how to export data"
  };

  function detectFieldIntent(el) {
    const hints = [
      el.getAttribute("autocomplete") || "",
      el.name || "",
      el.id || "",
      el.placeholder || "",
      getFieldLabel(el) || ""
    ].join(" ").toLowerCase().replace(/[\s_-]/g, "");

    for (const [key, value] of Object.entries(FIELD_DATA)) {
      if (hints.includes(key)) return value;
    }

    // Fallback by input type
    const type = (el.type || "").toLowerCase();
    if (type === "email") return FIELD_DATA.email;
    if (type === "password") return FIELD_DATA.password;
    if (type === "tel") return FIELD_DATA.phone;
    if (type === "url") return FIELD_DATA.url;
    if (type === "number") {
      const min = parseFloat(el.min);
      const max = parseFloat(el.max);
      if (!isNaN(min) && !isNaN(max)) return String(Math.round((min + max) / 2));
      if (!isNaN(min)) return String(min + 1);
      return "42";
    }
    if (type === "date") return new Date().toISOString().slice(0, 10);
    if (type === "time") return "12:00";
    if (type === "color") return "#336699";

    return "Test Input";
  }

  function smartFillForm() {
    const steps = [];
    const seenRadioGroups = new Set(); // Track radio button groups by name

    document.querySelectorAll("input, textarea, select").forEach(el => {
      if (!isVisible(el)) return;
      if (el.disabled || el.readOnly) return;
      const type = (el.type || "").toLowerCase();
      if (["hidden", "submit", "button", "reset", "image", "file"].includes(type)) return;

      const sel = uniqueSelector(el);

      if (el.tagName === "SELECT") {
        // Skip if we've already selected a value in this dropdown this session
        if (visitedSelectors.has(`selected_${sel}`)) return;
        const options = [...el.options].filter(o => o.value && o.value !== "" && o.value !== el.value);
        if (options.length) steps.push({ action: "select", selector: sel, value: options[0].value });

      } else if (type === "radio") {
        // Use radio group name to deduplicate — only suggest one radio per group
        const groupKey = `radio_group_${el.name || sel}`;
        if (seenRadioGroups.has(groupKey)) return;
        if (visitedSelectors.has(groupKey)) return;
        // Find first unchecked radio in this group, or use current if none checked yet
        const groupChecked = document.querySelector(`input[type="radio"][name="${CSS.escape(el.name)}"]  :checked`);
        if (!groupChecked && !el.checked) {
          seenRadioGroups.add(groupKey);
          steps.push({ action: "check", selector: sel, value: groupKey });
        }

      } else if (type === "checkbox") {
        // Skip if already toggled in this session
        if (visitedSelectors.has(`checked_${sel}`)) return;
        if (!el.checked) steps.push({ action: "check", selector: sel, value: null });

      } else {
        // Text-like inputs — skip if already filled
        if (visitedSelectors.has(`typed_${sel}`)) return;
        if (!el.value || el.value === "") {
          const value = detectFieldIntent(el);
          steps.push({ action: "type", selector: sel, value });
        }
      }
    });
    return steps;
  }


  // ─── 6. Action Executor ─────────────────────────────────────────────────────

  function simulateRealTyping(el, text) {
    el.focus();
    // Clear existing value first
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));

    // Type char by char for React/Vue compatibility
    for (const char of text) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keypress", { key: char, bubbles: true }));
      el.value += char;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: char, inputType: "insertText" }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function scrollIntoViewIfNeeded(el) {
    if (!isInViewport(el)) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function executeAction({ action, selector, value }) {
    try {
      const el = selector ? document.querySelector(selector) : null;

      // ── click ──
      if (action === "click") {
        if (!el) return { success: false, error: `Element not found: ${selector}` };
        scrollIntoViewIfNeeded(el);
        el.focus();
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        el.click();
        visitedSelectors.add(`clicked_${selector}`);
        return { success: true, action: "click", selector };
      }

      // ── type ──
      if (action === "type") {
        if (!el) return { success: false, error: `Element not found: ${selector}` };
        scrollIntoViewIfNeeded(el);
        simulateRealTyping(el, value || "");
        visitedSelectors.add(`typed_${selector}`);
        return { success: true, action: "type", selector, value };
      }

      // ── clear ──
      if (action === "clear") {
        if (!el) return { success: false, error: `Element not found: ${selector}` };
        el.focus();
        el.select?.();
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { success: true, action: "clear", selector };
      }

      // ── select ──
      if (action === "select") {
        if (!el) return { success: false, error: `Element not found: ${selector}` };
        scrollIntoViewIfNeeded(el);
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        visitedSelectors.add(`selected_${selector}`);
        return { success: true, action: "select", selector, value };
      }

      // ── check / uncheck ──
      if (action === "check" || action === "uncheck") {
        if (!el) return { success: false, error: `Element not found: ${selector}` };
        scrollIntoViewIfNeeded(el);
        const shouldCheck = action === "check";
        if (el.checked !== shouldCheck) {
          el.click();
        }
        visitedSelectors.add(`checked_${selector}`);
        // If this is a radio button, mark the whole group as visited
        // The group key is passed in `value` by smartFillForm
        if (el.type === "radio") {
          const groupKey = value || `radio_group_${el.name || selector}`;
          visitedSelectors.add(groupKey);
        }
        return { success: true, action, selector, checked: el.checked };
      }

      // ── submit ──
      if (action === "submit") {
        const form = el ? el.closest("form") : document.querySelector("form");
        if (!form) return { success: false, error: "No form found" };
        // Use requestSubmit to trigger validation
        if (form.requestSubmit) {
          form.requestSubmit();
        } else {
          form.submit();
        }
        return { success: true, action: "submit" };
      }

      // ── hover ──
      if (action === "hover") {
        if (!el) return { success: false, error: `Element not found: ${selector}` };
        scrollIntoViewIfNeeded(el);
        el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
        return { success: true, action: "hover", selector };
      }

      // ── focus ──
      if (action === "focus") {
        if (!el) return { success: false, error: `Element not found: ${selector}` };
        el.focus();
        el.dispatchEvent(new Event("focus", { bubbles: true }));
        return { success: true, action: "focus", selector };
      }

      // ── scroll ──
      if (action === "scroll") {
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        } else {
          const amount = parseInt(value) || window.innerHeight;
          window.scrollBy({ top: amount, behavior: "smooth" });
        }
        return { success: true, action: "scroll", selector, value };
      }

      // ── navigate ──
      if (action === "navigate") {
        if (!value) return { success: false, error: "No URL provided" };
        location.href = value;
        return { success: true, action: "navigate", value };
      }

      // ── assert ──
      if (action === "assert") {
        if (!el) return { success: false, error: `Element not found: ${selector}` };
        const actualText = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
        const matches = value ? actualText.toLowerCase().includes(value.toLowerCase()) : actualText.length > 0;
        const result = { success: true, action: "assert", selector, expected: value, actual: actualText, passed: matches };
        if (!matches) {
          report({ type: "assertion_failure", severity: "high", title: "Assertion Failed", detail: `Expected "${value}" in ${selector}, got: "${actualText}"`, selector });
        }
        return result;
      }

      // ── smart_fill ──
      if (action === "smart_fill") {
        const steps = smartFillForm();
        for (const step of steps) {
          executeAction(step);
        }
        return { success: true, action: "smart_fill", stepsExecuted: steps.length };
      }

      return { success: false, error: `Unknown action: ${action}` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ─── 7. DOM Snapshot for LLM ────────────────────────────────────────────────

  function getAccessibilityTree() {
    const selector = "[aria-label], [role], button, input, a[href], select, textarea, [aria-describedby]";
    const nodes = [];
    const seen = new Set();
    document.querySelectorAll(selector).forEach(el => {
      if (!isVisible(el)) return;
      const sel = uniqueSelector(el);
      if (seen.has(sel)) return;
      seen.add(sel);
      nodes.push({
        role: el.getAttribute("role") || el.tagName.toLowerCase(),
        label: el.getAttribute("aria-label") || getFieldLabel(el) || el.innerText?.slice(0, 50) || "",
        selector: sel,
        state: el.getAttribute("aria-expanded") || el.getAttribute("aria-checked") || el.getAttribute("aria-selected") || null
      });
    });
    return nodes.slice(0, 40);
  }

  function getDOMSnapshot() {
    const elements = crawlInteractiveElements();
    const formFields = smartFillForm(); // What the heuristic engine would fill
    const pageText = document.body?.innerText?.slice(0, 2000) || "";

    return {
      url: location.href,
      title: document.title,
      interactiveElements: elements.slice(0, 60),
      formCount: document.querySelectorAll("form").length,
      linkCount: document.querySelectorAll("a[href]").length,
      errorCount: findings.filter(f => f.type === "js_error").length,
      ariaTree: getAccessibilityTree(),
      heuristicNextSteps: formFields.slice(0, 10),
      pageText: pageText,
      scrollPosition: { x: window.scrollX, y: window.scrollY },
      pageHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      visitedCount: visitedSelectors.size
    };
  }

  // ─── 8. Message Handler ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case "START_TESTING":
        isRunning = true;
        findings.length = 0;
        visitedSelectors.clear();
        testFormValidation();
        checkLayoutIssues();
        checkSpelling();
        checkLinks();
        sendResponse({ status: "started" });
        break;

      case "STOP_TESTING":
        isRunning = false;
        sendResponse({ status: "stopped" });
        break;

      case "GET_SNAPSHOT":
        sendResponse({ snapshot: getDOMSnapshot() });
        break;

      case "EXECUTE_ACTION":
        const result = executeAction(msg.payload);
        sendResponse(result);
        break;

      case "SMART_FILL":
        const fillSteps = smartFillForm();
        sendResponse({ steps: fillSteps });
        break;

      case "GET_FINDINGS":
        sendResponse({ findings });
        break;
    }
    return true;
  });

})();
