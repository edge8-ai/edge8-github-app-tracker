# Set up the Edge8 tracker

**Time: about 5 minutes. You need one thing: your `e8k_…` key, sent to you privately by an Edge8 admin.**

You do *not* need a GitHub account with access to Edge8 repos. Your key grants that access by itself.

---

## 1. Check you have Node 18+ and Git 2.34+

```bash
node -v
git --version
```

Missing or too old? Windows: `winget install OpenJS.NodeJS.LTS` and `winget install Git.Git`, then open a **new** terminal. macOS: `brew install node git`. Linux: your package manager.

## 2. Download the tracker

Paste your key where shown. On Windows PowerShell use `curl.exe`, not `curl`.

```bash
curl -H "x-edge8-key: PASTE_YOUR_KEY" -o tracker.tgz \
  https://edge8-github-app-tracker-kappa.vercel.app/api/cli/latest
```

You should get a file of roughly 17 KB. If you get `{"error":"bad key"}`, your key is wrong or revoked — re-copy it, and ask your admin for a fresh one if it still fails.

## 3. Install it

```bash
npm i -g ./tracker.tgz
```

On macOS or Linux, if this fails with `EACCES`, re-run it with `sudo`.

## 4. Turn it on

```bash
tracker setup --key PASTE_YOUR_KEY --server https://edge8-github-app-tracker-kappa.vercel.app
```

This wires git, then asks **one yes/no question**: whether to also report your Claude Code session effort. Answer it. If you say yes it installs the `edge8-telemetry` plugin for you — there is nothing else to install.

## 5. Restart Claude Code

A plugin does not attach to a session that is already running. If you said no in step 4, skip this.

## 6. Check it worked

```bash
tracker status
```

Five lines. The first four green and `all checks passed — this machine is being counted ✔` means git is tracked. The fifth, `effort`, reports telemetry and never fails the check — saying no is a valid answer.

---

## That's it

Work normally. Every `git clone/pull/push` on an Edge8 repo now authenticates automatically with a short-lived token. Your personal and unrelated repos are untouched.

## Three things worth knowing

**`gh auth login` and `gh auth setup-git` silently remove the tracker.** They rewrite git's credential helper list. If you ever run either, run `tracker setup` again straight after — no flags needed, it remembers your key.

**When in doubt, run `tracker status`.** It is safe to run as often as you like and every ✘ line tells you its own fix.

**Upgrading later:** repeat steps 2–3 with the same command, then run `tracker setup` with **no flags**. `npm i -g` alone replaces only the `tracker` command — the git plumbing is refreshed only when `setup` runs.

## If something is wrong

- `tracker: command not found` → open a new terminal. Still missing: `npm prefix -g` shows where npm installs global commands; that folder needs to be on your PATH.
- git asks for a username or password on an Edge8 repo → run `tracker setup` again. If it keeps happening, tell your admin the repo name: its owner may not have the Edge8 GitHub App installed, which is fixed on their side, not yours.
- Anything else → send your admin the output of `tracker status`.

## What it records, and what it does not

It records git activity on **registered Edge8 repositories**: which repo, which branch, and when. With telemetry on, it also records session token totals and active minutes for those same repos.

It does not record file contents, keystrokes, screens, or anything at all in your personal repositories — repos under your own GitHub account are excluded by policy, permanently, not by configuration.

To remove it: `tracker uninstall`. To stop telemetry only: `/edge8-telemetry` inside Claude Code and withdraw consent.
