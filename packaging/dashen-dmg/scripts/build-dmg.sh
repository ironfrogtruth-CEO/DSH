#!/bin/bash
set -euo pipefail

PACKAGE_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SOURCE_ROOT="${DASHEN_SOURCE_ROOT:-/Users/marcus/.dsh}"
OUTPUT_ROOT="${DASHEN_OUTPUT_ROOT:-/Users/marcus/Desktop/大神安装包}"
VERSION="2.1.1"
NODE_VERSION="22.23.1"
BUILD_ROOT="$PACKAGE_ROOT/build"
CACHE_ROOT="$PACKAGE_ROOT/.cache/node-$NODE_VERSION"
NPM_CACHE_ROOT="$PACKAGE_ROOT/.cache/npm-prebuilt"
NPM_PREBUILT_LOCK="$PACKAGE_ROOT/resources/npm-prebuilt-lock.json"
APP="$BUILD_ROOT/stage/大神.app"
CONTENTS="$APP/Contents"
RESOURCES="$CONTENTS/Resources"
SEED="$BUILD_ROOT/seed/dsh-home"
DMG_STAGE="$BUILD_ROOT/dmg-root"
DMG="$OUTPUT_ROOT/大神-$VERSION-universal.dmg"

if [[ "$BUILD_ROOT" != "$PACKAGE_ROOT/build" ]]; then
  echo "拒绝清理非预期构建目录: $BUILD_ROOT" >&2
  exit 64
fi
/bin/rm -rf "$BUILD_ROOT"
mkdir -p "$BUILD_ROOT" "$CACHE_ROOT" "$NPM_CACHE_ROOT" "$OUTPUT_ROOT" "$CONTENTS/MacOS" "$RESOURCES/bin" "$RESOURCES/runtime" "$RESOURCES/payload"

download_node() {
  local node_arch="$1"
  local archive="node-v$NODE_VERSION-darwin-$node_arch.tar.gz"
  local archive_path="$CACHE_ROOT/$archive"
  local sums="$CACHE_ROOT/SHASUMS256.txt"
  if [[ ! -f "$sums" ]]; then
    /usr/bin/curl -fL --retry 3 "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$sums"
  fi
  local expected actual
  expected=$(awk -v file="$archive" '$2 == file {print $1}' "$sums")
  if [[ -f "$archive_path" ]]; then
    actual=$(shasum -a 256 "$archive_path" | awk '{print $1}')
    if [[ "$actual" != "$expected" ]]; then rm -f "$archive_path"; fi
  fi
  if [[ ! -f "$archive_path" ]]; then
    /usr/bin/curl -fL --retry 3 "https://npmmirror.com/mirrors/node/v$NODE_VERSION/$archive" -o "$archive_path"
  fi
  actual=$(shasum -a 256 "$archive_path" | awk '{print $1}')
  [[ -n "$expected" && "$expected" == "$actual" ]] || {
    echo "Node $node_arch 校验失败" >&2
    exit 1
  }
  local extract="$BUILD_ROOT/node-$node_arch"
  mkdir -p "$extract"
  tar -xzf "$archive_path" -C "$extract" --strip-components=1
  echo "$extract"
}

NODE_ARM=$(download_node arm64)
NODE_X64=$(download_node x64)
"$NODE_ARM/bin/node" "$PACKAGE_ROOT/scripts/prepare-seed.mjs" "$SOURCE_ROOT" "$SEED" "$PACKAGE_ROOT/resources/portable-seed"

