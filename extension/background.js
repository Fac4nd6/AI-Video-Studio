import * as storage from "./storage.js";
import {
  beginFlowObservation,
  cancelGenerationWatch,
  confirmGenerationWatchClick,
  diagnoseFlow,
  endFlowObservation,
  getFlowStatus,
  preparePrompt,
  prepareControlledTest,
  startGenerationWatch,
  stopFlow,
} from "./flow.js";
import { createQueueManager } from "./queue.js";

const OBSERVATION_KEY = "flowDomObservation";
const MAX_OBSERVATION_EVENTS = 100;
let observationWriteChain = Promise.resolve();
const queue = createQueueManager({
  storage,
  flow: {
    getFlowStatus,
    stopFlow,
    submitPrompt: startObservedQueuePrompt,
    startControlledTest: startObservedControlledTest
  }
});

async function readObservation() {
  const stored = await chrome.storage.session.get(OBSERVATION_KEY);
  return stored[OBSERVATION_KEY] ?? { running: false, tabId: null, startedAt: null, events: [] };
}

async function writeObservation(observation) {
  await chrome.storage.session.set({ [OBSERVATION_KEY]: observation });
  return observation;
}

async function startObservationSession(activeTabId) {
  const flowStatus = await getFlowStatus(activeTabId);
  if (!flowStatus.connected) return { ok: false, message: flowStatus.message };

  const previous = await readObservation();
  if (previous.running) await endFlowObservation(previous.tabId, previous.sessionId);

  const observation = {
    running: true,
    tabId: flowStatus.tabId,
    sessionId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    events: []
  };
  await writeObservation(observation);

  const result = await beginFlowObservation(flowStatus.tabId, observation.sessionId);
  if (!result.ok) {
    observation.running = false;
    await writeObservation(observation);
    return { ...result, observation };
  }
  await recordObservation(result.snapshot, flowStatus.tabId, observation.sessionId, observation.startedAt);
  return { ok: true, observation: await readObservation() };
}

function recordObservation(snapshot, tabId, sessionId, capturedAt = new Date().toISOString()) {
  const operation = observationWriteChain.then(async () => {
    const observation = await readObservation();
    if (!observation.running || observation.tabId !== tabId || observation.sessionId !== sessionId) {
      return { accepted: false };
    }
    observation.events.push({ capturedAt, snapshot });
    observation.events.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
    if (observation.events.length > MAX_OBSERVATION_EVENTS) {
      observation.events.splice(0, observation.events.length - MAX_OBSERVATION_EVENTS);
    }
    await writeObservation(observation);
    return { accepted: true, count: observation.events.length };
  });
  observationWriteChain = operation.then(() => undefined, () => undefined);
  return operation;
}

async function stopObservationSession() {
  const observation = await readObservation();
  if (!observation.running) return observation;
  const result = await endFlowObservation(observation.tabId, observation.sessionId);
  observation.running = false;
  observation.stoppedAt = new Date().toISOString();
  observation.stopMessage = result?.message ?? "";
  await writeObservation(observation);
  return observation;
}

