import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { argsOf, followed, keepLinks, listAccounts, lock, plan, rowOf, samePath, whyNot, Follower } from "./follow.js"

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
    expect(got.map(argsOf)).toEqual([
      ["library", "mcp", "agents", "b", "claude,codex,claude#rec-1,claude#rec-2"],
      ["library", "mcp", "agents", "c", "codex"],
      ["library", "mcp", "agents", "d", "claude,claude#rec-1,claude#rec-2"],
      ["library", "instructions", "agents", "claude,claude#rec-1,claude#rec-2"],
    ])
    expect(argsOf({ kind: "skill", name: "s", agents: [] })).toEqual(["library", "skill", "agents", "s", "none"])
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

test("a tick links, copies the ticks through magpie and syncs", async () => {
  account("5")
  account("6", []) // not signed in yet: linked, not ticked
  const cfg = path.join(root, "cfg")
  fs.mkdirSync(cfg)
  fs.writeFileSync(path.join(cfg, "library.json"), JSON.stringify({ mcp: [{ name: "m", agents: ["claude"] }], skills: [], instructions: { agents: [] } }))
  // a fake magpie that records its arguments
  const calls = path.join(root, "calls.txt")
  const fake = path.join(root, process.platform === "win32" ? "magpie.cmd" : "magpie")
  if (process.platform === "win32") fs.writeFileSync(fake, `@echo %*>>"${calls}"\r\n`)
  else fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${calls}"\n`, { mode: 0o755 })
  const logs = []
  const f = new Follower({ home, recRoot: rec, configDir: cfg, magpie: fake, lockDir: path.join(root, "l"), log: (m) => logs.push(m) })
  const did = await f.once()
  expect(did.made.sort()).toEqual(["5", "6"])
  expect(did.changes).toEqual([{ kind: "mcp", name: "m", agents: ["claude", "claude#rec-5"] }])
  expect(did.synced).toBe(true)
  expect(fs.readFileSync(calls, "utf8").trim().split(/\r?\n/)).toEqual(["library mcp agents m claude,claude#rec-5", "library sync"])
})

test("only magpie's own host follows, never one with CLAUDE_CONFIG_DIR set", () => {
  const cfg = path.join(root, "cfg2")
  fs.mkdirSync(cfg)
  expect(whyNot({}, cfg)).toBe("not in magpie's config folder")
  fs.writeFileSync(path.join(cfg, "library.json"), "{}")
  expect(whyNot({}, cfg)).toBe("")
  expect(whyNot({ CLAUDE_CONFIG_DIR: path.join(rec, "1", "config") }, cfg)).toContain("CLAUDE_CONFIG_DIR is set")
})
