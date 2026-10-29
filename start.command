#!/bin/zsh
set -eu
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
runtime="runtime/darwin-$(uname -m | sed 's/x86_64/x64/')/node"
if [[ ! -x "$runtime" ]]; then
  runtime="$(command -v node || true)"
fi
if [[ -z "$runtime" ]]; then
  print '未找到运行环境，请完整解压体验包后再启动，或安装 Node.js 22.13+。'
  read -r '?按回车关闭…'
  exit 1
fi
if ! "$runtime" --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(":memory:"); db.close();' >/dev/null 2>&1; then
  print '运行环境无法启动，请确认电脑与体验包版本匹配。需要支持 node:sqlite 的 Node.js 22.13+。'
  read -r '?按回车关闭…'
  exit 1
fi
"$runtime" scripts/launch.mjs || { print '启动失败，请保留以上错误信息。'; read -r '?按回车关闭…'; exit 1; }
