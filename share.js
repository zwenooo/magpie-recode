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

// merge moves everything in from into to, folder by folder. moved,
// dropped (the same bytes were there) and kept (a different file was
// there: the older of the two went to conflicts) count what it did.
export function merge(from, to, conflicts, did = { moved: 0, dropped: 0, kept: 0 }) {
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
      merge(src, dst, path.join(conflicts, e.name), did)
      fs.rmdirSync(src)
      continue
    }
    if (!e.isDirectory() && !there.isDirectory() && same(src, dst)) {
      fs.rmSync(src)
      did.dropped++
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
        if (now - newest(link) < quietMs) {
          out.waiting.push(name)
          continue
        }
        out.merged[name] = merge(link, target, path.join(sharedDir, "conflicts", account.id, name))
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
