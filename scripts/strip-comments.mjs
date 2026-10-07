#!/usr/bin/env node
/**
 * strip-comments.mjs — remove all comments from source files.
 *
 * Tokenizer-based (not regex), so comment markers inside strings,
 * template literals and regex literals are left alone.
 *
 * Preserved by default (use --aggressive to nuke these too):
 *   - `/// ...` directives (e.g. `/// <reference types="vite/client" />`)
 *   - `//! ...` directives
 *   - `// @ts-...` pragmas (e.g. `// @ts-expect-error`)
 *
 * Comment-only lines are deleted outright; trailing comments are cut and
 * the line is right-trimmed. Nothing else is reformatted.
 *
 * Usage:
 *   node scripts/strip-comments.mjs [paths...] [options]
 *
 * Options:
 *   --ext=ts,tsx        comma-separated extensions to process (default: ts,tsx)
 *   --dry-run           report what would change, write nothing
 *   --backup            keep a .bak copy of every modified file
 *   --aggressive        also remove /// directives and @ts- pragmas
 *   -h, --help          show this help
 *
 * Examples:
 *   node scripts/strip-comments.mjs --dry-run
 *   node scripts/strip-comments.mjs src --ext=ts,tsx --backup
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { join, extname, basename, resolve } from "node:path"

const SELF = basename(process.argv[1])

function stripComments(src, { aggressive = false, lineComments = true } = {}) {
  const out = []
  const dirty = new Set() // 0-based output lines that lost comment text
  let line = 0
  let i = 0
  let comments = 0
  let prevSig = "" // last significant (non-whitespace) char emitted
  const stack = [] // pushed 'tpl' while inside a ${ ... } interpolation
  let braceDepth = 0
  let state = "code"
  const n = src.length

  const emit = (ch) => {
    out.push(ch)
    if (ch === "\n") line++
    else if (ch !== " " && ch !== "\t" && ch !== "\r") prevSig = ch
  }

  // `/` starts a regex (not division) unless the previous significant
  // token is something a division can follow.
  const isRegexStart = () => !prevSig || !/[A-Za-z0-9_$)\]}'"`]/.test(prevSig)

  while (i < n) {
    const ch = src[i]
    const next = i + 1 < n ? src[i + 1] : ""

    if (state === "code") {
      if (ch === "/" && next === "/" && lineComments) {
        const rest = src.slice(i)
        const keep = !aggressive && /^\/\/(\/|\!|\s*@ts-[a-z]+)/.test(rest)
        if (keep) {
          while (i < n && src[i] !== "\n") emit(src[i++])
          continue
        }
        comments++
        dirty.add(line)
        i += 2
        while (i < n && src[i] !== "\n") i++
        continue
      }
      if (ch === "/" && next === "*") {
        comments++
        dirty.add(line)
        i += 2
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
          if (src[i] === "\n") {
            emit("\n")
            dirty.add(line)
          }
          i++
        }
        i += 2 // consume */ (harmless if we ran off the end)
        continue
      }
      if (ch === "/" && isRegexStart()) {
        emit(ch)
        i++
        let inClass = false
        while (i < n) {
          const c = src[i]
          if (c === "\\") {
            emit(c)
            i++
            if (i < n) emit(src[i++])
            continue
          }
          if (c === "\n") break // unterminated, bail out safely
          if (c === "[") inClass = true
          else if (c === "]") inClass = false
          else if (c === "/" && !inClass) {
            emit(c)
            i++
            while (i < n && /[A-Za-z]/.test(src[i])) emit(src[i++])
            break
          }
          emit(c)
          i++
        }
        continue
      }
      if (ch === "'" || ch === '"') {
        const q = ch
        emit(ch)
        i++
        state = q === "'" ? "sq" : "dq"
        continue
      }
      if (ch === "`") {
        emit(ch)
        i++
        state = "tpl"
        continue
      }
      if (stack.length > 0 && (ch === "{" || ch === "}")) {
        if (ch === "{") braceDepth++
        else if (braceDepth > 0) braceDepth--
        else {
          emit(ch)
          i++
          stack.pop()
          state = "tpl"
          continue
        }
      }
      emit(ch)
      i++
      continue
    }

    if (state === "sq" || state === "dq") {
      const q = state === "sq" ? "'" : '"'
      if (ch === "\\") {
        emit(ch)
        i++
        if (i < n) emit(src[i++])
        continue
      }
      emit(ch)
      i++
      if (ch === q) state = "code"
      continue
    }

    if (state === "tpl") {
      if (ch === "\\") {
        emit(ch)
        i++
        if (i < n) emit(src[i++])
        continue
      }
      if (ch === "`") {
        emit(ch)
        i++
        state = "code"
        continue
      }
      if (ch === "$" && next === "{") {
        emit(ch)
        emit(next)
        i += 2
        stack.push("tpl")
        braceDepth = 0
        state = "code"
        continue
      }
      emit(ch)
      i++
      continue
    }
  }

  const lines = out.join("").split("\n")
  const kept = []
  for (let li = 0; li < lines.length; li++) {
    let l = lines[li]
    if (dirty.has(li)) {
      l = l.replace(/[ \t\r]+$/, "")
      if (l === "") continue
    }
    kept.push(l)
  }
  return { code: kept.join("\n"), comments }
}

