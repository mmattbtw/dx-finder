# dx-finder

Bun + TypeScript monitor that scrapes the maimai DX location page and tracks the cabinet closest to Nashville, TN.

When the closest cabinet changes from the previously saved result, it sends a Discord webhook.

## Setup

```bash
bun install
```

## Configuration

Environment variables:

- `WEBHOOK_URL` (optional): Discord webhook URL to notify when closest cabinet changes.
- `STATE_FILE` (optional): path to state JSON file. Defaults to `state/closest-cabinet.json`.
- `CHECK_INTERVAL_MINUTES` (optional): how often to check. Defaults to `60`.

Example:

```bash
export WEBHOOK_URL='https://example.com/webhook'
export STATE_FILE='state/closest-cabinet.json'
```

## Run

```bash
bun run run
```

This is a long-running process. It checks once at startup, then keeps checking every hour (or your configured interval).

On first run, it initializes state and does not notify. On later runs, it compares the closest cabinet to the saved one and notifies only if changed.

## Discord Message

On change, it posts a formatted Discord message with:

- summary line
- embed containing previous/new closest cabinet
- cabinet `sid`, address, distance from Nashville
- links to each cabinet details page

Stop with `Ctrl+C` (SIGINT) or SIGTERM.
