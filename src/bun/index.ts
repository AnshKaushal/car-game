import { ApplicationMenu, BrowserWindow, Updater } from "electrobun/main"

const DEV_SERVER_PORT = 5173
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`

// Update watchdog: some updaters hang while offline, and we never want the
// game launch to stall on one. Either the operation finishes in time or we
// boot the installed version and try again next launch.
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

// Silent auto-update: check the release feed at startup, and if a newer
// build is published, download it and hand off (the updater replaces the app
// and relaunches it, so code below never runs for the old version).
// Runs before the window opens, only for installed builds, never in dev.
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
    // Offline, no feed, or anything else: boot the installed version.
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

// Native app menu: without one, macOS has no Quit item, so Cmd+Q does
// nothing. The Quit role gets the standard Cmd+Q binding automatically.
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
  // Esc drops fullscreen and macOS sometimes minimizes the window along
  // with it. Restore it first so the pause menu is actually visible.
  try {
    if (mainWindow.isMinimized()) mainWindow.unminimize()
  } catch {}
  // Re-enter fullscreen only once the exit has settled. Requesting it
  // mid-transition is what glitched the window into the dock.
  if (now - fullscreenLostAt < 2500) return
  if (now - lastRefullscreen < 2000) return
  lastRefullscreen = now
  try {
    mainWindow.setFullScreen(true)
  } catch {}
}, 500)

console.log("OverSteer started!")
