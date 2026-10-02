const { app, BrowserWindow, ipcMain } = require('electron')
const pty = require('node-pty')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync, spawn } = require('child_process')

// ---- paths ----
const ROOT = __dirname
const LIB = path.join(ROOT, 'library')
const WORKSPACES = path.join(ROOT, 'workspaces')
const STATE_FILE = path.join(ROOT, 'state.json')

for (const d of [LIB, WORKSPACES]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
}
const MY = path.join(LIB, 'my_examples.json')
if (!fs.existsSync(MY)) fs.writeFileSync(MY, JSON.stringify({ examples: [] }, null, 2))

// ---- state ----
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }
  catch { return { target: '', domain: '', workspace: '' } }
}
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)) } catch {} }
let state = loadState()
state.dismissedTools = state.dismissedTools || []

// ---- window ----
let win
function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    backgroundColor: '#15151b',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  win.loadFile(path.join('ui', 'index.html'))
}
app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())

// ---- terminal ----
let shellProc = null
let outputWatcher = null

ipcMain.on('term-ready', (e, size) => {
  // a page reload fires this again — kill the old shell so it doesn't
  // keep running in the background, orphaned
  if (shellProc) { try { shellProc.kill() } catch {} }
  const shell = process.env.SHELL || 'bash'
  shellProc = pty.spawn(shell, [], {
    name: 'xterm-color',
    cwd: workspaceDir() || process.env.HOME || os.homedir(),
    env: process.env,
    // spawn at the terminal's real on-screen size (not a guessed default) so
    // the shell draws its first prompt at the right width — spawning smaller
    // then resizing a moment later makes zsh redraw the prompt line on top
    // of the old one (SIGWINCH), leaving a ghosted double prompt.
    cols: size?.cols || 100, rows: size?.rows || 30
  })
  shellProc.onData(d => { if (win) win.webContents.send('term-out', d) })
})
ipcMain.on('term-in', (ev, d) => { if (shellProc) shellProc.write(d) })
ipcMain.on('term-insert', (ev, text) => { if (shellProc) shellProc.write(text) })
ipcMain.on('term-resize', (ev, size) => {
  try { if (shellProc) shellProc.resize(size.cols, size.rows) } catch {}
})

// ---- examples ----
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
ipcMain.handle('get-examples', () => {
  const starter = readJson(path.join(LIB, 'examples.json'), { examples: [] })
  const mine = readJson(MY, { examples: [] })
  const s = (starter.examples || []).map(x => ({ ...x, mine: false }))
  const m = (mine.examples || []).map(x => ({ ...x, mine: true }))
  return [...s, ...m]
})
ipcMain.handle('add-example', (ev, ex) => {
  const mine = readJson(MY, { examples: [] })
  mine.examples = mine.examples || []
  mine.examples.push(ex)
  fs.writeFileSync(MY, JSON.stringify(mine, null, 2))
  return true
})

// ---- target ----
ipcMain.handle('get-target', () => state)
ipcMain.handle('set-target', (ev, t) => {
  state.target = t.target || ''
  state.domain = t.domain || ''
  saveState(state)
  return state
})

// ---- workspaces ----
function workspaceDir() { return state.workspace ? path.join(WORKSPACES, state.workspace) : '' }
function outputDir() { const d = workspaceDir(); return d ? path.join(d, 'output') : '' }

ipcMain.handle('list-workspaces', () => {
  try {
    return fs.readdirSync(WORKSPACES, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name)
  } catch { return [] }
})
// folders made under output/ so every shipped tool has somewhere to write
const TOOL_DIRS = [
  'nmap', 'ffuf', 'gobuster', 'feroxbuster', 'nikto', 'whatweb', 'wpscan',
  'smb', 'snmp', 'misc'
]
function ensureDirs(dir) {
  for (const sub of TOOL_DIRS) {
    try { fs.mkdirSync(path.join(dir, 'output', sub), { recursive: true }) } catch {}
  }
  if (!fs.existsSync(path.join(dir, 'notes.md'))) fs.writeFileSync(path.join(dir, 'notes.md'), '# Notes\n')
  if (!fs.existsSync(path.join(dir, 'loot.md'))) fs.writeFileSync(path.join(dir, 'loot.md'), '# Loot\n')
}

ipcMain.handle('new-workspace', (ev, name) => {
  const safe = String(name).replace(/[^a-zA-Z0-9_\-\.]/g, '_')
  ensureDirs(path.join(WORKSPACES, safe))
  return safe
})
ipcMain.handle('set-workspace', (ev, name) => {
  state.workspace = name
  saveState(state)
  const dir = workspaceDir()
  if (dir) ensureDirs(dir)
  if (shellProc && dir) shellProc.write(`cd "${dir}"\n`)
  startWatching()
  return { workspace: name, outputDir: outputDir() }
})
ipcMain.handle('delete-workspace', (ev, name) => {
  const safe = String(name).replace(/[^a-zA-Z0-9_\-\.]/g, '_')
  try { fs.rmSync(path.join(WORKSPACES, safe), { recursive: true, force: true }) } catch {}
  if (state.workspace === safe) {
    state.workspace = ''
    saveState(state)
    try { if (outputWatcher) outputWatcher.close() } catch {}
  }
  return true
})

