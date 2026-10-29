#!/bin/sh
# 单文件 IIFE 打包（3.3）。用法：sh build.sh [probe]
#   probe = 阶段 0 抓包版（PROTOCOL.discovery=true，只记结构不注入不落库）
set -e
cd "$(dirname "$0")"
[ -f dist/.banner.js ] || { echo "缺少 dist/.banner.js（UserScript 元数据头）"; exit 1; }

MODE="${1:-normal}"
if [ "$MODE" = "probe" ]; then
  python3 - <<'PY'
p='src/02-config.js'; s=open(p).read()
open(p+'.bak','w').write(s)
open(p,'w').write(s.replace('discovery: false','discovery: true',1))
PY
  OUT=dist/deepseek-web-mem-probe.user.js
else
  OUT=dist/deepseek-web-mem.user.js
fi

npx esbuild src/99-main.js \
  --bundle --format=iife --platform=browser --target=es2017 --minify \
  --legal-comments=none \
  --banner:js="$(cat dist/.banner.js)" \
  --outfile=$OUT

if [ "$MODE" = "probe" ]; then
  python3 - <<'PY'
p='src/02-config.js'; s=open(p+'.bak').read()
open(p,'w').write(s)
import os; os.remove(p+'.bak')
PY
fi

echo "--- built $OUT ---"
head -3 "$OUT"
wc -c "$OUT"
