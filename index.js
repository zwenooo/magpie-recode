// magpie loads this in its plugin host, which runs as long as magpie
// does. The host calls every function this file exports, so it exports
// only the plugin's.

import { Follower, whyNot } from "./follow.js"

let follower

export default async function ReClaude(_input, options = {}) {
  const configDir = options.configDir || process.cwd()
  const why = whyNot(process.env, configDir)
  if (why) {
    if (process.env.CLAUDE_CONFIG_DIR) console.error(`[reclaude] ${why}`)
  } else if (!follower) {
    follower = new Follower({ ...options, configDir }).start()
  }
  return {}
}
