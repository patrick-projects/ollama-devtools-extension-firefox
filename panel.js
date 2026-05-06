const modelInput = document.getElementById("model");
const includeContextInput = document.getElementById("includeContext");
const autoRunInput = document.getElementById("autoRun");
const directModeInput = document.getElementById("directMode");
const promptInput = document.getElementById("prompt");
const responseOutput = document.getElementById("response");
const sendBtn = document.getElementById("sendBtn");
const runBtn = document.getElementById("runBtn");
const undoBtn = document.getElementById("undoBtn");
const statusEl = document.getElementById("status");

let lastPrimarySnippet = "";
let lastRestoreSnippet = "";

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#ff9b9b" : "#8bc3ff";
}

function extractCodeFences(text) {
  const snippets = [];
  const regex = /```(?:javascript|js)?\n([\s\S]*?)```/gi;
  let match = regex.exec(text);
  while (match) {
    snippets.push(match[1].trim());
    match = regex.exec(text);
  }
  return snippets;
}

function parseActionPayload(text) {
  if (!text) {
    return null;
  }

  const parseObject = (raw) => {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && typeof obj.apply_js === "string") {
        return {
          applyJs: obj.apply_js || "",
          undoJs: obj.undo_js || "",
          summary: obj.summary || ""
        };
      }
    } catch (_error) {
      return null;
    }
    return null;
  };

  const direct = parseObject(text.trim());
  if (direct) {
    return direct;
  }

  const jsonFenceMatch = text.match(/```json\s*([\s\S]*?)```/i);
  if (jsonFenceMatch) {
    const fenced = parseObject(jsonFenceMatch[1].trim());
    if (fenced) {
      return fenced;
    }
  }

  return null;
}

function isValidationBypassRequest(promptText) {
  const text = String(promptText || "").toLowerCase();
  return (
    (text.includes("disable") || text.includes("bypass") || text.includes("remove")) &&
    (text.includes("validation") || text.includes("required"))
  );
}

function collectTargetSelectorsFromContext(context, promptText) {
  const selectorSet = new Set();
  const prompt = String(promptText || "").toLowerCase();
  const wantsPhone = /phone|tel|mobile|contact/.test(prompt);

  if (context?.inspectedSelection?.selector) {
    selectorSet.add(context.inspectedSelection.selector);
  }
  if (Array.isArray(context?.likelyPhoneTargets)) {
    for (const item of context.likelyPhoneTargets.slice(0, 8)) {
      if (item?.selector) {
        selectorSet.add(item.selector);
      }
    }
  }
  if (Array.isArray(context?.labelHints)) {
    const filtered = wantsPhone
      ? context.labelHints.filter((item) =>
          /phone|tel|mobile|contact/.test(String(item?.labelText || "").toLowerCase())
        )
      : context.labelHints;
    for (const item of filtered.slice(0, 8)) {
      if (item?.inputSelector) {
        selectorSet.add(item.inputSelector);
      }
    }
  }

  return Array.from(selectorSet).filter(Boolean).slice(0, 12);
}

