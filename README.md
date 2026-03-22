# pi-config

Personal `pi` global config, extensions, and setup notes.

## What is included

- `settings.json`
- `extensions/`
- `.gitignore`

## What is intentionally not included

These are ignored and stay machine-local:

- `auth.json` — provider login / credentials
- `sessions/` — saved conversation history
- `git/` — package install cache / git package clones
- logs / temp files

## Prerequisites

Install pi first:

```bash
npm install -g @mariozechner/pi-coding-agent
```

Pi docs note that global settings live in:

- `~/.pi/agent/settings.json`

and global extensions are auto-discovered from:

- `~/.pi/agent/extensions/*.ts`
- `~/.pi/agent/extensions/*/index.ts`

## Fresh setup on a new machine

### 1. Install pi

```bash
npm install -g @mariozechner/pi-coding-agent
```

### 2. Clone this repo into pi's global config directory

If `~/.pi/agent` does not exist yet:

```bash
git clone git@github.com:dca123/pi-config.git ~/.pi/agent
```

If it already exists, back it up first:

```bash
mv ~/.pi/agent ~/.pi/agent.backup.$(date +%Y%m%d-%H%M%S)
git clone git@github.com:dca123/pi-config.git ~/.pi/agent
```

### 3. Start pi and authenticate

You still need to authenticate locally on each machine.

Options:

- run `pi` and use `/login`
- or provide provider API keys via environment variables

Examples from the pi docs:

```bash
pi
/login
```

or:

```bash
pi
```

Since this config uses OpenAI Codex by default, you should log into the configured provider or set the appropriate credentials for that provider on the target machine.

### 4. Reload or restart pi

If pi was already open when you updated files:

```text
/reload
```

Otherwise just restart pi.

## Current config defaults

Current `settings.json` includes:

- `defaultProvider: openai-codex`
- `defaultModel: gpt-5.4`
- `defaultThinkingLevel: medium`
- `hideThinkingBlock: true`
- `steeringMode: one-at-a-time`

## Included extensions

### `extensions/thread-switcher/index.ts`
Adds the `/threads` command.

After starting or reloading pi, use:

```text
/threads
```

### `extensions/exa-web-search.ts`
Local extension currently stored in this config.

## Updating this repo after local changes

Because this repo lives directly at `~/.pi/agent`, your local config directory is also the git repo.

Typical workflow:

```bash
cd ~/.pi/agent
git status
git add settings.json extensions .gitignore README.md
git commit -m "Update pi config"
git push
```

## Pulling updates on another machine

```bash
cd ~/.pi/agent
git pull
```

Then either restart pi or run:

```text
/reload
```

## Notes

- This is a **global** pi setup, not a project-local `.pi/` setup.
- Pi docs also support project-local configuration via `.pi/settings.json` and `.pi/extensions/` if you later want per-repo reproducibility instead of one global setup for all projects.