function walk(dir, files = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".git" || e === "dist" || e === "build")
      continue
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, files)
    else files.push(p)
  }
  return files
}

function printHelp() {
  console.log(`Usage: node scripts/strip-comments.mjs [paths...] [options]

Removes all comments from source files (tokenizer-based, string-safe).

Options:
  --ext=ts,tsx    comma-separated extensions to process (default: ts,tsx)
  --dry-run       report what would change, write nothing
  --backup        keep a .bak copy of every modified file
  --aggressive    also remove /// directives and @ts- pragmas
  -h, --help      show this help`)
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes("-h") || args.includes("--help")) {
    printHelp()
    return
  }
  let exts = ["ts", "tsx"]
  let dryRun = false
  let backup = false
  let aggressive = false
  const paths = []
  for (const a of args) {
    if (a.startsWith("--ext="))
      exts = a
        .slice(6)
        .split(",")
        .map((s) => s.replace(/^\./, ""))
    else if (a === "--dry-run") dryRun = true
    else if (a === "--backup") backup = true
    else if (a === "--aggressive") aggressive = true
    else if (a.startsWith("-")) {
      console.error(`Unknown option: ${a}`)
      process.exit(1)
    } else paths.push(a)
  }
  if (paths.length === 0) paths.push("src")

  let files = []
  for (const p of paths) {
    const st = statSync(p)
    if (st.isDirectory()) walk(p, files)
    else files.push(p)
  }
  files = files.filter(
    (f) => exts.includes(extname(f).replace(/^\./, "")) && basename(f) !== SELF,
  )

  let changed = 0
  let totalComments = 0
  let totalLines = 0
  for (const f of files) {
    const src = readFileSync(f, "utf8")
    const css = extname(f) === ".css"
    const { code, comments } = stripComments(src, {
      aggressive,
      lineComments: !css,
    })
    if (code === src) continue
    const removed = src.split("\n").length - code.split("\n").length
    changed++
    totalComments += comments
    totalLines += removed
    console.log(`${f}: -${removed} lines (${comments} comments)`)
    if (!dryRun) {
      if (backup) writeFileSync(f + ".bak", src)
      writeFileSync(f, code)
    }
  }
  console.log(
    dryRun
      ? `\nWould strip ${totalComments} comments / ${totalLines} lines in ${changed} files.`
      : `\nStripped ${totalComments} comments / ${totalLines} lines in ${changed} files.`,
  )
}

main()
