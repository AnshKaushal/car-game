import type { ElectrobunConfig } from "electrobun"

export default {
  app: {
    name: "Car Game",
    identifier: "car.game.dev",
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
    },
    watchIgnore: ["dist/**"],
    mac: {
      bundleCEF: false,
    },
    linux: {
      bundleCEF: false,
    },
    win: {
      bundleCEF: false,
    },
  },
} satisfies ElectrobunConfig
