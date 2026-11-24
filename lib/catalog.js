const PROVIDER = "openai-codex"
const REFRESH_TIMEOUT_MS = 20_000

class CatalogError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "CatalogError"
    this.code = code
  }
}

export function createFetchSelectors(modelRegistry) {
  let refreshPending = false

  return async function fetchSelectors(signal) {
    if (signal?.aborted) {
      throw aborted()
    }

    if (
      typeof modelRegistry?.refreshDiscoverableProviders !== "function" ||
      typeof modelRegistry.getProviderDiscoveryState !== "function" ||
      typeof modelRegistry.getAvailableForProviders !== "function"
    ) {
      throw new CatalogError("UNSUPPORTED", "OMP does not expose the required catalog APIs.")
    }

    if (refreshPending) {
      throw new CatalogError("BUSY", "A Codex catalog refresh is still running.")
    }

    try {
      const previousState = modelRegistry.getProviderDiscoveryState(PROVIDER)
      const startedAt = Date.now()
      refreshPending = true
      const refresh = Promise.resolve().then(async () => {
        try {
          if (!signal?.aborted) {
            await modelRegistry.refreshDiscoverableProviders([PROVIDER], "online")
          }
        } finally {
          refreshPending = false
        }
      })
      await waitForRefresh(refresh, signal)
      if (signal?.aborted) {
        throw aborted()
      }

      const state = modelRegistry.getProviderDiscoveryState(PROVIDER)
      return selectFreshChatModels(modelRegistry, state, previousState, startedAt)
    } catch (error) {
      if (error instanceof CatalogError) {
        throw error
      }

      // Host diagnostics may contain endpoint or credential details.
      throw new CatalogError("REFRESH_FAILED", "OMP could not refresh the Codex catalog.")
    }
  }
}

function selectFreshChatModels(modelRegistry, state, previousState, startedAt) {
  if (state && state !== previousState && state.provider === PROVIDER && state.status === "unauthenticated") {
    throw new CatalogError("AUTH_REQUIRED", "OMP could not authenticate Codex catalog discovery.")
  }

  // The OMP listing alone can include cached or bundled fallback rows. Accept
  // only the roster from a new, successful provider discovery pass (OMP 19.1.1).
  if (
    !state ||
    state === previousState ||
    state.provider !== PROVIDER ||
    state.source !== "provider" ||
    state.stale !== false ||
    state.error !== undefined ||
    !Number.isFinite(state.fetchedAt) ||
    state.fetchedAt < startedAt ||
    (state.status !== "ok" && state.status !== "empty") ||
    !Array.isArray(state.models)
  ) {
    throw new CatalogError("NOT_FRESH", "OMP did not confirm a fresh Codex catalog.")
  }

  const discoveredIds = new Set(state.models)
  const chatModels = modelRegistry.getAvailableForProviders(new Set([PROVIDER]), "chat")
  const selectors = new Set()
  for (const model of chatModels) {
    if (model.provider !== PROVIDER || (model.kind !== undefined && model.kind !== "chat")) {
      continue
    }

    const { id } = model
    if (typeof id === "string" && id.length > 0 && !/[\p{C}\s]/u.test(id) && discoveredIds.has(id)) {
      selectors.add(`${PROVIDER}/${id}`)
    }
  }

  if (state.status === "empty" || selectors.size === 0) {
    throw new CatalogError("EMPTY", "The fresh Codex catalog contains no available chat models.")
  }

  return [...selectors].sort()
}

async function waitForRefresh(refresh, signal) {
  // OMP's registry has no AbortSignal parameter. Bound our wait, not the
  // underlying operation; a retry must not overlap an unresolved refresh.
  let timeout
  let onAbort
  const stop = new Promise((_, reject) => {
    onAbort = () => reject(aborted())
    signal?.addEventListener("abort", onAbort, {
      once: true,
    })
    timeout = setTimeout(() => {
      reject(new CatalogError("TIMEOUT", "Timed out waiting for the Codex catalog refresh."))
    }, REFRESH_TIMEOUT_MS)
  })

  try {
    await Promise.race([refresh, stop])
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", onAbort)
  }
}

function aborted() {
  return new CatalogError("ABORTED", "The Codex catalog check was cancelled.")
}
