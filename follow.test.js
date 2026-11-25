import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { followed, isFork, keepLinks, listAccounts, lock, plan, rowOf, samePath, whyNot, writeFollowed, Follower } from "./follow.js"

let root, home, rec

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reclaude-test-"))
  home = path.join(root, "home")
  rec = path.join(home, ".rec", "claude", "accounts")
  fs.mkdirSync(rec, { recursive: true })
})

afterEach(() => {
  // junctions first, so nothing is removed through them
  for (const n of fs.readdirSync(home)) {
    const p = path.join(home, n)
    if (fs.lstatSync(p).isSymbolicLink()) fs.rmdirSync(p)
  }
  fs.rmSync(root, { recursive: true, force: true })
})

function account(id, files = [".credentials.json"]) {
  const dir = path.join(rec, id, "config")
  fs.mkdirSync(dir, { recursive: true })
  for (const f of files) fs.writeFileSync(path.join(dir, f), "{}")
  return dir
}

describe("accounts and junctions", () => {
  test("an account is Claude's once it has a sign-in, settings or projects", () => {
    account("1")
    account("2", [])
    account("3", ["settings.json"])
    fs.mkdirSync(path.join(rec, "4", "config", "projects"), { recursive: true })
    fs.mkdirSync(path.join(rec, "bad name", "config"), { recursive: true })
    fs.mkdirSync(path.join(rec, "5"), { recursive: true }) // no config folder
    expect(listAccounts(rec).map((a) => [a.id, a.claude])).toEqual([
      ["1", true],
      ["2", false],
      ["3", true],
      ["4", true],
    ])
    expect(listAccounts(path.join(root, "missing"))).toEqual([])
  })

  test("each account gets a junction, and a junction whose account is gone goes", () => {
    const d1 = account("11")
    account("12")
    let r = keepLinks(home, rec, listAccounts(rec))
    expect(r.made.sort()).toEqual(["11", "12"])
    expect(r.linked.sort()).toEqual(["11", "12"])
    const link = path.join(home, ".claude-rec-11")
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(samePath(fs.readlinkSync(link), d1)).toBe(true)
    // through the junction, the account's own files
    expect(fs.existsSync(path.join(link, ".credentials.json"))).toBe(true)

    r = keepLinks(home, rec, listAccounts(rec))
    expect(r.made).toEqual([])
    expect(r.linked.sort()).toEqual(["11", "12"])

    fs.rmSync(path.join(rec, "12"), { recursive: true, force: true })
    r = keepLinks(home, rec, listAccounts(rec))
    expect(r.removed).toEqual(["12"])
    expect(fs.existsSync(path.join(home, ".claude-rec-12"))).toBe(false)
    expect(fs.existsSync(d1)).toBe(true)
  })

  test("a name taken by something else is left alone", () => {
    account("21")
    account("22")
    const own = path.join(home, ".claude-rec-21")
    fs.mkdirSync(own)
    fs.writeFileSync(path.join(own, "keep"), "x")
    const elsewhere = path.join(root, "elsewhere")
    fs.mkdirSync(elsewhere)
    fs.symlinkSync(elsewhere, path.join(home, ".claude-rec-22"), "junction")
    // a dangling link outside the accounts folder is not ours either
    const gone = path.join(root, "gone")
    fs.mkdirSync(gone)
    fs.symlinkSync(gone, path.join(home, ".claude-rec-99"), "junction")
    fs.rmdirSync(gone)

    const r = keepLinks(home, rec, listAccounts(rec))
    expect(r.made).toEqual([])
    expect(r.removed).toEqual([])
    expect(r.linked).toEqual([])
    expect(fs.readFileSync(path.join(own, "keep"), "utf8")).toBe("x")
    expect(fs.lstatSync(path.join(home, ".claude-rec-99")).isSymbolicLink()).toBe(true)
  })
})

