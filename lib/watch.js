import { spawn } from "node:child_process"
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

const MINUTE = 60_000
const DEFAULT_INTERVAL_HOURS = 24
const FAILURE_RETRY = 15 * MINUTE
const LOCK_RETRY = MINUTE
const LOCK_CONFLICT = 75
const SELECTOR_PATTERN = /^[^/\s]+\/\S+$/

export async function checkWhenDue({
  agentDir,
  now = Date.now,
  fetchSelectors,
  onAdded,
  signal,
}) {
  const watchDir = join(agentDir, "model-watch")
  const statePath = join(watchDir, "state.json")

  try {
    signal?.throwIfAborted()
    await mkdir(watchDir, {
      recursive: true,
      mode: 0o700,
    })

    const lock = await open(join(watchDir, "check.lock"), "a", 0o600)
    try {
      const { fd } = lock
      const hasLock = await tryLock(fd)
      if (!hasLock) {
        return {
          nextCheckAt: now() + LOCK_RETRY,
          added: [],
        }
      }

      return await checkLockedCatalog(statePath, now, fetchSelectors, onAdded, signal)
    } finally {
      await lock.close()
    }
  } catch (error) {
    const message = errorMessage(error)
    return {
      nextCheckAt: now() + FAILURE_RETRY,
      added: [],
      error: message,
    }
  }
}

async function readCheckInterval(statePath) {
  let hours
  try {
    const config = JSON.parse(await readFile(join(statePath, "..", "config.json"), "utf8"))
    hours = config.checkIntervalHours
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error("Cannot read model-watch/config.json; check the file and its JSON syntax", {
        cause: error,
      })
    }
  }

  if (hours === undefined) hours = DEFAULT_INTERVAL_HOURS
  if (!Number.isInteger(hours) || hours < 1 || hours > 596) {
    throw new Error("Set checkIntervalHours to a whole number from 1 to 596")
  }
  return hours * 60 * MINUTE
}

async function checkLockedCatalog(statePath, now, fetchSelectors, onAdded, signal) {
  const interval = await readCheckInterval(statePath)
  const state = await readState(statePath)
  if (state.lastSuccessAt !== null) {
    const nextCheckAt = state.lastSuccessAt + interval
    if (now() < nextCheckAt) {
      return {
        nextCheckAt,
        added: [],
      }
    }
  }

  if (state.retryAt !== null && now() < state.retryAt) {
    return {
      nextCheckAt: state.retryAt,
      added: [],
      error: "The profile's last model catalog check failed; waiting to retry",
    }
  }

  signal?.throwIfAborted()
  let selectors
  try {
    selectors = await fetchSelectors(signal)
    if (!isSelectorList(selectors) || selectors.length === 0) {
      throw new Error("The model catalog did not return a nonempty list of selectors")
    }
  } catch (error) {
    signal?.throwIfAborted()
    const retryAt = now() + FAILURE_RETRY
    await saveState(statePath, {
      ...state,
      retryAt,
    })

    const message = errorMessage(error)
    return {
      nextCheckAt: retryAt,
      added: [],
      error: message,
    }
  }

  signal?.throwIfAborted()
  const seen = new Set(state.seen)
  const added = []
  for (const selector of selectors) {
    if (seen.has(selector)) {
      continue
    }

    if (state.lastSuccessAt !== null) {
      added.push(selector)
    }
    seen.add(selector)
  }

  // Deliver before persisting: shutdown or a failed footer must not consume an unseen listing.
  if (added.length > 0) {
    onAdded?.(added)
    signal?.throwIfAborted()
  }

  const lastSuccessAt = now()
  await saveState(statePath, {
    lastSuccessAt,
    seen: [...seen],
    retryAt: null,
  })

  return {
    nextCheckAt: lastSuccessAt + interval,
    added,
  }
}

function tryLock(fd) {
  return new Promise((resolve, reject) => {
    // flock locks the inherited open file description. Our copy keeps the lock
    // after flock exits; closing it (including on process death) releases it.
    const child = spawn("flock", ["-n", "-E", String(LOCK_CONFLICT), "3"], {
      stdio: ["ignore", "ignore", "ignore", fd],
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(true)
      } else if (code === LOCK_CONFLICT) {
        resolve(false)
      } else {
        reject(new Error(`Could not lock the model watch (${signal ?? `flock exited ${code}`})`))
      }
    })
  })
}

async function readState(statePath) {
  let contents
  try {
    contents = await readFile(statePath, "utf8")
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error
    }

    return {
      lastSuccessAt: null,
      seen: [],
      retryAt: null,
    }
  }

  const state = JSON.parse(contents)
  if (!isValidState(state)) {
    throw new Error("Invalid model watch state; the existing baseline was left untouched")
  }

  return state
}

function isValidState(state) {
  if (!state || !isSelectorList(state.seen)) {
    return false
  }

  const hasBaseline = state.lastSuccessAt !== null
  if (hasBaseline !== (state.seen.length > 0)) {
    return false
  }

  return (!hasBaseline || Number.isFinite(state.lastSuccessAt)) &&
    (state.retryAt === null || Number.isFinite(state.retryAt))
}

function isSelectorList(selectors) {
  if (!Array.isArray(selectors)) {
    return false
  }

  for (const selector of selectors) {
    if (typeof selector !== "string" || !SELECTOR_PATTERN.test(selector)) {
      return false
    }
  }

  return true
}

async function saveState(statePath, state) {
  // Only the lock holder writes here, so a crashed write's staging file can be reused.
  const stagingPath = `${statePath}.tmp`
  const contents = JSON.stringify(state)
  await writeFile(stagingPath, `${contents}\n`, {
    mode: 0o600,
  })
  await rename(stagingPath, statePath)
}

function errorMessage(error) {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
