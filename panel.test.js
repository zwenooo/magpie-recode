import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { collect, mcpOf } from "./panel.js"

function tree() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "recode-panel-"))
  const configDir = path.join(home, ".config", "magpie")
  const recRoot = path.join(home, ".rec", "claude", "accounts")
  const sharedDir = path.join(home, ".rec-sessions")
  fs.mkdirSync(configDir, { recursive: true })
  for (const s of ["alpha", "beta"]) {
    fs.mkdirSync(path.join(home, ".claude", "skills", s), { recursive: true })
    fs.writeFileSync(path.join(home, ".claude", "skills", s, "SKILL.md"), `---
name: ${s}
---
`)
  }
  // a sync tool's marker folder: no skill
  fs.mkdirSync(path.join(home, ".claude", "skills", "synced"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", "skills", "synced", ".bucket-1"), "")
  fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "- 中文\n")
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { magpie: { type: "http", url: "http://127.0.0.1:3425/mcp/magpie/hub" } } }))
  const acct = (id, { mcp, skills = [], md = null }) => {
    const dir = path.join(recRoot, id, "config")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "settings.json"), "{}")
    fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ mcpServers: mcp }))
    for (const s of skills) {
      fs.mkdirSync(path.join(dir, "skills", s), { recursive: true })
      fs.writeFileSync(path.join(dir, "skills", s, "SKILL.md"), "x")
    }
    if (md !== null) fs.writeFileSync(path.join(dir, "CLAUDE.md"), md)
    fs.symlinkSync(dir, path.join(home, ".claude-rec-" + id), "junction")
    return dir
  }
  const hub = (row) => ({ type: "http", url: `http://127.0.0.1:3425/mcp/magpie/hub/${encodeURIComponent(row)}`, headers: { Authorization: "Bearer secret-token" } })
  acct("100", { mcp: { magpie: hub("claude#rec-100") }, skills: ["alpha", "beta"], md: "- 中文\n" })
  acct("200", { mcp: { magpie: hub("claude#rec-200"), "ops-mcp": { command: "uvx", env: { KEY: "secret" } } }, skills: ["alpha"], md: "- 旧\n" })
  acct("300", { mcp: { "ops-mcp": { command: "uvx" }, node_repl: { command: "node" } } })
  // 100 shares its sessions; 200 keeps its own
  fs.mkdirSync(path.join(sharedDir, "projects", "p1", "memory"), { recursive: true })
  fs.writeFileSync(path.join(sharedDir, "projects", "p1", "s1.jsonl"), "{}\n")
  fs.writeFileSync(path.join(sharedDir, "projects", "p1", "memory", "MEMORY.md"), "- x\n")
  fs.mkdirSync(path.join(sharedDir, "file-history"), { recursive: true })
  fs.symlinkSync(path.join(sharedDir, "projects"), path.join(recRoot, "100", "config", "projects"), "junction")
  fs.symlinkSync(path.join(sharedDir, "file-history"), path.join(recRoot, "100", "config", "file-history"), "junction")
  fs.mkdirSync(path.join(recRoot, "200", "config", "projects", "q"), { recursive: true })
  fs.writeFileSync(path.join(recRoot, "200", "config", "projects", "q", "a.jsonl"), "{}\n")
  const lib = {
    mcp: [{ name: "ops-mcp", agents: ["claude", "claude#rec-100", "claude#rec-200"] }],
    skills: [{ name: "alpha", agents: ["claude", "claude#rec-100"] }, { name: "beta", agents: ["claude", "claude#rec-100"] }],
    instructions: { agents: [] },
    mcpHub: true,
  }
  fs.writeFileSync(path.join(configDir, "library.json"), JSON.stringify(lib))
  return { home, configDir, recRoot, sharedDir }
}

test("mcpOf: names and the hub's path, nothing else", () => {
  const { recRoot } = tree()
  expect(mcpOf(path.join(recRoot, "200", "config", ".claude.json"))).toEqual({ names: ["magpie", "ops-mcp"], hub: "claude#rec-200" })
  expect(mcpOf(path.join(recRoot, "300", "config", ".claude.json"))).toEqual({ names: ["node_repl", "ops-mcp"], hub: null })
  expect(mcpOf(path.join(recRoot, "nope", ".claude.json"))).toEqual({ names: [], hub: null })
  fs.writeFileSync(path.join(recRoot, "100", "bad.json"), "{")
  expect(mcpOf(path.join(recRoot, "100", "bad.json"))).toBe(null)
})

test("collect compares each account with Claude Code's own", () => {
  const t = tree()
  const s = collect({ ...t, options: { shareSessions: true } })
  expect(s.main.mcp).toEqual(["magpie"])
  expect(s.main.skills).toEqual(["alpha", "beta"])
  expect(s.library.claude).toEqual({ mcp: ["ops-mcp"], skills: ["alpha", "beta"], instructions: false })
  const [a, b, c] = s.accounts
  expect(a.link).toBe("ok")
  expect(a.library).toEqual({ mcp: [1, 1], skills: [2, 2], instructions: null })
  expect(a.mcp).toMatchObject({ hub: "ok", missing: [], extra: [], dupes: [] })
  expect(a.skills).toEqual({ count: 2, missing: [], extra: [], notInLibrary: [] })
  expect(a.claudeMd).toBe("same")
  expect(a.folders).toEqual({ projects: "shared", "file-history": "shared" })
  expect(a.own).toBe(null)

  expect(b.library).toEqual({ mcp: [1, 1], skills: [0, 2], instructions: null })
  expect(b.mcp).toMatchObject({ hub: "ok", extra: ["ops-mcp"], dupes: ["ops-mcp"] })
  expect(b.skills).toEqual({ count: 1, missing: ["beta"], extra: [], notInLibrary: [] })
  expect(b.claudeMd).toBe("different")
  expect(b.folders.projects).toBe("own")
  expect(b.own).toEqual({ projects: 1, sessions: 1, memory: 0 })

  expect(c.mcp).toMatchObject({ hub: "missing", extra: ["node_repl", "ops-mcp"], dupes: ["ops-mcp"] })
  expect(s.mainNotInLibrary).toEqual([])
  expect(c.claudeMd).toBe("missing")
  expect(s.shared).toMatchObject({ projects: 1, sessions: 1, memory: 1, conflicts: 0, on: true })
  // nothing secret of an MCP server's goes out
  expect(JSON.stringify(s)).not.toContain("secret")
})
