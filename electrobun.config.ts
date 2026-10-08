import type { ElectrobunConfig } from "electrobun"

export default {
  app: {
    name: "OverSteer",
    identifier: "dev.oversteer.game",
    version: "1.0",
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
