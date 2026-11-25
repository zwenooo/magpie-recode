import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { merge, resolveParked, shareAccount } from "./share.js"

let root, shared

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reclaude-share-"))
  shared = path.join(root, "shared")
})

afterEach(() => {
  // junctions first, so nothing is removed through them
  const unlink = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (fs.lstatSync(p).isSymbolicLink()) fs.rmdirSync(p)
      else if (e.isDirectory()) unlink(p)
    }
  }
  unlink(root)
  fs.rmSync(root, { recursive: true, force: true })
})

function account(id) {
  const dir = path.join(root, "accounts", id, "config")
  fs.mkdirSync(dir, { recursive: true })
  return { id, dir }
}

function write(p, text, ageMs = 0) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
  const t = new Date(Date.now() - ageMs)
  fs.utimesSync(p, t, t)
}

const old = 60 * 60_000

test("a new account's folders are junctions to the shared ones at once", () => {
  const a = account("1")
  const r = shareAccount(a, shared)
  expect(r.linked).toEqual(["projects", "file-history"])
  expect(fs.lstatSync(path.join(a.dir, "projects")).isSymbolicLink()).toBe(true)
  // what Claude Code writes there lands in the shared folder
  write(path.join(a.dir, "projects", "D--x", "s1.jsonl"), "hi")
  expect(fs.readFileSync(path.join(shared, "projects", "D--x", "s1.jsonl"), "utf8")).toBe("hi")
  // and a second pass changes nothing
  expect(shareAccount(a, shared)).toEqual({ linked: [], merged: {}, waiting: [], problems: [] })
})

test("an account's sessions merge into the shared folder and every account sees them", () => {
  const a = account("1")
  const b = account("2")
  write(path.join(a.dir, "projects", "D--x", "s1.jsonl"), "one", old)
  write(path.join(a.dir, "projects", "D--x", "s1", "subagents", "agent-1.jsonl"), "sub", old)
  write(path.join(b.dir, "projects", "D--x", "s2.jsonl"), "two", old)
  write(path.join(b.dir, "projects", "D--y", "s3.jsonl"), "three", old)
  write(path.join(b.dir, "file-history", "s2", "f@v1"), "v1", old)
  const ra = shareAccount(a, shared)
  const rb = shareAccount(b, shared)
  expect(ra.merged.projects).toEqual({ moved: 1, dropped: 0, joined: 0, kept: 0 })
  expect(rb.merged.projects).toEqual({ moved: 2, dropped: 0, joined: 0, kept: 0 })
  for (const acc of [a, b]) {
    const p = path.join(acc.dir, "projects")
    expect(fs.readdirSync(path.join(p, "D--x")).sort()).toEqual(["s1", "s1.jsonl", "s2.jsonl"])
    expect(fs.readFileSync(path.join(p, "D--x", "s1", "subagents", "agent-1.jsonl"), "utf8")).toBe("sub")
    expect(fs.readFileSync(path.join(p, "D--y", "s3.jsonl"), "utf8")).toBe("three")
    expect(fs.readFileSync(path.join(acc.dir, "file-history", "s2", "f@v1"), "utf8")).toBe("v1")
  }
})

test("an account written to lately waits; nothing moves", () => {
  const a = account("1")
  write(path.join(a.dir, "projects", "D--x", "s1.jsonl"), "busy", 1000)
  const r = shareAccount(a, shared, { quietMs: 10 * 60_000 })
  expect(r.waiting).toContain("projects")
  expect(fs.lstatSync(path.join(a.dir, "projects")).isSymbolicLink()).toBe(false)
  expect(fs.existsSync(path.join(shared, "projects", "D--x"))).toBe(false)
})

test("the same session in two accounts: same bytes kept once, different bytes kept apart", () => {
  const a = account("1")
  const b = account("2")
  write(path.join(a.dir, "projects", "D--x", "same.jsonl"), "copy", old)
  write(path.join(b.dir, "projects", "D--x", "same.jsonl"), "copy", old)
  write(path.join(a.dir, "projects", "D--x", "diff.jsonl"), "older", old + 1000)
  write(path.join(b.dir, "projects", "D--x", "diff.jsonl"), "newer, went on", old)
  shareAccount(a, shared)
  const r = shareAccount(b, shared)
  expect(r.merged.projects).toEqual({ moved: 0, dropped: 1, joined: 0, kept: 1 })
  const p = path.join(shared, "projects", "D--x")
  expect(fs.readFileSync(path.join(p, "same.jsonl"), "utf8")).toBe("copy")
  expect(fs.readFileSync(path.join(p, "diff.jsonl"), "utf8")).toBe("newer, went on")
  // the older is kept, outside the folder Claude Code lists
  expect(fs.readFileSync(path.join(shared, "conflicts", "2", "projects", "D--x", "diff.jsonl"), "utf8")).toBe("older")
})

