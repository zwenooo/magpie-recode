// ReClaude account folders as magpie Library rows that follow Claude Code.
//
// ReClaude keeps each account's Claude Code config folder at
// ~/.rec/claude/accounts/<id>/config. magpie makes a row of its own,
// claude#<name>, of every folder in the home folder named .claude-<name>
// that holds Claude Code's files, links and junctions included. So each
// account gets a junction ~/.claude-rec-<id> pointing at its folder, and
// becomes the row claude#rec-<id>.
//
// A new row is ticked for nothing. So each row gets the claude row's
// ticks (MCP servers, skills, instructions) through magpie's own command
// line, and then magpie writes the Library into it. This has to be done
// before the account's first Claude Code session: Claude Code reads its
// MCP servers once, when a session starts.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"

const LINK_PREFIX = ".claude-rec-"
const ROW_PREFIX = "claude#rec-"
const ID = /^[A-Za-z0-9_-]+$/

// rowOf is the Library row magpie makes of an account's junction, as
// magpie names it (internal/agent/claude_dirs.go claudeDirName).
export function rowOf(id) {
  return ROW_PREFIX + id.toLowerCase()
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

// looksClaude is whether magpie takes dir for a Claude Code folder
// (claudeDirIsClaude): its settings.json or sign-in file, or projects.
export function looksClaude(dir) {
  return isFile(path.join(dir, "settings.json")) || isFile(path.join(dir, ".credentials.json")) || isDir(path.join(dir, "projects"))
}

// listAccounts is every account folder under recRoot: {id, dir, claude}.
export function listAccounts(recRoot) {
  let es
  try {
    es = fs.readdirSync(recRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const e of es) {
    if (!ID.test(e.name)) continue
    const dir = path.join(recRoot, e.name, "config")
    if (!isDir(dir)) continue
    out.push({ id: e.name, dir, claude: looksClaude(dir) })
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out
}

// samePath compares two paths as the system does: a junction's target
// may come back as \\?\C:\…, and Windows ignores case.
function norm(p) {
  p = path.resolve(p.replace(/^\\\\\?\\/, ""))
  return process.platform === "win32" ? p.toLowerCase() : p
}

export function samePath(a, b) {
  return norm(a) === norm(b)
}

function linkTarget(link) {
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return null
    return fs.readlinkSync(link)
  } catch {
    return null
  }
}

function inside(p, root) {
  const rel = path.relative(norm(root), norm(p))
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

// keepLinks gives each account a ~/.claude-rec-<id> junction to its
// folder, and takes away a junction of ours whose account is gone. A
// name taken by anything else (a real folder, a link elsewhere) is left
// alone. It returns {made, removed, linked: ids whose junction is ours,
// problems}.
export function keepLinks(home, recRoot, accounts) {
  const made = []
  const removed = []
  const linked = []
  const problems = []
  for (const a of accounts) {
    const link = path.join(home, LINK_PREFIX + a.id)
    let st
    try {
      st = fs.lstatSync(link)
    } catch {}
    if (!st) {
      try {
        fs.symlinkSync(a.dir, link, "junction")
        made.push(a.id)
        linked.push(a.id)
      } catch (e) {
        problems.push(`can't link ${link}: ${e.message}`)
      }
      continue
    }
    const to = linkTarget(link)
    if (to !== null && samePath(to, a.dir)) linked.push(a.id)
  }
  let es = []
  try {
    es = fs.readdirSync(home)
  } catch {}
  for (const name of es) {
    if (!name.startsWith(LINK_PREFIX)) continue
    const link = path.join(home, name)
    const to = linkTarget(link)
    if (to === null || !inside(to, recRoot) || fs.existsSync(to)) continue
    try {
      // rmdir takes a junction away without reaching into it
      fs.rmdirSync(link)
      removed.push(name.slice(LINK_PREFIX.length))
    } catch {
      try {
        fs.unlinkSync(link)
        removed.push(name.slice(LINK_PREFIX.length))
      } catch (e) {
        problems.push(`can't remove ${link}: ${e.message}`)
      }
    }
  }
  return { made, removed, linked, problems }
}

// followed is a list of agents as it should be: every row in rows when
// the claude row is in it, none when it isn't; gone rows taken out.
export function followed(list, rows, gone) {
  const base = list.filter((a) => !rows.includes(a) && !gone.has(a))
  return list.includes("claude") ? [...base, ...rows] : base
}

function sameSet(a, b) {
  if (a.length !== b.length) return false
  const s = new Set(a)
  return b.every((x) => s.has(x))
}

// plan is the changes that make rows follow the claude row in the
// library (library.json as magpie keeps it): [{kind, name, agents}],
// kind "mcp", "skill" or "instructions". A claude#rec-<number> row whose
// account is gone (no folder under recRoot, no ~/.claude-rec-<number>)
// leaves every list; a row of another name is never ours to take out.
export function plan(lib, rows, recRoot, home = os.homedir()) {
  const gone = new Set()
  const lists = []
  for (const s of Array.isArray(lib?.mcp) ? lib.mcp : []) lists.push({ kind: "mcp", name: s?.name, agents: s?.agents })
  for (const s of Array.isArray(lib?.skills) ? lib.skills : []) lists.push({ kind: "skill", name: s?.name, agents: s?.agents })
  if (lib?.instructions && typeof lib.instructions === "object") lists.push({ kind: "instructions", name: "", agents: lib.instructions.agents })
  for (const l of lists) {
    l.agents = Array.isArray(l.agents) ? l.agents.filter((a) => typeof a === "string") : []
    for (const a of l.agents) {
      if (!a.startsWith(ROW_PREFIX) || rows.includes(a)) continue
      const id = a.slice(ROW_PREFIX.length)
      if (/^\d+$/.test(id) && !isDir(path.join(recRoot, id)) && !fs.existsSync(path.join(home, LINK_PREFIX + id))) gone.add(a)
    }
  }
  const out = []
  for (const l of lists) {
    if (l.kind !== "instructions" && (typeof l.name !== "string" || l.name === "" || l.name.startsWith("-"))) continue
    const want = followed(l.agents, rows, gone)
    if (!sameSet(want, l.agents)) out.push({ kind: l.kind, name: l.name, agents: want })
  }
  return out
}

// argsOf is the magpie command line that makes a change.
export function argsOf(c) {
  const list = c.agents.length ? c.agents.join(",") : "none"
  if (c.kind === "instructions") return ["library", "instructions", "agents", list]
  return ["library", c.kind, "agents", c.name, list]
}

export function readLibrary(configDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir, "library.json"), "utf8"))
  } catch {
    // missing, or half-written by magpie this moment: next time
    return null
  }
}

