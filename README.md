# OMP Model Watch

Get a footer hint when OMP discovers a new `openai-codex` chat model. Use the exact selector in the hint to decide what to evaluate. A catalog listing is not proof that a particular subscription can run the model. Model Watch never runs inference or changes routing.

## Install and use

Install from the default branch and start a fresh interactive OMP process with a configured Codex subscription:

```sh
omp plugin install github:klondikemarlen/omp-model-watch
```

The first successful check quietly records the models already listed. Later checks report only previously unseen selectors. The terminal that detects an addition shows the hint in its own footer rows alongside other extensions, including Trainer.

- `/model-watch status` — see whether the watch is healthy or unavailable, and when this terminal will check again.
- `/model-watch demo` — show a labeled example in the footer for eight seconds, without querying the provider or changing watch state.

Interactive main sessions check on startup when due and again every 24 hours while open, even when idle. Terminals in the same OMP profile share the baseline. Nothing runs when OMP is closed: the next interactive startup catches up. Offline or unsuccessful discovery leaves the last good baseline intact and schedules a retry. If checks keep failing, use `/model-watch status` and check OMP's `openai-codex` authentication and discovery settings; there is no API-key fallback.

## Development

Use `npm test` for the watch behavior and `omp --no-extensions -e ./index.js` to exercise the terminal commands. GitHub is the install source; the project does not require an npm registry publish. See [release history](CHANGELOG.md).
