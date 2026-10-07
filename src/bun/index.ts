import { BrowserWindow, Updater } from "electrobun/main"

const DEV_SERVER_PORT = 5173
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`

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
setInterval(() => {
  let full = true
  try {
    full = mainWindow.isFullScreen()
  } catch {
    return
  }
  if (full || Date.now() - lastRefullscreen < 2000) return
  lastRefullscreen = Date.now()
  try {
    mainWindow.setFullScreen(true)
  } catch {}
}, 500)

console.log("OverSteer started!")