function buildValidationBypassScripts(targetSelectors) {
  const selectorsJson = JSON.stringify(targetSelectors || []);

  const applyJs = `(function() {
  const selectors = ${selectorsJson};
  if (!window.__localLlmValidationBypassBackup) {
    window.__localLlmValidationBypassBackup = { forms: [], targets: [] };
  }
  const backup = window.__localLlmValidationBypassBackup;

  if (!window.__localLlmValidationProtoBackup) {
    window.__localLlmValidationProtoBackup = {
      inputCheck: HTMLInputElement.prototype.checkValidity,
      inputReport: HTMLInputElement.prototype.reportValidity,
      selectCheck: HTMLSelectElement.prototype.checkValidity,
      selectReport: HTMLSelectElement.prototype.reportValidity,
      textCheck: HTMLTextAreaElement.prototype.checkValidity,
      textReport: HTMLTextAreaElement.prototype.reportValidity,
      formCheck: HTMLFormElement.prototype.checkValidity,
      formReport: HTMLFormElement.prototype.reportValidity
    };

    HTMLInputElement.prototype.checkValidity = function() { return true; };
    HTMLInputElement.prototype.reportValidity = function() { return true; };
    HTMLSelectElement.prototype.checkValidity = function() { return true; };
    HTMLSelectElement.prototype.reportValidity = function() { return true; };
    HTMLTextAreaElement.prototype.checkValidity = function() { return true; };
    HTMLTextAreaElement.prototype.reportValidity = function() { return true; };
    HTMLFormElement.prototype.checkValidity = function() { return true; };
    HTMLFormElement.prototype.reportValidity = function() { return true; };
  }

  const targetSet = new Set();
  for (const selector of selectors) {
    try {
      const el = document.querySelector(selector);
      if (el) targetSet.add(el);
    } catch (_error) {}
  }

  if (!targetSet.size) {
    const generic = document.querySelectorAll("input, select, textarea");
    generic.forEach((el) => targetSet.add(el));
  }

  targetSet.forEach((el) => {
    if (!backup.targets.find((t) => t.el === el)) {
      backup.targets.push({
        el,
        required: el.hasAttribute("required"),
        pattern: el.getAttribute("pattern"),
        min: el.getAttribute("min"),
        max: el.getAttribute("max"),
        minLength: el.getAttribute("minlength"),
        maxLength: el.getAttribute("maxlength"),
        readOnly: el.hasAttribute("readonly"),
        disabled: el.hasAttribute("disabled")
      });
    }

    ["required", "pattern", "min", "max", "minlength", "maxlength", "readonly", "disabled"].forEach((attr) => {
      el.removeAttribute(attr);
    });
    if (typeof el.setCustomValidity === "function") {
      el.setCustomValidity("");
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  });

  const forms = document.querySelectorAll("form");
  forms.forEach((form) => {
    if (!backup.forms.find((f) => f.form === form)) {
      backup.forms.push({
        form,
        hadNoValidateAttr: form.hasAttribute("novalidate"),
        noValidateValue: !!form.noValidate
      });
    }
    form.setAttribute("novalidate", "novalidate");
    form.noValidate = true;
  });
})();`;

  const undoJs = `(function() {
  const backup = window.__localLlmValidationBypassBackup;
  if (backup) {
    backup.targets.forEach((entry) => {
      const el = entry.el;
      if (!el) return;

      if (entry.required) el.setAttribute("required", "required"); else el.removeAttribute("required");
      if (entry.pattern !== null) el.setAttribute("pattern", entry.pattern); else el.removeAttribute("pattern");
      if (entry.min !== null) el.setAttribute("min", entry.min); else el.removeAttribute("min");
      if (entry.max !== null) el.setAttribute("max", entry.max); else el.removeAttribute("max");
      if (entry.minLength !== null) el.setAttribute("minlength", entry.minLength); else el.removeAttribute("minlength");
      if (entry.maxLength !== null) el.setAttribute("maxlength", entry.maxLength); else el.removeAttribute("maxlength");
      if (entry.readOnly) el.setAttribute("readonly", "readonly"); else el.removeAttribute("readonly");
      if (entry.disabled) el.setAttribute("disabled", "disabled"); else el.removeAttribute("disabled");
      if (typeof el.setCustomValidity === "function") el.setCustomValidity("");
    });

    backup.forms.forEach((entry) => {
      const form = entry.form;
      if (!form) return;
      if (entry.hadNoValidateAttr) form.setAttribute("novalidate", "novalidate");
      else form.removeAttribute("novalidate");
      form.noValidate = !!entry.noValidateValue;
    });
  }

  const proto = window.__localLlmValidationProtoBackup;
  if (proto) {
    HTMLInputElement.prototype.checkValidity = proto.inputCheck;
    HTMLInputElement.prototype.reportValidity = proto.inputReport;
    HTMLSelectElement.prototype.checkValidity = proto.selectCheck;
    HTMLSelectElement.prototype.reportValidity = proto.selectReport;
    HTMLTextAreaElement.prototype.checkValidity = proto.textCheck;
    HTMLTextAreaElement.prototype.reportValidity = proto.textReport;
    HTMLFormElement.prototype.checkValidity = proto.formCheck;
    HTMLFormElement.prototype.reportValidity = proto.formReport;
  }

  delete window.__localLlmValidationBypassBackup;
  delete window.__localLlmValidationProtoBackup;
})();`;

  return { applyJs, undoJs };
}