describe("following the claude row", () => {
  test("rows follow claude, both ways, and keep the rest of the list", () => {
    const rows = ["claude#rec-1", "claude#rec-2"]
    expect(followed(["claude", "codex"], rows, new Set())).toEqual(["claude", "codex", ...rows])
    expect(followed(["codex", "claude#rec-1"], rows, new Set())).toEqual(["codex"])
    expect(followed(["claude", "claude#rec-9"], rows, new Set(["claude#rec-9"]))).toEqual(["claude", ...rows])
  })

  test("plan changes only the lists that differ, and drops gone accounts", () => {
    account("1")
    account("2")
    const rows = [rowOf("1"), rowOf("2")]
    const lib = {
      instructions: { agents: ["claude"] },
      mcp: [
        { name: "hub-a", agents: ["claude", "claude#rec-2", "claude#rec-1"] }, // same set: no change
        { name: "b", agents: ["claude", "codex"] },
        { name: "c", agents: ["codex", "claude#rec-1"] },
        { name: "d", agents: ["claude", "claude#rec-1", "claude#rec-2", "claude#rec-77"] }, // 77 is gone
        { name: "e", agents: ["claude#rec-work"] }, // not an account id of ours: kept
      ],
      skills: [{ name: "s", agents: [] }, { name: "t" }],
    }
    const got = plan(lib, rows, rec, home)
    expect(got).toEqual([
      { kind: "mcp", name: "b", agents: ["claude", "codex", ...rows] },
      { kind: "mcp", name: "c", agents: ["codex"] },
      { kind: "mcp", name: "d", agents: ["claude", ...rows] },
      { kind: "instructions", name: "", agents: ["claude", ...rows] },
    ])
    expect(plan(null, rows, rec, home)).toEqual([])
  })
})

test("one lock at a time, and a stale one is taken", () => {
  const dir = path.join(root, "lock")
  const release = lock(dir)
  expect(release).toBeTruthy()
  expect(lock(dir)).toBe(null)
  release()
  // one whose process has ended is taken at once
  const done = Bun.spawnSync([process.execPath, "-e", "0"])
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, "pid"), String(done.pid))
  expect(lock(dir)).toBeTruthy()
  fs.rmSync(dir, { recursive: true })
  // one naming no process, after a while
  fs.mkdirSync(dir)
  expect(lock(dir)).toBe(null)
  const old = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(dir, old, old)
  expect(lock(dir)).toBeTruthy()
})

test("library.json is changed in place, keeping all else, and left alone when nothing differs", () => {
  account("1")
  const cfg = path.join(root, "cfg3")
  fs.mkdirSync(cfg)
  const file = path.join(cfg, "library.json")
  const lib = {
    instructions: { agents: ["claude"], note: "x" },
    mcp: [{ name: "m", transport: "http", url: "u", agents: ["claude", "codex"], env: { K: "<v>" } }],
    skills: [{ name: "s", agents: ["codex"] }],
    applied: { claude: { mcp: ["magpie"] } },
    mcpHub: true,
  }
  fs.writeFileSync(file, JSON.stringify(lib, null, 2))
  const rows = [rowOf("1")]
  const got = writeFollowed(cfg, rows, rec, home)
  expect(got.map((c) => c.kind + ":" + c.name)).toEqual(["mcp:m", "instructions:"])
  const after = JSON.parse(fs.readFileSync(file, "utf8"))
  expect(after).toEqual({
    ...lib,
    instructions: { agents: ["claude", "claude#rec-1"], note: "x" },
    mcp: [{ ...lib.mcp[0], agents: ["claude", "codex", "claude#rec-1"] }],
  })
  const st = fs.statSync(file).mtimeMs
  expect(writeFollowed(cfg, rows, rec, home)).toEqual([])
  expect(fs.statSync(file).mtimeMs).toBe(st)
  expect(fs.readdirSync(cfg)).toEqual(["library.json"])
  // unreadable: nothing written, next time
  fs.writeFileSync(file, "{half")
  expect(writeFollowed(cfg, rows, rec, home)).toBe(null)
  expect(fs.readFileSync(file, "utf8")).toBe("{half")
})

