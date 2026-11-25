#!/usr/bin/env node

import { intervalCommand } from "../lib/settings.js"

const [, , action, ...args] = process.argv

try {
  if (action !== "interval") {
    throw new Error("Usage: node bin/model-watch.js interval [hours|reset]")
  }

  const message = await intervalCommand(args)
  console.log(message)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