function sendMessageToBackground(message) {
  if (typeof browser !== "undefined" && browser.runtime?.sendMessage) {
    return browser.runtime.sendMessage(message);
  }

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function getPageContext() {
  return new Promise((resolve, reject) => {
    const expression = `(() => {
      function safeText(value) {
        return String(value || "").replace(/\\s+/g, " ").trim();
      }

      function getControlSelector(el) {
        if (el.id) {
          return "#" + el.id;
        }
        if (el.name) {
          return el.tagName.toLowerCase() + '[name="' + el.name + '"]';
        }
        return el.tagName.toLowerCase();
      }

      function getLabelText(el) {
        const labels = [];
        if (el.labels && el.labels.length) {
          labels.push(...Array.from(el.labels));
        }
        if (el.id) {
          labels.push(
            ...Array.from(document.querySelectorAll("label")).filter((label) => label.htmlFor === el.id)
          );
        }
        return labels
          .map((label) => safeText(label.textContent))
          .filter(Boolean)
          .join(" | ");
      }

      function collectLabelHints() {
        return Array.from(document.querySelectorAll("label"))
          .slice(0, 120)
          .map((label) => {
            const labelText = safeText(label.textContent);
            if (!labelText) {
              return null;
            }

            let input = null;
            if (label.htmlFor) {
              input = document.getElementById(label.htmlFor);
            }
            if (!input) {
              input = label.querySelector("input, select, textarea");
            }
            if (!input) {
              const container = label.closest("div, td, li, section, form") || label.parentElement;
              input = container ? container.querySelector("input, select, textarea") : null;
            }

            return {
              labelText,
              inputSelector: input ? getControlSelector(input) : "",
              inputTag: input ? input.tagName : "",
              inputType: input ? input.type || "" : "",
              inputName: input ? input.name || "" : "",
              inputId: input ? input.id || "" : "",
              required: input ? !!input.required : false
            };
          })
          .filter(Boolean);
      }

      const allControls = [];
      const forms = Array.from(document.forms).slice(0, 8).map((form, index) => {
        const controls = Array.from(form.elements).slice(0, 35).map((el) => {
          const summary = {
            tag: el.tagName,
            type: el.type || "",
            name: el.name || "",
            id: el.id || "",
            selector: getControlSelector(el),
            labelText: getLabelText(el),
            placeholder: el.placeholder || "",
            ariaLabel: el.getAttribute("aria-label") || "",
            inputMode: el.inputMode || "",
            autoComplete: el.autocomplete || "",
            required: !!el.required,
            disabled: !!el.disabled,
            readOnly: !!el.readOnly,
            hasPattern: !!el.pattern,
            pattern: el.pattern || "",
            minLength: typeof el.minLength === "number" ? el.minLength : -1,
            maxLength: typeof el.maxLength === "number" ? el.maxLength : -1
          };
          allControls.push(summary);
          return summary;
        });
        return { index, action: form.action || "", method: form.method || "get", controls };
      });

      const likelyPhoneTargets = allControls
        .filter((control) =>
          /phone|tel|mobile|contact number/i.test(
            [
              control.labelText,
              control.name,
              control.id,
              control.placeholder,
              control.ariaLabel,
              control.type
            ]
              .filter(Boolean)
              .join(" ")
          )
        )
        .slice(0, 10);

      return {
        url: location.href,
        title: document.title,
        forms,
        likelyPhoneTargets,
        labelHints: collectLabelHints()
      };
    })();`;

    chrome.devtools.inspectedWindow.eval(expression, (result, exceptionInfo) => {
      if (exceptionInfo?.isException) {
        reject(new Error(exceptionInfo.value || "Failed to collect page context."));
        return;
      }
      resolve(result);
    });
  });
}

function getInspectedSelectionContext() {
  return new Promise((resolve) => {
    const expression = `(() => {
      try {
        if (typeof $0 === "undefined" || !$0) {
          return null;
        }
        const el = $0;
        const labels = el.labels ? Array.from(el.labels).map((l) => (l.textContent || "").trim()).filter(Boolean) : [];
        return {
          tag: el.tagName || "",
          type: el.type || "",
          id: el.id || "",
          name: el.name || "",
          className: el.className || "",
          placeholder: el.placeholder || "",
          ariaLabel: el.getAttribute ? el.getAttribute("aria-label") || "" : "",
          labelText: labels.join(" | "),
          selector: el.id ? "#" + el.id : (el.name ? el.tagName.toLowerCase() + '[name="' + el.name + '"]' : el.tagName.toLowerCase())
        };
      } catch (_error) {
        return null;
      }
    })();`;

    chrome.devtools.inspectedWindow.eval(expression, (result, _exceptionInfo) => {
      resolve(result || null);
    });
  });
}

function runSnippetInInspectedPage(snippet) {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(snippet, (_result, exceptionInfo) => {
      if (exceptionInfo?.isException) {
        reject(new Error(exceptionInfo.value || "Snippet execution failed."));
        return;
      }
      resolve();
    });
  });
}

