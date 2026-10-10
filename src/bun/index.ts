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
  } catch {
  }
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

ApplicationMenu.setApplicationMenu([
  { label: "OverSteer", submenu: [{ role: "quit" }] },
])

const mainWindow = new BrowserWindow({
  title: "OverSteer",
  url,
  frame: {
    width: 900,
    height: 700,
  },
  styleMask: {
    Miniaturizable: false,
  },
})

const MACOS_ESCAPE_KEYCODE = 53

mainWindow.on("keyDown", (event: any) => {
  const data = event?.data ?? event
  if (data?.keyCode !== MACOS_ESCAPE_KEYCODE) return

  try {
    mainWindow.webview.executeJavascript(
      `document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }));
       document.dispatchEvent(new KeyboardEvent('keyup',   { code: 'Escape', key: 'Escape', bubbles: true }));`,
    )
  } catch {}

  try {
    if (!mainWindow.isFullScreen()) {
      if (mainWindow.isMinimized()) mainWindow.unminimize()
      mainWindow.setFullScreen(true)
    }
  } catch {}
})

mainWindow.setFullScreen(true)

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

console.log("OverSteer started!")