test("a folder that links elsewhere is left as it is", () => {
  const a = account("1")
  const elsewhere = path.join(root, "elsewhere")
  fs.mkdirSync(elsewhere)
  fs.symlinkSync(elsewhere, path.join(a.dir, "projects"), "junction")
  const r = shareAccount(a, shared, { folders: ["projects"] })
  expect(r.problems[0]).toContain("links somewhere else")
  expect(fs.readlinkSync(path.join(a.dir, "projects")).toLowerCase()).toContain("elsewhere")
})

test("merge finishes what an earlier, cut-short merge began", () => {
  const from = path.join(root, "from")
  const to = path.join(root, "to")
  write(path.join(from, "p", "a.jsonl"), "a", old)
  write(path.join(to, "p", "b.jsonl"), "b", old)
  expect(merge(from, to, path.join(root, "c"))).toEqual({ moved: 1, dropped: 0, joined: 0, kept: 0 })
  expect(fs.readdirSync(path.join(to, "p")).sort()).toEqual(["a.jsonl", "b.jsonl"])
  expect(fs.readdirSync(from)).toEqual([])
})

test("two accounts' memories are joined: index lines from both, a different note kept beside", () => {
  const a = account("1")
  const b = account("2")
  const mem = (acc) => path.join(acc.dir, "projects", "D--x", "memory")
  write(path.join(mem(a), "MEMORY.md"), "- [A](a.md) — from one\n- [Both](both.md) — same line\n", old + 2000)
  write(path.join(mem(a), "a.md"), "note a", old)
  write(path.join(mem(a), "both.md"), "one's version", old + 2000)
  write(path.join(mem(b), "MEMORY.md"), "- [Both](both.md) — same line\n- [B](b.md) — from two\n", old)
  write(path.join(mem(b), "b.md"), "note b", old)
  write(path.join(mem(b), "both.md"), "two's version, newer", old)
  shareAccount(a, shared, { folders: ["projects"] })
  const r = shareAccount(b, shared, { folders: ["projects"] })
  expect(r.merged.projects).toEqual({ moved: 1, dropped: 0, joined: 1, kept: 1 })
  const m = path.join(shared, "projects", "D--x", "memory")
  const index = fs.readFileSync(path.join(m, "MEMORY.md"), "utf8").trim().split("\n")
  // every line of both, once (in the order the folder lists its files)
  for (const l of ["- [A](a.md) — from one", "- [Both](both.md) — same line", "- [B](b.md) — from two"]) expect(index).toContain(l)
  expect(index.filter((l) => l.includes("(both.from-earlier.md)"))).toHaveLength(1)
  expect(index).toHaveLength(4)
  expect(fs.readFileSync(path.join(m, "both.md"), "utf8")).toBe("two's version, newer")
  expect(fs.readFileSync(path.join(m, "both.from-earlier.md"), "utf8")).toBe("one's version")
  expect(fs.existsSync(path.join(shared, "conflicts"))).toBe(false)
})

test("memory notes 0.2.0 parked in conflicts are joined in, once", () => {
  const m = path.join(shared, "projects", "D--x", "memory")
  write(path.join(m, "MEMORY.md"), "- [A](a.md) — kept\n", old)
  write(path.join(m, "n.md"), "newer note", old)
  const parked = path.join(shared, "conflicts", "7", "projects", "D--x", "memory")
  write(path.join(parked, "MEMORY.md"), "- [A](a.md) — kept\n- [B](b.md) — was parked\n", old + 5000)
  write(path.join(parked, "n.md"), "older note", old + 5000)
  write(path.join(shared, "conflicts", "7", "projects", "D--x", "s.jsonl"), "not memory", old)
  expect(resolveParked(shared)).toBe(2)
  const index = fs.readFileSync(path.join(m, "MEMORY.md"), "utf8")
  expect(index).toContain("- [B](b.md) — was parked")
  expect(index).toContain("(n.from-7.md)")
  expect(fs.readFileSync(path.join(m, "n.md"), "utf8")).toBe("newer note")
  expect(fs.readFileSync(path.join(m, "n.from-7.md"), "utf8")).toBe("older note")
  // what isn't memory stays parked
  expect(fs.existsSync(path.join(shared, "conflicts", "7", "projects", "D--x", "s.jsonl"))).toBe(true)
  expect(resolveParked(shared)).toBe(0)
})

test("a new account's empty folders are linked at once, with no wait", () => {
  const a = account("9")
  fs.mkdirSync(path.join(a.dir, "projects", "D--x"), { recursive: true })
  fs.mkdirSync(path.join(a.dir, "file-history"))
  const r = shareAccount(a, shared, { quietMs: 10 * 60_000 })
  expect(r.waiting).toEqual([])
  expect(r.linked).toEqual(["projects", "file-history"])
  expect(fs.lstatSync(path.join(a.dir, "projects")).isSymbolicLink()).toBe(true)
})