export function run(magpie, args, timeout = 120_000) {
  return new Promise((resolve) => {
    execFile(magpie, args, { timeout, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ""}${stderr ?? ""}`.trim()
      resolve({ ok: !err, out: err && !out ? String(err.message) : out })
    })
  })
}

// findMagpie is the magpie command line to run: the one given, else the
// one beside the magpie that started this plugin's host (its parent),
// else magpie on the PATH. On Windows magpie.com is the console one.
export async function findMagpie(given) {
  if (given) return given
  const beside = (exe) => {
    const dir = path.dirname(exe)
    for (const n of process.platform === "win32" ? ["magpie.com", "magpie.exe"] : ["magpie"]) {
      if (isFile(path.join(dir, n))) return path.join(dir, n)
    }
    return null
  }
  const parent = await parentExe()
  if (parent && /^magpie(\.exe)?$/i.test(path.basename(parent))) {
    const m = beside(parent)
    if (m) return m
  }
  return typeof Bun !== "undefined" ? Bun.which("magpie") : null
}

async function parentExe() {
  const pid = process.ppid
  if (!pid) return null
  if (process.platform === "linux") {
    try {
      return fs.readlinkSync(`/proc/${pid}/exe`)
    } catch {
      return null
    }
  }
  const [cmd, args] =
    process.platform === "win32"
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).Path`]]
      : ["ps", ["-o", "comm=", "-p", String(pid)]]
  const r = await run(cmd, args, 20_000)
  const p = r.ok ? r.out.split(/\r?\n/)[0].trim() : ""
  return p || null
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === "EPERM"
  }
}

// lock is a folder only one tick holds at a time, across every process
// that loaded this plugin (a magpie command in a terminal starts a host
// of its own for as long as it runs, and ends it mid-tick). One whose
// process has ended is taken at once; one with no process named, after
// staleMs.
export function lock(dir, staleMs = 5 * 60_000, again = true) {
  try {
    fs.mkdirSync(dir)
  } catch (e) {
    if (e.code !== "EEXIST" || !again) return null
    let pid = 0
    try {
      pid = Number(fs.readFileSync(path.join(dir, "pid"), "utf8")) || 0
    } catch {}
    let stale = pid ? !alive(pid) : false
    try {
      stale ||= !pid && Date.now() - fs.statSync(dir).mtimeMs > staleMs
    } catch {}
    if (!stale) return null
    fs.rmSync(dir, { recursive: true, force: true })
    return lock(dir, staleMs, false)
  }
  try {
    fs.writeFileSync(path.join(dir, "pid"), String(process.pid))
  } catch {}
  return () => fs.rmSync(dir, { recursive: true, force: true })
}

