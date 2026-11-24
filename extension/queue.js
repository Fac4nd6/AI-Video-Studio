const STATUS_MESSAGES = {
  CONTENT_SCRIPT_UNAVAILABLE: "No se detectó el content script de Flow en la pestaña activa.",
  PING_FAILED: "Flow está abierto, pero no respondió al mensaje PING.",
  INVALID_PONG: "Flow respondió con un mensaje de conexión no reconocido.",
  TAB_QUERY_FAILED: "No se pudieron consultar las pestañas abiertas de Flow.",
  FLOW_TAB_NOT_FOUND: "No se encontró una pestaña abierta de Google Flow.",
  FLOW_PAGE_UNVERIFIED: "La página activa no se pudo confirmar como Google Flow.",
  SELECTORS_UNVERIFIED: "La automatización está bloqueada: faltan selectores de Flow verificados."
};

export function createQueueManager({ storage, flow }) {
  let dispatchInProgress = false;
  let queuedProcessTabId = null;
  let controlledTestInProgress = false;

  async function setQueueState(state, status, message, patch = {}) {
    state.queue = {
      ...state.queue,
      ...patch,
      status,
      message,
      updatedAt: new Date().toISOString()
    };
    await storage.writeState(state);
    return state;
  }

  async function processNext(tabId) {
    if (dispatchInProgress) {
      queuedProcessTabId = tabId;
      return storage.readState();
    }
    dispatchInProgress = true;
    try {
      const state = await storage.readState();
      if (state.queue.status !== "running") return state;
      if (state.prompts.some(prompt => prompt.status === "processing")) return state;

      const next = state.prompts.find(prompt => prompt.status === "pending");
      if (!next) {
        const hasErrors = state.prompts.some(prompt => prompt.status === "error");
        return setQueueState(
          state,
          hasErrors ? "completed_with_errors" : "completed",
          hasErrors ? "Cola finalizada; hay escenas con errores." : "Todos los prompts se completaron.",
          { currentPromptId: null }
        );
      }

      next.status = "processing";
      next.processedAt = null;
      state.queue.currentPromptId = next.id;
      state.queue.message = `Preparando la escena ${next.sceneNumber} de ${state.prompts.length}.`;
      await storage.writeState(state);

      const result = await flow.submitPrompt(tabId, next);
      const currentState = await storage.readState();
      const currentPrompt = currentState.prompts.find(prompt => prompt.id === next.id);
      if (currentState.queue.currentPromptId !== next.id || currentPrompt?.status !== "processing") {
        return currentState;
      }
      if (!result?.ok) {
        currentPrompt.status = "pending";
        currentPrompt.lastError = result?.message ?? STATUS_MESSAGES[result?.code] ?? "No se pudo enviar el prompt.";
        currentState.queue.currentPromptId = null;
        return setQueueState(
          currentState,
          "waiting_user",
          currentPrompt.lastError,
          { activeTabId: tabId }
        );
      }
      const sentMessage = result.message ??
        `Escena ${next.sceneNumber} enviada. Esperando evidencia de resultado antes de continuar.`;
      return setQueueState(
        currentState,
        currentState.queue.status,
        currentState.queue.status === "paused" ? `En pausa; ${sentMessage}` : sentMessage,
        { activeTabId: tabId }
      );
    } finally {
      dispatchInProgress = false;
      if (queuedProcessTabId !== null) {
        const queuedTabId = queuedProcessTabId;
        queuedProcessTabId = null;
        const state = await storage.readState();
        if (state.queue.status === "running" &&
            !state.prompts.some(prompt => prompt.status === "processing")) {
          await processNext(queuedTabId);
        }
      }
    }
  }

  async function start(tabId) {
    const state = await storage.readState();
    if (["running", "paused"].includes(state.queue.status)) return state;
    if (!state.prompts.length) {
      return setQueueState(state, "idle", "Importá al menos un prompt para iniciar.");
    }
    if (state.prompts.some(prompt => prompt.status === "error")) {
      return setQueueState(
        state,
        "waiting_user",
        "Hay escenas con resultado incierto. Verificalas en Flow y reintentá cada escena explícitamente."
      );
    }

    const flowStatus = await flow.getFlowStatus(tabId);
    if (!flowStatus?.connected) {
      return setQueueState(
        state,
        "waiting_user",
        flowStatus?.message ?? STATUS_MESSAGES[flowStatus?.reason] ?? "Abrí Google Flow en una pestaña de Chrome.",
        { activeTabId: flowStatus?.tabId ?? tabId }
      );
    }
    if (!flowStatus.automationReady) {
      return setQueueState(
        state,
        "waiting_user",
        flowStatus?.message ?? STATUS_MESSAGES[flowStatus?.reason] ?? STATUS_MESSAGES.SELECTORS_UNVERIFIED,
        { activeTabId: flowStatus.tabId }
      );
    }

    if (state.prompts.some(prompt => prompt.status === "processing")) {
      return setQueueState(
        state,
        "waiting_user",
        "Hay una escena cuyo resultado no se confirmó. Verificala en Flow antes de reintentar.",
        { activeTabId: tabId }
      );
    }

    const flowTabId = flowStatus.tabId;
    await setQueueState(
      state,
      "running",
      "Iniciando la cola secuencial.",
      { activeTabId: flowTabId, mode: "automatic_queue" }
    );
    return processNext(flowTabId);
  }

  async function startControlledTest(tabId) {
    if (controlledTestInProgress) return storage.readState();
    controlledTestInProgress = true;
    try {
      const state = await storage.readState();
      if (["running", "paused"].includes(state.queue.status) ||
          state.prompts.some(prompt => prompt.status === "processing")) {
        return state;
      }
      if (state.prompts.some(prompt => prompt.status === "error")) {
        return setQueueState(
          state,
          "waiting_user",
          "Resolvé o verificá las escenas con error antes de iniciar la prueba."
        );
      }

      const flowStatus = await flow.getFlowStatus(tabId);
      if (!flowStatus?.connected || !flowStatus.promptPreparationReady) {
        return setQueueState(
          state,
          "waiting_user",
          flowStatus?.message ?? "Flow no confirmó que el editor y el botón estén disponibles."
        );
      }
      const next = state.prompts.find(prompt => prompt.status === "pending");
      if (!next) return setQueueState(state, "idle", "No hay escenas pendientes para probar.");

      const flowTabId = flowStatus.tabId;
      next.status = "processing";
      next.processedAt = null;
      state.queue.currentPromptId = next.id;
      await setQueueState(
        state,
        "running",
        "Prueba supervisada: se enviará una sola escena y no habrá avance automático.",
        { activeTabId: flowTabId, mode: "single_scene_test" }
      );

      const result = await flow.startControlledTest(flowTabId, next);
      if (!result?.ok) {
        if (result?.uncertain) {
          next.status = "error";
          next.lastError = result.message ?? "No se pudo confirmar si Flow recibió el clic.";
          state.queue.currentPromptId = null;
          return setQueueState(
            state,
            "waiting_user",
            next.lastError,
            { mode: "single_scene_test" }
          );
        }
        next.status = "pending";
        state.queue.currentPromptId = null;
        return setQueueState(
          state,
          "waiting_user",
          result?.message ?? "No se inició la generación.",
          { mode: "single_scene_test" }
        );
      }
      const currentState = await storage.readState();
      return setQueueState(
        currentState,
        "running",
        result.message ??
          `Se envió el clic para la escena ${next.sceneNumber}. Confirmá en Flow que haya comenzado; no habrá avance automático.`,
        { activeTabId: flowTabId, mode: "single_scene_test" }
      );
    } finally {
      controlledTestInProgress = false;
    }
  }

  async function pause() {
    const state = await storage.readState();
    if (state.queue.status !== "running") return state;
    return setQueueState(state, "paused", "En pausa. La escena en curso no se vuelve a enviar.");
  }

  async function resume() {
    const state = await storage.readState();
    if (state.queue.status === "running") return state;
    if (state.queue.mode === "single_scene_test" &&
        state.prompts.some(prompt => prompt.status === "processing")) {
      return setQueueState(
        state,
        "running",
        "La prueba sigue supervisada; no se enviarán más escenas.",
        { activeTabId: state.queue.activeTabId }
      );
    }
    const tabId = state.queue.activeTabId;
    const flowStatus = await flow.getFlowStatus(tabId);
    if (!flowStatus?.automationReady) {
      return setQueueState(
        state,
        "waiting_user",
        flowStatus?.message ?? STATUS_MESSAGES[flowStatus?.reason] ?? STATUS_MESSAGES.SELECTORS_UNVERIFIED,
        { activeTabId: flowStatus?.tabId ?? tabId }
      );
    }
    if (state.prompts.some(prompt => prompt.status === "processing")) {
      if (state.queue.status === "paused") {
        return setQueueState(
          state,
          "running",
          "Reanudando; esperando la escena actual.",
          { activeTabId: flowStatus.tabId }
        );
      }
      return setQueueState(
        state,
        "waiting_user",
        "El estado de la escena actual es incierto. Verificala en Flow antes de continuar.",
        { activeTabId: flowStatus.tabId }
      );
    }
    await setQueueState(state, "running", "Reanudando cola.", { activeTabId: flowStatus.tabId });
    return processNext(flowStatus.tabId);
  }

  async function stop() {
    const state = await storage.readState();
    const tabId = state.queue.activeTabId;
    await flow.stopFlow(tabId);

    const current = state.prompts.find(prompt => prompt.id === state.queue.currentPromptId);
    const controlledTest = state.queue.mode === "single_scene_test";
    if (current?.status === "processing") {
      current.status = "error";
      current.lastError = controlledTest
        ? "La cola se detuvo, pero Flow puede seguir generando. Verificá el resultado antes de reintentar."
        : "Automatización detenida; verificá en Flow si la generación terminó.";
    }
    return setQueueState(
      state,
      "stopped",
      controlledTest
        ? "Cola detenida. Flow puede continuar la generación actual; no se iniciarán otras escenas."
        : "Automatización detenida.",
      { currentPromptId: null }
    );
  }

  async function handleFlowEvent(event, tabId) {
    const state = await storage.readState();
    const current = state.prompts.find(prompt => prompt.id === state.queue.currentPromptId);
    if (!current || current.status !== "processing") return state;
    if (tabId !== state.queue.activeTabId || event.promptId !== current.id) return state;

    if (event.type === "FLOW_GENERATION_FINISHED") {
      current.status = "completed";
      current.processedAt = new Date().toISOString();
      delete current.lastError;
      state.queue.currentPromptId = null;
      await storage.writeState(state);
      if (state.queue.status !== "running") return state;
      if (state.queue.mode === "single_scene_test") {
        return setQueueState(
          state,
          "idle",
          `La prueba de la escena ${current.sceneNumber} terminó; no se inició otra escena.`,
          { mode: "single_scene_test" }
        );
      }
      return processNext(state.queue.activeTabId);
    }

    if (event.type === "FLOW_GENERATION_UNKNOWN") {
      current.status = "error";
      current.lastError = event.message ?? "No se pudo confirmar el final de la generación.";
      return setQueueState(state, "waiting_user", current.lastError, { currentPromptId: null });
    }
    return state;
  }

  async function retry(promptId) {
    const state = await storage.readState();
    if (["running", "paused"].includes(state.queue.status)) return state;
    const prompt = state.prompts.find(item => item.id === promptId);
    if (!prompt || prompt.status !== "error") return state;
    prompt.status = "pending";
    delete prompt.lastError;
    prompt.processedAt = null;
    return setQueueState(state, "idle", `Escena ${prompt.sceneNumber} lista para reintentar.`);
  }

  async function confirmCompleted(promptId) {
    const state = await storage.readState();
    if (["running", "paused"].includes(state.queue.status)) return state;
    const prompt = state.prompts.find(item => item.id === promptId);
    if (!prompt || prompt.status !== "error") return state;
    prompt.status = "completed";
    prompt.processedAt = new Date().toISOString();
    delete prompt.lastError;
    return setQueueState(
      state,
      "idle",
      `Escena ${prompt.sceneNumber} marcada como completada por confirmación manual.`
    );
  }

  async function recoverInterruptedQueue() {
    const state = await storage.readState();
    if (state.queue.status === "running" || state.prompts.some(prompt => prompt.status === "processing")) {
      for (const prompt of state.prompts) {
        if (prompt.status === "processing") {
          prompt.status = "error";
          prompt.lastError = "La extensión se reinició durante esta escena; verificá su resultado en Flow.";
        }
      }
      return setQueueState(
        state,
        "waiting_user",
        "La extensión se reinició durante una escena. Verificá el resultado en Flow antes de continuar.",
        { currentPromptId: null }
      );
    }
    return state;
  }

  return {
    start,
    startControlledTest,
    pause,
    resume,
    stop,
    handleFlowEvent,
    retry,
    confirmCompleted,
    recoverInterruptedQueue
  };
}
