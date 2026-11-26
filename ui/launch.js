// magpie's page for a plugin can reach nothing, so this one goes on to the
// panel's local service (service.js): magpie.service in magpie web, else
// 127.0.0.1 at the plugin's port. The theme goes with it in the address.
;(async () => {
  const say = document.getElementById("say")
  await magpie.ready
  let port = 3587
  try {
    const o = await magpie.options.get()
    if (Number(o?.port) > 0) port = Number(o.port)
  } catch {}
  let base = magpie.service || `http://127.0.0.1:${port}/`
  if (!base.endsWith("/")) base += "/"
  const t = magpie.theme || {}
  const theme = encodeURIComponent(JSON.stringify({ dark: !!t.dark, tokens: t.tokens || {} }))
  // a refused address leaves the frame here, with no error to catch
  setTimeout(() => {
    say.textContent = `ReCode 面板没有打开：它的服务（${base}）没有回应。在「插件」页确认 ReCode 是打开的；端口被别的程序占用时，在 ReCode 的选项里改 port。`
  }, 8000)
  location.assign(base + "#theme=" + theme)
})()