// ---- notes / loot ----
function noteFile(type) {
  const dir = workspaceDir()
  if (!dir) return ''
  return path.join(dir, type === 'loot' ? 'loot.md' : 'notes.md')
}
ipcMain.handle('read-note', (ev, type) => {
  const f = noteFile(type)
  if (!f) return ''
  try { return fs.readFileSync(f, 'utf8') } catch { return '' }
})
ipcMain.handle('write-note', (ev, type, text) => {
  const f = noteFile(type)
  if (!f) return false
  try { fs.writeFileSync(f, text); return true } catch { return false }
})

// ---- output files ----
function listOutputFiles() {
  const base = outputDir()
  if (!base || !fs.existsSync(base)) return []
  const out = []
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name)
      if (d.isDirectory()) walk(full)
      else out.push({ name: path.relative(base, full), path: full, mtime: fs.statSync(full).mtimeMs })
    }
  }
  try { walk(base) } catch {}
  return out.sort((a, b) => b.mtime - a.mtime)
}
ipcMain.handle('list-output', () => listOutputFiles())
ipcMain.handle('read-output', (ev, filePath) => {
  try { return fs.readFileSync(filePath, 'utf8') } catch (e) { return 'Could not read file: ' + e.message }
})
function startWatching() {
  try { if (outputWatcher) outputWatcher.close() } catch {}
  const base = outputDir()
  if (!base || !fs.existsSync(base)) return
  try {
    outputWatcher = fs.watch(base, { recursive: true }, () => {
      if (win) win.webContents.send('output-changed')
    })
  } catch {}
}

// ---- environment check (tools + seclists) ----
function have(bin) {
  try { execSync('command -v ' + bin, { stdio: 'ignore', shell: '/bin/bash' }); return true }
  catch { return false }
}
// A TOOL_CHECKS `bins` entry is normally one required binary (a string). Some
// tools go by a different name depending on how they were installed (e.g.
// Arch's impacket package ships "secretsdump.py", pipx's install creates
// "impacket-secretsdump") — write that entry as an array of alternatives and
// ANY one of them being present satisfies it, instead of hardcoding one name
// and silently failing for everyone who installed it a different way.
function haveBin(bin) {
  return Array.isArray(bin) ? bin.some(have) : have(bin)
}

// Detect the system package manager so install hints suit the user's distro,
// not just Arch. First match wins. Returns null if none is found.
const PACKAGE_MANAGERS = [
  { bin: 'pacman', install: 'sudo pacman -S' },
  { bin: 'apt',    install: 'sudo apt install' },
  { bin: 'dnf',    install: 'sudo dnf install' },
  { bin: 'zypper', install: 'sudo zypper install' },
  { bin: 'apk',    install: 'sudo apk add' }
]
let _pmCache
function detectPM() {
  if (_pmCache !== undefined) return _pmCache
  _pmCache = PACKAGE_MANAGERS.find(pm => have(pm.bin)) || null
  return _pmCache
}

