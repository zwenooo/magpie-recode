// magpie loads this in its plugin host, which runs as long as magpie
// does. The host calls every function this file exports, so it exports
// only the plugin's.

import { Follower, whyNot } from "./follow.js"
import { serve } from "./service.js"

const PORT = 3587

let follower

export default async function ReCode(_input, options = {}) {
  const configDir = options.configDir || process.cwd()
  const why = whyNot(process.env, configDir)
  if (why) {
    if (process.env.CLAUDE_CONFIG_DIR) console.error(`[recode] ${why}`)
  } else if (!follower) {
    follower = new Follower({ ...options, configDir }).start()
    // the panel's server: the host that follows serves it (a magpie
    // command's host is given a free port of its own by magpie)
    const port = Number(options.port) || PORT
    serve({ port, follower, options, log: follower.log })
  }
  return {}
}
