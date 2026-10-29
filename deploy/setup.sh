#!/bin/bash
# うわさ裁判を ConoHa VPS に載せるスクリプト（kitakuArcade と同居、nginx + Cloudflare 前提）
# 使い方: sudo bash deploy/setup.sh rumor.kitakuarcade.com
set -e
DOMAIN=${1:-rumor.kitakuarcade.com}
SRC=$(cd "$(dirname "$0")/.." && pwd)
KITAKU_CONF=/etc/nginx/sites-available/kitakuarcade

echo "== Webサーバーの確認 =="
systemctl is-active --quiet nginx || { echo "nginx が動いていません。ここで止めます"; exit 1; }

echo "== Node.js =="
node -v
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] || { echo "Node 18 以上が必要です"; exit 1; }

echo "== ファイル配置 =="
mkdir -p /opt/rumor-court
cp -r "$SRC"/. /opt/rumor-court/
mkdir -p /opt/rumor-court/.cache
chown -R www-data:www-data /opt/rumor-court
[ -f /opt/rumor-court/.env ] || echo "※ /opt/rumor-court/.env がありません。APIキーを書いてから sudo systemctl restart rumor-court してください"

echo "== 常駐（systemd） =="
cp "$SRC/deploy/rumor-court.service" /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now rumor-court && systemctl restart rumor-court
sleep 1 && curl -s http://127.0.0.1:8787/api/status | head -c 200; echo

echo "== nginx（kitakuArcade と同じ Cloudflare 証明書を使う） =="
CERT=$(grep -m1 -E '^\s*ssl_certificate\s' "$KITAKU_CONF" | awk '{print $2}' | tr -d ';')
KEY=$(grep -m1 -E '^\s*ssl_certificate_key\s' "$KITAKU_CONF" | awk '{print $2}' | tr -d ';')
echo "cert: $CERT"; echo "key : $KEY"
[ -n "$CERT" ] && [ -n "$KEY" ] || { echo "証明書の場所が読み取れませんでした。ここで止めます"; exit 1; }
cat > /etc/nginx/sites-available/rumor-court <<NGINX
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}
server {
    listen 443 ssl;
    server_name $DOMAIN;
    ssl_certificate     $CERT;
    ssl_certificate_key $KEY;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$http_cf_connecting_ip;
        proxy_read_timeout 180s;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/rumor-court /etc/nginx/sites-enabled/rumor-court
nginx -t && systemctl reload nginx
echo "完了: https://$DOMAIN （Cloudflare の DNS に $DOMAIN を「プロキシ有効（オレンジ雲）」で追加しておくこと）"
