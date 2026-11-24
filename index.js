import { createFetchSelectors } from "./lib/catalog.js"
import { checkWhenDue } from "./lib/watch.js"

// OMP sorts footer status keys. Trainer owns zz-omp-trainer.hint.*.
const HINT_KEY = "zzz-model-watch"
const FAILURE_RETRY_MS = 60 * 60 * 1000

function formatNextCheck(remainingMs) {
  if (remainingMs <= 0) return "Next check due now."
  if (remainingMs < 60_000) return "Next check in less than a minute."

  const totalMinutes = Math.floor(remainingMs / 60_000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor(totalMinutes / 60) % 24
  const minutes = totalMinutes % 60
  const parts = []
  for (const [amount, unit] of [[days, "day"], [hours, "hour"], [minutes, "minute"]]) {
    if (amount > 0) parts.push(`${amount} ${unit}${amount === 1 ? "" : "s"}`)
  }
  return `Next check in ${parts.join(" ")}.`
}

function showListing(ctx, key, selectors, label) {
  const { ui } = ctx
  const { theme } = ui
  function renderBorders() {
    const border = theme.fg("warning", "─".repeat(process.stdout.columns || 80))
    ui.setStatus(key + ".0", border)
    ui.setStatus(key + ".2", border)
  }

  renderBorders()
  const rows = [
    theme.bold(theme.fg("warning", label)),
    theme.fg("muted", "Reassess your model choices:"),
    ...selectors.map(selector => theme.fg("accent", selector)),
  ]
  const keys = rows.map((_, index) => `${key}.1.${String(index).padStart(5, "0")}`)
  rows.forEach((row, index) => ui.setStatus(keys[index], row))
  const watchResize = ctx.mode === "tui" && process.stdout.isTTY
  if (watchResize) process.stdout.on("resize", renderBorders)

  return () => {
    if (watchResize) process.stdout.off("resize", renderBorders)
    ui.setStatus(key + ".0", undefined)
    ui.setStatus(key + ".2", undefined)
    for (const rowKey of keys) ui.setStatus(rowKey, undefined)
  }
}

export function registerModelWatch(pi, check) {
  pi.setLabel("Model Watch")
  let stop
  let status = "Waiting for an interactive session."
  let nextCheckAt
  let clearListing
  let demoTimer
  let clearDemo

  pi.on("session_start", (_event, ctx) => {
    stop?.()
    if (!ctx.hasUI || ctx.agent?.kind !== "main") return

    const controller = new AbortController()
    const fetchSelectors = createFetchSelectors(ctx.modelRegistry)

    function showAdditions(added) {
      clearListing?.()
      clearListing = showListing(ctx, HINT_KEY + ".live", added, "New openai-codex listings")
    }

    let timer
    async function tick() {
      try {
        const result = await check({
          agentDir: ctx.agentDir || pi.pi.getAgentDir(),
          fetchSelectors,
          onAdded: showAdditions,
          signal: controller.signal,
        })
        if (controller.signal.aborted) return

        nextCheckAt = result.nextCheckAt
        if (result.error) {
          status = "Check unavailable: " + result.error
        } else {
          status = "Watching openai-codex."
        }
      } catch {
        if (controller.signal.aborted) return
        status = "Check unavailable: could not access the profile watch state."
        nextCheckAt = Date.now() + FAILURE_RETRY_MS
      }
      timer = ctx.setTimeout(tick, Math.max(1, nextCheckAt - Date.now()))
    }

    status = "Checking the catalog schedule."
    nextCheckAt = undefined
    timer = ctx.setTimeout(tick, 0)
    stop = () => {
      controller.abort()
      ctx.clearTimer(timer)
      clearListing?.()
      clearListing = undefined
      clearDemo?.()
      clearDemo = undefined
      if (demoTimer) ctx.clearTimer(demoTimer)
      demoTimer = undefined
    }
  })

  pi.on("session_shutdown", () => {
    stop?.()
    stop = undefined
  })

  pi.registerCommand("model-watch", {
    description: "Show catalog watch status or preview a sample footer hint (demo)",
    getArgumentCompletions(prefix) {
      return ["status", "demo"].filter(value => value.startsWith(prefix)).map(value => ({
        value,
        label: value,
      }))
    },
    handler(args, ctx) {
      if (!ctx.hasUI) return
      const action = args.trim()
      if (action === "demo") {
        const key = HINT_KEY + ".sample"
        if (demoTimer) ctx.clearTimer(demoTimer)
        clearDemo?.()
        clearDemo = showListing(ctx, key, ["openai-codex/example-model"], "Model Watch demo")
        demoTimer = ctx.setTimeout(() => {
          clearDemo()
          clearDemo = undefined
          demoTimer = undefined
        }, 8000)
        return
      }
      if (!action || action === "status") {
        let message = status
        if (nextCheckAt !== undefined) {
          message += " " + formatNextCheck(nextCheckAt - Date.now())
        }
        ctx.ui.notify(message, "info")
        return
      }
      ctx.ui.notify("Usage: /model-watch [status|demo]", "info")
    },
  })
}

export default function modelWatch(pi) {
  registerModelWatch(pi, checkWhenDue)
}
