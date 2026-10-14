import { ApplicationMenu, BrowserWindow, Updater } from "electrobun/main"

const DEV_SERVER_PORT = 5173
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms)
      }),
    ])
  } catch {
    return null
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function autoUpdate(): Promise<void> {
  let channel = ""
  try {
    channel = await Updater.localInfo.channel()
  } catch {
    return
  }
  if (channel === "dev") return
  try {
    Updater.onStatusChange((entry) => {
      console.log(`[update] ${entry.status}: ${entry.message}`)
    })
    const info = await withTimeout(Updater.checkForUpdate(), 8000)
    if (!info || info.error || !info.updateAvailable) return
    console.log(`[update] version ${info.version} available, downloading`)
    const downloaded = await withTimeout(
      Updater.downloadUpdate(),
      10 * 60 * 1000,
    )
    if (downloaded === null) return
    const fresh = await Updater.checkForUpdate()
    if (fresh.updateReady && !fresh.error) {
      console.log("[update] applying, relaunching on the new version")
      await Updater.applyUpdate()
    }
  } catch {}
}

await autoUpdate()

async function getMainViewUrl(): Promise<string> {
  const channel = await Updater.localInfo.channel()
  if (channel === "dev") {
    try {
      await fetch(DEV_SERVER_URL, { method: "HEAD" })
      console.log(`HMR enabled: Using Vite dev server at ${DEV_SERVER_URL}`)
      return DEV_SERVER_URL
    } catch {
      console.log(
        "Vite dev server not running. Run 'hutch run dev:hmr' for HMR support.",
      )
    }
  }
  return "views://mainview/index.html"
}

const url = await getMainViewUrl()

import os from "os"

function getLocalIp(): string {
  try {
    const nets = os.networkInterfaces()
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === "IPv4" && !net.internal) {
          return net.address
        }
      }
    }
  } catch {}
  return "127.0.0.1"
}

// Built-in zero-config LAN WebSocket relay server on port 9876
const LAN_PORT = 9876
const lanClients = new Set<any>()

try {
  Bun.serve({
    port: LAN_PORT,
    fetch(req, server) {
      try {
        if (req.method === "OPTIONS") {
          return new Response(null, {
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type",
            },
          })
        }
      } catch {}
      if (server.upgrade(req)) return undefined
      return new Response(
        `OverSteer LAN Relay Server (${getLocalIp()}:${LAN_PORT})`,
        { status: 200 },
      )
    },
    websocket: {
      open(ws) {
        lanClients.add(ws)
      },
      message(ws, msg) {
        const text = typeof msg === "string" ? msg : msg.toString()
        for (const c of lanClients) {
          if (c === ws) continue
          try {
            c.send(text)
          } catch {}
        }
      },
      close(ws) {
        lanClients.delete(ws)
      },
    },
  })
  console.log(`[LAN Relay] Server running on ws://${getLocalIp()}:${LAN_PORT}`)
} catch {
  console.log(
    `[LAN Relay] Port ${LAN_PORT} in use or already bound by host instance`,
  )
}

const isWindowed =
  process.argv.includes("--windowed") ||
  process.argv.includes("-w") ||
  process.env.OVERSTEER_WINDOWED === "1"

const openWindows: BrowserWindow[] = []

function createWindow(winUrl: string, windowed = isWindowed) {
  console.log(`[Window] Creating window (windowed=${windowed}) -> ${winUrl}`)
  const win = new BrowserWindow({
    title: "OverSteer",
    url: winUrl,
    frame: {
      width: windowed ? 1024 : 900,
      height: windowed ? 680 : 700,
    },
    styleMask: {
      Miniaturizable: true,
      Resizable: true,
      FullSizeContentView: !windowed,
    },
  })

  openWindows.push(win)

  if (!windowed) {
    try {
      win.setFullScreen(true)
    } catch {}
  }

  return win
}

ApplicationMenu.setApplicationMenu([
  {
    label: "OverSteer",
    submenu: [
      {
        label: "Toggle Fullscreen",
        action: "toggle-fullscreen",
        accelerator: "CmdOrCtrl+F",
      },
      { role: "quit" },
    ],
  },
  {
    // Restores native clipboard shortcuts (Cmd+C/V/X, Ctrl+V, select all)
    // in lobby inputs. Without an Edit menu the webview has no
    // paste/cut/copy selectors and keyboard paste silently does nothing.
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  },
  {
    label: "Window",
    submenu: [
      {
        label: "Toggle Fullscreen",
        action: "toggle-fullscreen",
      },
    ],
  },
])

ApplicationMenu.on("application-menu-clicked", (event: any) => {
  const data = event?.data ?? event
  const action = data?.action
  console.log("[Menu Action Triggered]:", action)
  if (action === "toggle-fullscreen") {
    try {
      mainWindow.setFullScreen(!mainWindow.isFullScreen())
    } catch {}
  }
})

const mainWindow = createWindow(url, isWindowed)

const MACOS_ESCAPE_KEYCODE = 53

let lastEscapeAt = 0

mainWindow.on("keyDown", (event: any) => {
  const data = event?.data ?? event
  if (data?.keyCode !== MACOS_ESCAPE_KEYCODE) return
  if (data?.isRepeat) return

  const now = Date.now()
  const isDouble = now - lastEscapeAt < 500
  lastEscapeAt = now

  if (isDouble) {
    try {
      if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false)
    } catch {}
    try {
      mainWindow.minimize()
    } catch {}
    return
  }

  try {
    mainWindow.webview.executeJavascript(
      `document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }));
       document.dispatchEvent(new KeyboardEvent('keyup',   { code: 'Escape', key: 'Escape', bubbles: true }));`,
    )
  } catch {}

  if (!isWindowed) {
    try {
      if (!mainWindow.isFullScreen()) {
        if (mainWindow.isMinimized()) mainWindow.unminimize()
        mainWindow.setFullScreen(true)
      }
    } catch {}
  }
})

if (!isWindowed) {
  let lastRefullscreen = 0
  let fullscreenLostAt = 0
  setInterval(() => {
    let full = true
    try {
      full = mainWindow.isFullScreen()
    } catch {
      return
    }
    const now = Date.now()
    if (full) {
      fullscreenLostAt = 0
      return
    }
    if (!fullscreenLostAt) fullscreenLostAt = now
    try {
      if (mainWindow.isMinimized()) mainWindow.unminimize()
    } catch {}
    if (now - fullscreenLostAt < 600) return
    if (now - lastRefullscreen < 800) return
    lastRefullscreen = now
    try {
      mainWindow.setFullScreen(true)
    } catch {}
  }, 200)
}

console.log(
  `OverSteer started! (${isWindowed ? "Windowed Mode" : "Fullscreen Mode"})`,
)
