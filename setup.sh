#!/bin/bash
# Oracle Cloud Ubuntu 서버에서 한 번만 실행: bash setup.sh
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

npm ci --omit=dev
sudo npm install -g pm2

pm2 start bot.js --name good-day --node-args="--env-file=.env"
pm2 save
sudo env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME"  # 서버 재부팅 시 자동 실행
