const { app, BrowserWindow, ipcMain } = require('electron')
const pty = require('node-pty')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync, spawn } = require('child_process')

// ---- paths ----
// ROOT holds the app's own files (read-only once packaged — an AppImage is a
// read-only mount). DATA holds everything the user creates: boxes, state and
// their own commands. Running from a git checkout keeps DATA = ROOT, exactly
// like before; an installed build (AppImage / .deb) uses ~/.config/red-dash.
const ROOT = __dirname
const DATA = app.isPackaged ? path.join(app.getPath('appData'), 'red-dash') : ROOT
const LIB = path.join(ROOT, 'library')          // shipped examples.json
const MY_LIB = path.join(DATA, 'library')       // the user's my_examples.json
const WORKSPACES = path.join(DATA, 'workspaces')
const STATE_FILE = path.join(DATA, 'state.json')

for (const d of [MY_LIB, WORKSPACES]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
}
const MY = path.join(MY_LIB, 'my_examples.json')
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
    minWidth: 1100,
    minHeight: 640,
    title: 'Red Dash',
    backgroundColor: '#0b0b0f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  // the UI is a single local page — never navigate away or open popups
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.loadFile(path.join(ROOT, 'ui', 'index.html'))
}
app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())

// ---- terminals (one PTY per tab) ----
let outputWatcher = null
const shells = new Map()   // id -> pty process
let activeShellId = null    // the tab the box-switch `cd` is typed into

function spawnShell(id, size) {
  const shell = process.env.SHELL || 'bash'
  const p = pty.spawn(shell, [], {
    name: 'xterm-color',
    cwd: workspaceDir() || process.env.HOME || os.homedir(),
    env: process.env,
    // spawn at the terminal's real on-screen size (not a guessed default) so
    // the shell draws its first prompt at the right width — spawning smaller
    // then resizing a moment later makes zsh redraw the prompt line on top
    // of the old one (SIGWINCH), leaving a ghosted double prompt.
    cols: size?.cols || 100, rows: size?.rows || 30
  })
  p.onData(d => { if (win) win.webContents.send('term-out', { id, data: d }) })
  p.onExit(() => { shells.delete(id); if (win) win.webContents.send('term-exit', { id }) })
  shells.set(id, p)
}
// a page reload re-creates terminals from scratch — kill any orphaned shells first
ipcMain.on('term-reset', () => { for (const p of shells.values()) { try { p.kill() } catch {} } shells.clear() })
ipcMain.on('term-open', (ev, { id, size }) => { if (!shells.has(id)) spawnShell(id, size) })
ipcMain.on('term-in', (ev, { id, data }) => { const p = shells.get(id); if (p) p.write(data) })
ipcMain.on('term-insert', (ev, { id, text }) => { const p = shells.get(id); if (p) p.write(text) })
ipcMain.on('term-resize', (ev, { id, size }) => { const p = shells.get(id); try { if (p) p.resize(size.cols, size.rows) } catch {} })
ipcMain.on('term-close', (ev, { id }) => { const p = shells.get(id); if (p) { try { p.kill() } catch {} } })
ipcMain.on('term-active', (ev, { id }) => { activeShellId = id })

// ---- examples ----
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
ipcMain.handle('get-examples', () => {
  const starter = readJson(path.join(LIB, 'examples.json'), { examples: [] })
  const mine = readJson(MY, { examples: [] })
  const s = (starter.examples || []).map(x => ({ ...x, mine: false }))
  const m = (mine.examples || []).map((x, i) => ({ ...x, mine: true, mineIndex: i }))
  return [...s, ...m]
})
ipcMain.handle('add-example', (ev, ex) => {
  const mine = readJson(MY, { examples: [] })
  mine.examples = mine.examples || []
  mine.examples.push(ex)
  fs.writeFileSync(MY, JSON.stringify(mine, null, 2))
  return true
})
// `index` is the position within my_examples.json (the renderer tracks it)
ipcMain.handle('delete-example', (ev, index) => {
  const mine = readJson(MY, { examples: [] })
  mine.examples = mine.examples || []
  if (!Number.isInteger(index) || index < 0 || index >= mine.examples.length) return false
  mine.examples.splice(index, 1)
  fs.writeFileSync(MY, JSON.stringify(mine, null, 2))
  return true
})

ipcMain.handle('app-info', () => ({
  version: require('./package.json').version,
  electron: process.versions.electron,
  shell: path.basename(process.env.SHELL || 'bash')
}))

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

