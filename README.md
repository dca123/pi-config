# pi-config

Personal global Pi config, extensions, skills, themes, and setup notes.

## Managed here

- active extensions in `extensions/`
- deferred/local extensions in `extensions-deferred/` and `extensions-local/`
- skills, themes, prompts, modes, models, and loadouts
- package manifest in `npm/package.json`

## Machine-local / ignored

- `auth.json`, `pins.json`, `codex-multiplexer.json`, `trust.json`
- `settings.json`
- `sessions/`, `handoffs/`, `state/`, `cache/`, `debug/`
- `git/` package clones
- `pi-rewind/shadow-git/`
- `node_modules/`, package locks, and generated extension build output

## Chezmoi setup

Initialize the dotfiles repo from the actual remote:

```bash
chezmoi init git@github.com:dca123/config.git
chezmoi edit-config
chezmoi diff
chezmoi apply
```

That repo manages this repo as a chezmoi external:

```txt
~/.pi/agent <- git@github.com:dca123/pi-config.git
```

The chezmoi bootstrap script installs `@earendil-works/pi-coding-agent@0.79.8`, creates `settings.json` only when missing, installs local extension dependencies, and links Plannotator skills from `~/Projects/plannotator/apps/pi-extension/skills`.

## Manual setup without chezmoi

```bash
npm install -g @earendil-works/pi-coding-agent@0.79.8
git clone git@github.com:dca123/pi-config.git ~/.pi/agent
cd ~/.pi/agent/npm && npm install
cd ~/.pi/agent/extensions-deferred/sweep && npm install
cd ~/.pi/agent/extensions-deferred/web-fetch && npm install
```

Then create `~/.pi/agent/settings.json`, authenticate with `/login`, and restart Pi or run `/reload`.

## Reproduction gates

This setup only reproduces elsewhere after this repo is committed and pushed to `git@github.com:dca123/pi-config.git`. Chezmoi clones that remote; unpushed local changes in `~/.pi/agent` are invisible to new machines.

The `pi-context` and `pi-context-prune` externals clone upstream remotes. Local dirty checkout changes on this machine are not reproducible until they are pushed or packaged.

The `plannotator` external clones `git@github.com:dca123/plannotator.git`. Local commits ahead of that remote are not reproducible until they are pushed.

`/day-man review` dynamically loads helpers from `~/Projects/night-man`; because that project has no configured remote, it needs a manual checkout on another machine.
