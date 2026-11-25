import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { checkWhenDue } from "../lib/watch.js"

const MINUTE = 60_000
const SIX_HOURS = 6 * 60 * MINUTE
const START = Date.UTC(2026, 10, 24)
const EXISTING = "openai-codex/gpt-existing"
const NEW = "openai-codex/gpt-new"

async function createProfile(t) {
  const agentDir = await mkdtemp(join(tmpdir(), "omp-model-watch-"))
  t.after(async () => {
    await rm(agentDir, {
      recursive: true,
      force: true,
    })
  })
  return agentDir
}

test("when discovery stays offline, backs off to hourly and resets after recovery", async (t) => {
  // Arrange
  const agentDir = await createProfile(t)
  let time = START
  const options = {
    agentDir,
    now: () => time,
    fetchSelectors: async () => {
      throw new Error("offline")
    },
  }

  const expectedMinutes = [1, 2, 4, 8, 16, 32, 60, 60]
  const observedMinutes = []

  // Act
  for (let attempt = 0; attempt < expectedMinutes.length; attempt++) {
    const failure = await checkWhenDue(options)
    observedMinutes.push((failure.nextCheckAt - time) / MINUTE)
    time = failure.nextCheckAt
  }

  const recoveredAt = time
  const recovery = await checkWhenDue({
    ...options,
    fetchSelectors: async () => [EXISTING],
  })
  time = recovery.nextCheckAt
  const nextOutage = await checkWhenDue(options)

  // Assert
  assert.deepEqual(observedMinutes, expectedMinutes)
  assert.equal(recovery.nextCheckAt, recoveredAt + SIX_HOURS)
  assert.equal(nextOutage.nextCheckAt, time + MINUTE)
})

test("when the profile is new, records a silent baseline and waits six hours to refresh", async (t) => {
  // Arrange
  const agentDir = await createProfile(t)
  let time = START
  let fetchCount = 0
  const options = {
    agentDir,
    now: () => time,
    fetchSelectors: async () => {
      fetchCount += 1
      return [EXISTING]
    },
  }

  // Act
  const baseline = await checkWhenDue(options)

  // Assert
  assert.deepEqual(baseline, {
    nextCheckAt: START + SIX_HOURS,
    added: [],
  })

  time += SIX_HOURS - 1
  assert.deepEqual(await checkWhenDue(options), {
    nextCheckAt: START + SIX_HOURS,
    added: [],
  })
  assert.equal(fetchCount, 1)

  time += 1
  assert.deepEqual(await checkWhenDue(options), {
    nextCheckAt: START + 2 * SIX_HOURS,
    added: [],
  })
  assert.equal(fetchCount, 2)
})

test("when listings disappear and return, reports only previously unseen selectors", async (t) => {
  // Arrange
  const agentDir = await createProfile(t)
  let time = START
  let selectors = [EXISTING]
  const options = {
    agentDir,
    now: () => time,
    fetchSelectors: async () => selectors,
  }
  await checkWhenDue(options)

  // Act
  time += 3 * SIX_HOURS
  const otherNew = "openai-codex/another-new"
  selectors = [NEW, NEW, otherNew]
  const afterDowntime = await checkWhenDue(options)

  // Assert
  assert.deepEqual(afterDowntime, {
    nextCheckAt: START + 4 * SIX_HOURS,
    added: [NEW, otherNew],
  })

  time += SIX_HOURS
  selectors = [EXISTING, otherNew]
  assert.deepEqual(await checkWhenDue(options), {
    nextCheckAt: START + 5 * SIX_HOURS,
    added: [],
  })

  time += SIX_HOURS
  selectors = [EXISTING, NEW, otherNew]
  assert.deepEqual(await checkWhenDue(options), {
    nextCheckAt: START + 6 * SIX_HOURS,
    added: [],
  })
})

test("when the interval increases after failure, retries on time before adopting the longer interval", async (t) => {
  // Arrange
  const agentDir = await createProfile(t)
  await checkWhenDue({
    agentDir,
    now: () => START,
    fetchSelectors: async () => [EXISTING],
  })

  // Act
  const failure = await checkWhenDue({
    agentDir,
    now: () => START + SIX_HOURS,
    fetchSelectors: async () => {
      throw new Error("catalog unavailable")
    },
  })

  // Assert
  const retryAt = START + SIX_HOURS + MINUTE
  assert.deepEqual(failure, {
    nextCheckAt: retryAt,
    added: [],
    error: "catalog unavailable",
  })

  await writeFile(join(agentDir, "model-watch", "config.json"), JSON.stringify({
    checkIntervalHours: 48,
  }))

  const deferred = await checkWhenDue({
    agentDir,
    now: () => retryAt - 1,
    fetchSelectors: async () => assert.fail("should not fetch during shared backoff"),
  })
  assert.deepEqual(deferred.added, [])
  assert.equal(deferred.nextCheckAt, retryAt)
  assert.match(deferred.error, /last model catalog check failed/)

  assert.deepEqual(await checkWhenDue({
    agentDir,
    now: () => retryAt,
    fetchSelectors: async () => [EXISTING, NEW],
  }), {
    nextCheckAt: retryAt + 48 * 60 * MINUTE,
    added: [NEW],
  })
})