install_prebuilt_package() {
  local package_name="$1"
  local version="$2"
  local destination="$3"
  local url integrity expected actual mirror_url spec
  spec="$package_name@$version"
  url=$("$NODE_ARM/bin/node" -e "const j=require(process.argv[1]);const p=j.packages[process.argv[2]];if(!p)process.exit(1);process.stdout.write(p.url)" "$NPM_PREBUILT_LOCK" "$spec")
  integrity=$("$NODE_ARM/bin/node" -e "const j=require(process.argv[1]);const p=j.packages[process.argv[2]];if(!p)process.exit(1);process.stdout.write(p.integrity)" "$NPM_PREBUILT_LOCK" "$spec")
  [[ "$url" == https://registry.npmjs.org/* ]] || { echo "非预期 npm 下载地址: $package_name" >&2; exit 1; }
  [[ "$integrity" == sha512-* ]] || { echo "缺少 npm 完整性值: $package_name" >&2; exit 1; }
  local archive="$NPM_CACHE_ROOT/$(echo "$package_name-$version" | tr '/@' '__').tgz"
  expected=${integrity#sha512-}
  if [[ -f "$archive" ]]; then
    actual=$(openssl dgst -sha512 -binary "$archive" | openssl base64 -A)
    if [[ "$actual" != "$expected" ]]; then rm -f "$archive"; fi
  fi
  if [[ ! -f "$archive" ]]; then
    mirror_url=${url/https:\/\/registry.npmjs.org\//https:\/\/registry.npmmirror.com\/}
    /usr/bin/curl -fL --retry 5 --retry-all-errors "$mirror_url" -o "$archive"
  fi
  actual=$(openssl dgst -sha512 -binary "$archive" | openssl base64 -A)
  [[ "$actual" == "$expected" ]] || { echo "npm 完整性校验失败: $package_name" >&2; exit 1; }
  /bin/rm -rf "$destination"
  mkdir -p "$destination"
  tar -xzf "$archive" -C "$destination" --strip-components=1
}

install_prebuilt_package "@img/sharp-darwin-x64" "0.35.3" "$SEED/install/node_modules/@img/sharp-darwin-x64"
install_prebuilt_package "@img/sharp-libvips-darwin-x64" "1.3.2" "$SEED/install/node_modules/@img/sharp-libvips-darwin-x64"
install_prebuilt_package "@koromix/koffi-darwin-x64" "3.1.6" "$SEED/install/node_modules/@koromix/koffi-darwin-x64"
install_prebuilt_package "node-addon-require-builtin-darwin-x64" "0.1.5" "$SEED/install/node_modules/node-addon-require-builtin-darwin-x64"

PATH="$NODE_ARM/bin:$PATH" "$NODE_ARM/bin/node" -e "const {createRequire}=require('module');const r=createRequire('$SEED/install/package.json');r('sharp');r('koffi');r('node-pty');console.log('arm64-native-modules-ok')"
arch -x86_64 "$NODE_X64/bin/node" -e "const {createRequire}=require('module');const r=createRequire('$SEED/install/package.json');r('sharp');r('koffi');r('node-pty');console.log('x86_64-native-modules-ok')"

"$NODE_ARM/bin/node" "$PACKAGE_ROOT/scripts/secret-scan.mjs" "$SOURCE_ROOT/.credentials.yaml" "$SEED"

/usr/bin/ditto --noqtn "$NODE_ARM" "$RESOURCES/runtime/node-arm64"
/usr/bin/ditto --noqtn "$NODE_X64" "$RESOURCES/runtime/node-x86_64"
/usr/bin/ditto --noqtn "$SEED" "$RESOURCES/payload/dsh-home"
cp "$PACKAGE_ROOT/resources/bin/dashen-runtime" "$RESOURCES/bin/dashen-runtime"
cp "$PACKAGE_ROOT/resources/bin/configure-portable.mjs" "$RESOURCES/bin/configure-portable.mjs"
cp "$PACKAGE_ROOT/resources/AppIcon.icns" "$RESOURCES/AppIcon.icns"
cp "$PACKAGE_ROOT/resources/menubar-logo.png" "$RESOURCES/menubar-logo.png"
cp "$PACKAGE_ROOT/resources/templates/首次打开说明.txt" "$RESOURCES/首次打开说明.txt"
cp "$NPM_PREBUILT_LOCK" "$RESOURCES/npm-prebuilt-lock.json"
cp "$PACKAGE_ROOT/contracts/work-contract.json" "$RESOURCES/work-contract.json"
cp "$PACKAGE_ROOT/resources/templates/Info.plist" "$CONTENTS/Info.plist"
printf '%s\n' "$VERSION" > "$RESOURCES/version.txt"
chmod 755 "$RESOURCES/bin/dashen-runtime" "$RESOURCES/bin/configure-portable.mjs"

xcrun swiftc -O -target arm64-apple-macos11.0 \
  -o "$BUILD_ROOT/大神-arm64" "$PACKAGE_ROOT/src/大神便携版.swift" \
  -framework Cocoa -framework WebKit -framework Speech -framework AVFoundation
xcrun swiftc -O -target x86_64-apple-macos11.0 \
  -o "$BUILD_ROOT/大神-x86_64" "$PACKAGE_ROOT/src/大神便携版.swift" \
  -framework Cocoa -framework WebKit -framework Speech -framework AVFoundation
lipo -create "$BUILD_ROOT/大神-arm64" "$BUILD_ROOT/大神-x86_64" -output "$CONTENTS/MacOS/大神"
chmod 755 "$CONTENTS/MacOS/大神"

DSH_VERSION=$("$NODE_ARM/bin/node" -p "require('$SEED/install/node_modules/@deepseek-ai/dsh/package.json').version")
SOURCE_COMMIT=$(git -C "$SOURCE_ROOT" rev-parse HEAD)
SOURCE_DIRTY=$(git -C "$SOURCE_ROOT" status --porcelain | wc -l | tr -d ' ')
"$NODE_ARM/bin/node" -e "const fs=require('fs');fs.writeFileSync(process.argv[1],JSON.stringify({schema:'dashen-distribution-manifest.v1',version:process.argv[2],nodeVersion:process.argv[3],dshVersion:process.argv[4],architectures:['arm64','x86_64'],minimumMacOS:'11.0',sourceCommit:process.argv[5],sourceDirtyEntries:Number(process.argv[6]),signing:'ad-hoc-app-with-preserved-node-developer-id',notarized:false,generatedAt:new Date().toISOString()},null,2)+'\n')" "$RESOURCES/distribution-manifest.json" "$VERSION" "$NODE_VERSION" "$DSH_VERSION" "$SOURCE_COMMIT" "$SOURCE_DIRTY"

mkdir -p "$RESOURCES/licenses"
cp "$NODE_ARM/LICENSE" "$RESOURCES/licenses/Node.js-LICENSE.txt"
if [[ -f "$SEED/install/node_modules/@deepseek-ai/dsh/LICENSE" ]]; then
  cp "$SEED/install/node_modules/@deepseek-ai/dsh/LICENSE" "$RESOURCES/licenses/DeepSeek-Harness-LICENSE.txt"
fi

while IFS= read -r -d '' file; do
  if /usr/bin/file "$file" | grep -q 'Mach-O'; then
    if codesign -dv --verbose=2 "$file" 2>&1 | grep '^Authority=' >/dev/null; then
      echo "preserve trusted signature: $file"
    else
      codesign --force --sign - "$file" >/dev/null
    fi
  fi
done < <(find "$APP" -type f -print0)
codesign --force --sign - "$APP" >/dev/null

plutil -lint "$CONTENTS/Info.plist"
lipo -info "$CONTENTS/MacOS/大神"
codesign --verify --deep --strict --verbose=2 "$APP"

mkdir -p "$DMG_STAGE"
/usr/bin/ditto --noqtn "$APP" "$DMG_STAGE/大神.app"
ln -s /Applications "$DMG_STAGE/Applications"
cp "$PACKAGE_ROOT/resources/templates/首次打开说明.txt" "$DMG_STAGE/首次打开说明.txt"
cp "$PACKAGE_ROOT/resources/templates/诊断大神.command" "$DMG_STAGE/诊断大神.command"
cp "$PACKAGE_ROOT/resources/templates/卸载大神.command" "$DMG_STAGE/卸载大神.command"
chmod 755 "$DMG_STAGE/诊断大神.command" "$DMG_STAGE/卸载大神.command"

rm -f "$DMG"
hdiutil create -volname "大神 $VERSION 安装程序" -srcfolder "$DMG_STAGE" -ov -format UDZO -imagekey zlib-level=9 "$DMG"
shasum -a 256 "$DMG" > "$DMG.sha256"
cp "$RESOURCES/distribution-manifest.json" "$OUTPUT_ROOT/发行清单.json"
cp "$PACKAGE_ROOT/resources/templates/首次打开说明.txt" "$OUTPUT_ROOT/首次打开说明.txt"
cp "$PACKAGE_ROOT/contracts/work-contract.json" "$OUTPUT_ROOT/工作合同.json"

echo "DMG=$DMG"
echo "APP=$APP"
echo "SHA256=$(awk '{print $1}' "$DMG.sha256")"
