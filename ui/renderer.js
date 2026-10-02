const { ipcRenderer } = require('electron')

// ---------- TERMINAL ----------
const term = new Terminal({
  cursorBlink: true,
  fontSize: 15,
  fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
  theme: { background: '#15151b', foreground: '#e6e6ee' }
})
const fit = new FitAddon.FitAddon()
term.loadAddon(fit)
term.open(document.getElementById('terminal'))
fit.fit()

term.onData(d => ipcRenderer.send('term-in', d))
ipcRenderer.on('term-out', (e, d) => term.write(d))
ipcRenderer.send('term-ready')

// Ctrl+Shift+C always copies the selection; plain Ctrl+C copies instead of
// sending SIGINT only when there's a selection (matches gnome-terminal/VS
// Code convention) so it doesn't interrupt a running command by accident.
term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown' || !e.ctrlKey || e.key.toLowerCase() !== 'c') return true
  if (!term.hasSelection()) return true
  ipcRenderer.invoke('copy-text', term.getSelection())
  return false
})

function doFit() {
  try { fit.fit(); ipcRenderer.send('term-resize', { cols: term.cols, rows: term.rows }) } catch {}
}
window.addEventListener('resize', doFit)
setTimeout(doFit, 300)

// ---------- STATE ----------
let target = { target: '', domain: '', workspace: '' }
let currentOutDir = ''
const DEFAULTS = {
  WORDLIST: '/usr/share/seclists/Discovery/Web-Content/common.txt',
  SUBLIST: '/usr/share/seclists/Discovery/DNS/subdomains-top1million-5000.txt',
  PORTS: ''
}

// ---------- TARGET BAR ----------
const inTarget = document.getElementById('in-target')
const inDomain = document.getElementById('in-domain')
async function loadTarget() {
  target = await ipcRenderer.invoke('get-target')
  inTarget.value = target.target || ''
  inDomain.value = target.domain || ''
  updateBrand()
}
function updateBrand() {
  const b = document.querySelector('.brand')
  const t = target.target || target.domain
  b.textContent = t ? 'RED DASH  →  ' + t : 'RED DASH'
}
document.getElementById('btn-set-target').onclick = async () => {
  target = await ipcRenderer.invoke('set-target', {
    target: inTarget.value.trim(), domain: inDomain.value.trim()
  })
  updateBrand(); renderExamples()
}

// ---------- WORKSPACES ----------
const selWs = document.getElementById('sel-workspace')
async function loadWorkspaces() {
  const list = await ipcRenderer.invoke('list-workspaces')
  selWs.innerHTML = '<option value="">— pick a box —</option>'
  for (const w of list) {
    const o = document.createElement('option')
    o.value = w; o.textContent = w
    if (w === target.workspace) o.selected = true
    selWs.appendChild(o)
  }
}
function updateDeleteBtn() {
  document.getElementById('btn-delete-workspace').disabled = !target.workspace
}
selWs.onchange = async () => {
  if (!selWs.value) return
  const res = await ipcRenderer.invoke('set-workspace', selWs.value)
  currentOutDir = res.outputDir
  target.workspace = res.workspace
  updateDeleteBtn()
  refreshOutput(); renderExamples()
  if (activeTab !== 'output') loadNote(activeTab)
}
const newboxModal = document.getElementById('modal-newbox')
const newboxName = document.getElementById('newbox-name')
async function createWorkspace() {
  const name = newboxName.value.trim()
  newboxModal.classList.add('hidden')
  if (!name) return
  const safe = await ipcRenderer.invoke('new-workspace', name)
  await loadWorkspaces()
  selWs.value = safe
  selWs.onchange()
}
document.getElementById('btn-new-workspace').onclick = () => {
  newboxName.value = ''
  newboxModal.classList.remove('hidden')
  newboxName.focus()
}
document.getElementById('newbox-create').onclick = createWorkspace
document.getElementById('newbox-cancel').onclick = () => newboxModal.classList.add('hidden')
newboxName.addEventListener('keydown', (e) => { if (e.key === 'Enter') createWorkspace() })

