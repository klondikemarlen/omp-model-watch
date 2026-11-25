# OMP Model Watch

Get a footer hint when OMP discovers a new `openai-codex` chat model. Use the exact selector in the hint to decide what to evaluate. A catalog listing is not proof that a particular subscription can run the model. Model Watch never runs inference or changes routing.

## Install and use

Requires Linux with util-linux `flock`, OMP's provider discovery API (tested on 19.1.1), and a configured Codex subscription. Install from the default branch and start a fresh interactive OMP process:

```sh
omp plugin install github:klondikemarlen/omp-model-watch
```

The first successful check quietly records the models already listed. Later checks report only previously unseen selectors. The terminal that detects an addition shows an update-style notice below Trainer, if Trainer is present.

- `/model-watch status` — see whether the watch is healthy or unavailable and how long until its next check, for example `Next check in 3 hours 12 minutes.`
- `/model-watch demo` — show a labeled example in the footer for eight seconds, without querying the provider or changing watch state.

Interactive main sessions check on startup when due and every six hours by default while open, even when idle. Nothing runs while OMP is closed.

To change the interval, open **Settings → Plugins → omp-model-watch → checkIntervalHours**. You can also set the profile value with `/model-watch interval 24` or, from the plugin directory, `node bin/model-watch.js interval 24`. Omit the number to read the effective interval. Use `reset` to clear the profile value; a project override still takes precedence, otherwise the interval returns to six hours. The range is 1 to 596 hours; `1.5` means 90 minutes.

Changes apply at the next scheduled check or interactive startup. If you set a custom interval in v0.2.0's `model-watch/config.json`, enter that number once in plugin settings. The old file is not modified or used.

If discovery fails, Model Watch keeps the last good list. It retries after 1 minute, then 2, 4, 8, 16, 32, and at most 60 minutes between attempts. Terminals share the retry deadline. A successful check resets backoff and resumes the normal interval. Use `/model-watch status` for the countdown.

## Development

With Node 22.13+ or 24+, run `npm ci`, `npm run lint`, and `npm test`. Use `omp --no-extensions -e ./index.js` to exercise the terminal commands. GitHub is the install source; the project does not require an npm registry publish. See [release history](CHANGELOG.md).
