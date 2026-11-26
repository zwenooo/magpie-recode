// The panel's local service. magpie's page for a plugin is a sandboxed
// frame that can reach nothing (connect-src 'none'), so the page
// (ui/index.html) goes on to this server's address, and this serves the
// panel itself and what it reads and does. It listens on 127.0.0.1 only;
// magpie web serves it under its own address to a browser elsewhere
// (package.json magpie.page.service).
//
// The page stays in magpie's sandbox when it goes on here: its origin is
// opaque ("null"), so /api answers it with Access-Control-Allow-Origin:
// null. Another site's sandboxed frame is "null" too, and so is kept out
// by a token of this process's, written into the panel's HTML alone (a
// frame of another origin can't read that HTML). A Host other than this
// server's own name (DNS rebinding) is refused.

import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { collect } from "./panel.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))

// hostOK is whether a request's Host names this server: 127.0.0.1,
// localhost or [::1], at its port.
export function hostOK(host, port) {
  return ["127.0.0.1", "localhost", "[::1]"].some((h) => host === `${h}:${port}`)
}

// opener is the command that opens a folder in the system's file manager.
function opener() {
  if (process.platform === "win32") return "explorer.exe"
  if (process.platform === "darwin") return "open"
  return "xdg-open"
}

// where is the folder a panel button names, null for one it doesn't.
export function where(what, id, ctx) {
  if (what === "main") return ctx.main
  if (what === "shared") return ctx.sharedDir
  if (what === "conflicts") return path.join(ctx.sharedDir, "conflicts")
  if (what === "backups") return path.join(ctx.sharedDir, "backups")
  if (what === "account" && typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id)) return path.join(ctx.recRoot, id, "config")
  return null
}

// originOK is whether a request's Origin may use /api: none, "null"
// (magpie's sandboxed frame) or this server's own.
export function originOK(origin, port) {
  return origin === undefined || origin === "null" || hostOK(String(origin).replace(/^http:\/\//, ""), port)
}

const CORS = {
  "Access-Control-Allow-Origin": "null",
  "Access-Control-Allow-Methods": "GET, POST",
  "Access-Control-Allow-Headers": "Content-Type, X-ReCode-Token",
  "Access-Control-Max-Age": "600",
  Vary: "Origin",
}

function send(res, code, type, body, extra = {}) {
  res.writeHead(code, {
    ...extra,
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
  })
  res.end(body)
}

function json(res, code, v) {
  send(res, code, "application/json; charset=utf-8", JSON.stringify(v), CORS)
}

function body(req) {
  return new Promise((resolve) => {
    let s = ""
    req.on("data", (c) => {
      s += c
      if (s.length > 64 << 10) req.destroy()
    })
    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : {})
      } catch {
        resolve(null)
      }
    })
    req.on("error", () => resolve(null))
  })
}

// serve starts the panel's server on 127.0.0.1:port for follower, and
// answers it (or null, with why logged, when the port is taken).
export function serve({ port, follower, options = {}, log = (m) => console.error(`[recode] ${m}`) }) {
  const token = crypto.randomBytes(24).toString("hex")
  const page = () => fs.readFileSync(path.join(HERE, "ui", "panel.html"), "utf8").replace("__RECODE_TOKEN__", token)
  const icon = fs.readFileSync(path.join(HERE, "ui", "icon.svg"))
  const ctx = {
    home: follower.home,
    recRoot: follower.recRoot,
    sharedDir: follower.sharedDir,
    configDir: follower.configDir,
    main: path.join(follower.home, ".claude"),
  }
  let cached = null
  const status = (fresh) => {
    if (!fresh && cached && Date.now() - cached.at < 3000) return { ...cached, follower: follower.status() }
    cached = collect({ ...ctx, options: { ...options, port }, follower })
    return cached
  }
  const server = http.createServer(async (req, res) => {
    if (!hostOK(req.headers.host ?? "", port)) return send(res, 403, "text/plain", "not this server's name")
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`)
    try {
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        if (url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", page())
        if (url.pathname === "/icon.svg") return send(res, 200, "image/svg+xml", icon)
        return send(res, 404, "text/plain", "not found")
      }
      if (!url.pathname.startsWith("/api/")) return send(res, 405, "text/plain", "GET only")
      if (!originOK(req.headers.origin, port)) return send(res, 403, "text/plain", "not the panel's origin")
      if (req.method === "OPTIONS") return send(res, 204, "text/plain", "", CORS)
      const given = Buffer.from(String(req.headers["x-recode-token"] ?? ""))
      if (given.length !== token.length || !crypto.timingSafeEqual(given, Buffer.from(token))) return json(res, 403, { error: "the panel's token is missing or old: reload the page" })
      if (req.method === "GET") {
        if (url.pathname === "/api/status") return json(res, 200, status(url.searchParams.has("fresh")))
        return json(res, 404, { error: "not found" })
      }
      if (req.method !== "POST") return json(res, 405, { error: "GET or POST" })
      const b = await body(req)
      if (b === null) return json(res, 400, { error: "the body isn't JSON" })
      if (url.pathname === "/api/check") {
        // a tick may run a sync owed, minutes long: the panel watches
        if (follower.busy) return json(res, 409, { error: "a check is running" })
        follower.tick().catch((e) => log(`check now failed: ${e?.message ?? e}`))
        return json(res, 202, { started: true })
      }
      if (url.pathname === "/api/sync") {
        if (follower.syncing) return json(res, 409, { error: "a sync is running" })
        // the sync takes minutes: the panel watches its status
        follower.syncNow().catch((e) => log(`sync now failed: ${e?.message ?? e}`))
        return json(res, 202, { started: true })
      }
      if (url.pathname === "/api/open") {
        const dir = where(b.what, b.id, ctx)
        if (!dir) return json(res, 400, { error: "no such folder" })
        if (!fs.existsSync(dir)) return json(res, 404, { error: `${dir} isn't there` })
        execFile(opener(), [dir], { windowsHide: false }, () => {})
        return json(res, 200, { opened: dir })
      }
      return json(res, 404, { error: "not found" })
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) })
    }
  })
  server.on("error", (e) => log(`the panel's server on 127.0.0.1:${port}: ${e.message}`))
  server.listen(port, "127.0.0.1", () => log(`panel at http://127.0.0.1:${port}/`))
  server.unref?.()
  return server
}
