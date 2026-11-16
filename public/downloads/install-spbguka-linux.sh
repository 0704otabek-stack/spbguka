#!/usr/bin/env bash
set -e

SERVER_URL="${1:-https://video-53li.onrender.com}"
APP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/192x192/apps"
DESKTOP_FILE="$APP_DIR/spbguka.desktop"

mkdir -p "$APP_DIR" "$ICON_DIR"

echo "Скачиваю иконку СПБГУКА..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$SERVER_URL/icons/icon-192.png" -o "$ICON_DIR/spbguka.png"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$ICON_DIR/spbguka.png" "$SERVER_URL/icons/icon-192.png"
fi

BROWSER=""
for bin in google-chrome chromium chromium-browser microsoft-edge brave-browser vivaldi; do
  if command -v "$bin" >/dev/null 2>&1; then
    BROWSER="$bin"
    break
  fi
done

if [ -z "$BROWSER" ]; then
  echo "Не найден Chromium/Chrome/Edge/Brave. Установите Chrome или Chromium для запуска в режиме приложения."
  EXEC_CMD="xdg-open $SERVER_URL"
else
  EXEC_CMD="$BROWSER --app=$SERVER_URL --class=SPBGUKA --name=SPBGUKA"
fi

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=СПБГУКА
GenericName=Онлайн-кинотеатр
Comment=Фильмы, сериалы и аниме без рекламы с синхронизацией профиля
Exec=$EXEC_CMD
Icon=$ICON_DIR/spbguka.png
Terminal=false
Categories=AudioVideo;Video;Player;TV;
StartupWMClass=SPBGUKA
EOF

chmod +x "$DESKTOP_FILE"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APP_DIR" || true
echo "Готово! Приложение «СПБГУКА» добавлено в меню приложений (подключено к $SERVER_URL)."
