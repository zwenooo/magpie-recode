# reclaude

让 ReClaude 的每个账号在 magpie 的 Library 里成为一行 `claude#rec-<id>`，
并且跟随 Claude Code（`claude` 行）的 MCP server、skill 和说明。换了新的
ReClaude 账号，第一次开 Claude 会话前就已经有 magpie 的 hub。

只用 magpie 官方的功能，不需要改 magpie。

## 做什么

插件在 magpie 的插件宿主里运行（宿主随 magpie 启动），每 5 秒看一次：

1. **建 junction**：`~/.rec/claude/accounts/<id>/config` 每多一个账号，就建
   `~/.claude-rec-<id>` 指过去。magpie 会把家目录下名为 `.claude-<名字>`、装着
   Claude Code 文件的文件夹认成 `claude#<名字>` 行，链接和 junction 也算。
   账号文件夹删掉后，删掉对应的 junction。同名的真文件夹，或者指向别处的链接，
   不动。
2. **跟随**：在 magpie 的 `library.json` 里，凡是勾了 `claude` 的 MCP server、
   skill 和说明，都给每个账号行勾上；没勾 `claude` 的，账号行也取消。只改
   这些勾选列表，其他内容原样保留；先写到旁边的临时文件，确认 `library.json`
   在这期间没被 magpie 改过，再换过去。
3. **同步**：有改动时运行一次 `magpie library sync`，由 magpie 把 Library
   写进各个账号。

为什么不用 `magpie library mcp|skill agents …` 一项一项改：magpie 的每条命令
都要先把所有 agent 看一遍（包括 WSL 里的），在作者的电脑上每条要 30 秒到
3 分钟，一个新账号要改几十项。直接改勾选列表再同步一次，新账号只需要一条命令。

账号行完全跟着 `claude` 行走：在账号行上单独勾选的东西，下一次检查时会被改回
和 `claude` 行一样。

已经不存在的账号（`claude#rec-<数字>`，账号文件夹和 junction 都没了）会从各个
勾选列表里去掉。别的名字的 `claude#…` 行不动。

Sessions 页也会读到这些账号的对话：magpie 会读家目录下每个 `.claude…` 文件夹
里的 `projects/`。

## 安装

在 magpie 的插件页添加，或者：

```sh
magpie plugin add github:zwenooo/magpie-plugins#reclaude-v0.1.1
```

## 选项

插件页里这个插件的 Options（都可以不填）：

| 选项 | 默认 | 作用 |
| --- | --- | --- |
| `recRoot` | `~/.rec/claude/accounts` | ReClaude 的账号文件夹 |
| `magpie` | 自动找 | magpie 命令行的路径。默认用启动插件宿主的那个 magpie 旁边的 `magpie.com`（Windows）或 `magpie`，找不到再用 PATH 里的 |
| `every` | `5000` | 多少毫秒检查一次 |
| `follow` | `true` | `false` 时只建 junction，不改勾选 |

## 注意

- 插件只在 magpie 的插件宿主里工作。magpie 启动时会起宿主，之后每小时也会
  问一次插件；装了任何插件，宿主基本一直在。
- 在终端运行 `magpie plugin …` 之类的命令时，命令自己也会临时起一个宿主，
  插件在里面也会检查一次。所有检查都可以重复做，并且同一时刻只有一个在做
  （系统临时目录下的 `magpie-reclaude.lock`）。
- 读写的是 magpie 的 `library.json`，它的格式不是公开接口。magpie 升级后，
  如果日志里出现 `[reclaude]` 的报错，或者新账号没有拿到 hub，先看这里。
- 欠着的同步记在系统临时目录的 `magpie-reclaude.lock.sync-owed`，做到一半被
  结束的进程留下的同步，下一次检查会补上。
- 在终端里从 ReClaude 账号的会话运行 magpie 命令时，环境里有
  `CLAUDE_CONFIG_DIR`，那个 magpie 会把该账号当成 Claude Code。插件在这样的
  进程里不工作。
- 项目级的设置（Library › Projects 里单独给某个项目加减的 MCP）不会跟随。
- 日志在 magpie 的日志里，以 `plugin: [reclaude]` 开头。

## 开发

```sh
bun test                     # 在本文件夹里
magpie plugin add <本文件夹>  # 直接装本地文件夹，改了文件 magpie 会自己重启宿主
```
