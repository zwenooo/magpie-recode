import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { added, followClaudeMd } from "./claudemd.js"

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recode-md-"))
  const main = path.join(root, ".claude", "CLAUDE.md")
  fs.mkdirSync(path.dirname(main), { recursive: true })
  const accounts = ["111", "222", "333"].map((id) => {
    const dir = path.join(root, "accounts", id, "config")
    fs.mkdirSync(dir, { recursive: true })
    return { id, dir }
  })
  const o = { main, accounts, stateFile: path.join(root, "shared", "claude-md.json"), backupDir: path.join(root, "shared", "backups"), now: 1_700_000_000_000 }
  const md = (a) => fs.readFileSync(path.join(a.dir, "CLAUDE.md"), "utf8")
  return { root, main, accounts, o, md }
}

test("added: the lines base lacks, blanks and repeats left out", () => {
  expect(added("a\n\nb\nc\nb\n", "a\nc")).toEqual(["b"])
  expect(added("x", "")).toEqual(["x"])
})

// the first run: an old copy is replaced, what only it had kept apart,
// a missing file written, a copy that is the same left alone
test("first run copies Claude Code's CLAUDE.md, keeping an old copy's lines", () => {
  const { main, accounts, o, md } = setup()
  fs.writeFileSync(main, "- 中文回复\n- 新规则\n")
  fs.writeFileSync(path.join(accounts[0].dir, "CLAUDE.md"), "- 中文回复\n- 旧规则\n")
  fs.writeFileSync(path.join(accounts[2].dir, "CLAUDE.md"), "- 中文回复\n- 新规则\n")
  const r = followClaudeMd(o)
  expect(r.problems).toEqual([])
  expect(r.written.sort()).toEqual(["111", "222"])
  expect(r.joined).toEqual({})
  for (const a of accounts) expect(md(a)).toBe("- 中文回复\n- 新规则\n")
  expect(fs.readFileSync(main, "utf8")).toBe("- 中文回复\n- 新规则\n")
  expect(Object.keys(r.backedUp)).toEqual(["111"])
  expect(fs.readFileSync(r.backedUp["111"], "utf8")).toBe("- 中文回复\n- 旧规则\n")
  // again: nothing to do
  const again = followClaudeMd(o)
  expect(again.written).toEqual([])
  expect(again.backedUp).toEqual({})
})

// a line noted in one account reaches Claude Code's and every account
test("a line an account added is joined in and reaches every account", () => {
  const { main, accounts, o, md } = setup()
  fs.writeFileSync(main, "- 中文回复\n")
  followClaudeMd(o)
  fs.appendFileSync(path.join(accounts[1].dir, "CLAUDE.md"), "- 记住：用 pnpm\n")
  const r = followClaudeMd(o)
  expect(r.joined).toEqual({ "222": ["- 记住：用 pnpm"] })
  expect(r.backedUp).toEqual({})
  expect(fs.readFileSync(main, "utf8")).toBe("- 中文回复\n- 记住：用 pnpm\n")
  for (const a of accounts) expect(md(a)).toBe("- 中文回复\n- 记住：用 pnpm\n")
})

// an edit of Claude Code's own reaches the accounts, a line taken out there
// included; nothing is joined back from copies this wrote
test("an edit of Claude Code's CLAUDE.md reaches every account", () => {
  const { main, accounts, o, md } = setup()
  fs.writeFileSync(main, "- 一\n- 二\n")
  followClaudeMd(o)
  fs.writeFileSync(main, "- 一\n")
  const r = followClaudeMd(o)
  expect(r.joined).toEqual({})
  expect(r.backedUp).toEqual({})
  for (const a of accounts) expect(md(a)).toBe("- 一\n")
})

test("no CLAUDE.md of Claude Code's: the accounts are left alone", () => {
  const { accounts, o } = setup()
  fs.writeFileSync(path.join(accounts[0].dir, "CLAUDE.md"), "own\n")
  const r = followClaudeMd(o)
  expect(r.written).toEqual([])
  expect(fs.readFileSync(path.join(accounts[0].dir, "CLAUDE.md"), "utf8")).toBe("own\n")
  expect(fs.existsSync(o.stateFile)).toBe(false)
})
