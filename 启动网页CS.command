#!/bin/zsh
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then source "$HOME/.nvm/nvm.sh"; fi
fi
if ! command -v node >/dev/null 2>&1; then
  echo '请先安装 Node.js 22.12 或更高版本。'
  read '?按回车退出…'
  exit 1
fi
if [[ ! -f dist/private.html || ! -f artifacts/performance-maps/maps-v1/catalog.json || ! -f public/assets/characters-cs2/ct-sas.glb ]]; then
  node local/install.mjs || { read '?安装失败，按回车退出…'; exit 1; }
fi
node local/start.mjs --open