test("when the first catalog is empty, waits for a valid baseline", async (t) => {
  // Arrange
  const agentDir = await createProfile(t)

  // Act
  const failure = await checkWhenDue({
    agentDir,
    now: () => START,
    fetchSelectors: async () => [],
  })

  // Assert
  assert.deepEqual(failure, {
    nextCheckAt: START + MINUTE,
    added: [],
    error: "The model catalog did not return a nonempty list of selectors",
  })

  const { nextCheckAt } = failure
  assert.deepEqual(await checkWhenDue({
    agentDir,
    now: () => nextCheckAt,
    fetchSelectors: async () => [EXISTING, NEW],
  }), {
    nextCheckAt: nextCheckAt + SIX_HOURS,
    added: [],
  })
})

test("when the session aborts discovery, leaves another terminal free to establish the baseline", async (t) => {
  // Arrange
  const agentDir = await createProfile(t)
  const controller = new AbortController()

  // Act
  const result = await checkWhenDue({
    agentDir,
    now: () => START,
    signal: controller.signal,
    fetchSelectors: async (signal) => {
      assert.equal(signal, controller.signal)
      controller.abort(new Error("session ended"))
      return [EXISTING]
    },
  })

  // Assert
  assert.equal(result.error, "session ended")

  let fetchCount = 0
  assert.deepEqual(await checkWhenDue({
    agentDir,
    now: () => START,
    fetchSelectors: async () => {
      fetchCount += 1
      return [EXISTING, NEW]
    },
  }), {
    nextCheckAt: START + SIX_HOURS,
    added: [],
  })
  assert.equal(fetchCount, 1)
})

test("when shutdown interrupts the footer, the next session can still show the new listing", async (t) => {
  // Arrange
  const agentDir = await createProfile(t)
  await checkWhenDue({
    agentDir,
    now: () => START,
    fetchSelectors: async () => [EXISTING],
  })
  const due = {
    agentDir,
    now: () => START + SIX_HOURS,
    fetchSelectors: async () => [EXISTING, NEW],
  }
  const closing = new AbortController()
  const shown = []

  // Act
  await checkWhenDue({
    ...due,
    signal: closing.signal,
    onAdded: () => closing.abort(),
  })
  await checkWhenDue({
    ...due,
    onAdded: selectors => shown.push(...selectors),
  })

  // Assert
  assert.deepEqual(shown, [NEW])
})

test("when a competing process crashes, releases its exclusive check without losing the baseline", {
  timeout: 10_000,
}, async (t) => {
  // Arrange
  const agentDir = await createProfile(t)
  await checkWhenDue({
    agentDir,
    now: () => START,
    fetchSelectors: async () => [EXISTING],
  })

  const dueAt = START + SIX_HOURS
  const watchUrl = new URL("../lib/watch.js", import.meta.url)
  const holdLock = `
    const [watchUrl, agentDir, dueAt] = process.argv.slice(1)
    const { checkWhenDue } = await import(watchUrl)
    process.stdin.resume()
    await checkWhenDue({
      agentDir,
      now: () => Number(dueAt),
      fetchSelectors: () => {
        process.stdout.write("fetching\\n")
        return new Promise(() => {})
      },
    })
    process.stdin.pause()
  `

  // Act
  const child = spawn(process.execPath, ["--input-type=module", "--eval", holdLock, watchUrl.href, agentDir, String(dueAt)], {
    stdio: ["pipe", "pipe", "inherit"],
  })
  const exited = once(child, "exit")
  try {
    const [ready] = await Promise.race([
      once(child.stdout, "data", {
        signal: t.signal,
      }),
      exited.then(() => {
        throw new Error("Competing process exited before fetching the catalog")
      }),
    ])
    assert.equal(ready.toString(), "fetching\n")

    // Assert
    assert.deepEqual(await checkWhenDue({
      agentDir,
      now: () => dueAt,
      fetchSelectors: async () => assert.fail("should not fetch while another process holds the lock"),
    }), {
      nextCheckAt: dueAt + MINUTE,
      added: [],
    })
  } finally {
    child.kill("SIGKILL")
    await exited
  }

  assert.deepEqual(await checkWhenDue({
    agentDir,
    now: () => dueAt + MINUTE,
    fetchSelectors: async () => [EXISTING, NEW],
  }), {
    nextCheckAt: dueAt + MINUTE + SIX_HOURS,
    added: [NEW],
  })
})
