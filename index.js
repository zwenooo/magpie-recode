// magpie loads this in its plugin host, which runs as long as magpie
// does. The host calls every function this file exports, so it exports
// only the plugin's.

import fs from "node:fs"
import path from "node:path"
import { Follower } from "./follow.js"

let follower

export default async function ReClaude(_input, options = {}) {
  // Only in magpie's plugin host, whose working folder is magpie's config
  // folder. Another program that loads the plugin (a page plugin's scan of
  // the installed plugins) leaves it be.
  const configDir = options.configDir || process.cwd()
  if (!follower && fs.existsSync(path.join(configDir, "library.json"))) {
    follower = new Follower({ ...options, configDir }).start()
  }
  return {}
}
