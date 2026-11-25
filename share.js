// Every ReClaude account's sessions in one folder, so a conversation started
// in one account can be resumed (/resume, claude --resume <id>) in another.
//
// Claude Code keeps an account's sessions in <config>/projects (and the
// checkpoints /rewind uses in <config>/file-history), and looks for a
// session to resume only there. With shareSessions on, each account's
// folder becomes a junction to one shared folder: ~/.rec-sessions/projects
// and ~/.rec-sessions/file-history. (The shared folder's name doesn't start
// with "claude", so magpie takes it for no Claude Code folder of its own.)
//
// A new account gets its junctions before its first session, as it gets
// its Library row. An account that has sessions already is merged into the
// shared folder, and only while nothing has been written in it for a while
// (quietMs): a session running in it would append to a file being moved.
// Files move within one volume, so a handle open on one goes with it.
// Nothing is deleted: a file the shared folder has already is dropped only
// when its bytes are the same; otherwise the newer one stays and the other
// goes to ~/.rec-sessions/conflicts/<account>/….

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export const SHARED_FOLDERS = ["projects", "file-history"]

function lstat(p) {
  try {
    return fs.lstatSync(p)
  } catch {
    return null
  }
}

function norm(p) {
  p = path.resolve(p.replace(/^\\\\\?\\/, ""))
  return process.platform === "win32" ? p.toLowerCase() : p
}

function linksTo(link, target) {
  const st = lstat(link)
  if (!st?.isSymbolicLink()) return false
  try {
    return norm(fs.readlinkSync(link)) === norm(target)
  } catch {
    return false
  }
}

// newest is the latest modification time of any file under dir, 0 for none.
export function newest(dir) {
  let out = 0
  const walk = (d) => {
    let es
    try {
      es = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of es) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        const st = lstat(p)
        if (st && st.mtimeMs > out) out = st.mtimeMs
      }
    }
  }
  walk(dir)
  return out
}

function hash(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")
}

function same(a, b) {
  const sa = lstat(a)
  const sb = lstat(b)
  return !!sa && !!sb && sa.size === sb.size && hash(a) === hash(b)
}

// A project's memory (projects/<project>/memory/*.md: Claude Code's
// MEMORY.md index and the notes it points to) was each account's own and
// becomes every account's. Two accounts' MEMORY.md are joined line by
// line; of two different notes under one name the newer keeps the name,
// the other is kept beside it as <name>.from-<account>.md and indexed.
function inMemory(dst) {
  return path.basename(path.dirname(dst)) === "memory" && dst.endsWith(".md")
}

function writeFile(p, text) {
  const tmp = `${p}.reclaude-${process.pid}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, p)
}

function joinIndex(dst, extra) {
  const have = fs.existsSync(dst) ? fs.readFileSync(dst, "utf8") : ""
  const lines = have.split(/\r?\n/)
  const seen = new Set(lines.map((l) => l.trim()).filter(Boolean))
  const add = extra.split(/\r?\n/).filter((l) => l.trim() && !seen.has(l.trim()))
  if (add.length === 0) return false
  writeFile(dst, have.replace(/\s*$/, "") + (have.trim() ? "\n" : "") + add.join("\n") + "\n")
  return true
}

// mergeMemory takes the note src into the shared memory note dst (which
// exists and differs) and says what it did: "joined" or "kept".
export function mergeMemory(src, dst, who) {
  if (path.basename(dst) === "MEMORY.md") {
    joinIndex(dst, fs.readFileSync(src, "utf8"))
    fs.rmSync(src)
    return "joined"
  }
  const srcNewer = (lstat(src)?.mtimeMs ?? 0) > (lstat(dst)?.mtimeMs ?? 0)
  const stem = path.basename(dst, ".md")
  const label = srcNewer ? "earlier" : who || "another"
  const other = path.join(path.dirname(dst), `${stem}.from-${label}.md`)
  const older = srcNewer ? dst : src
  if (fs.existsSync(other) && same(other, older)) fs.rmSync(older)
  else fs.renameSync(older, other)
  if (srcNewer) fs.renameSync(src, dst)
  joinIndex(path.join(path.dirname(dst), "MEMORY.md"), `- [${stem} (from account ${label})](${path.basename(other)}) — another copy of ${stem}.md, kept when the accounts' memories were joined`)
  return "kept"
}

