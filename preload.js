// Bridge between the sandboxed UI and the main process. The renderer has no
// Node access — it can only reach the channels listed here, so a malicious
// string that somehow ran in the page still couldn't touch the filesystem or
// spawn processes directly.
const { contextBridge, ipcRenderer } = require('electron')

const INVOKE = [
  'get-examples', 'add-example', 'delete-example',
  'get-target', 'set-target',
  'list-workspaces', 'new-workspace', 'set-workspace', 'delete-workspace',
  'read-note', 'write-note',
  'list-output', 'read-output',
  'check-env', 'check-vpn', 'dismiss-tool', 'undismiss-tools',
  'copy-text', 'app-info'
]
const SEND = ['term-ready', 'term-in', 'term-insert', 'term-resize']
const LISTEN = ['term-out', 'output-changed']

contextBridge.exposeInMainWorld('api', {
  invoke: (ch, ...args) => {
    if (!INVOKE.includes(ch)) throw new Error('blocked channel: ' + ch)
    return ipcRenderer.invoke(ch, ...args)
  },
  send: (ch, ...args) => {
    if (!SEND.includes(ch)) throw new Error('blocked channel: ' + ch)
    ipcRenderer.send(ch, ...args)
  },
  on: (ch, fn) => {
    if (!LISTEN.includes(ch)) throw new Error('blocked channel: ' + ch)
    ipcRenderer.on(ch, (e, ...args) => fn(...args))
  }
})
