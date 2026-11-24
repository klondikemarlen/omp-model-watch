import { createFetchSelectors } from "./lib/catalog.js"
import { checkWhenDue } from "./lib/watch.js"

const HINT_KEY = "omp-model-watch.hint"
const FAILURE_RETRY_MS = 60 * 60 * 1000

function showListing(ui, key, selectors, label) {
  ui.setStatus(key, label + ": reassess your model choices.")
  for (const [index, selector] of selectors.entries()) {
    ui.setStatus(key + "." + index, selector)
  }
}

export function registerModelWatch(pi, check) {
  pi.setLabel("Model Watch")
  let stop
  let status = "Waiting for an interactive session."
  let hintRows = 0

  pi.on("session_start", (_event, ctx) => {
    stop?.()
    if (!ctx.hasUI || ctx.agent?.kind !== "main") return

    const controller = new AbortController()
    const fetchSelectors = createFetchSelectors(ctx.modelRegistry)
    let timer
    async function tick() {
      let nextCheckAt
      try {
        const result = await check({
          agentDir: ctx.agentDir || pi.pi.getAgentDir(),
          fetchSelectors,
          signal: controller.signal,
        })
        if (controller.signal.aborted) return

        nextCheckAt = result.nextCheckAt
        if (result.error) {
          status = "Check unavailable: " + result.error
        } else {
          status = "Watching openai-codex."
        }
        if (result.added.length > 0) {
          for (let i = result.added.length; i < hintRows; i++) {
            ctx.ui.setStatus(HINT_KEY + "." + i, undefined)
          }
          showListing(ctx.ui, HINT_KEY, result.added, "New openai-codex listings")
          hintRows = result.added.length
        }
      } catch {
        if (controller.signal.aborted) return
        status = "Check unavailable: could not access the profile watch state."
        nextCheckAt = Date.now() + FAILURE_RETRY_MS
      }
      status += " Next check: " + new Date(nextCheckAt).toISOString()
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
        showListing(ctx.ui, key, ["openai-codex/example-model"], "Model Watch demo")
        ctx.setTimeout(() => {
          ctx.ui.setStatus(key, undefined)
          ctx.ui.setStatus(key + ".0", undefined)
        }, 8000)
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
