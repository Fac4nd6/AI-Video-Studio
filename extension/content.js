(() => {
  const scriptVersion = `${chrome.runtime.id}:${chrome.runtime.getManifest().version}`;
  if (globalThis.__aiVideoStudioContentScriptLoaded === scriptVersion) return;
  globalThis.__aiVideoStudioContentScriptLoaded = scriptVersion;

  // The result alt label was observed in the user's Flow trace; pairing it with returned controls is experimental.
  const FLOW_SELECTORS = Object.freeze({
    promptInput: 'div[aria-label="What do you want to create?"]',
    generateButton: 'button[aria-label="Start generation"]',
    generationResult: "img[alt=\"Tile displaying a user's image\"]"
  });
  const GENERATION_WATCH_TIMEOUT_MS = 15 * 60 * 1000;

  let stateObserver = null;
  let mediaEventHandler = null;
  let observationSessionId = null;
  let lastObservedState = "";
  let generationWatch = null;

  function isFlowPage() {
    return location.protocol === "https:" &&
      location.hostname === "flow.google.com";
  }

  function getStatus() {
    const connected = isFlowPage();
    const promptPreparationReady = Boolean(FLOW_SELECTORS.promptInput && FLOW_SELECTORS.generateButton);
    const completionDetectionReady = Boolean(FLOW_SELECTORS.generationResult);
    return {
      connected,
      promptPreparationReady: connected && promptPreparationReady,
      automationReady: connected && promptPreparationReady && completionDetectionReady,
      reason: !connected
        ? "FLOW_PAGE_UNVERIFIED"
        : !promptPreparationReady
          ? "SELECTORS_UNVERIFIED"
          : !completionDetectionReady
            ? "COMPLETION_DETECTION_UNVERIFIED"
            : null
    };
  }

  function isVisible(element) {
    return element.getClientRects().length > 0;
  }

  function escapeAttributeValue(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ");
  }

  function getUniqueSelectorCandidate(element) {
    const tag = element.tagName.toLowerCase();
    const attributes = ["aria-label", "placeholder", "data-placeholder", "name", "data-testid", "title"];
    for (const attribute of attributes) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const selector = `${tag}[${attribute}="${escapeAttributeValue(value)}"]`;
      try {
        if (document.querySelectorAll(selector).length === 1) {
          return { selector, uniqueInDocument: true, basedOn: attribute };
        }
      } catch {
        // Ignore an invalid candidate and continue with other stable attributes.
      }
    }

    if (element.isContentEditable && document.querySelectorAll('[contenteditable="true"]').length === 1) {
      return {
        selector: '[contenteditable="true"]',
        uniqueInDocument: true,
        basedOn: "contenteditable"
      };
    }
    return null;
  }

  function describeElement(element, includeText = false) {
    const description = {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      ariaLabel: element.getAttribute("aria-label"),
      title: element.getAttribute("title"),
      placeholder: element.getAttribute("placeholder"),
      dataPlaceholder: element.getAttribute("data-placeholder"),
      dataTestId: element.getAttribute("data-testid"),
      name: element.getAttribute("name"),
      type: element.getAttribute("type"),
      contentEditable: element.isContentEditable,
      ariaBusy: element.getAttribute("aria-busy"),
      ariaLive: element.getAttribute("aria-live"),
      ariaDisabled: element.getAttribute("aria-disabled"),
      disabled: "disabled" in element ? element.disabled : null,
      visible: isVisible(element),
      selectorCandidate: getUniqueSelectorCandidate(element)
    };
    if (includeText) {
      description.accessibleText = (
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.innerText ||
        ""
      ).trim().slice(0, 160);
    }
    return description;
  }

  function diagnoseInterface() {
    const fields = [...document.querySelectorAll(
      'textarea, input:not([type="hidden"]):not([type="password"]), [contenteditable="true"], [role="textbox"]'
    )].filter(isVisible).slice(0, 30);
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter(isVisible)
      .slice(0, 50);
    const indicators = [...document.querySelectorAll(
      '[role="status"], [role="alert"], [role="alertdialog"], [role="progressbar"], [aria-live], [aria-busy="true"]'
    )].filter(isVisible).slice(0, 50);
    const indicatorDetails = indicators.map(element => ({
      ...describeElement(element, true),
      text: (element.innerText || "").trim().slice(0, 160)
    }));

    return {
      readOnly: true,
      capturedAt: new Date().toISOString(),
      fields: fields.map(element => describeElement(element)),
      buttons: buttons.map(element => describeElement(element, true)),
      statusIndicators: indicatorDetails,
      stateAssessment: {
        processingHints: indicatorDetails.filter(item =>
          item.ariaBusy === "true" || item.role === "progressbar"
        ),
        errorOrConfirmationHints: indicatorDetails.filter(item =>
          item.role === "alert" || item.role === "alertdialog"
        ),
        idle: "No se infiere solo por ausencia de indicadores.",
        completed: "Pendiente de verificar un indicador accesible de resultado terminado."
      }
    };
  }

  function getObservationSnapshot() {
    const describeSignal = element => ({
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      ariaLabel: element.getAttribute("aria-label"),
      title: element.getAttribute("title"),
      ariaBusy: element.getAttribute("aria-busy"),
      ariaLive: element.getAttribute("aria-live"),
      ariaDisabled: element.getAttribute("aria-disabled"),
      disabled: "disabled" in element ? element.disabled : null,
      ariaValueNow: element.getAttribute("aria-valuenow"),
      ariaValueText: element.getAttribute("aria-valuetext"),
      dataState: element.getAttribute("data-state"),
      visible: isVisible(element)
    });
    const editor = document.querySelector(FLOW_SELECTORS.promptInput);
    const generateButton = document.querySelector(FLOW_SELECTORS.generateButton);
    const statusElements = [...document.querySelectorAll(
      '[role="status"], [role="alert"], [role="alertdialog"], [role="progressbar"], [aria-live], [aria-busy="true"]'
    )].filter(isVisible).slice(0, 30);
    const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
      .filter(isVisible).slice(0, 10);
    const media = [...document.querySelectorAll('img[alt], video, canvas, [role="img"]')]
      .filter(isVisible).slice(0, 30);

    return {
      editor: editor ? {
        ...describeSignal(editor),
        contentEditable: editor.isContentEditable,
        hasText: Boolean(editor.textContent.trim())
      } : null,
      generateButton: generateButton ? describeSignal(generateButton) : null,
      statusElements: statusElements.map(element => ({
        ...describeSignal(element),
        text: ["status", "alert", "alertdialog"].includes(element.getAttribute("role"))
          ? (element.innerText || "").trim().slice(0, 160)
          : null
      })),
      dialogs: dialogs.map(describeSignal),
      media: media.map(element => ({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        ariaLabel: element.getAttribute("aria-label"),
        alt: element.getAttribute("alt"),
        title: element.getAttribute("title"),
        hasSource: Boolean(element.currentSrc || element.getAttribute("src") || element.getAttribute("poster")),
        complete: "complete" in element ? element.complete : null,
        naturalWidth: "naturalWidth" in element ? element.naturalWidth : null,
        naturalHeight: "naturalHeight" in element ? element.naturalHeight : null,
        readyState: "readyState" in element ? element.readyState : null,
        width: "width" in element ? element.width : null,
        height: "height" in element ? element.height : null,
        visible: isVisible(element)
      }))
    };
  }

  function emitObservationIfChanged() {
    const snapshot = getObservationSnapshot();
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastObservedState) return;
    lastObservedState = serialized;
    emitObservation(snapshot);
  }

  function emitObservation(snapshot) {
    chrome.runtime.sendMessage({
      type: "FLOW_OBSERVATION_EVENT",
      snapshot,
      sessionId: observationSessionId,
      capturedAt: new Date().toISOString()
    }).then(response => {
      if (!response?.ok) {
        console.warn("AI Video Studio: no se pudo guardar una observación de Flow.", response?.error);
      }
    }).catch(error => console.warn("AI Video Studio: no se pudo guardar una observación de Flow.", error));
  }

  function getResultSource(element) {
    const source = element.currentSrc || element.getAttribute("src") || "";
    if (!source) return "";
    try {
      const url = new URL(source, location.href);
      return `${url.origin}${url.pathname}`;
    } catch {
      return source;
    }
  }

  function clearGenerationWatch() {
    if (!generationWatch) return;
    clearTimeout(generationWatch.timeoutId);
    generationWatch = null;
  }

  function finishGenerationWatch(type, message, result) {
    if (!generationWatch) return;
    const { promptId } = generationWatch;
    clearGenerationWatch();
    chrome.runtime.sendMessage({
      type,
      promptId,
      message,
      result
    }).then(response => {
      if (!response?.ok) {
        console.warn("AI Video Studio: Flow no pudo actualizar el estado de la generación.", response?.error);
      }
    }).catch(error => console.warn("AI Video Studio: Flow no pudo actualizar el estado de la generación.", error));
  }

  function checkGenerationWatch() {
    const watch = generationWatch;
    if (!watch?.clickIssued) return;

    const alert = [...document.querySelectorAll('[role="alert"], [role="alertdialog"]')]
      .find(isVisible);
    if (alert) {
      const message = (alert.innerText || alert.getAttribute("aria-label") || "").trim();
      finishGenerationWatch(
        "FLOW_GENERATION_UNKNOWN",
        message || "Flow mostró una alerta durante la generación; verificá el resultado."
      );
      return;
    }

    const editor = document.querySelector(FLOW_SELECTORS.promptInput);
    const button = document.querySelector(FLOW_SELECTORS.generateButton);
    if (!editor || !button || !isVisible(editor) || !isVisible(button)) {
      watch.sawControlsUnavailable = true;
    }

    if (!watch.newResult) {
      const resultImage = [...document.querySelectorAll(FLOW_SELECTORS.generationResult)]
        .find(image => {
          const source = getResultSource(image);
          return isVisible(image) &&
            image.complete &&
            image.naturalWidth > 32 &&
            image.naturalHeight > 32 &&
            source &&
            !watch.baselineSources.has(source);
        });
      if (resultImage) {
        watch.newResult = {
          alt: resultImage.getAttribute("alt"),
          width: resultImage.naturalWidth,
          height: resultImage.naturalHeight
        };
      }
    }

    const busy = [...document.querySelectorAll(
      '[aria-busy="true"], [role="progressbar"], [role="dialog"], [role="alertdialog"]'
    )].some(isVisible);
    const controlsReturned = watch.sawControlsUnavailable &&
      editor && button &&
      isVisible(editor) &&
      isVisible(button) &&
      !editor.textContent.trim() &&
      button.disabled;
    if (watch.newResult && controlsReturned && !busy) {
      finishGenerationWatch(
        "FLOW_GENERATION_FINISHED",
        "Apareció una imagen nueva cargada y Flow volvió a mostrar el editor vacío.",
        watch.newResult
      );
    }
  }

  function startGenerationWatch(promptId) {
    if (!stateObserver || !promptId || generationWatch) {
      return {
        ok: false,
        message: "No se pudo armar el observador de resultado para esta escena."
      };
    }
    const baselineSources = new Set(
      [...document.querySelectorAll(FLOW_SELECTORS.generationResult)]
        .map(getResultSource)
        .filter(Boolean)
    );
    generationWatch = {
      promptId,
      sessionId: observationSessionId,
      baselineSources,
      sawControlsUnavailable: false,
      newResult: null,
      clickIssued: false,
      timeoutId: null
    };
    return { ok: true };
  }

  function confirmGenerationWatchClick(promptId) {
    if (!generationWatch || generationWatch.promptId !== promptId) {
      return { ok: false, message: "No hay un observador armado para esta escena." };
    }
    generationWatch.clickIssued = true;
    generationWatch.timeoutId = setTimeout(() => {
      finishGenerationWatch(
        "FLOW_GENERATION_UNKNOWN",
        "No apareció evidencia suficiente de resultado nuevo; verificá Flow antes de continuar."
      );
    }, GENERATION_WATCH_TIMEOUT_MS);
    checkGenerationWatch();
    return { ok: true };
  }

  function startStateObservation(sessionId) {
    if (!isFlowPage()) {
      return { ok: false, code: "FLOW_PAGE_UNVERIFIED", message: "La pestaña ya no está en Google Flow." };
    }
    if (generationWatch) {
      return { ok: false, code: "GENERATION_WATCH_ACTIVE", message: "Ya hay una generación observada en esta pestaña." };
    }
    stateObserver?.disconnect();
    if (mediaEventHandler) {
      document.removeEventListener("load", mediaEventHandler, true);
      document.removeEventListener("error", mediaEventHandler, true);
      document.removeEventListener("loadeddata", mediaEventHandler, true);
      document.removeEventListener("canplay", mediaEventHandler, true);
    }
    observationSessionId = sessionId;
    const initialSnapshot = getObservationSnapshot();
    lastObservedState = JSON.stringify(initialSnapshot);
    stateObserver = new MutationObserver(() => {
      emitObservationIfChanged();
      checkGenerationWatch();
    });
    stateObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "aria-busy", "aria-live", "aria-label", "aria-disabled", "aria-valuenow",
        "aria-valuetext", "contenteditable", "disabled", "hidden", "role",
        "data-state", "alt", "title", "placeholder", "src", "srcset", "poster"
      ],
      characterData: true
    });
    mediaEventHandler = event => {
      if (event.target instanceof Element && event.target.matches("img, video")) {
        emitObservationIfChanged();
        checkGenerationWatch();
      }
    };
    document.addEventListener("load", mediaEventHandler, true);
    document.addEventListener("error", mediaEventHandler, true);
    document.addEventListener("loadeddata", mediaEventHandler, true);
    document.addEventListener("canplay", mediaEventHandler, true);
    return { ok: true, snapshot: initialSnapshot };
  }

  function stopStateObservation(sessionId) {
    if (sessionId && sessionId !== observationSessionId) return;
    if (generationWatch?.sessionId === observationSessionId) {
      finishGenerationWatch(
        "FLOW_GENERATION_UNKNOWN",
        "La observación se detuvo antes de confirmar el resultado; verificá Flow."
      );
    }
    stateObserver?.disconnect();
    stateObserver = null;
    observationSessionId = null;
    if (!mediaEventHandler) return;
    document.removeEventListener("load", mediaEventHandler, true);
    document.removeEventListener("error", mediaEventHandler, true);
    document.removeEventListener("loadeddata", mediaEventHandler, true);
    document.removeEventListener("canplay", mediaEventHandler, true);
    mediaEventHandler = null;
  }

  function isVisible(element) {
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none";
  }

  function waitForEnabledGenerateButton(timeoutMs = 5000) {
    return new Promise(resolve => {
      let observer;
      const finish = result => {
        observer?.disconnect();
        clearTimeout(timeout);
        resolve(result);
      };
      const check = () => {
        const button = document.querySelector(FLOW_SELECTORS.generateButton);
        if (!button || !isVisible(button)) return;
        if (!button.disabled && button.getAttribute("aria-disabled") !== "true") {
          finish(button);
        }
      };
      observer = new MutationObserver(check);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
      const timeout = setTimeout(() => finish(null), timeoutMs);
      check();
    });
  }

  async function preparePrompt({ text }) {
    const status = getStatus();
    if (!status.promptPreparationReady) {
      return { ok: false, code: status.reason, message: "Los controles de preparación no están disponibles en esta pestaña." };
    }

    const input = document.querySelector(FLOW_SELECTORS.promptInput);
    const button = document.querySelector(FLOW_SELECTORS.generateButton);
    if (!input || input.getAttribute("aria-label") !== "What do you want to create?" ||
        input.getAttribute("role") !== "textbox" || !input.isContentEditable) {
      return { ok: false, code: "PROMPT_INPUT_UNVERIFIED", message: "No se encontró el editor contenteditable verificado." };
    }
    if (!button || button.tagName !== "BUTTON" ||
        button.getAttribute("aria-label") !== "Start generation" ||
        button.getAttribute("type") !== "submit") {
      return { ok: false, code: "GENERATE_BUTTON_UNVERIFIED", message: "No se encontró el botón de envío verificado." };
    }
    if (!isVisible(input) || !isVisible(button)) {
      return { ok: false, code: "FLOW_CONTROLS_NOT_VISIBLE", message: "El editor o el botón de envío no está visible." };
    }

    const inputEvents = [];
    const captureButtonState = () => {
      const currentButton = document.querySelector(FLOW_SELECTORS.generateButton);
      return currentButton ? {
        visible: isVisible(currentButton),
        disabled: currentButton.disabled,
        ariaDisabled: currentButton.getAttribute("aria-disabled")
      } : null;
    };
    input.focus();
    const beforeInputEvent = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: text
    });
    const beforeInputNotCanceled = input.dispatchEvent(beforeInputEvent);
    inputEvents.push({
      type: "beforeinput",
      isTrusted: beforeInputEvent.isTrusted,
      notCanceled: beforeInputNotCanceled,
      button: captureButtonState()
    });
    if (!beforeInputNotCanceled) {
      return {
        ok: false,
        code: "PROMPT_EDIT_CANCELED",
        message: "Flow canceló el evento beforeinput; no se modificó el editor.",
        inputEvents
      };
    }

    const selection = window.getSelection();
    if (!selection) {
      return { ok: false, code: "PROMPT_SELECTION_UNAVAILABLE", message: "No se pudo seleccionar el contenido editable." };
    }
    const range = document.createRange();
    range.selectNodeContents(input);
    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    const inputEvent = new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text
    });
    const inputNotCanceled = input.dispatchEvent(inputEvent);
    inputEvents.push({
      type: "input",
      isTrusted: inputEvent.isTrusted,
      notCanceled: inputNotCanceled,
      button: captureButtonState()
    });
    if (input.textContent !== text) {
      return {
        ok: false,
        code: "PROMPT_TEXT_NOT_CONFIRMED",
        message: "Flow no conservó exactamente el texto del prompt.",
        inputEvents
      };
    }

    const enabledButton = await waitForEnabledGenerateButton();
    if (!enabledButton) {
      return {
        ok: false,
        code: "GENERATE_BUTTON_NOT_ENABLED",
        message: "El DOM muestra el texto, pero Flow no habilitó Start generation tras beforeinput/input. No se hizo clic.",
        inputEvents,
        button: captureButtonState()
      };
    }
    return {
      ok: true,
      prepared: true,
      sent: false,
      button: captureButtonState(),
      inputEvents
    };
  }

  function getGenerateButtonClickTarget() {
    const button = document.querySelector(FLOW_SELECTORS.generateButton);
    if (!button || button.tagName !== "BUTTON" ||
        button.getAttribute("aria-label") !== "Start generation" ||
        button.getAttribute("type") !== "submit" ||
        !isVisible(button) || button.disabled ||
        button.getAttribute("aria-disabled") === "true") {
      return {
        ok: false,
        code: "GENERATE_BUTTON_NOT_READY",
        message: "Start generation ya no está visible y habilitado."
      };
    }

    const rect = button.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (rect.width <= 0 || rect.height <= 0 ||
        x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
      return {
        ok: false,
        code: "GENERATE_BUTTON_OUT_OF_VIEW",
        message: "Start generation está fuera del área visible; no se envió el clic."
      };
    }
    return { ok: true, clickTarget: { x, y } };
  }

  async function prepareControlledTest({ text }) {
    function hasInterventionAlert() {
      return [...document.querySelectorAll('[role="alert"], [role="alertdialog"]')]
        .some(element => isVisible(element));
    }
    function hasBusyHint() {
      return [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')]
        .some(element => isVisible(element));
    }

    if (hasInterventionAlert() || hasBusyHint()) {
      return {
        ok: false,
        code: "FLOW_REQUIRES_INTERVENTION",
        message: "Flow muestra una alerta o señal de actividad accesible; revisala antes de generar."
      };
    }

    const preparation = await preparePrompt({ text });
    if (!preparation.ok) return preparation;
    if (hasInterventionAlert() || hasBusyHint()) {
      return {
        ok: false,
        code: "FLOW_REQUIRES_INTERVENTION",
        message: "Flow mostró una alerta o señal de actividad durante la preparación; no se inició la generación."
      };
    }
    const button = document.querySelector(FLOW_SELECTORS.generateButton);
    if (!button || !isVisible(button) || button.disabled ||
        button.getAttribute("aria-disabled") === "true") {
      return {
        ok: false,
        code: "GENERATE_BUTTON_NOT_READY",
        message: "El botón dejó de estar visible o habilitado. No se inició la generación."
      };
    }
    if (!stateObserver) {
      return {
        ok: false,
        code: "FLOW_OBSERVER_NOT_RUNNING",
        message: "No se pudo iniciar el observador de cambios de Flow."
      };
    }

    const clickTarget = getGenerateButtonClickTarget();
    if (!clickTarget.ok) return clickTarget;
    emitObservation(getObservationSnapshot());
    return { ...clickTarget, prepared: true, singleSceneOnly: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PING" || message?.type === "FLOW_GET_STATUS") {
      sendResponse({ type: "PONG", ...getStatus() });
      return;
    }
    if (message?.type === "FLOW_DIAGNOSE") {
      sendResponse({
        type: "FLOW_DIAGNOSTIC_RESULT",
        connected: isFlowPage(),
        diagnostic: diagnoseInterface()
      });
      return;
    }
    if (message?.type === "FLOW_PREPARE_PROMPT") {
      preparePrompt(message).then(sendResponse, error => {
        sendResponse({ ok: false, code: "FLOW_DOM_ERROR", message: error.message });
      });
      return true;
    }
    if (message?.type === "FLOW_CONTROLLED_TEST_PREPARE") {
      prepareControlledTest(message).then(sendResponse, error => {
        sendResponse({ ok: false, code: "FLOW_DOM_ERROR", message: error.message });
      });
      return true;
    }
    if (message?.type === "FLOW_GENERATION_WATCH_START") {
      sendResponse(startGenerationWatch(message.promptId));
      return;
    }
    if (message?.type === "FLOW_GENERATION_WATCH_CLICKED") {
      sendResponse(confirmGenerationWatchClick(message.promptId));
      return;
    }
    if (message?.type === "FLOW_GENERATION_WATCH_CANCEL") {
      if (generationWatch?.promptId === message.promptId) clearGenerationWatch();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "FLOW_OBSERVER_START") {
      sendResponse({ type: "FLOW_OBSERVER_STARTED", ...startStateObservation(message.sessionId) });
      return;
    }
    if (message?.type === "FLOW_OBSERVER_STOP") {
      stopStateObservation(message.sessionId);
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "FLOW_SUBMIT_PROMPT") {
      sendResponse({
        ok: false,
        code: "GENERATION_NOT_VERIFIED",
        message: "No se envió el prompt: los estados de generación y finalización aún no están verificados."
      });
      return;
    }
    if (message?.type === "FLOW_STOP") {
      clearGenerationWatch();
      sendResponse({ ok: true, stopped: false, message: "No hay una generación automática activa." });
    }
  });
})();
