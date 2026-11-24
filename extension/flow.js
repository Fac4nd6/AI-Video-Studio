const FLOW_TIMEOUT_MS = 15 * 60 * 1000;
const FLOW_URL_PATTERNS = ["https://flow.google.com/*"];

function isFlowUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" &&
      parsed.hostname === "flow.google.com";
  } catch {
    return false;
  }
}

async function pingTab(tab) {
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "PING" });
    if (response?.type !== "PONG" || response.connected !== true) {
      return {
        connected: false,
        automationReady: false,
        flowOpen: true,
        tabId: tab.id,
        reason: response?.type === "PONG" ? response.reason ?? "FLOW_PAGE_UNVERIFIED" : "INVALID_PONG",
        message: response?.type === "PONG"
          ? "Flow respondió al PING, pero content.js no confirmó que esta URL sea compatible."
          : "La pestaña es de Flow, pero content.js respondió con un mensaje no reconocido."
      };
    }
    return {
      ...response,
      flowOpen: true,
      tabId: tab.id,
      message: response.automationReady
        ? "Conectado con Flow; cola secuencial habilitada con detección experimental. Se detiene si la evidencia del resultado no coincide."
        : response.promptPreparationReady
          ? "Conectado con Flow; editor y botón verificados. Falta configurar la detección del resultado para procesar la cola."
        : "Conectado con Flow y content.js; la automatización aún no está configurada."
    };
  } catch (pingError) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"]
      });
    } catch (injectionError) {
      return {
        connected: false,
        automationReady: false,
        flowOpen: true,
        tabId: tab.id,
        reason: "CONTENT_SCRIPT_UNAVAILABLE",
        message: `Flow está abierto, pero no se pudo inyectar content.js. ${injectionError.message}`
      };
    }

    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "PING" });
      if (response?.type !== "PONG" || response.connected !== true) {
        return {
          connected: false,
          automationReady: false,
          flowOpen: true,
          tabId: tab.id,
          reason: response?.type === "PONG" ? response.reason ?? "FLOW_PAGE_UNVERIFIED" : "INVALID_PONG",
          message: response?.type === "PONG"
            ? "Se inyectó content.js, pero no confirmó que esta URL sea compatible."
            : "Se inyectó content.js, pero la respuesta PONG no es válida."
        };
      }
      return {
        ...response,
        flowOpen: true,
        tabId: tab.id,
        message: response.automationReady
          ? "Conectado con Flow; cola secuencial habilitada con detección experimental. Se detiene si la evidencia del resultado no coincide."
          : response.promptPreparationReady
            ? "Conectado con Flow; editor y botón verificados. Falta configurar la detección del resultado para procesar la cola."
          : "Conectado con Flow y content.js; la automatización aún no está configurada."
      };
    } catch (retryError) {
      return {
        connected: false,
        automationReady: false,
        flowOpen: true,
        tabId: tab.id,
        reason: "PING_FAILED",
        message: `No hubo PONG después de inyectar content.js. ${retryError.message || pingError.message}`
      };
    }
  }
}

export async function getFlowStatus(activeTabId) {
  try {
    const tabs = await chrome.tabs.query({ url: FLOW_URL_PATTERNS });
    const candidates = tabs.filter(tab => Number.isInteger(tab.id) && isFlowUrl(tab.url));
    candidates.sort((left, right) =>
      Number(right.id === activeTabId) - Number(left.id === activeTabId)
    );

    if (!candidates.length) {
      return {
        connected: false,
        automationReady: false,
        flowOpen: false,
        reason: "FLOW_TAB_NOT_FOUND",
        message: "No se encontró una pestaña abierta en flow.google.com."
      };
    }

    let lastStatus;
    for (const tab of candidates) {
      lastStatus = await pingTab(tab);
      if (lastStatus.connected) return lastStatus;
    }
    return lastStatus;
  } catch (error) {
    return {
      connected: false,
      automationReady: false,
      flowOpen: false,
      reason: "TAB_QUERY_FAILED",
      message: `No se pudieron consultar las pestañas de Flow. ${error.message}`
    };
  }
}

