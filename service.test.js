import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { hostOK, originOK, serve, where } from "./service.js"

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "recode-svc-"))
const follower = {
  home,
  recRoot: path.join(home, ".rec", "claude", "accounts"),
  sharedDir: path.join(home, ".rec-sessions"),
  configDir: home,
  busy: false,
  syncing: false,
  ticks: 0,
  syncs: 0,
  async tick() {
    this.ticks++
    return true
  },
  async syncNow() {
    this.syncs++
    return true
  },
  status() {
    return { events: [], refused: "", busy: false, syncing: false }
  },
}
const port = await freePort()
const server = serve({ port, follower, log: () => {} })
await new Promise((r) => (server.listening ? r() : server.once("listening", r)))
afterAll(() => server.close())
const base = `http://127.0.0.1:${port}`
const token = /const TOKEN = "([0-9a-f]+)"/.exec(await (await fetch(base + "/")).text())?.[1]

test("hostOK and originOK: this server's names, and magpie's sandboxed frame", () => {
  expect(hostOK("127.0.0.1:3587", 3587)).toBe(true)
  expect(hostOK("localhost:3587", 3587)).toBe(true)
  expect(hostOK("evil.example:3587", 3587)).toBe(false)
  expect(hostOK("127.0.0.1:3588", 3587)).toBe(false)
  expect(originOK(undefined, 3587)).toBe(true)
  expect(originOK("null", 3587)).toBe(true)
  expect(originOK("http://127.0.0.1:3587", 3587)).toBe(true)
  expect(originOK("https://evil.example", 3587)).toBe(false)
})

test("where opens only the panel's own folders", () => {
  const ctx = { main: "/h/.claude", sharedDir: "/h/.rec-sessions", recRoot: "/h/.rec/claude/accounts" }
  expect(where("account", "57658", ctx)).toBe(path.join("/h/.rec/claude/accounts", "57658", "config"))
  expect(where("account", "../../etc", ctx)).toBe(null)
  expect(where("anything", "", ctx)).toBe(null)
})

test("the page carries the token; /api wants it", async () => {
  expect(token).toMatch(/^[0-9a-f]{48}$/)
  expect((await fetch(base + "/api/status")).status).toBe(403)
  expect((await fetch(base + "/api/status", { headers: { "X-ReCode-Token": "0".repeat(48) } })).status).toBe(403)
  const r = await fetch(base + "/api/status", { headers: { "X-ReCode-Token": token, Origin: "null" } })
  expect(r.status).toBe(200)
  expect(r.headers.get("access-control-allow-origin")).toBe("null")
  const s = await r.json()
  expect(Array.isArray(s.accounts)).toBe(true)
  // the page itself is no cross-origin read
  expect((await fetch(base + "/")).headers.get("access-control-allow-origin")).toBe(null)
})

test("another site, or another name for this server, is refused", async () => {
  expect((await fetch(base + "/api/status", { headers: { "X-ReCode-Token": token, Origin: "https://evil.example" } })).status).toBe(403)
  const viaName = await fetch(base + "/", { headers: { Host: "evil.example:" + port } })
  expect(viaName.status).toBe(403)
})

test("a preflight from the sandboxed frame is answered", async () => {
  const r = await fetch(base + "/api/check", { method: "OPTIONS", headers: { Origin: "null", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-recode-token" } })
  expect(r.status).toBe(204)
  expect(r.headers.get("access-control-allow-headers")).toContain("X-ReCode-Token")
})

test("check and sync start the follower's work", async () => {
  const post = (p) => fetch(base + p, { method: "POST", headers: { "X-ReCode-Token": token, "Content-Type": "application/json" }, body: "{}" })
  expect((await post("/api/check")).status).toBe(202)
  expect((await post("/api/sync")).status).toBe(202)
  await new Promise((r) => setTimeout(r, 20))
  expect(follower.ticks).toBe(1)
  expect(follower.syncs).toBe(1)
  expect((await post("/api/open")).status).toBe(400)
})