// ---------- DELETE BOX ----------
const deleteModal = document.getElementById('modal-delete')
document.getElementById('btn-delete-workspace').onclick = () => {
  if (!target.workspace) return
  document.getElementById('delete-warning').textContent =
    `This permanently deletes workspaces/${target.workspace} — all its output, notes, and loot. This cannot be undone.`
  deleteModal.classList.remove('hidden')
}
document.getElementById('delete-cancel').onclick = () => deleteModal.classList.add('hidden')
document.getElementById('delete-confirm').onclick = async () => {
  const name = target.workspace
  deleteModal.classList.add('hidden')
  await ipcRenderer.invoke('delete-workspace', name)
  target.workspace = ''
  currentOutDir = ''
  selWs.value = ''
  updateDeleteBtn()
  await loadWorkspaces()
  refreshOutput(); renderExamples()
  if (activeTab !== 'output') loadNote(activeTab)
}

// ---------- RELOAD ----------
document.getElementById('btn-reload').onclick = () => location.reload()

// ---------- VPN STATUS (HTB/THM openvpn or wireguard) ----------
async function checkVpn() {
  const v = await ipcRenderer.invoke('check-vpn')
  const el = document.getElementById('vpn-status')
  if (v.connected) {
    el.className = 'chip ok'
    el.textContent = `✓ ${v.ip}`
    el.title = `${v.iface} — click to copy IP`
    el.onclick = () => ipcRenderer.invoke('copy-text', v.ip)
  } else {
    el.className = 'chip bad'
    el.textContent = '✗ not connected'
    el.title = 'No tun/tap/wg interface found — connect your HTB/THM VPN'
    el.onclick = null
  }
}
setInterval(checkVpn, 3000)

// ---------- ENV CHECK (tools + seclists) ----------
let envPollTimer = null

async function checkEnv() {
  const env = await ipcRenderer.invoke('check-env')
  const dismissed = new Set(env.dismissed || [])
  let allGood = true

  // tools chips (incl. SecLists) — only show what's still missing and not
  // dismissed; found/dismissed tools drop off the strip
  const chips = document.getElementById('chips')
  chips.innerHTML = ''
  for (const [name, ok] of Object.entries(env.tools)) {
    if (ok) continue
    if (dismissed.has(name)) continue
    allGood = false
    const c = document.createElement('span')
    c.className = 'chip bad'
    c.title = 'Click for the install command'
    c.textContent = '✗ ' + name
    c.onclick = () => showHint(env.hints[name] || ('install ' + name))

    const x = document.createElement('span')
    x.className = 'chip-dismiss'
    x.textContent = '×'
    x.title = "Don't ask about " + name + ' again'
    x.onclick = async (e) => {
      e.stopPropagation()
      await ipcRenderer.invoke('dismiss-tool', name)
      checkEnv()
    }
    c.appendChild(x)
    chips.appendChild(c)
  }

  if (env.wordlist) DEFAULTS.WORDLIST = env.wordlist
  if (env.sublist) DEFAULTS.SUBLIST = env.sublist

  const btnUndismiss = document.getElementById('btn-undismiss')
  const dismissedCount = (env.dismissed || []).length
  btnUndismiss.classList.toggle('hidden', dismissedCount === 0)
  btnUndismiss.textContent = `Show dismissed (${dismissedCount})`

  // whole setup strip disappears once everything is found or dismissed
  document.getElementById('status-strip').classList.toggle('hidden', allGood)

  if (allGood) stopEnvPolling()
  renderExamples()
}

// real-time: keep re-checking in the background so chips clear themselves
// the moment an install finishes, without needing a manual Re-check click
function startEnvPolling() {
  if (envPollTimer) return
  envPollTimer = setInterval(checkEnv, 4000)
}
function stopEnvPolling() {
  if (!envPollTimer) return
  clearInterval(envPollTimer)
  envPollTimer = null
}
function showHint(cmd) {
  const bar = document.getElementById('hint-bar')
  document.getElementById('hint-text').textContent = cmd
  bar.classList.remove('hidden')
  const copyBtn = document.getElementById('hint-copy')
  copyBtn.onclick = async () => {
    const ok = await ipcRenderer.invoke('copy-text', cmd)
    const original = 'Copy command'
    copyBtn.textContent = ok ? 'Copied!' : 'Copy failed'
    setTimeout(() => { copyBtn.textContent = original }, 1200)
  }
}
document.getElementById('hint-close').onclick = () =>
  document.getElementById('hint-bar').classList.add('hidden')
