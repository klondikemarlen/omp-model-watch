import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { checkWhenDue } from "../lib/watch.js"

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
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

test("when the profile is new, records a silent baseline and waits one day to refresh", async (t) => {
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
    nextCheckAt: START + DAY,
    added: [],
  })

  time += DAY - 1
  assert.deepEqual(await checkWhenDue(options), {
    nextCheckAt: START + DAY,
    added: [],
  })
  assert.equal(fetchCount, 1)

  time += 1
  assert.deepEqual(await checkWhenDue(options), {
    nextCheckAt: START + 2 * DAY,
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
  time += 3 * DAY
  const otherNew = "openai-codex/another-new"
  selectors = [NEW, NEW, otherNew]
  const afterDowntime = await checkWhenDue(options)

  // Assert
  assert.deepEqual(afterDowntime, {
    nextCheckAt: START + 4 * DAY,
    added: [NEW, otherNew],
  })

  time += DAY
  selectors = [EXISTING, otherNew]
  assert.deepEqual(await checkWhenDue(options), {
    nextCheckAt: START + 5 * DAY,
    added: [],
  })

  time += DAY
  selectors = [EXISTING, NEW, otherNew]
  assert.deepEqual(await checkWhenDue(options), {
    nextCheckAt: START + 6 * DAY,
    added: [],
  })
})

test("when discovery fails, shares a retry deadline and preserves the baseline", async (t) => {
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
    now: () => START + DAY,
    fetchSelectors: async () => {
      throw new Error("catalog unavailable")
    },
  })

  // Assert
  const retryAt = START + DAY + 15 * MINUTE
  assert.deepEqual(failure, {
    nextCheckAt: retryAt,
    added: [],
    error: "catalog unavailable",
  })

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
    nextCheckAt: retryAt + DAY,
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
    nextCheckAt: START + 15 * MINUTE,
    added: [],
    error: "The model catalog did not return a nonempty list of selectors",
  })

  const { nextCheckAt } = failure
  assert.deepEqual(await checkWhenDue({
    agentDir,
    now: () => nextCheckAt,
    fetchSelectors: async () => [EXISTING, NEW],
  }), {
    nextCheckAt: nextCheckAt + DAY,
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
    nextCheckAt: START + DAY,
    added: [],
  })
  assert.equal(fetchCount, 1)
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

  const dueAt = START + DAY
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
    nextCheckAt: dueAt + MINUTE + DAY,
    added: [NEW],
  })
})