async function dispatchTrustedFlowClick(tabId, clickTarget) {
  const { x, y } = clickTarget ?? {};
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return {
      ok: false,
      code: "FLOW_CLICK_TARGET_INVALID",
      message: "Flow no devolvió una posición válida para Start generation; no se hizo clic."
    };
  }

  let activeTab;
  try {
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (error) {
    return {
      ok: false,
      code: "FLOW_TAB_QUERY_FAILED",
      message: `No se pudo verificar la pestaña activa de Flow. ${error.message}`
    };
  }
  if (activeTab?.id !== tabId) {
    return {
      ok: false,
      code: "FLOW_TAB_NOT_ACTIVE",
      message: "Activá la pestaña de Google Flow antes de iniciar la prueba; no se hizo clic."
    };
  }

  const target = { tabId };
  let attached = false;
  let pressAttempted = false;
  let pressAcknowledged = false;
  let clickReleased = false;
  let clickError = null;
  let cleanupError = null;

  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y
    });
    pressAttempted = true;
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    pressAcknowledged = true;
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1
    });
    clickReleased = true;
  } catch (error) {
    clickError = error;
  } finally {
    if (attached) {
      if (pressAttempted && !clickReleased) {
        try {
          await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x,
            y,
            button: "left",
            buttons: 0,
            clickCount: 1
          });
          clickReleased = pressAcknowledged;
        } catch (error) {
          cleanupError = error;
        }
      }
      try {
        await chrome.debugger.detach(target);
      } catch (error) {
        cleanupError ??= error;
      }
    }
  }

  if (clickReleased) {
    return {
      ok: true,
      submitted: true,
      singleSceneOnly: true,
      message: cleanupError
        ? `Se envió el clic a Start generation, pero Chrome informó un problema al cerrar la conexión de depuración: ${cleanupError.message}. Verificá Flow antes de volver a intentarlo.`
        : "Se envió un clic real a Start generation. Verificá en Flow que haya comenzado; no se iniciarán otras escenas."
    };
  }

  if (pressAttempted) {
    return {
      ok: false,
      uncertain: true,
      code: "FLOW_CLICK_STATE_UNKNOWN",
      message: `Chrome no pudo confirmar si Flow recibió el clic. No vuelvas a enviarlo hasta verificar Flow. ${clickError?.message ?? cleanupError?.message ?? ""}`
    };
  }

  return {
    ok: false,
    code: "FLOW_TRUSTED_CLICK_FAILED",
    message: `Chrome no pudo enviar el clic real a Start generation. ${clickError?.message ?? cleanupError?.message ?? ""}`
  };
}

async function stopObservationAfterFailure(result) {
  try {
    await stopObservationSession();
    return result;
  } catch (error) {
    return {
      ...result,
      message: `${result.message ?? "La prueba no pudo continuar."} No se pudo detener la observación: ${error.message}`
    };
  }
}

async function startObservedPrompt(tabId, prompt) {
  let observation;
  try {
    observation = await startObservationSession(tabId);
  } catch (error) {
    return {
      ok: false,
      code: "FLOW_OBSERVER_START_FAILED",
      message: `No se pudo iniciar el observador de Flow. ${error.message}`
    };
  }
  if (!observation.ok) return observation;

  const preparation = await prepareControlledTest(tabId, prompt);
  if (!preparation?.ok) {
    return stopObservationAfterFailure(preparation);
  }

  const watch = await startGenerationWatch(tabId, prompt.id);
  if (!watch.ok) {
    return stopObservationAfterFailure(watch);
  }

  const clickResult = await dispatchTrustedFlowClick(tabId, preparation.clickTarget);
  if (!clickResult.ok) {
    await cancelGenerationWatch(tabId, prompt.id);
    return stopObservationAfterFailure(clickResult);
  }

  const watchResult = await confirmGenerationWatchClick(tabId, prompt.id);
  if (!watchResult.ok) {
    await cancelGenerationWatch(tabId, prompt.id);
    return stopObservationAfterFailure({
      ok: false,
      uncertain: true,
      code: "FLOW_WATCH_START_FAILED",
      message: `El clic de Flow se envió, pero no se pudo confirmar su observador. Verificá Flow antes de reintentar. ${watchResult.message}`
    });
  }
  return {
    ...clickResult,
    message: `Clic real enviado para la escena ${prompt.sceneNumber}. Esperando una imagen nueva y el retorno del editor vacío; no se iniciará otra hasta confirmarlo.`
  };
}

async function startObservedQueuePrompt(tabId, prompt) {
  return startObservedPrompt(tabId, prompt);
}

async function startObservedControlledTest(tabId, prompt) {
  return startObservedPrompt(tabId, prompt);
}

async function handleGenerationEvent(message, tabId) {
  const state = await queue.handleFlowEvent(message, tabId);
  if (message.type === "FLOW_GENERATION_UNKNOWN" || state.queue.status !== "running") {
    await stopObservationSession();
  }
  return state;
}