test("a tick links, writes the ticks and syncs once, and a sync owed survives the process", async () => {
  account("5")
  account("6", []) // not signed in yet: linked, not ticked
  const cfg = path.join(root, "cfg")
  fs.mkdirSync(cfg)
  fs.writeFileSync(path.join(cfg, "library.json"), JSON.stringify({ mcp: [{ name: "m", agents: ["claude"] }], skills: [{ name: "s", agents: ["claude"] }], instructions: { agents: [] } }))
  // a fake magpie that records its arguments
  const calls = path.join(root, "calls.txt")
  const fake = fakeMagpie(calls, "magpie 0.1.4800")
  const o = { home, recRoot: rec, configDir: cfg, magpie: fake, lockDir: path.join(root, "l"), log: () => {} }
  const did = await new Follower(o).once()
  expect(did.made.sort()).toEqual(["5", "6"])
  expect(did.changes.map((c) => c.name)).toEqual(["m", "s"])
  expect(did.synced).toBe(true)
  const lib = JSON.parse(fs.readFileSync(path.join(cfg, "library.json"), "utf8"))
  expect(lib.mcp[0].agents).toEqual(["claude", "claude#rec-5"])
  expect(lib.skills[0].agents).toEqual(["claude", "claude#rec-5"])
  expect(fs.readFileSync(calls, "utf8").trim().split(/\r?\n/)).toEqual(["--version", "library sync"])

  // nothing to change, nothing owed: no sync
  expect((await new Follower(o).once()).synced).toBe(false)
  // a sync owed by a process that ended before it ran is run by the next
  fs.writeFileSync(path.join(root, "l.sync-owed"), "1")
  expect((await new Follower(o).once()).synced).toBe(true)
  expect(fs.existsSync(path.join(root, "l.sync-owed"))).toBe(false)
  expect(fs.readFileSync(calls, "utf8").trim().split(/\r?\n/).filter((l) => l !== "--version")).toEqual(["library sync", "library sync"])
})

function fakeMagpie(calls, version) {
  const fake = path.join(path.dirname(calls), process.platform === "win32" ? "magpie.cmd" : "magpie")
  if (process.platform === "win32") fs.writeFileSync(fake, `@echo %*>>"${calls}"\r\n@if "%1"=="--version" echo ${version}\r\n`)
  else fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${calls}"\n[ "$1" = --version ] && echo "${version}"\nexit 0\n`, { mode: 0o755 })
  return fake
}

test("on the zwenooo/magpie fork it does nothing at all", async () => {
  expect(isFork("magpie 0.1.4728-vb.0.0.3")).toBe(true)
  expect(isFork("magpie 0.1.4800")).toBe(false)
  expect(isFork("magpie dev")).toBe(false)
  account("7")
  const cfg = path.join(root, "cfg4")
  fs.mkdirSync(cfg)
  fs.writeFileSync(path.join(cfg, "library.json"), JSON.stringify({ mcp: [{ name: "m", agents: ["claude"] }] }))
  const calls = path.join(root, "calls4.txt")
  const logs = []
  const f = new Follower({ home, recRoot: rec, configDir: cfg, magpie: fakeMagpie(calls, "magpie 0.1.4728-vb.0.0.3"), lockDir: path.join(root, "l4"), log: (m) => logs.push(m) })
  const did = await f.once()
  await f.once()
  expect(did).toEqual({ made: [], removed: [], changes: [], synced: false })
  expect(fs.existsSync(path.join(home, ".claude-rec-7"))).toBe(false)
  expect(fs.readFileSync(calls, "utf8").trim().split(/\r?\n/)).toEqual(["--version"])
  expect(logs).toHaveLength(1)
  expect(logs[0]).toContain("zwenooo/magpie fork")
})

test("only magpie's own host follows, never one with CLAUDE_CONFIG_DIR set", () => {
  const cfg = path.join(root, "cfg2")
  fs.mkdirSync(cfg)
  expect(whyNot({}, cfg)).toBe("not in magpie's config folder")
  fs.writeFileSync(path.join(cfg, "library.json"), "{}")
  expect(whyNot({}, cfg)).toBe("")
  expect(whyNot({ CLAUDE_CONFIG_DIR: path.join(rec, "1", "config") }, cfg)).toContain("CLAUDE_CONFIG_DIR is set")
})
