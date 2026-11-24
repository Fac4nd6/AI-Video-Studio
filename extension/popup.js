const elements = Object.fromEntries([
  "connectionDot", "connectionLabel", "connectionDetail", "progressSummary", "progressPercent",
  "diagnoseButton", "diagnosticOutput", "prepareButton", "preparationOutput",
  "observeButton", "stopObservationButton", "observationOutput",
  "progressBar", "queueMessage", "startButton", "pauseButton", "resumeButton", "stopButton",
  "currentPrompt", "generationStatus", "promptInput", "splitMode", "importButton", "totalCount",
  "completedCount", "sceneList", "editPrompt", "saveEditButton", "retryButton",
  "confirmCompletedButton", "notice"
].map(id => [id, document.getElementById(id)]));

let state;
let selectedPromptId = null;
let observationState = { running: false, events: [] };
let flowStatus = {
  connected: false,
  automationReady: false,
  flowOpen: false,
  message: "Comprobando pestañas de Flow…"
};

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error ?? "No se pudo completar la operación.");
  return response.state;
}

function parsePrompts(text, splitMode) {
  const blocks = splitMode === "blank-lines"
    ? text.split(/\r?\n\s*\r?\n+/)
    : text.split(/^\s*---PROMPT---\s*$/m);
  return blocks.map(block => block.trim()).filter(Boolean);
}

function labelForStatus(status) {
  return ({
    pending: "Pendiente",
    processing: "Procesando",
    completed: "Completada",
    error: "Error"
  })[status] ?? status;
}

function render() {
  if (!state) return;
  const total = state.prompts.length;
  const completed = state.prompts.filter(prompt => prompt.status === "completed").length;
  const current = state.prompts.find(prompt => prompt.id === state.queue.currentPromptId);
  const percent = total ? Math.round((completed / total) * 100) : 0;

  elements.totalCount.textContent = `${total} ${total === 1 ? "escena" : "escenas"}`;
  elements.completedCount.textContent = `${completed} completadas`;
  elements.progressSummary.textContent = `${completed} de ${total} completados`;
  elements.progressPercent.textContent = `${percent}%`;
  elements.progressBar.max = total;
  elements.progressBar.value = completed;
  elements.queueMessage.textContent = state.queue.message || "Importá prompts para comenzar.";
  elements.currentPrompt.textContent = current?.text ?? "Sin prompt en proceso.";
  elements.generationStatus.textContent = current && state.queue.status === "paused"
    ? "En pausa · esperando la escena actual"
    : current && state.queue.mode === "single_scene_test"
      ? "Prueba supervisada · estado por verificar"
      : current
        ? "Generación en curso"
    : labelForStatus(state.queue.status);
  elements.connectionDot.classList.toggle("connected", flowStatus.connected);
  elements.connectionLabel.textContent = flowStatus.connected
    ? "Google Flow detectado · conectado"
    : flowStatus.flowOpen
      ? "Google Flow abierto · sin comunicación"
      : "Google Flow no encontrado";
  elements.connectionDetail.textContent = flowStatus.message;
  elements.diagnoseButton.disabled = !flowStatus.connected;
  elements.prepareButton.disabled = !flowStatus.promptPreparationReady ||
    ["running", "paused"].includes(state.queue.status) ||
    state.prompts.some(prompt => prompt.status === "processing");
  const queueActive = ["running", "paused"].includes(state.queue.status);
  elements.observeButton.disabled = !flowStatus.connected || observationState.running || queueActive;
  elements.stopObservationButton.disabled = !observationState.running || queueActive;

  const canStart = total > 0 && flowStatus.automationReady &&
    !["running", "paused"].includes(state.queue.status);
  elements.startButton.disabled = !canStart;
  elements.importButton.disabled = ["running", "paused"].includes(state.queue.status) ||
    state.prompts.some(prompt => prompt.status === "processing");
  elements.pauseButton.disabled = state.queue.status !== "running";
  elements.resumeButton.disabled = state.queue.status !== "paused";
  elements.stopButton.disabled = !["running", "paused", "waiting_user"].includes(state.queue.status);

  elements.sceneList.replaceChildren();
  for (const prompt of state.prompts) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `scene-item${prompt.id === selectedPromptId ? " selected" : ""}`;
    button.setAttribute("aria-label", `Escena ${prompt.sceneNumber}: ${labelForStatus(prompt.status)}`);
    if (prompt.lastError) button.title = prompt.lastError;
    const number = document.createElement("span");
    number.className = "scene-number";
    number.textContent = String(prompt.sceneNumber).padStart(2, "0");
    const text = document.createElement("span");
    text.className = "scene-text";
    text.textContent = prompt.text;
    const status = document.createElement("span");
    status.className = `scene-state ${prompt.status}`;
    status.textContent = labelForStatus(prompt.status);
    button.append(number, text, status);
    button.addEventListener("click", () => selectPrompt(prompt.id));
    elements.sceneList.append(button);
  }
  updateSelection();
}