export async function diagnoseFlow(activeTabId) {
  const status = await getFlowStatus(activeTabId);
  if (!status.connected) return status;

  try {
    const response = await chrome.tabs.sendMessage(status.tabId, { type: "FLOW_DIAGNOSE" });
    if (response?.type !== "FLOW_DIAGNOSTIC_RESULT" || response.connected !== true) {
      return {
        ...status,
        diagnostic: null,
        message: "Flow respondió al PING, pero no entregó un diagnóstico de interfaz válido."
      };
    }
    return {
      ...status,
      diagnostic: response.diagnostic,
      message: "Diagnóstico de solo lectura completado. Los selectores candidatos aún no están verificados."
    };
  } catch (error) {
    return {
      ...status,
      diagnostic: null,
      message: `No se pudo leer el DOM de Flow. ${error.message}`
    };
  }
}

export async function preparePrompt(tabId, prompt) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: "FLOW_PREPARE_PROMPT",
      promptId: prompt.id,
      text: prompt.text
    });
  } catch (error) {
    return {
      ok: false,
      code: "CONTENT_SCRIPT_UNAVAILABLE",
      message: `No se pudo preparar el prompt en Flow. ${error.message}`
    };
  }
}

export async function prepareControlledTest(tabId, prompt) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: "FLOW_CONTROLLED_TEST_PREPARE",
      promptId: prompt.id,
      text: prompt.text
    });
  } catch (error) {
    return {
      ok: false,
      code: "CONTENT_SCRIPT_UNAVAILABLE",
      message: `No se pudo preparar el clic supervisado en Flow. ${error.message}`
    };
  }
}

export async function startGenerationWatch(tabId, promptId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "FLOW_GENERATION_WATCH_START",
      promptId
    });
    return response?.ok
      ? response
      : { ok: false, message: response?.message ?? "Flow no confirmó el observador de resultado." };
  } catch (error) {
    return { ok: false, message: `No se pudo observar el resultado de Flow. ${error.message}` };
  }
}

export async function confirmGenerationWatchClick(tabId, promptId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "FLOW_GENERATION_WATCH_CLICKED",
      promptId
    });
    return response?.ok
      ? response
      : { ok: false, message: response?.message ?? "Flow no confirmó el inicio del seguimiento." };
  } catch (error) {
    return { ok: false, message: `No se pudo activar el seguimiento de Flow. ${error.message}` };
  }
}

export async function cancelGenerationWatch(tabId, promptId) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: "FLOW_GENERATION_WATCH_CANCEL",
      promptId
    });
  } catch (error) {
    return { ok: false, message: `No se pudo cancelar el seguimiento de Flow. ${error.message}` };
  }
}

export async function beginFlowObservation(tabId, sessionId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "FLOW_OBSERVER_START", sessionId });
    if (response?.type !== "FLOW_OBSERVER_STARTED" || !response.ok) {
      return {
        ok: false,
        message: response?.message ?? "Flow no confirmó el inicio del observador."
      };
    }
    return { ok: true, snapshot: response.snapshot };
  } catch (error) {
    return { ok: false, message: `No se pudo iniciar el observador de Flow. ${error.message}` };
  }
}

export async function endFlowObservation(tabId, sessionId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "FLOW_OBSERVER_STOP", sessionId });
  } catch (error) {
    return { ok: false, message: `No se pudo detener el observador de Flow. ${error.message}` };
  }
}

export async function submitPrompt(tabId, prompt) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: "FLOW_SUBMIT_PROMPT",
      promptId: prompt.id,
      text: prompt.text,
      timeoutMs: FLOW_TIMEOUT_MS
    });
  } catch (error) {
    return {
      ok: false,
      code: "CONTENT_SCRIPT_UNAVAILABLE",
      message: `No se pudo enviar el prompt a Flow. ${error.message}`
    };
  }
}

export async function stopFlow(tabId) {
  if (!Number.isInteger(tabId)) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "FLOW_STOP" });
  } catch {
    // The tab may have been closed or navigated away from Flow.
  }
}
