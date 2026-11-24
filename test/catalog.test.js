import assert from "node:assert/strict"
import { test } from "node:test"

import { createFetchSelectors } from "../lib/catalog.js"

test("when the fresh roster and OMP listings overlap, returns only sorted unique Codex chat selectors", async () => {
  // Arrange
  const registry = freshRegistry({
    discoveredIds: ["fresh-z", "fresh-a", "fresh-speech", "other-route", "fresh\ninvalid"],
    listings: [
      {
        provider: "openai-codex",
        id: "fresh-z",
      },
      {
        provider: "openai",
        id: "other-route",
        kind: "chat",
      },
      {
        provider: "proxy-openai-codex",
        id: "other-route",
        kind: "chat",
      },
      {
        provider: "openai-codex",
        id: "fresh-speech",
        kind: "tts",
      },
      {
        provider: "openai-codex",
        id: "bundled-only",
        kind: "chat",
      },
      {
        provider: "openai-codex",
        id: "fresh-a",
        kind: "chat",
      },
      {
        provider: "openai-codex",
        id: "fresh-z",
      },
      {
        provider: "openai-codex",
        id: "fresh\ninvalid",
      },
    ],
  })
  const fetchSelectors = createFetchSelectors(registry)

  // Act
  const selectors = await fetchSelectors()

  // Assert
  assert.deepEqual(selectors, ["openai-codex/fresh-a", "openai-codex/fresh-z"])
})

test("when probing Codex, scopes the live refresh and chat listing to that provider", async () => {
  // Arrange
  const registry = freshRegistry()
  const refresh = registry.refreshDiscoverableProviders
  const list = registry.getAvailableForProviders
  const catalogRequests = []
  registry.refreshDiscoverableProviders = (providers, strategy) => {
    catalogRequests.push([providers, strategy])
    return refresh(providers, strategy)
  }
  registry.getAvailableForProviders = (providers, kind) => {
    catalogRequests.push([[...providers], kind])
    return list(providers, kind)
  }
  const fetchSelectors = createFetchSelectors(registry)

  // Act
  await fetchSelectors()

  // Assert
  assert.deepEqual(catalogRequests, [
    [["openai-codex"], "online"],
    [["openai-codex"], "chat"],
  ])
})

test("when forced discovery falls back to cached Codex rows, refuses the listing", async () => {
  // Arrange
  const registry = freshRegistry({
    stateOverrides: {
      source: "cache",
      status: "cached",
      stale: true,
    },
  })
  const fetchSelectors = createFetchSelectors(registry)

  // Act / Assert
  await assert.rejects(fetchSelectors(), {
    code: "NOT_FRESH",
  })
})

test("when a different provider reports a fresh roster, refuses the listing", async () => {
  // Arrange
  const registry = freshRegistry({
    stateOverrides: {
      provider: "openai",
    },
  })
  const fetchSelectors = createFetchSelectors(registry)

  // Act / Assert
  await assert.rejects(fetchSelectors(), {
    code: "NOT_FRESH",
  })
})

test("when a previously successful discovery state is unchanged, refuses to reuse it", async () => {
  // Arrange
  const registry = freshRegistry()
  await registry.refreshDiscoverableProviders(["openai-codex"], "online")
  registry.refreshDiscoverableProviders = async () => {}
  const fetchSelectors = createFetchSelectors(registry)

  // Act / Assert
  await assert.rejects(fetchSelectors(), {
    code: "NOT_FRESH",
  })
})

test("when discovery reports success without provider provenance, refuses the listing", async () => {
  // Arrange
  const registry = freshRegistry({
    stateOverrides: {
      source: undefined,
    },
  })
  const fetchSelectors = createFetchSelectors(registry)

  // Act / Assert
  await assert.rejects(fetchSelectors(), {
    code: "NOT_FRESH",
  })
})

test("when fresh discovery has no chat models, rejects instead of returning a baseline", async () => {
  // Arrange
  const registry = freshRegistry({
    discoveredIds: ["voice"],
    listings: [
      {
        provider: "openai-codex",
        id: "voice",
        kind: "tts",
      },
    ],
  })
  const fetchSelectors = createFetchSelectors(registry)

  // Act / Assert
  await assert.rejects(fetchSelectors(), {
    code: "EMPTY",
  })
})

