// Launch the Electron agent. Strips ELECTRON_RUN_AS_NODE (some shells export it,
// which would force Electron into plain-Node mode and break the Electron APIs).
const { spawn } = require('node:child_process')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const electronBinary = require('electron') // path string in a Node context
const child = spawn(electronBinary, ['.'], { stdio: 'inherit', env })
child.on('close', (code) => process.exit(code ?? 0))
