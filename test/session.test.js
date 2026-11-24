import assert from "node:assert/strict"
import { test } from "node:test"
import { registerModelWatch } from "../index.js"

const DAY = 24 * 60 * 60 * 1000

test("an idle main session shows a new listing on its next daily check without user input", async t => {
  const start = Date.UTC(2026, 0, 1)
  t.mock.timers.enable({
    apis: ["Date"],
    now: start,
  })
  const events = new Map()
  const statuses = new Map()
  let timer
  const ctx = {
    hasUI: true,
    agent: {
      kind: "main",
    },
    agentDir: "/test-profile",
    ui: {
      setStatus: statuses.set.bind(statuses),
    },
    setTimeout(callback, delay) {
      timer = {
        callback,
        delay,
      }
      return timer
    },
    clearTimer() {
      timer = undefined
    },
  }
  const pi = {
    on: events.set.bind(events),
    setLabel() {},
    registerCommand() {},
  }
  const selector = "openai-codex/new-chat"
  registerModelWatch(pi, async () => {
    const added = []
    if (Date.now() > start) added.push(selector)
    return {
      nextCheckAt: Date.now() + DAY,
      added,
    }
  })

  events.get("session_start")({}, ctx)
  await timer.callback()
  assert.deepEqual([...statuses.values()], [])
  assert.equal(timer.delay, DAY)

  t.mock.timers.tick(timer.delay)
  await timer.callback()
  assert.ok([...statuses.values()].includes(selector))
  events.get("session_shutdown")({}, ctx)
  assert.equal(timer, undefined)
})