document.getElementById('btn-recheck').onclick = () => { checkEnv(); startEnvPolling() }
document.getElementById('btn-undismiss').onclick = async () => {
  await ipcRenderer.invoke('undismiss-tools')
  checkEnv(); startEnvPolling()
}

// ---------- EXAMPLES ----------
let allExamples = []
async function loadExamples() {
  allExamples = await ipcRenderer.invoke('get-examples')
  renderExamples()
}
function fillVars(cmd) {
  return cmd
    .replaceAll('{TARGET}', target.target || '{TARGET}')
    .replaceAll('{DOMAIN}', target.domain || '{DOMAIN}')
    .replaceAll('{OUT}', currentOutDir || 'output')
    .replaceAll('{WORDLIST}', DEFAULTS.WORDLIST)
    .replaceAll('{SUBLIST}', DEFAULTS.SUBLIST)
    .replaceAll('{PORTS}', DEFAULTS.PORTS || '{PORTS}')
}
function renderExamples() {
  const box = document.getElementById('examples')
  box.innerHTML = ''
  const groups = {}
  for (const ex of allExamples) { (groups[ex.tool] = groups[ex.tool] || []).push(ex) }
  for (const tool of Object.keys(groups)) {
    const g = document.createElement('div')
    g.className = 'tool-group'
    g.innerHTML = `<div class="tool-title">${esc(tool)}</div>`
    for (const ex of groups[tool]) {
      const cmd = fillVars(ex.command)
      const el = document.createElement('div')
      el.className = 'ex'
      el.innerHTML = `
        <div class="ex-name">${ex.mine ? '<span class="star">★</span> ' : ''}${esc(ex.name)}</div>
        <div class="ex-cmd">${esc(cmd)}</div>
        ${ex.note ? `<div class="ex-note">${esc(ex.note)}</div>` : ''}`
      el.onclick = () => ipcRenderer.send('term-insert', cmd)
      g.appendChild(el)
    }
    box.appendChild(g)
  }
}

// ---------- ADD EXAMPLE ----------
const modal = document.getElementById('modal')
document.getElementById('btn-add-example').onclick = () => modal.classList.remove('hidden')
document.getElementById('ex-cancel').onclick = () => modal.classList.add('hidden')
document.getElementById('ex-save').onclick = async () => {
  const ex = {
    tool: document.getElementById('ex-tool').value.trim() || 'other',
    name: document.getElementById('ex-name').value.trim() || 'My command',
    command: document.getElementById('ex-cmd').value.trim(),
    note: document.getElementById('ex-note').value.trim()
  }
  if (!ex.command) return
  await ipcRenderer.invoke('add-example', ex)
  modal.classList.add('hidden')
  document.getElementById('ex-cmd').value = ''
  document.getElementById('ex-name').value = ''
  document.getElementById('ex-note').value = ''
  loadExamples()
}

