const DEFAULT_SYSTEM_PROMPT = [
  "You are assisting with authorized web application security testing.",
  "Provide concise, practical guidance.",
  "Use the provided page context to infer target elements by label, name, id, placeholder, and aria-label.",
  "Use context.labelHints, context.likelyPhoneTargets, and context.inspectedSelection aggressively when user names a field.",
  "For front-end validation bypass requests, provide one robust JavaScript DevTools snippet that tries multiple selector strategies first.",
  "Do not ask for a selector if the context includes any plausible candidate; give a best-effort runnable snippet first.",
  "Code must be directly executable in DevTools without missing identifiers.",
  "Do not use CSS :has(...) selectors.",
  "Do not call removeEventListener with undefined function references.",
  "Prefer removing attributes and overriding setCustomValidity/checkValidity/reportValidity safely.",
  "Output exactly two JavaScript code fences when returning executable steps: first is apply, second is undo/restore.",
  "When direct execution mode is requested, output strict JSON only.",
  "Include a short risk note."
].join(" ");

function looksLikeBurpHtml(bodyText) {
  const text = (bodyText || "").toLowerCase();
  return (
    text.includes("burp suite professional") ||
    text.includes("<title>burp suite") ||
    text.includes("portswigger")
  );
}

function looksLikeOriginDenied(status, bodyText) {
  const text = (bodyText || "").toLowerCase();
  return status === 403 || text.includes("origin") || text.includes("forbidden");
}

function buildTargetingHint(promptText, context) {
  if (!context || typeof context !== "object") {
    return "";
  }

  const prompt = String(promptText || "").toLowerCase();
  const wantsPhoneField = /phone|tel|mobile|contact/.test(prompt);
  const selectorSet = new Set();

  if (context.inspectedSelection?.selector) {
    selectorSet.add(context.inspectedSelection.selector);
  }

  if (Array.isArray(context.likelyPhoneTargets)) {
    for (const item of context.likelyPhoneTargets.slice(0, 8)) {
      if (item?.selector) {
        selectorSet.add(item.selector);
      }
    }
  }

  if (Array.isArray(context.labelHints)) {
    const labels = context.labelHints;
    const filtered = wantsPhoneField
      ? labels.filter((item) => /phone|tel|mobile|contact/.test(String(item?.labelText || "").toLowerCase()))
      : labels;
    for (const item of filtered.slice(0, 8)) {
      if (item?.inputSelector) {
        selectorSet.add(item.inputSelector);
      }
    }
  }

  const selectors = Array.from(selectorSet).filter(Boolean).slice(0, 10);
  if (!selectors.length) {
    return "";
  }

  return [
    "Targeting constraints:",
    "- You MUST target one of these candidate selectors before generic fallbacks.",
    `- Candidate selectors: ${selectors.join(", ")}`,
    `- Declare these in code as: const candidateSelectors = ${JSON.stringify(selectors)};`,
    "- If one selector fails, iterate to the next candidate.",
    "- Avoid unsupported selectors and avoid undefined references.",
    "- Keep the snippet reversible and include restore steps."
  ].join("\n");
}

async function requestOllama(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (error) {
    return {
      ok: false,
      error:
        "Network error while connecting to Ollama. " +
        "Confirm Ollama is running and reachable on this endpoint. " +
        `Details: ${error.message || String(error)}`,
      burpDetected: false
    };
  }

  const rawText = await response.text();
  const contentType = response.headers.get("content-type") || "";

  if (!response.ok) {
    return {
      ok: false,
      error:
        `HTTP ${response.status}. Content-Type: ${contentType || "unknown"}. ` +
        `Body preview: ${rawText.slice(0, 220)}`,
      burpDetected: looksLikeBurpHtml(rawText),
      originDenied: looksLikeOriginDenied(response.status, rawText)
    };
  }

  if (!contentType.toLowerCase().includes("application/json")) {
    return {
      ok: false,
      error:
        `Expected JSON but got ${contentType || "unknown"}. ` +
        `Body preview: ${rawText.slice(0, 220)}`,
      burpDetected: looksLikeBurpHtml(rawText),
      originDenied: false
    };
  }

  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch (_parseError) {
    return {
      ok: false,
      error: `Invalid JSON body preview: ${rawText.slice(0, 220)}`,
      burpDetected: looksLikeBurpHtml(rawText),
      originDenied: false
    };
  }

  const content = payload?.message?.content;
  if (!content) {
    return {
      ok: false,
      error: "Ollama returned an empty response.",
      burpDetected: false,
      originDenied: false
    };
  }

  return { ok: true, content, burpDetected: false, originDenied: false };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "ask-ollama") {
    return false;
  }

  (async () => {
    try {
      const model = message.model || "gemma4:e4b";
      const directMode = !!message.directMode;
      const contextText = message.context
        ? `Page context:\n${JSON.stringify(message.context, null, 2)}\n\n`
        : "";
      const targetingHint = buildTargetingHint(message.prompt, message.context);
      const targetingText = targetingHint ? `${targetingHint}\n\n` : "";
      const directModeHint = directMode
        ? [
            "Response format requirements:",
            "- Return ONLY valid JSON. No markdown. No code fences.",
            '- Keys: "apply_js", "undo_js", "summary".',
            "- apply_js and undo_js must each be a self-contained IIFE JavaScript string.",
            "- summary must be one concise sentence."
          ].join("\n")
        : "";
      const modeText = directModeHint ? `${directModeHint}\n\n` : "";

      const body = {
        model,
        stream: false,
        messages: [
          { role: "system", content: DEFAULT_SYSTEM_PROMPT },
          { role: "user", content: `${modeText}${targetingText}${contextText}${message.prompt || ""}` }
        ]
      };

      const endpoints = [
        "http://127.0.0.1:11434/api/chat",
        "http://localhost:11434/api/chat",
        "http://[::1]:11434/api/chat"
      ];

      const errors = [];
      let burpDetected = false;
      let originDenied = false;

      for (const endpoint of endpoints) {
        const result = await requestOllama(endpoint, body);
        if (result.ok) {
          sendResponse({ content: result.content });
          return;
        }
        if (result.burpDetected) {
          burpDetected = true;
        }
        if (result.originDenied) {
          originDenied = true;
        }
        errors.push(`${endpoint} -> ${result.error}`);
      }

      if (burpDetected) {
        throw new Error(
          "Burp appears to be intercepting localhost Ollama traffic. " +
            "In Burp Proxy settings, add localhost bypass entries for 127.0.0.1, localhost, and ::1 " +
            "for port 11434 (or disable interception for loopback). " +
            `Attempt details: ${errors.join(" | ")}`
        );
      }

      if (originDenied) {
        throw new Error(
          "Ollama returned HTTP 403, likely due to origin allowlist restrictions. " +
            "Allow extension origins in Ollama by setting OLLAMA_ORIGINS (for example '*', " +
            "'moz-extension://*', and 'chrome-extension://*') and then restart Ollama. " +
            `Attempt details: ${errors.join(" | ")}`
        );
      }

      throw new Error(`Failed to reach Ollama. Attempt details: ${errors.join(" | ")}`);
    } catch (error) {
      sendResponse({ error: error.message || String(error) });
    }
  })();

  return true;
});