// box names become folder names and get typed into the shell (cd), so only
// allow a safe character set — and never "." / ".." which would escape workspaces/
function safeName(name) {
  const safe = String(name || '').replace(/[^a-zA-Z0-9_\-\.]/g, '_')
  return /^\.+$/.test(safe) ? '' : safe
}

ipcMain.handle('new-workspace', (ev, name) => {
  const safe = safeName(name)
  if (!safe) return ''
  ensureDirs(path.join(WORKSPACES, safe))
  return safe
})
ipcMain.handle('set-workspace', (ev, name) => {
  name = safeName(name)
  state.workspace = name
  saveState(state)
  const dir = workspaceDir()
  if (dir) ensureDirs(dir)
  // Ctrl+U first: wipe anything sitting un-run at the prompt (e.g. a playbook
  // command that was clicked but not entered) — otherwise the cd gets glued
  // onto the end of it and the Enter runs that half-typed command. Only the
  // active tab follows the box; other tabs (e.g. a listener) stay put.
  const activeShell = shells.get(activeShellId)
  if (activeShell && dir) activeShell.write(`\x15cd "${dir}"\n`)
  startWatching()
  return { workspace: name, outputDir: outputDir() }
})
ipcMain.handle('delete-workspace', (ev, name) => {
  const safe = safeName(name)
  if (!safe) return false
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

// ---- per-box data: ports + creds (workspaces/<box>/box.json) ----
// Values from here get typed into the shell, so they're cleaned on the way in:
// ports may only hold digits/commas/dashes, creds are plain strings (the UI
// shell-quotes them when it fills a command).
const MAX_CREDS = 500
const MAX_CHECKS = 200
// The default checklist a brand-new box starts with (a rough HTB/THM flow).
// Only seeded when box.json has never stored a checklist — once the user has
// one (even an empty one), theirs is kept.
const DEFAULT_CHECKLIST = [
  'Full port scan (nmap -p-)',
  'Enumerate each open service',
  'Web: dirbust + look for vhosts',
  'Find a foothold / initial access',
  'Stabilise the shell',
  'Local enumeration (linpeas / winpeas)',
  'User flag',
  'Privilege escalation',
  'Root / Administrator flag',
  'Loot creds + write it up'
].map(text => ({ text, done: false }))
function boxFile() { const d = workspaceDir(); return d ? path.join(d, 'box.json') : '' }
// keep only real ports / ranges ("22", "1-1000"); anything else is dropped
function cleanPorts(s) {
  return (String(s || '').match(/\d+(?:-\d+)?/g) || []).join(',')
}
function cleanBox(b) {
  b = b && typeof b === 'object' ? b : {}
  const creds = (Array.isArray(b.creds) ? b.creds : []).slice(0, MAX_CREDS).map(c => ({
    user: String(c?.user || ''), pass: String(c?.pass || ''),
    hash: String(c?.hash || ''), note: String(c?.note || '')
  }))
  const active = Number.isInteger(b.activeCred) && b.activeCred < creds.length ? b.activeCred : -1
  // undefined checklist = never set -> seed the template; an array (even []) = the user's own
  const checklist = Array.isArray(b.checklist)
    ? b.checklist.slice(0, MAX_CHECKS).map(c => ({ text: String(c?.text || '').slice(0, 200), done: !!c?.done }))
    : DEFAULT_CHECKLIST.map(c => ({ ...c }))
  return { ports: cleanPorts(b.ports), portsManual: !!b.portsManual, creds, activeCred: active, checklist }
}
ipcMain.handle('read-box', () => {
  const f = boxFile()
  return cleanBox(f ? readJson(f, {}) : {})
})
ipcMain.handle('write-box', (ev, data) => {
  const f = boxFile()
  if (!f) return false
  try { fs.writeFileSync(f, JSON.stringify(cleanBox(data), null, 2)); return true } catch { return false }
})

// Open TCP ports from every nmap XML file in this box. If a target IP is set,
// only hosts with that address count (a sweep of a whole subnet shouldn't
// pollute one box's port list) — unless no host matches, e.g. the scan was run
// against a hostname, in which case every host counts.
function parseNmapPorts(xml, targetIp) {
  const hosts = xml.split(/<host[\s>]/).slice(1)
  const portsOf = (h) => [...h.matchAll(/<port\s+protocol="tcp"\s+portid="(\d+)"\s*>\s*<state\s+state="open"/g)].map(m => +m[1])
  const matching = targetIp ? hosts.filter(h => h.includes(`addr="${targetIp}"`)) : []
  return (matching.length ? matching : hosts).flatMap(portsOf)
}
function nmapPorts() {
  const dir = path.join(outputDir() || '', 'nmap')
  if (!outputDir() || !fs.existsSync(dir)) return ''
  const ports = new Set()
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.xml')) {
        try { parseNmapPorts(fs.readFileSync(full, 'utf8'), state.target).forEach(p => ports.add(p)) } catch {}
      }
    }
  }
  try { walk(dir) } catch {}
  return [...ports].sort((a, b) => a - b).join(',')
}
ipcMain.handle('get-ports', () => nmapPorts())

