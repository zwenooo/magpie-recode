// What the panel shows: for each ReCode account, how far it is the same as
// Claude Code's own (~/.claude): its Library row, MCP servers, skills,
// CLAUDE.md, and its sessions and memory. Only names and counts are read:
// an MCP server's command, URL, headers and env can hold keys, and none of
// them leaves this file but the magpie hub's path, which holds none.

import fs from "node:fs"
import path from "node:path"
import { listAccounts, rowOf } from "./follow.js"
import { FILE, hashOf } from "./claudemd.js"
import { SHARED_FOLDERS } from "./share.js"

const HUB = /\/mcp\/magpie\/hub(\/[^/?#]*)?\/?$/

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"))
  } catch {
    return null
  }
}

function read(p) {
  try {
    return fs.readFileSync(p, "utf8")
  } catch {
    return null
  }
}

function lstat(p) {
  try {
    return fs.lstatSync(p)
  } catch {
    return null
  }
}

function mtime(p) {
  try {
    return fs.statSync(p).mtimeMs
  } catch {
    return 0
  }
}

function norm(p) {
  p = path.resolve(p.replace(/^\\\\\?\\/, ""))
  return process.platform === "win32" ? p.toLowerCase() : p
}

function names(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => !n.startsWith("."))
      .sort()
  } catch {
    return null
  }
}

// skillsIn is the skills a skills folder holds: the folders (or links to
// them) with a SKILL.md. Anything else there (a sync tool's marker folder,
// .trash) is no skill Claude Code loads.
export function skillsIn(dir) {
  return (names(dir) ?? []).filter((n) => fs.existsSync(path.join(dir, n, "SKILL.md")))
}