function selectPrompt(promptId) {
  selectedPromptId = promptId;
  updateSelection();
  render();
}

function updateSelection() {
  const prompt = state?.prompts.find(item => item.id === selectedPromptId);
  elements.editPrompt.value = prompt?.text ?? "";
  elements.editPrompt.disabled = !prompt || prompt.status === "processing";
  elements.saveEditButton.disabled = !prompt || prompt.status === "processing";
  elements.retryButton.disabled = !prompt || prompt.status !== "error";
  elements.confirmCompletedButton.disabled = !prompt || prompt.status !== "error";
}

function showNotice(message = "") {
  elements.notice.textContent = message;
}

async function refresh() {
  state = await send("APP_GET_STATE");
  elements.splitMode.value = state.settings.splitMode;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  flowStatus = await send("APP_GET_FLOW_STATUS", { activeTabId: tab?.id ?? null });
  observationState = await send("APP_GET_FLOW_OBSERVATION");
  renderObservation();
  if (!state.prompts.some(prompt => prompt.id === selectedPromptId)) {
    selectedPromptId = state.prompts[0]?.id ?? null;
  }
  render();
}

function renderObservation() {
  const events = observationState.events ?? [];
  if (!events.length) {
    elements.observationOutput.textContent = observationState.running
      ? "Observación activa; todavía no se han observado cambios."
      : "La cola inicia la observación automáticamente durante el procesamiento.";
    return;
  }
  const visibleEvents = events.slice(-25);
  elements.observationOutput.textContent = [
    `Observación ${observationState.running ? "activa" : "detenida"} · ${events.length} cambios registrados`,
    `Mostrando los últimos ${visibleEvents.length}; máximo conservado: 100.`,
    JSON.stringify(visibleEvents, null, 2)
  ].join("\n\n");
}

async function run(action) {
  showNotice("");
  try {
    const result = await action();
    if (result) state = result;
    render();
  } catch (error) {
    showNotice(error.message);
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.aiVideoStudioState?.newValue) {
    state = changes.aiVideoStudioState.newValue;
    if (!state.prompts.some(prompt => prompt.id === selectedPromptId)) {
      selectedPromptId = state.prompts[0]?.id ?? null;
    }
    render();
  }
  if (areaName === "session" && changes.flowDomObservation?.newValue) {
    observationState = changes.flowDomObservation.newValue;
    renderObservation();
  }
});

elements.diagnoseButton.addEventListener("click", async () => {
  showNotice("");
  elements.diagnoseButton.disabled = true;
  elements.diagnosticOutput.textContent = "Leyendo controles y atributos accesibles; no se enviará ningún prompt…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await send("APP_DIAGNOSE_FLOW", { activeTabId: tab?.id ?? null });
    elements.diagnosticOutput.textContent = result.diagnostic
      ? `${result.message}\n\n${JSON.stringify(result.diagnostic, null, 2)}`
      : result.message;
  } catch (error) {
    elements.diagnosticOutput.textContent = "El diagnóstico falló.";
    showNotice(error.message);
  } finally {
    elements.diagnoseButton.disabled = !flowStatus.connected;
  }
});

elements.prepareButton.addEventListener("click", async () => {
  showNotice("");
  elements.prepareButton.disabled = true;
  elements.preparationOutput.textContent = "Preparando el próximo prompt; el botón de generación no se pulsará…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await send("APP_PREPARE_NEXT_PROMPT", { activeTabId: tab?.id ?? null });
    elements.preparationOutput.textContent = result.ok
      ? `Escena ${result.sceneNumber} preparada. El botón está visible y habilitado. No se envió ni se marcó como completada.\n${JSON.stringify(result.inputEvents)}`
      : `${result.message ?? "No se pudo preparar el prompt."}${result.inputEvents ? `\nEventos: ${JSON.stringify(result.inputEvents)}` : ""}${result.button ? `\nBotón: ${JSON.stringify(result.button)}` : ""}`;
  } catch (error) {
    elements.preparationOutput.textContent = "No se pudo preparar el prompt.";
    showNotice(error.message);
  } finally {
    elements.prepareButton.disabled = !flowStatus.promptPreparationReady ||
      ["running", "paused"].includes(state.queue.status) ||
      state.prompts.some(prompt => prompt.status === "processing");
  }
});