// ---------- OUTPUT ----------
async function refreshOutput() {
  const list = await ipcRenderer.invoke('list-output')
  const box = document.getElementById('output-list')
  box.innerHTML = ''
  if (!list.length) {
    box.innerHTML = '<div class="out-file" style="color:#9a9ab0">No output yet. Run a scan into this box.</div>'
    return
  }
  for (const f of list) {
    const el = document.createElement('div')
    el.className = 'out-file'
    const when = new Date(f.mtime).toLocaleTimeString()
    el.innerHTML = `${esc(f.name)} <span class="t">${esc(when)}</span>`
    el.onclick = async () => {
      const txt = await ipcRenderer.invoke('read-output', f.path)
      const view = document.getElementById('output-view')
      const summary = buildSummary(f.name, txt)
      showOutputView(view, summary, txt)
    }
    box.appendChild(el)
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}
function renderNmapTable(xmlText) {
  let doc
  try { doc = new DOMParser().parseFromString(xmlText, 'text/xml') }
  catch { return 'Could not read this scan file.' }
  const hosts = [...doc.querySelectorAll('host')]
  if (!hosts.length) return 'No hosts yet (scan may still be running).'
  let html = ''
  for (const h of hosts) {
    const addr = h.querySelector('address')?.getAttribute('addr') || '?'
    const ports = [...h.querySelectorAll('port')]
      .filter(p => p.querySelector('state')?.getAttribute('state') === 'open')
    html += `<div class="nmap-host">${esc(addr)}</div>`
    if (!ports.length) { html += '<div class="dim">No open ports found.</div>'; continue }
    html += '<table class="nmap-table"><thead><tr><th>Port</th><th>Service</th><th>Version</th></tr></thead><tbody>'
    for (const p of ports) {
      const portid = p.getAttribute('portid')
      const proto = p.getAttribute('protocol')
      const svc = p.querySelector('service')
      const name = svc?.getAttribute('name') || ''
      const product = svc?.getAttribute('product') || ''
      const version = svc?.getAttribute('version') || ''
      const extra = svc?.getAttribute('extrainfo') || ''
      const ver = [product, version, extra].filter(Boolean).join(' ')
      html += `<tr><td>${esc(portid)}/${esc(proto)}</td><td>${esc(name)}</td><td>${esc(ver)}</td></tr>`
    }
    html += '</tbody></table>'
  }
  return html
}

// ---- per-tool "just the findings" summaries ----
// Returns an HTML summary string, or null to fall back to the raw file (unknown
// format, custom command, or a format that didn't match what was expected).
function buildSummary(relPath, txt) {
  const tool = relPath.split('/')[0]
  if (relPath.endsWith('.xml') && txt.includes('<nmaprun')) return renderNmapTable(txt)
  if (tool === 'ffuf' && relPath.toLowerCase().endsWith('.json')) return renderFfuf(txt)
  if (tool === 'gobuster') return renderGobuster(txt)
  if (tool === 'feroxbuster') return renderFerox(txt)
  if (tool === 'nikto') return renderPrefixFindings(txt, l => l.startsWith('+ '))
  if (tool === 'wpscan') return renderPrefixFindings(txt, l => l.startsWith('[+]') || l.startsWith('[!]'))
  if (tool === 'whatweb') return renderWhatweb(txt)
  return null
}
function buildTable(headers, rows) {
  if (!rows.length) return '<div class="dim">Nothing found yet (scan may still be running, or everything was filtered).</div>'
  let html = '<table class="out-table"><thead><tr>' + headers.map(h => `<th>${esc(h)}</th>`).join('') + '</tr></thead><tbody>'
  for (const r of rows) html += '<tr>' + r.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>'
  html += '</tbody></table>'
  return html
}
function renderFfuf(txt) {
  let data
  try { data = JSON.parse(txt) } catch { return null }
  const rows = (data.results || []).map(r => {
    let display = r.url || r.input?.FUZZ || ''
    // Vhost fuzzing (-H 'Host: FUZZ...') keeps `url` constant across every
    // result; the actual discovered subdomain only shows up in `host`.
    if (r.host) {
      try {
        if (new URL(r.url).hostname !== r.host) display = r.host
      } catch { if (r.host !== r.url) display = r.host }
    }
    return [r.status, r.length, display]
  })
  return buildTable(['Status', 'Size', 'URL / Host'], rows)
}
function renderGobuster(txt) {
  const re = /^(.+?)\s+\(Status:\s*(\d+)\)\s*\[Size:\s*(\d+)\]/
  const rows = []
  for (const line of txt.split('\n')) {
    const m = line.match(re)
    if (m) rows.push([m[1].replace(/^Found:\s*/, '').trim(), m[2], m[3]])
  }
  if (!rows.length) return null
  return buildTable(['Found', 'Status', 'Size'], rows)
}
function renderFerox(txt) {
  const re = /^(\d{3})\s+\S+\s+\d+l\s+\d+w\s+(\d+)c\s+(\S+)/
  const rows = []
  for (const line of txt.split('\n')) {
    const m = line.match(re)
    if (m) rows.push([m[1], m[2], m[3]])
  }
  if (!rows.length) return null
  return buildTable(['Status', 'Size', 'URL'], rows)
}
function renderPrefixFindings(txt, matchFn) {
  const lines = txt.split('\n').map(l => l.trim()).filter(matchFn)
  if (!lines.length) return null
  return '<ul class="finding-list">' + lines.map(l => `<li>${esc(l)}</li>`).join('') + '</ul>'
}
function renderWhatweb(txt) {
  const tags = [...txt.matchAll(/([A-Za-z][\w\-]*)\[([^\]]*)\]/g)]
  if (!tags.length) return null
  return '<ul class="finding-list">' + tags.map(([, k, v]) => `<li><b>${esc(k)}</b>: ${esc(v || '(detected)')}</li>`).join('') + '</ul>'
}
function showOutputView(view, summary, raw) {
  if (!summary) { view.textContent = raw; return }
  view.innerHTML = summary + '<div class="out-toggle"><a href="#">Show raw output</a></div>'
  view.querySelector('.out-toggle a').onclick = (e) => {
    e.preventDefault()
    view.textContent = raw
    const back = document.createElement('div')
    back.className = 'out-toggle'
    back.innerHTML = '<a href="#">Show summary</a>'
    back.querySelector('a').onclick = (e2) => { e2.preventDefault(); showOutputView(view, summary, raw) }
    view.appendChild(back)
  }
}
document.getElementById('btn-refresh-output').onclick = refreshOutput
ipcRenderer.on('output-changed', refreshOutput)

