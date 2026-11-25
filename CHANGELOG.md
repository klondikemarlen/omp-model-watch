# Changelog

## Unreleased

## 0.3.0 — 2026-11-24

- Set the check interval in OMP's plugin settings, with `/model-watch interval`, or from `node bin/model-watch.js interval`.

## 0.2.0 — 2026-11-24

- Check every six hours by default, with a configurable interval per profile. Failed discovery retries after one minute and doubles the wait up to one hour until recovery.

## 0.1.2 — 2026-11-24

- `/model-watch status` now shows how long until the next check or retry instead of a clock time and timezone. The countdown is recalculated whenever you ask.

## 0.1.1 — 2026-11-24

- Real and demo hints appear below Trainer with OMP update-notice styling. `/model-watch status` shows the next check in local time, including the time zone.

## 0.1.0 — 2026-11-24

- Get a passive hint for new Codex chat-model listings at startup or during a long-running OMP session. Use `/model-watch status` to distinguish an unavailable check from an unchanged catalog.
