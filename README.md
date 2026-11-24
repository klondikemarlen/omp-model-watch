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

Interactive main sessions check on startup when due and again every 24 hours while open, even when idle. Terminals in the same OMP profile share the baseline. Nothing runs when OMP is closed: the next interactive startup catches up. Offline or unsuccessful discovery leaves the last good baseline intact and schedules a retry. If checks keep failing, use `/model-watch status` and check OMP's `openai-codex` authentication and discovery settings; there is no API-key fallback.

## Development

With Node 22.13+ or 24+, run `npm ci`, `npm run lint`, and `npm test`. Use `omp --no-extensions -e ./index.js` to exercise the terminal commands. GitHub is the install source; the project does not require an npm registry publish. See [release history](CHANGELOG.md).