// ---------- NOTES / LOOT TABS ----------
let activeTab = 'output'
const tabButtons = {
  output: document.getElementById('tab-output'),
  notes: document.getElementById('tab-notes'),
  loot: document.getElementById('tab-loot')
}
const outputListEl = document.getElementById('output-list')
const outputViewEl = document.getElementById('output-view')
const notesView = document.getElementById('notes-view')
const lootView = document.getElementById('loot-view')
const saveBar = document.getElementById('note-save-bar')
const refreshOutputBtn = document.getElementById('btn-refresh-output')
const savedMsg = document.getElementById('note-saved-msg')

async function loadNote(type) {
  const txt = await ipcRenderer.invoke('read-note', type)
  ;(type === 'notes' ? notesView : lootView).value = txt
}
function switchTab(tab) {
  activeTab = tab
  for (const [k, btn] of Object.entries(tabButtons)) btn.classList.toggle('active', k === tab)
  outputListEl.classList.toggle('hidden', tab !== 'output')
  outputViewEl.classList.toggle('hidden', tab !== 'output')
  notesView.classList.toggle('hidden', tab !== 'notes')
  lootView.classList.toggle('hidden', tab !== 'loot')
  refreshOutputBtn.classList.toggle('hidden', tab !== 'output')
  saveBar.classList.toggle('hidden', tab === 'output')
  if (tab !== 'output') loadNote(tab)
}
tabButtons.output.onclick = () => switchTab('output')
tabButtons.notes.onclick = () => switchTab('notes')
tabButtons.loot.onclick = () => switchTab('loot')
document.getElementById('btn-save-note').onclick = async () => {
  if (activeTab === 'output') return
  const text = (activeTab === 'notes' ? notesView : lootView).value
  await ipcRenderer.invoke('write-note', activeTab, text)
  savedMsg.classList.remove('hidden')
  setTimeout(() => savedMsg.classList.add('hidden'), 1200)
}

// ---------- INIT ----------
;(async () => {
  checkVpn()
  await loadTarget()
  await loadWorkspaces()
  if (target.workspace) {
    const res = await ipcRenderer.invoke('set-workspace', target.workspace)
    currentOutDir = res.outputDir
  }
  updateDeleteBtn()
  await checkEnv()
  startEnvPolling()
  await loadExamples()
  refreshOutput()
})()