// merge moves everything in from into to, folder by folder. moved,
// dropped (the same bytes were there), joined (a memory note taken in)
// and kept (a different file was there: the older of the two went to
// conflicts, or beside it for a memory note) count what it did. who is
// the account it comes from.
export function merge(from, to, conflicts, who = "", did = { moved: 0, dropped: 0, joined: 0, kept: 0 }) {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name)
    const dst = path.join(to, e.name)
    const there = lstat(dst)
    if (!there) {
      fs.renameSync(src, dst)
      did.moved++
      continue
    }
    if (e.isDirectory() && there.isDirectory()) {
      merge(src, dst, path.join(conflicts, e.name), who, did)
      fs.rmdirSync(src)
      continue
    }
    if (!e.isDirectory() && !there.isDirectory() && same(src, dst)) {
      fs.rmSync(src)
      did.dropped++
      continue
    }
    if (!e.isDirectory() && !there.isDirectory() && inMemory(dst)) {
      if (mergeMemory(src, dst, who) === "joined") did.joined++
      else did.kept++
      continue
    }
    // two different things under one name: the newer stays shared
    fs.mkdirSync(conflicts, { recursive: true })
    const parked = path.join(conflicts, e.name)
    if ((lstat(src)?.mtimeMs ?? 0) > there.mtimeMs) {
      fs.renameSync(dst, parked)
      fs.renameSync(src, dst)
    } else {
      fs.renameSync(src, parked)
    }
    did.kept++
  }
  return did
}

// shareAccount makes one account's folders junctions into the shared
// folder. It returns {linked: names made junctions, merged: {name: did},
// waiting: names left for later (written to within quietMs), problems}.
export function shareAccount(account, sharedDir, { quietMs = 10 * 60_000, now = Date.now(), folders = SHARED_FOLDERS } = {}) {
  const out = { linked: [], merged: {}, waiting: [], problems: [] }
  for (const name of folders) {
    const link = path.join(account.dir, name)
    const target = path.join(sharedDir, name)
    try {
      fs.mkdirSync(target, { recursive: true })
      if (linksTo(link, target)) continue
      const st = lstat(link)
      if (st?.isSymbolicLink()) {
        out.problems.push(`${link} links somewhere else; left as it is`)
        continue
      }
      if (st && !st.isDirectory()) {
        out.problems.push(`${link} is a file; left as it is`)
        continue
      }
      if (st) {
        // a folder with no file in it (one ReClaude made with a new
        // account) has no session to wait for
        const last = newest(link)
        if (last > 0 && now - last < quietMs) {
          out.waiting.push(name)
          continue
        }
        out.merged[name] = merge(link, target, path.join(sharedDir, "conflicts", account.id, name), account.id)
        fs.rmdirSync(link)
      }
      fs.symlinkSync(target, link, "junction")
      out.linked.push(name)
    } catch (e) {
      // a file in use, a folder another program holds: next time
      out.problems.push(`${link}: ${e.message}`)
    }
  }
  return out
}

// resolveParked takes the memory notes 0.2.0 parked in conflicts/ (it
// kept only the newest MEMORY.md of a project) into the shared memory as
// merge does now. It returns how many it took; running it again finds
// none.
export function resolveParked(sharedDir) {
  const root = path.join(sharedDir, "conflicts")
  let n = 0
  let accounts = []
  try {
    accounts = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())
  } catch {
    return 0
  }
  for (const acct of accounts) {
    const base = path.join(root, acct.name, "projects")
    const walk = (d, rel) => {
      let es = []
      try {
        es = fs.readdirSync(d, { withFileTypes: true })
      } catch {}
      for (const e of es) {
        const p = path.join(d, e.name)
        const r = path.join(rel, e.name)
        if (e.isDirectory()) walk(p, r)
        else {
          const dst = path.join(sharedDir, "projects", r)
          if (!inMemory(dst)) continue
          if (!fs.existsSync(dst)) fs.renameSync(p, dst)
          else if (same(p, dst)) fs.rmSync(p)
          else mergeMemory(p, dst, acct.name)
          n++
        }
      }
    }
    walk(base, "")
  }
  return n
}
