import { createFetchSelectors } from "./lib/catalog.js"
import { checkWhenDue } from "./lib/watch.js"

// OMP sorts footer status keys. Trainer owns zz-omp-trainer.hint.*.
const HINT_KEY = "zzz-model-watch"
const FAILURE_RETRY_MS = 60 * 60 * 1000
const localCheckTime = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
})

function showListing(ui, key, selectors, label) {
  const { theme } = ui
  const border = theme.fg("warning", "─".repeat(process.stdout.columns || 80))
  const rows = [
    border,
    theme.bold(theme.fg("warning", label)),
    theme.fg("muted", "Reassess your model choices:"),
    ...selectors.map(selector => theme.fg("accent", selector)),
    border,
  ]
  const keys = rows.map((_, index) => `${key}.${String(index).padStart(5, "0")}`)
  rows.forEach((row, index) => ui.setStatus(keys[index], row))

  return () => {
    for (const rowKey of keys) ui.setStatus(rowKey, undefined)
  }
}

export function registerModelWatch(pi, check) {
  pi.setLabel("Model Watch")
  let stop
  let status = "Waiting for an interactive session."
  let clearListing
  let demoTimer

  pi.on("session_start", (_event, ctx) => {
    stop?.()
    if (!ctx.hasUI || ctx.agent?.kind !== "main") return

    const controller = new AbortController()
    const fetchSelectors = createFetchSelectors(ctx.modelRegistry)

    function showAdditions(added) {
      clearListing?.()
      clearListing = showListing(ctx.ui, HINT_KEY + ".live", added, "New openai-codex listings")
    }

    let timer
    async function tick() {
      let nextCheckAt
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
      status += " Next check: " + localCheckTime.format(nextCheckAt)
      timer = ctx.setTimeout(tick, Math.max(1, nextCheckAt - Date.now()))
    }

    status = "Checking the catalog schedule."
    timer = ctx.setTimeout(tick, 0)
    stop = () => {
      controller.abort()
      ctx.clearTimer(timer)
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
        const clearDemo = showListing(ctx.ui, key, ["openai-codex/example-model"], "Model Watch demo")
        demoTimer = ctx.setTimeout(clearDemo, 8000)
        return
      }
      if (!action || action === "status") {
        ctx.ui.notify(status, "info")
        return
      }
      ctx.ui.notify("Usage: /model-watch [status|demo]", "info")
    },
  })
}

export default function modelWatch(pi) {
  registerModelWatch(pi, checkWhenDue)
}
