// Every ReCode account's CLAUDE.md the same as Claude Code's own.
//
// Claude Code reads its user instructions from <config>/CLAUDE.md, and a
// ReCode account's config folder is its own: an account made before the
// last edit of ~/.claude/CLAUDE.md kept the old text, and one made since
// had none. magpie's Library writes only its own part of the file (its
// instruction set, between marker lines), and only when the user keeps one,
// so the rest of the file never reached the accounts.
//
// So ~/.claude/CLAUDE.md is copied into each account. A line an account
// added since it was last written (Claude noting something there) is
// joined into ~/.claude/CLAUDE.md first, and so reaches every account. A
// line changed or taken out in an account comes back: edit Claude Code's
// own file for that. A file this never wrote (the first run) is replaced,
// not joined, as it may be an old copy: what it had that the new one
// lacks is kept in <sharedDir>/backups/<account>/ first. Nothing is lost.

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export const FILE = "CLAUDE.md"

function read(p) {
  try {
    return fs.readFileSync(p, "utf8")
  } catch {
    return null
  }
}

export function hashOf(text) {
  return text === null ? "" : crypto.createHash("sha256").update(text).digest("hex")
}

function lines(text) {
  return (text ?? "").split(/\r?\n/).map((l) => l.trimEnd())
}

// added is the lines of text that base doesn't have, blank ones left out,
// in text's order.
export function added(text, base) {
  const have = new Set(lines(base).map((l) => l.trim()).filter(Boolean))
  const out = []
  for (const l of lines(text)) {
    const t = l.trim()
    if (!t || have.has(t)) continue
    have.add(t)
    out.push(l)
  }
  return out
}

function writeFile(p, text) {
  const tmp = `${p}.recode-${process.pid}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, p)
}

function stamp(now) {
  return new Date(now).toISOString().replace(/[:.]/g, "-")
}

export function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"))
    return s && typeof s === "object" && s.accounts && typeof s.accounts === "object" ? s : { accounts: {} }
  } catch {
    return { accounts: {} }
  }
}

// followClaudeMd does one pass. main is Claude Code's CLAUDE.md, accounts
// [{id, dir}], stateFile where it keeps what it last wrote into each
// account (a hash), backupDir where a file it replaces goes first. It
// returns {joined: {id: lines}, written: [ids], backedUp: {id: file},
// problems}. With no main file it does nothing: a file Claude Code doesn't
// have is not taken from the accounts.
export function followClaudeMd({ main, accounts, stateFile, backupDir, now = Date.now() }) {
  const out = { joined: {}, written: [], backedUp: {}, problems: [] }
  let text = read(main)
  if (text === null) return out
  const state = readState(stateFile)
  const wrote = state.accounts

  // lines an account added since it was written go into Claude Code's own
  let more = []
  for (const a of accounts) {
    const cur = read(path.join(a.dir, FILE))
    if (cur === null || !wrote[a.id] || hashOf(cur) === wrote[a.id]) continue
    const add = added(cur, [text, ...more].join("\n"))
    if (add.length) {
      out.joined[a.id] = add
      more = more.concat(add)
    }
  }
  if (more.length) {
    text = text.replace(/\s*$/, "") + (text.trim() ? "\n" : "") + more.join("\n") + "\n"
    try {
      writeFile(main, text)
    } catch (e) {
      out.problems.push(`${main}: ${e.message}`)
      return out
    }
  }

  const want = hashOf(text)
  for (const a of accounts) {
    const file = path.join(a.dir, FILE)
    const cur = read(file)
    if (cur !== null && hashOf(cur) === want) {
      wrote[a.id] = want
      continue
    }
    try {
      // a file this didn't write, with lines Claude Code's lacks: kept
      if (cur !== null && hashOf(cur) !== wrote[a.id] && added(cur, text).length) {
        const dir = path.join(backupDir, a.id)
        fs.mkdirSync(dir, { recursive: true })
        const keep = path.join(dir, `CLAUDE-${stamp(now)}.md`)
        fs.writeFileSync(keep, cur)
        out.backedUp[a.id] = keep
      }
      writeFile(file, text)
      wrote[a.id] = want
      out.written.push(a.id)
    } catch (e) {
      out.problems.push(`${file}: ${e.message}`)
    }
  }
  for (const id of Object.keys(wrote)) if (!accounts.some((a) => a.id === id)) delete wrote[id]
  state.main = want
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    writeFile(stateFile, JSON.stringify(state, null, 2))
  } catch (e) {
    out.problems.push(`${stateFile}: ${e.message}`)
  }
  return out
}
