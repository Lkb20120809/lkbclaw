#!/bin/bash
set -e
VER=$(node -e "console.log(require('./package.json').version)")
rm -f "lkbclaw-$VER.tgz"
npm pack >/dev/null
rm -rf _x && mkdir _x
tar -xzf "lkbclaw-$VER.tgz" -C _x
node -e "const fs=require('fs');const f='_x/package/package.json';const j=JSON.parse(fs.readFileSync(f));j.bin={lkbclaw:'./src/lkbclaw.js'};fs.writeFileSync(f,JSON.stringify(j,null,2));"
chmod +x _x/package/src/lkbclaw.js
tar -czf "lkbclaw-$VER.tgz" -C _x package
rm -rf _x
echo "built lkbclaw-$VER.tgz (bin restored, exec bit set)"
