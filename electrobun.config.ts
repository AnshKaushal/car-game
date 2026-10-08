import type { ElectrobunConfig } from "electrobun"

export default {
  app: {
    name: "OverSteer",
    identifier: "dev.oversteer.game",
    version: "1.0",
  },
  release: {
    // Update feed for in-app auto-updates. The updater fetches
    // `<baseUrl>/<channel>-<platform>-<arch>-update.json`, which GitHub serves
    // from the latest release's assets (updater files keep stable names).
    // Also enables delta-patch generation during the build.
    baseUrl: "https://github.com/AnshKaushal/car-game/releases/latest/download",
  },
  build: {
    mainProcess: "cottontail",
    cottontail: {
      entrypoint: "src/bun/index.ts",
    },
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
      "dist/icon.png": "views/mainview/icon.png",
      "dist/models": "views/mainview/models",
    },
    watchIgnore: ["dist/**"],
    mac: {
      bundleCEF: false,
      icons: "icon.iconset",
    },
    linux: {
      bundleCEF: false,
      icon: "src/mainview/public/icon-256.png",
    },
    win: {
      bundleCEF: false,
      icon: "src/mainview/public/icon-256.png",
    },
  },
} satisfies ElectrobunConfig