// whyNot is why this process mustn't follow, "" when it may. magpie's
// claude row is the folder CLAUDE_CONFIG_DIR names when it is set (a
// magpie command typed in a terminal of a ReClaude account's session has
// it): such a magpie, and every magpie command it would run, takes that
// account for Claude Code, and would copy the wrong ticks. Only a process
// working in magpie's config folder (the plugin host's) follows: another
// program that loads the plugin (a page plugin's scan) doesn't.
export function whyNot(env, configDir) {
  if (env.CLAUDE_CONFIG_DIR) return `CLAUDE_CONFIG_DIR is set (${env.CLAUDE_CONFIG_DIR}): not following in this magpie`
  if (!isFile(path.join(configDir, "library.json"))) return "not in magpie's config folder"
  return ""
}

// Follower runs a tick every so often. Options:
//   recRoot   ReClaude's accounts folder (~/.rec/claude/accounts)
//   home      the home folder the junctions go in (os.homedir())
//   configDir magpie's config folder, which has library.json (the host's
//             working folder)
//   magpie    the magpie command to run (found by itself)
//   every     milliseconds between ticks (5000)
//   follow    false: junctions only, no ticks copied
export class Follower {
  constructor(o = {}) {
    this.home = o.home || os.homedir()
    this.recRoot = o.recRoot || path.join(this.home, ".rec", "claude", "accounts")
    this.configDir = o.configDir || process.cwd()
    this.magpieGiven = o.magpie || ""
    this.every = Math.max(1000, Number(o.every) || 5000)
    this.follow = o.follow !== false
    this.log = o.log || ((m) => console.error(`[reclaude] ${m}`))
    this.lockDir = o.lockDir || path.join(os.tmpdir(), "magpie-reclaude.lock")
    this.failures = 0
    this.holdUntil = 0
    this.said = new Set()
  }

  say(m) {
    if (this.said.has(m)) return
    this.said.add(m)
    this.log(m)
  }

  start() {
    const go = () => {
      this.tick().catch((e) => this.say(`tick failed: ${e?.stack ?? e}`))
    }
    go()
    this.timer = setInterval(go, this.every)
    // a process that only looked at this plugin (another plugin's scan)
    // still ends when its own work does
    this.timer.unref?.()
    return this
  }

  stop() {
    clearInterval(this.timer)
  }

  async tick() {
    if (this.busy) return
    this.busy = true
    const release = lock(this.lockDir)
    try {
      if (release) await this.once()
    } finally {
      release?.()
      this.busy = false
    }
  }

  // once does one tick's work and says what it did: {made, removed,
  // changes, synced}.
  async once() {
    const accounts = listAccounts(this.recRoot)
    const links = keepLinks(this.home, this.recRoot, accounts)
    for (const p of links.problems) this.say(p)
    for (const id of links.made) this.log(`linked ${path.join(this.home, LINK_PREFIX + id)} to account ${id}`)
    for (const id of links.removed) this.log(`removed ${path.join(this.home, LINK_PREFIX + id)}: account ${id} is gone`)
    const did = { made: links.made, removed: links.removed, changes: [], synced: false }
    if (!this.follow || Date.now() < this.holdUntil) return did
    const lib = readLibrary(this.configDir)
    if (!lib) return did
    const linked = new Set(links.linked)
    const rows = accounts.filter((a) => a.claude && linked.has(a.id)).map((a) => rowOf(a.id))
    const changes = plan(lib, rows, this.recRoot, this.home)
    if (changes.length === 0) return did
    if (!this.magpie) this.magpie = await findMagpie(this.magpieGiven)
    if (!this.magpie) {
      this.say("can't find magpie's command line: set the plugin's option magpie to its path")
      this.hold()
      return did
    }
    for (const c of changes) {
      const r = await run(this.magpie, argsOf(c))
      if (!r.ok) {
        this.log(`magpie ${argsOf(c).join(" ")} failed: ${r.out}`)
        this.hold()
        return did
      }
      did.changes.push(c)
    }
    const r = await run(this.magpie, ["library", "sync"])
    if (!r.ok) {
      this.log(`magpie library sync failed: ${r.out}`)
      this.hold()
      return did
    }
    did.synced = true
    this.failures = 0
    this.log(`${changes.length} Library list(s) now follow Claude Code (${rows.length} account(s)); synced`)
    return did
  }

  // hold waits a minute after a failure, doubled each time up to 30.
  hold() {
    this.failures++
    this.holdUntil = Date.now() + Math.min(30, 2 ** (this.failures - 1)) * 60_000
  }
}
