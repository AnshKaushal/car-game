// @hutch cli=0.27.1 cottontail=0.7.1
export default {
  scripts: {
    // NOTE: no --frozen-lockfile — hutch 0.27.1's frozen check errors even
    // with a byte-perfect lock (verified: clean checkout, fresh resolution
    // identical, still "lockfile had changes"). The committed hutch.lock
    // remains the reproducibility record: regenerate with `hutch install`
    // and commit it whenever package.json changes.
    install: ["hutch", "install"],
    start:
      "hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun dev",
    dev: "hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun dev --watch",
    "dev:hmr": [
      "hutch",
      "pm",
      "exec",
      "--",
      "concurrently",
      "hutch run hmr",
      "hutch run start",
    ],
    hmr: "hutch electrobun prepare && hutch pm exec -- vite --port 5173",
    build:
      "hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun build --env=stable",
    "build:canary":
      "hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun build --env=canary",
  },
  electrobun: {
    version: "2.0.2",
  },
}