// mcpOf is the MCP servers a .claude.json names: {names, hub}. hub is the
// path after /mcp/magpie/hub of the magpie entry ("" for the bare one),
// null when it has none. A file that isn't there names none; null for one
// that doesn't read.
export function mcpOf(file) {
  if (!fs.existsSync(file)) return { names: [], hub: null }
  const j = readJSON(file)
  if (!j) return null
  const servers = j.mcpServers && typeof j.mcpServers === "object" ? j.mcpServers : {}
  let hub = null
  for (const s of Object.values(servers)) {
    const m = typeof s?.url === "string" ? HUB.exec(s.url) : null
    if (m) hub = decodeURIComponent(m[1] ?? "").replace(/^\//, "")
  }
  return { names: Object.keys(servers).sort(), hub }
}

function diff(have, want) {
  const h = new Set(have)
  const w = new Set(want)
  return { missing: want.filter((x) => !h.has(x)), extra: have.filter((x) => !w.has(x)) }
}

// linkState is what <account>/<name> is: "shared" (a junction to the
// shared folder's), "own" (a folder of its own), "elsewhere", "none".
export function linkState(p, target) {
  const st = lstat(p)
  if (!st) return "none"
  if (st.isSymbolicLink()) {
    try {
      return norm(fs.readlinkSync(p)) === norm(target) ? "shared" : "elsewhere"
    } catch {
      return "elsewhere"
    }
  }
  return st.isDirectory() ? "own" : "elsewhere"
}

// sessionsIn counts a projects folder: its projects, their sessions
// (.jsonl) and their memory notes (memory/*.md).
export function sessionsIn(dir) {
  const out = { projects: 0, sessions: 0, memory: 0 }
  let ps
  try {
    ps = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const p of ps) {
    if (!p.isDirectory()) continue
    out.projects++
    const d = path.join(dir, p.name)
    for (const n of names(d) ?? []) if (n.endsWith(".jsonl")) out.sessions++
    for (const n of names(path.join(d, "memory")) ?? []) if (n.endsWith(".md")) out.memory++
  }
  return out
}

function countFiles(dir, cap = 5000) {
  let n = 0
  const walk = (d) => {
    let es
    try {
      es = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of es) {
      if (n >= cap) return
      if (e.isDirectory()) walk(path.join(d, e.name))
      else n++
    }
  }
  walk(dir)
  return n
}

// libraryTicks is, for the claude row and each row given, how many of the
// Library's MCP servers and skills it is ticked for, and whether its
// instructions are. null when library.json doesn't read.
export function libraryTicks(configDir, rows) {
  const file = path.join(configDir, "library.json")
  // a magpie whose Library was never used has no file: nothing to tick
  const lib = fs.existsSync(file) ? readJSON(file) : {}
  if (!lib) return null
  const lists = (xs) => (Array.isArray(xs) ? xs : []).filter((s) => typeof s?.name === "string" && s.name && !s.name.startsWith("-"))
  const mcp = lists(lib.mcp)
  const skills = lists(lib.skills)
  const instr = Array.isArray(lib.instructions?.agents) ? lib.instructions.agents : []
  const of = (row) => ({
    mcp: mcp.filter((s) => (s.agents ?? []).includes(row)).map((s) => s.name),
    skills: skills.filter((s) => (s.agents ?? []).includes(row)).map((s) => s.name),
    instructions: instr.includes(row),
  })
  const out = { claude: of("claude"), hub: !!lib.mcpHub, mcp: mcp.map((s) => s.name), skills: skills.map((s) => s.name), rows: {} }
  for (const r of rows) out.rows[r] = of(r)
  return out
}

// mcpRow is an account's MCP servers against Claude Code's: its hub,
// what it lacks and has besides. dupes are those besides that the Library
// has too (the hub gives them already); the rest are the account's own.
function mcpRow(mcp, row, want, ticks) {
  const d = diff(mcp.names, want)
  const lib = ticks?.mcp ?? []
  return {
    names: mcp.names,
    hub: mcp.hub === null ? "missing" : mcp.hub === row ? "ok" : mcp.hub === "" ? "bare" : "other",
    ...d,
    dupes: d.extra.filter((n) => lib.includes(n)),
  }
}

// collect is everything the panel shows. follower, when given, adds what
// the running follower knows (its last tick, sync and log).
export function collect({ home, recRoot, sharedDir, configDir, options = {}, follower = null }) {
  const mainDir = path.join(home, ".claude")
  const mainMd = read(path.join(mainDir, FILE))
  const mainMcp = mcpOf(path.join(home, ".claude.json"))
  const mainSkills = skillsIn(path.join(mainDir, "skills"))
  const main = {
    dir: mainDir,
    mcp: mainMcp?.names ?? null,
    skills: mainSkills,
    claudeMd: mainMd === null ? null : { bytes: Buffer.byteLength(mainMd), lines: mainMd.split(/\r?\n/).length, mtime: mtime(path.join(mainDir, FILE)) },
    sessions: sessionsIn(path.join(mainDir, "projects")),
  }
  const mainHash = hashOf(mainMd)
  const accounts = listAccounts(recRoot)
  const ticks = libraryTicks(
    configDir,
    accounts.map((a) => rowOf(a.id)),
  )
  const want = ticks?.claude
  const rows = accounts.map((a) => {
    const row = rowOf(a.id)
    const link = path.join(home, ".claude-rec-" + a.id)
    const mcp = mcpOf(path.join(a.dir, ".claude.json"))
    const skills = skillsIn(path.join(a.dir, "skills"))
    const md = read(path.join(a.dir, FILE))
    const t = ticks?.rows[row]
    const folders = {}
    for (const f of SHARED_FOLDERS) folders[f] = linkState(path.join(a.dir, f), path.join(sharedDir, f))
    const last = Math.max(mtime(path.join(a.dir, "history.jsonl")), mtime(path.join(a.dir, ".credentials.json")))
    return {
      id: a.id,
      dir: a.dir,
      claude: a.claude,
      lastUsed: last || null,
      link: linkState(link, a.dir) === "shared" ? "ok" : lstat(link) ? "other" : "missing",
      row,
      library: t && want ? { mcp: [t.mcp.filter((x) => want.mcp.includes(x)).length, want.mcp.length], skills: [t.skills.filter((x) => want.skills.includes(x)).length, want.skills.length], instructions: want.instructions ? t.instructions : null } : null,
      mcp: mcp ? mcpRow(mcp, row, main.mcp ?? [], ticks) : null,
      skills: { count: skills.length, ...diff(skills, mainSkills), notInLibrary: ticks ? diff(skills, mainSkills).missing.filter((n) => !ticks.skills.includes(n)) : [] },
      claudeMd: md === null ? (mainMd === null ? "none" : "missing") : hashOf(md) === mainHash ? "same" : "different",
      folders,
      own: folders.projects === "own" ? sessionsIn(path.join(a.dir, "projects")) : null,
      waiting: follower?.shareWaiting?.get(a.id) ?? [],
    }
  })
  const shared = {
    dir: sharedDir,
    on: !!options.shareSessions,
    ...sessionsIn(path.join(sharedDir, "projects")),
    conflicts: countFiles(path.join(sharedDir, "conflicts")),
    backups: countFiles(path.join(sharedDir, "backups")),
  }
  return {
    at: Date.now(),
    home,
    recRoot,
    configDir,
    main,
    library: ticks ? { hub: ticks.hub, claude: ticks.claude, skills: ticks.skills } : null,
    mainNotInLibrary: ticks ? mainSkills.filter((n) => !ticks.skills.includes(n)) : [],
    accounts: rows,
    shared,
    options,
    follower: follower?.status?.() ?? null,
  }
}
