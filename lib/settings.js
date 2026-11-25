import { execFile } from "node:child_process"
import { promisify } from "node:util"

import manifest from "../package.json" with { type: "json" }

const execFileAsync = promisify(execFile)
const INTERVAL_KEY = "checkIntervalHours"
const { min, max } = manifest.omp.settings[INTERVAL_KEY]
const INTERVAL_REQUIREMENT = `Set ${INTERVAL_KEY} to a number from ${min} to ${max}.`

export async function intervalCommand(args, options) {
  if (args.length > 1) {
    throw new Error(`Use interval [hours|reset]. ${INTERVAL_REQUIREMENT}`)
  }

  let update
  const [input] = args
  if (input === "reset") {
    await runNativeConfig("delete", [], options)
    update = "Cleared the profile check interval."
  } else if (input !== undefined) {
    const hours = Number(input)
    if (!isValidInterval(hours)) {
      throw new Error(INTERVAL_REQUIREMENT)
    }

    const hoursArgument = String(hours)
    await runNativeConfig("set", [hoursArgument], options)
    update = `Saved the profile check interval: ${formatHours(hours)}.`
  }

  const hours = await readIntervalHours(options)
  const effective = `Effective check interval: ${formatHours(hours)}.`
  if (update) {
    return `${update} ${effective}`
  }

  return effective
}

export async function readIntervalHours(options) {
  const output = await runNativeConfig("get", ["--json"], options)
  let settings
  try {
    settings = JSON.parse(output)
  } catch (error) {
    throw new Error("OMP did not return valid JSON for the model watch interval.", {
      cause: error,
    })
  }

  const hours = settings?.[INTERVAL_KEY]
  if (!isValidInterval(hours)) {
    throw new Error(INTERVAL_REQUIREMENT)
  }

  return hours
}

function isValidInterval(hours) {
  return Number.isFinite(hours) && hours >= min && hours <= max
}

function formatHours(hours) {
  if (hours === 1) {
    return "1 hour"
  }

  return `${hours} hours`
}

async function runNativeConfig(action, args, { cwd, signal } = {}) {
  // Inherit OMP_PROFILE/PI_PROFILE; OMP exports both when activating --profile.
  const commandArgs = ["plugin", "config", action, manifest.name, INTERVAL_KEY, ...args]
  try {
    const { stdout } = await execFileAsync("omp", commandArgs, {
      cwd,
      signal,
    })
    return stdout
  } catch (error) {
    signal?.throwIfAborted()
    const message = error.stderr?.trim() || error.message
    throw new Error(`Could not ${action} the model watch interval with omp: ${message}`, {
      cause: error,
    })
  }
}
