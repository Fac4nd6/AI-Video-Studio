const STORAGE_KEY = "aiVideoStudioState";

export function createInitialState() {
  return {
    version: 1,
    prompts: [],
    queue: {
      status: "idle",
      currentPromptId: null,
      activeTabId: null,
      message: "",
      updatedAt: new Date().toISOString()
    },
    settings: {
      splitMode: "separator"
    }
  };
}

export async function readState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] ?? createInitialState();
}

export async function writeState(state) {
  state.queue.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  return state;
}

export async function updateState(mutator) {
  const state = await readState();
  const nextState = await mutator(state);
  return writeState(nextState ?? state);
}