// ---- command log (workspaces/<box>/commands.json) ----
// Records commands the user runs FROM Red Dash (playbook clicks, toolbox
// sends). It's intentionally not a shell-history scraper — it logs what the
// app sent, which is reliable and is what the report is built from.
const MAX_LOG = 2000
function logFile() { const d = workspaceDir(); return d ? path.join(d, 'commands.json') : '' }
ipcMain.handle('append-log', (ev, cmd) => {
  const f = logFile()
  cmd = String(cmd || '').trim()
  if (!f || !cmd) return false
  const log = readJson(f, [])
  const arr = Array.isArray(log) ? log : []
  // skip a verbatim repeat of the last command (double-clicks etc.)
  if (arr.length && arr[arr.length - 1].cmd === cmd) return true
  arr.push({ t: Date.now(), cmd })
  try { fs.writeFileSync(f, JSON.stringify(arr.slice(-MAX_LOG), null, 2)); return true } catch { return false }
})
ipcMain.handle('read-log', () => {
  const f = logFile()
  const log = f ? readJson(f, []) : []
  return Array.isArray(log) ? log : []
})
ipcMain.handle('delete-log-entry', (ev, i) => {
  const f = logFile()
  if (!f) return false
  const arr = readJson(f, [])
  if (!Array.isArray(arr) || !Number.isInteger(i) || i < 0 || i >= arr.length) return false
  arr.splice(i, 1)
  try { fs.writeFileSync(f, JSON.stringify(arr, null, 2)); return true } catch { return false }
})
ipcMain.handle('clear-log', () => {
  const f = logFile()
  if (!f) return false
  try { fs.writeFileSync(f, '[]'); return true } catch { return false }
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
      else {
        const st = fs.statSync(full)
        out.push({ name: path.relative(base, full), mtime: st.mtimeMs, size: st.size })
      }
    }
  }
  try { walk(base) } catch {}
  return out.sort((a, b) => b.mtime - a.mtime)
}
ipcMain.handle('list-output', () => listOutputFiles())
// takes a path relative to the box's output folder and refuses anything that
// resolves outside it, so the UI can't be used to read arbitrary files
ipcMain.handle('read-output', (ev, rel) => {
  const base = outputDir()
  if (!base) return 'No box selected.'
  const full = path.resolve(base, String(rel))
  if (!full.startsWith(base + path.sep)) return 'Refused: path is outside this box.'
  try { return fs.readFileSync(full, 'utf8') } catch (e) { return 'Could not read file: ' + e.message }
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

// ---- report export ----
// Pulls together everything on a box (target, ports/services, creds, checklist,
// command log, notes, loot, output files) into a Markdown / HTML / PDF write-up.
function parseNmapServices(xml, targetIp) {
  const hosts = xml.split(/<host[\s>]/).slice(1)
  const pick = targetIp ? hosts.filter(h => h.includes(`addr="${targetIp}"`)) : []
  const use = pick.length ? pick : hosts
  const out = []
  for (const h of use) {
    for (const m of h.matchAll(/<port\s+protocol="(\w+)"\s+portid="(\d+)"\s*>([\s\S]*?)<\/port>/g)) {
      const body = m[3]
      if (!/<state\s+state="open"/.test(body)) continue
      const svc = body.match(/<service\s+([^>]*?)\/?>/)
      const attr = (a) => { const r = svc && svc[1].match(new RegExp(a + '="([^"]*)"')); return r ? r[1] : '' }
      const ver = [attr('product'), attr('version'), attr('extrainfo')].filter(Boolean).join(' ')
      out.push({ port: `${m[2]}/${m[1]}`, service: attr('name'), version: ver })
    }
  }
  // de-dup by port, keep the richest row
  const byPort = {}
  for (const r of out) if (!byPort[r.port] || r.version.length > byPort[r.port].version.length) byPort[r.port] = r
  return Object.values(byPort).sort((a, b) => parseInt(a.port) - parseInt(b.port))
}
function collectReport() {
  const dir = workspaceDir()
  const b = cleanBox(dir ? readJson(boxFile(), {}) : {})
  // open services from every nmap XML in the box
  const services = []
  const seen = new Set()
  const ndir = path.join(outputDir() || '', 'nmap')
  if (outputDir() && fs.existsSync(ndir)) {
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.xml')) { try { for (const s of parseNmapServices(fs.readFileSync(full, 'utf8'), state.target)) if (!seen.has(s.port)) { seen.add(s.port); services.push(s) } } catch {} }
    } }
    try { walk(ndir) } catch {}
  }
  const log = Array.isArray(readJson(logFile(), [])) ? readJson(logFile(), []) : []
  const readFileSafe = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
  return {
    box: state.workspace || '(no box)',
    target: state.target || '', domain: state.domain || '',
    date: new Date().toISOString().slice(0, 10),
    ports: b.ports, services,
    creds: b.creds, checklist: b.checklist,
    commands: log,
    notes: dir ? readFileSafe(path.join(dir, 'notes.md')) : '',
    loot: dir ? readFileSafe(path.join(dir, 'loot.md')) : '',
    files: listOutputFiles().map(f => f.name)
  }
}
function fmtTime(ms) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') }
function reportMarkdown(d) {
  const L = []
  L.push(`# ${d.box} — engagement notes`, '')
  L.push(`- **Target:** ${d.target || '—'}${d.domain ? ` (${d.domain})` : ''}`)
  L.push(`- **Date:** ${d.date}`)
  if (d.ports) L.push(`- **Open ports:** ${d.ports}`)
  const done = d.checklist.filter(c => c.done).length
  if (d.checklist.length) L.push(`- **Progress:** ${done}/${d.checklist.length} steps done`)
  L.push('')
  if (d.services.length) {
    L.push('## Services', '', '| Port | Service | Version |', '| --- | --- | --- |')
    for (const s of d.services) L.push(`| ${s.port} | ${s.service || ''} | ${s.version || ''} |`)
    L.push('')
  }
  if (d.checklist.length) {
    L.push('## Checklist', '')
    for (const c of d.checklist) L.push(`- [${c.done ? 'x' : ' '}] ${c.text}`)
    L.push('')
  }
  if (d.creds.length) {
    L.push('## Credentials', '', '| User | Password | Hash | Note |', '| --- | --- | --- | --- |')
    for (const c of d.creds) L.push(`| ${c.user || ''} | ${c.pass || ''} | ${c.hash || ''} | ${c.note || ''} |`)
    L.push('')
  }
  if (d.commands.length) {
    L.push('## Commands run', '', '```')
    for (const e of d.commands) L.push(`${fmtTime(e.t)}  ${e.cmd}`)
    L.push('```', '')
  }
  if (d.notes.trim()) L.push('## Notes', '', d.notes.trim(), '')
  if (d.loot.trim()) L.push('## Loot', '', d.loot.trim(), '')
  if (d.files.length) { L.push('## Output files', ''); for (const f of d.files) L.push(`- \`${f}\``); L.push('') }
  L.push('---', '', '_Generated by Red Dash._')
  return L.join('\n')
}
function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) }
function reportHtml(d) {
  const row = (cells) => '<tr>' + cells.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>'
  let h = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font:13px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a22;max-width:820px;margin:32px auto;padding:0 24px}
    h1{font-size:24px;border-bottom:3px solid #ff3b5c;padding-bottom:8px}
    h2{font-size:16px;margin-top:28px;color:#c01f3c;border-bottom:1px solid #eee;padding-bottom:4px}
    table{border-collapse:collapse;width:100%;margin:8px 0;font-size:12px}
    th,td{border:1px solid #ddd;padding:6px 9px;text-align:left;vertical-align:top}
    th{background:#faf0f2}
    pre{background:#f6f6f8;border:1px solid #e3e3e8;border-radius:5px;padding:12px;font-size:11.5px;white-space:pre-wrap;word-break:break-word}
    .meta{color:#555} .done{color:#1a8a53} .todo{color:#999}
    code{background:#f2f2f5;padding:1px 4px;border-radius:3px}
    footer{margin-top:32px;color:#999;font-size:11px;border-top:1px solid #eee;padding-top:10px}
  </style></head><body>`
  h += `<h1>${esc(d.box)} — engagement notes</h1>`
  h += `<p class="meta"><b>Target:</b> ${esc(d.target || '—')}${d.domain ? ' (' + esc(d.domain) + ')' : ''}<br>`
  h += `<b>Date:</b> ${esc(d.date)}${d.ports ? '<br><b>Open ports:</b> ' + esc(d.ports) : ''}</p>`
  if (d.services.length) h += '<h2>Services</h2><table><tr><th>Port</th><th>Service</th><th>Version</th></tr>' + d.services.map(s => row([s.port, s.service, s.version])).join('') + '</table>'
  if (d.checklist.length) h += '<h2>Checklist</h2><ul>' + d.checklist.map(c => `<li class="${c.done ? 'done' : 'todo'}">${c.done ? '✓' : '☐'} ${esc(c.text)}</li>`).join('') + '</ul>'
  if (d.creds.length) h += '<h2>Credentials</h2><table><tr><th>User</th><th>Password</th><th>Hash</th><th>Note</th></tr>' + d.creds.map(c => row([c.user, c.pass, c.hash, c.note])).join('') + '</table>'
  if (d.commands.length) h += '<h2>Commands run</h2><pre>' + d.commands.map(e => esc(fmtTime(e.t) + '  ' + e.cmd)).join('\n') + '</pre>'
  if (d.notes.trim()) h += '<h2>Notes</h2><pre>' + esc(d.notes.trim()) + '</pre>'
  if (d.loot.trim()) h += '<h2>Loot</h2><pre>' + esc(d.loot.trim()) + '</pre>'
  if (d.files.length) h += '<h2>Output files</h2><ul>' + d.files.map(f => `<li><code>${esc(f)}</code></li>`).join('') + '</ul>'
  h += '<footer>Generated by Red Dash</footer></body></html>'
  return h
}
ipcMain.handle('build-report', () => (state.workspace ? reportMarkdown(collectReport()) : ''))
ipcMain.handle('export-report', async (ev, format) => {
  const dir = workspaceDir()
  if (!dir) return { ok: false, error: 'No box selected' }
  const data = collectReport()
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)
  const base = `report-${data.box}-${stamp}`
  try {
    if (format === 'md') {
      const p = path.join(dir, base + '.md')
      fs.writeFileSync(p, reportMarkdown(data)); return { ok: true, path: p }
    }
    if (format === 'html') {
      const p = path.join(dir, base + '.html')
      fs.writeFileSync(p, reportHtml(data)); return { ok: true, path: p }
    }
    if (format === 'pdf') {
      const tmp = path.join(dir, '.' + base + '.tmp.html')
      fs.writeFileSync(tmp, reportHtml(data))
      const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true } })
      await w.loadFile(tmp)
      const pdf = await w.webContents.printToPDF({ printBackground: true })
      try { w.destroy() } catch {}
      try { fs.unlinkSync(tmp) } catch {}
      const p = path.join(dir, base + '.pdf')
      fs.writeFileSync(p, pdf); return { ok: true, path: p }
    }
    return { ok: false, error: 'Unknown format' }
  } catch (e) { return { ok: false, error: e.message } }
})

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
  burpsuite:    { bins: ['burpsuite', 'burpsuite-pro'], any: true, note: 'download from portswigger.net/burp   # or AUR: yay -S burpsuite' },
  kerbrute:     { bins: ['kerbrute'], note: 'go install github.com/ ... /kerbrute@latest   # or a release from github.com/ropnop/kerbrute' },
  bloodhound:   { bins: ['bloodhound-python'], note: 'pipx install bloodhound' },
  // privesc / winpe are "run on the victim" helpers (linpeas, winPEAS, sudo -l,
  // whoami) — nothing for the attacker box to install, so don't nag about them.
  privesc:      { skip: true },
  winpe:        { skip: true },
  // pivoting tools you usually drop onto the victim (chisel, ligolo) or that are
  // already present (ssh) — only sshuttle is worth an install hint.
  pivot:        { bins: ['sshuttle'], pkg: 'sshuttle', note: 'chisel / ligolo: drop a release binary on the victim' }
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