// the "tool" field in examples.json is often a logical group (e.g. "smb"
// covers smbclient/smbmap/enum4linux-ng, not one binary) rather than a
// literal command name, so map each group to what it actually needs.
// `any: true` means any one binary satisfies the group (e.g. either
// burpsuite edition); otherwise every listed binary must be present.
// `skip: true` marks a group that needs nothing installed (shell builtins).
//
// Install hint is built per-distro at runtime:
//   `pkg`  = package name in the official repos -> gets the right install verb
//            for the user's package manager (pacman/apt/dnf/zypper/apk).
//            Either a plain string (same name on every distro) or an object
//            keyed by package-manager bin (pacman/apt/dnf/zypper/apk) for
//            tools whose package name actually differs per distro. If the
//            current PM has no entry, the pkg line is skipped rather than
//            guessing wrong — `note` (if present) still shows.
//   `note` = a distro-agnostic install line (pipx/gem/go/git/AUR) for tools
//            that aren't in most official repos. Shown as-is.
// A tool can have `pkg`, `note`, or both.
const SMBCLIENT_PKG = { pacman: 'smbclient', apt: 'smbclient', dnf: 'samba-client', zypper: 'samba-client', apk: 'samba-client' }
const TOOL_CHECKS = {
  hosts:        { skip: true },
  nmap:         { bins: ['nmap'], pkg: 'nmap' },
  gobuster:     { bins: ['gobuster'], pkg: 'gobuster' },
  ffuf:         { bins: ['ffuf'], note: 'go install github.com/ffuf/ffuf/v2@latest   # or AUR: yay -S ffuf' },
  feroxbuster:  { bins: ['feroxbuster'], note: 'cargo install feroxbuster   # or AUR: yay -S feroxbuster' },
  nikto:        { bins: ['nikto'], pkg: 'nikto', note: 'Arch: yay -S nikto (AUR)' },
  // Not published as a RubyGem — AUR or a direct git clone are the only real options.
  whatweb:      { bins: ['whatweb'], note: 'yay -S whatweb (AUR)   # or: git clone https://github.com/urbanadventurer/WhatWeb ~/WhatWeb' },
  wpscan:       { bins: ['wpscan'], note: 'gem install wpscan   # or AUR: yay -S wpscan' },
  curl:         { bins: ['curl'], pkg: 'curl' },
  smb:          { bins: ['smbclient', 'smbmap', 'enum4linux-ng'], pkg: SMBCLIENT_PKG, note: 'then: pipx install smbmap enum4linux-ng' },
  netexec:      { bins: ['nxc'], note: 'pipx install netexec   # formerly crackmapexec' },
  rpc:          { bins: ['rpcclient'], pkg: SMBCLIENT_PKG },
  nfs:          { bins: ['showmount'], pkg: { pacman: 'nfs-utils', apt: 'nfs-common', dnf: 'nfs-utils', zypper: 'nfs-client', apk: 'nfs-utils' } },
  ldap:         { bins: ['ldapsearch'], pkg: { pacman: 'openldap', apt: 'ldap-utils', dnf: 'openldap-clients', zypper: 'openldap2-client', apk: 'openldap-clients' } },
  snmp:         { bins: ['snmpwalk'], pkg: 'net-snmp' },
  dns:          { bins: ['dig', 'dnsrecon'], pkg: { pacman: 'bind', apt: 'dnsutils', dnf: 'bind-utils', zypper: 'bind-utils', apk: 'bind-tools' }, note: 'then: pipx install dnsrecon' },
  git:          { bins: ['git-dumper'], note: 'pipx install git-dumper' },
  sqlmap:       { bins: ['sqlmap'], pkg: 'sqlmap' },
  searchsploit: { bins: ['searchsploit'], pkg: { pacman: 'exploitdb', apt: 'exploitdb' }, note: 'or: git clone https://github.com/offensive-security/exploitdb /opt/exploitdb' },
  hydra:        { bins: ['hydra'], pkg: 'hydra' },
  john:         { bins: ['john'], pkg: 'john' },
  hashcat:      { bins: ['hashcat'], pkg: 'hashcat' },
  // Arch's impacket package ships the raw upstream script names (secretsdump.py,
  // GetNPUsers.py, ...) while `pipx install impacket` creates "impacket-secretsdump"
  // wrapper scripts instead — accept either so it's detected regardless of
  // which way it was installed.
  impacket:     { bins: [['secretsdump.py', 'impacket-secretsdump']], pkg: { pacman: 'impacket', apt: 'python3-impacket' }, note: 'or: pipx install impacket' },
  'evil-winrm': { bins: ['evil-winrm'], note: 'gem install evil-winrm   # or AUR: yay -S ruby-evil-winrm' },
  ssh:          { bins: ['ssh'], pkg: { pacman: 'openssh', apt: 'openssh-client', dnf: 'openssh-clients', zypper: 'openssh-clients', apk: 'openssh-client' } },
  ftp:          { bins: ['ftp'], pkg: { pacman: 'inetutils', apt: 'ftp', dnf: 'ftp', zypper: 'ftp' } },
  shells:       { bins: ['nc'], pkg: { pacman: 'openbsd-netcat', apt: 'netcat-openbsd', dnf: 'nmap-ncat', zypper: 'netcat-openbsd', apk: 'netcat-openbsd' }, note: 'Responder: pipx install responder' },
  burpsuite:    { bins: ['burpsuite', 'burpsuite-pro'], any: true, note: 'download from portswigger.net/burp   # or AUR: yay -S burpsuite' }
}

// resolves a TOOL_CHECKS `pkg` (plain string, or {pmBin: name} map) to the
// right package name for the detected PM. Returns null rather than a
// guessed-wrong name when the map has no entry for this PM.
function resolvePkgName(pkg, pm) {
  if (!pkg) return null
  if (typeof pkg === 'string') return pkg
  return (pm && pkg[pm.bin]) || null
}

