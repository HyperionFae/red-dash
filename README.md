# Red Dash

A visual red team cockpit. Terminal in the middle, your tools and their output around you — so you stop digging through folders, re-running scans just to see results, and forgetting what you already tried.

Runs on any Linux distro. Install hints adapt to your package manager (pacman, apt, dnf, zypper, apk). Developed on Omarchy / Hyprland. Wraps the tools you already use — it does not replace them.

> ⚠️ **Work in progress.** Red Dash is under active development — features are still being added and things may change. Use it on authorised labs and targets only.

---

## Why

- Stop re-running nmap just to look at the output again
- Stop hunting through folders for scan results
- Keep notes, loot, and commands per box, in one place
- One-click tool examples with your target filled in automatically

---

## Features

- Real terminal in the centre (xterm.js + node-pty)
- Target bar — set the IP/domain once, it fills `{TARGET}` / `{DOMAIN}` in every example
- Tool examples panel — click to drop a command into the terminal (nmap, ffuf, gobuster, feroxbuster, nikto, wpscan, smb, netexec, impacket, and more)
- Add your own examples — saved separately so updates never overwrite them
- Output panel — scan results appear automatically, parsed into clean tables (nmap, ffuf, gobuster, feroxbuster, nikto, wpscan, whatweb), with a raw-output toggle
- Notes + Loot tabs — per box, saved to disk
- Workspaces — each box kept separate (output, notes, loot)
- Setup check — finds your tools and SecLists, shows install commands for what's missing, clears itself as you install
- VPN status — shows your HTB/THM VPN IP, click to copy
- Opens with no terminal attached (app launcher or detached script)

---

## Install

Requires Node.js and npm.

```bash
git clone https://github.com/Basilisk-king/red-dash.git
cd red-dash
npm install
npx electron-rebuild
npm start
```

`electron-rebuild` builds the terminal engine (node-pty) for Electron — don't skip it.

---

## Open it without a terminal

```bash
./install-launcher.sh
```

Then search "Red Dash" in your app launcher.

Or run `./launch.sh` — it detaches, so you can close the terminal and the app stays open.

---

## Use it

1. Set a target (IP up top, click Set target)
2. Make a box (+ New box)
3. Click an example on the left — it drops into the terminal, you press Enter
4. Output appears on the right — click a file to read it again, no re-running

---

## Your own examples

Click "+ Add" in the examples panel, or edit `library/my_examples.json` directly.
Your examples get a star and are never overwritten by updates.

Auto-filled variables:
- `{TARGET}` — target IP
- `{DOMAIN}` — target domain
- `{OUT}` — the current box's output folder
- `{WORDLIST}` / `{SUBLIST}` — found automatically if SecLists is installed

`<user>` `<pass>` `<hash>` are placeholders you type over.

---

## Tech

Electron, node-pty, xterm.js. No framework, no build step — plain HTML/CSS/JS.

---

## Security note

This is a **local, single-user tool** for your own machine. It is not hardened for untrusted input and is not meant to be exposed to a network or run for other users.

- It runs with Electron `nodeIntegration` on / `contextIsolation` off — a deliberate, common choice for a local tool, but the less-sandboxed pattern.
- Scan output shown in the UI is HTML-escaped before display, so malicious content in a target's response cannot run in the app window.
- Only run it on engagements you are authorised to perform.

A future hardening pass (context isolation + a preload bridge) is planned as a separate improvement.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Disclaimer

For authorised testing and learning only (your own labs, HTB, THM, systems you have permission to test). You are responsible for how you use it.