async function sendPrompt() {
  const prompt = promptInput.value.trim();
  const model = modelInput.value.trim() || "gemma4:e4b";
  const directMode = !!directModeInput.checked;

  if (!prompt) {
    setStatus("Enter a prompt first.", true);
    return;
  }

  sendBtn.disabled = true;
  runBtn.disabled = true;
  undoBtn.disabled = true;
  setStatus("Collecting context...");
  responseOutput.textContent = "";
  lastPrimarySnippet = "";
  lastRestoreSnippet = "";

  try {
    let context = null;
    if (includeContextInput.checked) {
      context = await getPageContext();
      const inspectedSelection = await getInspectedSelectionContext();
      if (context && inspectedSelection) {
        context.inspectedSelection = inspectedSelection;
      }
    }

    setStatus("Asking Ollama...");
    const response = await sendMessageToBackground({
      type: "ask-ollama",
      model,
      prompt,
      context,
      directMode
    });

    if (!response || response.error) {
      throw new Error(response?.error || "No response from background worker.");
    }

    const rawContent = response.content || "";
    const actionPayload = parseActionPayload(rawContent);
    if (actionPayload) {
      lastPrimarySnippet = actionPayload.applyJs || "";
      lastRestoreSnippet = actionPayload.undoJs || "";
      responseOutput.textContent = actionPayload.summary || "Action plan received.";
    } else {
      const snippets = extractCodeFences(rawContent);
      lastPrimarySnippet = snippets[0] || "";
      lastRestoreSnippet = snippets[1] || "";
      responseOutput.textContent = directMode ? "Received non-structured response from model." : rawContent;
    }

    if (directMode && !lastPrimarySnippet) {
      throw new Error(
        "Model did not return an executable action. Retry or uncheck direct mode to inspect raw output."
      );
    }

    if (isValidationBypassRequest(prompt)) {
      const targetSelectors = collectTargetSelectorsFromContext(context, prompt);
      const fallbackScripts = buildValidationBypassScripts(targetSelectors);
      lastPrimarySnippet = lastPrimarySnippet
        ? `${lastPrimarySnippet}\n\n${fallbackScripts.applyJs}`
        : fallbackScripts.applyJs;
      lastRestoreSnippet = lastRestoreSnippet
        ? `${fallbackScripts.undoJs}\n\n${lastRestoreSnippet}`
        : fallbackScripts.undoJs;
    }

    runBtn.disabled = !lastPrimarySnippet;
    undoBtn.disabled = !lastRestoreSnippet;

    if ((directMode || autoRunInput.checked) && lastPrimarySnippet) {
      await runSnippetInInspectedPage(lastPrimarySnippet);
      setStatus("Action executed on page.");
    } else {
      setStatus("Done.");
    }
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    sendBtn.disabled = false;
  }
}

async function runLastSnippet() {
  if (!lastPrimarySnippet) {
    setStatus("No JavaScript snippet found in the last response.", true);
    return;
  }

  runBtn.disabled = true;
  setStatus("Running snippet in inspected page...");

  try {
    await runSnippetInInspectedPage(lastPrimarySnippet);
    setStatus("Snippet executed.");
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    runBtn.disabled = false;
  }
}

async function undoLastChange() {
  if (!lastRestoreSnippet) {
    setStatus("No restore snippet found in the last response.", true);
    return;
  }

  undoBtn.disabled = true;
  setStatus("Running restore snippet...");

  try {
    await runSnippetInInspectedPage(lastRestoreSnippet);
    setStatus("Restore snippet executed.");
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    undoBtn.disabled = false;
  }
}

sendBtn.addEventListener("click", sendPrompt);
runBtn.addEventListener("click", runLastSnippet);
undoBtn.addEventListener("click", undoLastChange);