// turns a tool definition into an install hint for THIS machine's package manager
function buildHint(def) {
  const pm = detectPM()
  const parts = []
  const pkgName = resolvePkgName(def.pkg, pm)
  if (pkgName) {
    parts.push(pm ? `${pm.install} ${pkgName}` : `install ${pkgName} with your package manager`)
  }
  if (def.note) parts.push(def.note)
  return parts.join('   # ') || 'install this tool (see its docs)'
}

// pulls every distinct "tool" group out of the shipped + user examples, so
// a newly added example (ours or theirs) gets checked without editing this
// file by hand
function requiredToolGroups() {
  const starter = readJson(path.join(LIB, 'examples.json'), { examples: [] })
  const mine = readJson(MY, { examples: [] })
  const names = new Set()
  for (const ex of [...(starter.examples || []), ...(mine.examples || [])]) {
    if (ex.tool) names.add(ex.tool)
  }
  return [...names]
}
function findSecLists() {
  const home = process.env.HOME || os.homedir()
  const roots = [
    '/usr/share/seclists',
    '/usr/share/SecLists',
    '/usr/share/wordlists/seclists',
    '/usr/share/wordlists/SecLists',
    path.join(home, 'SecLists'),
    path.join(home, 'seclists'),
    '/opt/SecLists'
  ]
  for (const r of roots) { try { if (fs.existsSync(r)) return r } catch {} }
  return null
}
function firstExisting(cands) {
  for (const c of cands) { try { if (fs.existsSync(c)) return c } catch {} }
  return cands[0]
}

// ---- clipboard ----
// Electron's own clipboard module is unreliable on this Wayland setup (writes
// silently don't reach the compositor), so shell out to the native tool instead.
function copyToClipboard(text) {
  return new Promise((resolve) => {
    const isWayland = process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY
    const candidates = isWayland
      ? [['wl-copy', []]]
      : [['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]]

    const tryNext = (i) => {
      if (i >= candidates.length) return resolve(false)
      const [cmd, args] = candidates[i]
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] })
      child.on('error', () => tryNext(i + 1))
      child.on('close', (code) => resolve(code === 0))
      child.stdin.write(text)
      child.stdin.end()
    }
    tryNext(0)
  })
}
ipcMain.handle('copy-text', (ev, text) => copyToClipboard(text))

// ---- vpn (HTB/THM use OpenVPN or WireGuard — tun*/tap*/wg* interfaces) ----
const VPN_IFACE_RE = /^(tun|tap|wg|ppp)\d*$/
function checkVpn() {
  const nets = os.networkInterfaces()
  for (const [name, addrs] of Object.entries(nets)) {
    if (!VPN_IFACE_RE.test(name)) continue
    const v4 = (addrs || []).find(a => a.family === 'IPv4' && !a.internal)
    if (v4) return { connected: true, iface: name, ip: v4.address }
  }
  return { connected: false, iface: null, ip: null }
}
ipcMain.handle('check-vpn', () => checkVpn())

ipcMain.handle('check-env', () => {
  const tools = {}
  const hints = {}
  for (const name of requiredToolGroups()) {
    const def = TOOL_CHECKS[name]
    if (def && def.skip) continue
    if (def) {
      tools[name] = def.any ? def.bins.some(haveBin) : def.bins.every(haveBin)
      hints[name] = buildHint(def)
    } else {
      // unknown group — e.g. a custom example added by the user whose
      // "tool" name isn't in TOOL_CHECKS — best-effort: look for a binary
      // of the same name and suggest it via the detected package manager
      tools[name] = have(name)
      hints[name] = buildHint({ pkg: name })
    }
  }

  const seclists = findSecLists()
  tools.seclists = !!seclists
  hints.seclists = 'git clone https://github.com/danielmiessler/SecLists ~/SecLists   # or your distro/AUR package'

  let wordlist = null, sublist = null
  if (seclists) {
    wordlist = firstExisting([
      path.join(seclists, 'Discovery/Web-Content/common.txt'),
      path.join(seclists, 'Discovery/Web-Content/directory-list-2.3-medium.txt')
    ])
    sublist = firstExisting([
      path.join(seclists, 'Discovery/DNS/subdomains-top1million-5000.txt'),
      path.join(seclists, 'Discovery/DNS/subdomains-top1million-110000.txt')
    ])
  }
  return { tools, seclists, wordlist, sublist, hints, dismissed: state.dismissedTools || [] }
})

// ---- tool setup dismissal — "I don't want this one" stops it nagging ----
ipcMain.handle('dismiss-tool', (ev, name) => {
  state.dismissedTools = state.dismissedTools || []
  if (!state.dismissedTools.includes(name)) state.dismissedTools.push(name)
  saveState(state)
  return state.dismissedTools
})
ipcMain.handle('undismiss-tools', () => {
  state.dismissedTools = []
  saveState(state)
  return state.dismissedTools
})