function respond(promise, sendResponse) {
  promise.then(
    result => sendResponse({ ok: true, state: result }),
    error => sendResponse({ ok: false, error: error.message })
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "FLOW_OBSERVATION_EVENT") {
    respond(
      recordObservation(message.snapshot, sender.tab?.id, message.sessionId, message.capturedAt),
      sendResponse
    );
    return true;
  }
  if (message?.type === "FLOW_GENERATION_FINISHED" || message?.type === "FLOW_GENERATION_UNKNOWN") {
    respond(handleGenerationEvent(message, sender.tab?.id), sendResponse);
    return true;
  }

  switch (message?.type) {
    case "APP_GET_STATE":
      respond(storage.readState(), sendResponse);
      return true;
    case "APP_GET_FLOW_STATUS":
      respond(getFlowStatus(message.activeTabId), sendResponse);
      return true;
    case "APP_DIAGNOSE_FLOW":
      respond(diagnoseFlow(message.activeTabId), sendResponse);
      return true;
    case "APP_START_FLOW_OBSERVATION":
      respond(startObservationSession(message.activeTabId), sendResponse);
      return true;
    case "APP_STOP_FLOW_OBSERVATION":
      respond(stopObservationSession(), sendResponse);
      return true;
    case "APP_GET_FLOW_OBSERVATION":
      respond(readObservation(), sendResponse);
      return true;
    case "APP_PREPARE_NEXT_PROMPT":
      respond((async () => {
        const flowStatus = await getFlowStatus(message.activeTabId);
        if (!flowStatus.connected || !flowStatus.promptPreparationReady) {
          return {
            ok: false,
            message: flowStatus.message ?? "No se puede preparar un prompt en esta pestaña."
          };
        }

        const state = await storage.readState();
        if (["running", "paused"].includes(state.queue.status) ||
            state.prompts.some(prompt => prompt.status === "processing")) {
          return { ok: false, message: "Detené o resolvé la cola antes de preparar un prompt." };
        }
        const prompt = state.prompts.find(item => item.status === "pending");
        if (!prompt) return { ok: false, message: "No hay prompts pendientes para preparar." };

        const result = await preparePrompt(flowStatus.tabId, prompt);
        return { ...result, sceneNumber: prompt.sceneNumber };
      })(), sendResponse);
      return true;
    case "APP_IMPORT_PROMPTS":
      respond(storage.updateState(state => {
        if (["running", "paused"].includes(state.queue.status) ||
            state.prompts.some(prompt => prompt.status === "processing")) {
          throw new Error("Detené o pausá y resolvé la cola antes de importar otra lista.");
        }
        state.prompts = message.prompts;
        state.queue = {
          status: "idle",
          currentPromptId: null,
          activeTabId: null,
          message: `${message.prompts.length} prompts importados.`,
          updatedAt: new Date().toISOString()
        };
        state.settings.splitMode = message.splitMode;
        return state;
      }), sendResponse);
      return true;
    case "APP_UPDATE_PROMPT":
      respond(storage.updateState(state => {
        const prompt = state.prompts.find(item => item.id === message.promptId);
        if (!prompt) throw new Error("No se encontró la escena seleccionada.");
        if (prompt.status === "processing") throw new Error("No se puede editar una escena en proceso.");
        prompt.text = message.text;
        prompt.status = "pending";
        prompt.processedAt = null;
        delete prompt.lastError;
        return state;
      }), sendResponse);
      return true;
    case "APP_START_QUEUE":
      respond(queue.start(message.tabId), sendResponse);
      return true;
    case "APP_START_CONTROLLED_TEST":
      respond(queue.startControlledTest(message.tabId), sendResponse);
      return true;
    case "APP_PAUSE_QUEUE":
      respond(queue.pause(), sendResponse);
      return true;
    case "APP_RESUME_QUEUE":
      respond(queue.resume(), sendResponse);
      return true;
    case "APP_STOP_QUEUE":
      respond((async () => {
        const state = await queue.stop();
        await stopObservationSession();
        return state;
      })(), sendResponse);
      return true;
    case "APP_RETRY_PROMPT":
      respond(queue.retry(message.promptId), sendResponse);
      return true;
    case "APP_CONFIRM_COMPLETED":
      respond(queue.confirmCompleted(message.promptId), sendResponse);
      return true;
    default:
      return false;
  }
});

chrome.runtime.onStartup.addListener(() => {
  queue.recoverInterruptedQueue();
});

chrome.runtime.onInstalled.addListener(() => {
  queue.recoverInterruptedQueue();
});