test("when OMP exposes an authentication failure, distinguishes it from an empty catalog", async () => {
  // Arrange
  const registry = freshRegistry({
    stateOverrides: {
      status: "unauthenticated",
      error: "private authorization detail",
    },
  })
  const fetchSelectors = createFetchSelectors(registry)

  // Act / Assert
  await assert.rejects(fetchSelectors(), {
    code: "AUTH_REQUIRED",
    message: "OMP could not authenticate Codex catalog discovery.",
  })
})

test("when the registry throws, exposes only a fixed failure diagnostic", async () => {
  // Arrange
  const registry = freshRegistry()
  registry.refreshDiscoverableProviders = async () => {
    throw new Error("private endpoint detail")
  }
  const fetchSelectors = createFetchSelectors(registry)

  // Act / Assert
  await assert.rejects(fetchSelectors(), {
    code: "REFRESH_FAILED",
    message: "OMP could not refresh the Codex catalog.",
  })
})

test("when the host does not expose scoped discovery, reports it as unsupported", async () => {
  // Arrange
  const fetchSelectors = createFetchSelectors({})

  // Act / Assert
  await assert.rejects(fetchSelectors(), {
    code: "UNSUPPORTED",
  })
})

test("when cancelled during refresh, rejects without waiting for the host", async () => {
  // Arrange
  const registry = freshRegistry()
  const { promise: hostStarted, resolve: startHost } = Promise.withResolvers()
  const { promise: hostDone, resolve: finishHost } = Promise.withResolvers()
  registry.refreshDiscoverableProviders = () => {
    startHost()
    return hostDone
  }
  const fetchSelectors = createFetchSelectors(registry)
  const abortController = new AbortController()

  // Act
  const fetch = fetchSelectors(abortController.signal)
  await hostStarted
  abortController.abort()

  // Assert
  try {
    await assert.rejects(fetch, {
      code: "ABORTED",
    })
  } finally {
    finishHost()
  }
})

test("when a refresh times out, reports a timeout without waiting for the host", async (t) => {
  // Arrange
  t.mock.timers.enable({
    apis: ["setTimeout"],
  })
  const registry = freshRegistry()
  const { promise: hostDone, resolve: finishHost } = Promise.withResolvers()
  registry.refreshDiscoverableProviders = () => hostDone
  const fetchSelectors = createFetchSelectors(registry)

  // Act
  const fetch = fetchSelectors()
  t.mock.timers.tick(20_000)

  // Assert
  try {
    await assert.rejects(fetch, {
      code: "TIMEOUT",
    })
  } finally {
    finishHost()
  }
})

test("when an abandoned refresh is still running, refuses to start an overlapping request", async () => {
  // Arrange
  const registry = freshRegistry()
  const { promise: hostStarted, resolve: startHost } = Promise.withResolvers()
  const { promise: hostDone, resolve: finishHost } = Promise.withResolvers()
  registry.refreshDiscoverableProviders = () => {
    startHost()
    return hostDone
  }
  const fetchSelectors = createFetchSelectors(registry)
  const abortController = new AbortController()
  const cancelled = fetchSelectors(abortController.signal).catch(() => {})
  await hostStarted
  abortController.abort()
  await cancelled

  // Act / Assert
  try {
    await assert.rejects(fetchSelectors(), {
      code: "BUSY",
    })
  } finally {
    finishHost()
  }
})

function freshRegistry({ discoveredIds = ["listed"], listings = defaultListings, stateOverrides = {} } = {}) {
  let state

  return {
    async refreshDiscoverableProviders() {
      state = {
        provider: "openai-codex",
        source: "provider",
        status: "ok",
        stale: false,
        fetchedAt: Date.now(),
        models: discoveredIds,
        ...stateOverrides,
      }
    },
    getProviderDiscoveryState() {
      return state
    },
    getAvailableForProviders() {
      return listings
    },
  }
}

const defaultListings = [
  {
    provider: "openai-codex",
    id: "listed",
  },
]