elements.observeButton.addEventListener("click", async () => {
  showNotice("");
  elements.observeButton.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await send("APP_START_FLOW_OBSERVATION", { activeTabId: tab?.id ?? null });
    observationState = result.observation ?? observationState;
    if (!result.ok) showNotice(result.message ?? "No se pudo iniciar la observación.");
    renderObservation();
    render();
  } catch (error) {
    showNotice(error.message);
  }
});

elements.stopObservationButton.addEventListener("click", async () => {
  showNotice("");
  elements.stopObservationButton.disabled = true;
  try {
    observationState = await send("APP_STOP_FLOW_OBSERVATION");
    renderObservation();
    render();
  } catch (error) {
    showNotice(error.message);
  }
});

elements.importButton.addEventListener("click", () => run(async () => {
  const texts = parsePrompts(elements.promptInput.value, elements.splitMode.value);
  if (!texts.length) throw new Error("Ingresá al menos un prompt.");
  if (state.prompts.length && !confirm("Importar reemplazará la lista y el progreso actuales. ¿Continuar?")) return;
  const prompts = texts.map((text, index) => ({
    id: crypto.randomUUID(),
    sceneNumber: index + 1,
    text,
    status: "pending",
    processedAt: null
  }));
  selectedPromptId = prompts[0]?.id ?? null;
  const importedState = await send("APP_IMPORT_PROMPTS", { prompts, splitMode: elements.splitMode.value });
  elements.promptInput.value = "";
  return importedState;
}));

elements.saveEditButton.addEventListener("click", () => run(async () => {
  const text = elements.editPrompt.value.trim();
  if (!text) throw new Error("El prompt no puede quedar vacío.");
  return send("APP_UPDATE_PROMPT", { promptId: selectedPromptId, text });
}));

elements.retryButton.addEventListener("click", () => run(
  () => send("APP_RETRY_PROMPT", { promptId: selectedPromptId })
));
elements.confirmCompletedButton.addEventListener("click", () => run(async () => {
  if (!confirm("Confirmá solo si verificaste manualmente en Flow que esta escena terminó.")) return;
  return send("APP_CONFIRM_COMPLETED", { promptId: selectedPromptId });
}));

elements.startButton.addEventListener("click", () => run(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = flowStatus.tabId ?? tab?.id ?? null;
  if (!flowStatus.automationReady) {
    showNotice(flowStatus.message ?? "La detección de finalización no está lista; no se inició ninguna generación.");
    return;
  }

  const unresolvedErrors = state.prompts.filter(prompt => prompt.status === "error");
  for (const prompt of unresolvedErrors) {
    const verified = confirm(
      `La escena ${prompt.sceneNumber} (${prompt.text.slice(0, 80)}) está en error. ` +
      "Confirmá solo si verificaste en Flow que terminó y el resultado está disponible. " +
      "Aceptar la marcará completada; si falló o sigue generándose, cancelá y usá Reintentar o esperá."
    );
    if (!verified) return;
    state = await send("APP_CONFIRM_COMPLETED", { promptId: prompt.id });
    render();
  }

  const pendingCount = state.prompts.filter(prompt => prompt.status === "pending").length;
  if (!pendingCount) {
    showNotice("No hay escenas pendientes para iniciar.");
    return;
  }
  const confirmed = confirm(
    `Se procesarán ${pendingCount} escenas pendientes, una por vez. Cada trabajo de Flow puede consumir créditos y producir más de un medio. ` +
    "La siguiente escena solo se enviará cuando aparezca una imagen nueva cargada y Flow vuelva a mostrar el editor vacío y el botón. " +
    "Si no se confirma esa combinación, la cola se detendrá para verificación. ¿Continuar?"
  );
  if (!confirmed) return;
  return send("APP_START_QUEUE", { tabId });
}));
elements.pauseButton.addEventListener("click", () => run(() => send("APP_PAUSE_QUEUE")));
elements.resumeButton.addEventListener("click", () => run(() => send("APP_RESUME_QUEUE")));
elements.stopButton.addEventListener("click", () => run(() => send("APP_STOP_QUEUE")));

refresh().catch(error => showNotice(error.message));
