import { ApplicationMenu, BrowserWindow, GlobalShortcut, Updater } from "electrobun/main"
import os from "os"

const DEV_SERVER_PORT = 5173
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`
const LAN_PORT = 9876

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

const lanClients = new Set<any>()

try {
  Bun.serve({
    port: LAN_PORT,

    fetch(req, server) {
      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        })
      }

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
        const message = typeof msg === "string" ? msg : msg.toString()

        for (const client of lanClients) {
          if (client === ws) continue

          try {
            client.send(message)
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
      width: windowed ? 1024 : 1440,
      height: windowed ? 680 : 900,
    },
    styleMask: {
      Miniaturizable: true,
      Resizable: true,
      FullSizeContentView: false,
    },
  })

  openWindows.push(win)

  if (!windowed) {
    win.setFullScreen(true)
  }

  return win
}

if (process.platform === "win32") {
  ApplicationMenu.setApplicationMenu([])
} else {
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
}

const url = await getMainViewUrl()
const mainWindow = createWindow(url, isWindowed)

let wantFullscreen = !isWindowed

ApplicationMenu.on("application-menu-clicked", (event: any) => {
  const data = event?.data ?? event

  if (data?.action !== "toggle-fullscreen") return

  wantFullscreen = !wantFullscreen
  mainWindow.setFullScreen(wantFullscreen)
})

if (process.platform === "win32") {
  try {
    GlobalShortcut.register("F11", () => {
      try {
        if (mainWindow.isFullScreen()) {
          wantFullscreen = false
          mainWindow.setFullScreen(false)
        }
      } catch {}
    })
  } catch {}
}

console.log(
  `OverSteer started! (${isWindowed ? "Windowed Mode" : "Fullscreen Mode"})`,
)
