#!/bin/bash
# =============================================================
# DeepSeek Design/PPT Studio 品牌补丁重放脚本
# 用途: 插件升级后, 一键把品牌改回 ShrimpTank 版
#   - Studio 左上角: HTML(Design) / 皮皮虾(PPT) + by ShrimpTank
#   - 全部模板: iPolloWork -> ShrimpTank, 品牌图标 -> 无边框虾缸 logo
#   - 导出后品牌不回退(bundle 重命名为独立文件名, 规避 immutable 缓存)
# 幂等: 可反复执行; 已应用过的步骤自动跳过
# 用法: bash replay-brand.sh
# =============================================================
set -euo pipefail

NPM=/Users/marcus/.dsh/profiles/web/node_modules
SHRIMP=/Users/marcus/.dsh/extensions/shrimp-shell/assets/hero-mark-cropped.png
BINDIR="$NPM/deepseek-idesign/studio/dist"
PPTDIR="$NPM/deepseek-ippt/studio/dist"

if [ ! -f "$SHRIMP" ]; then
  echo "错误: 找不到虾缸 logo 素材 $SHRIMP"; exit 1
fi

echo "== 1/4 Studio bundle 品牌字符串 + 重命名(缓存根治) =="
/usr/bin/python3 - "$BINDIR" "$PPTDIR" << 'PY'
import io, os, sys, shutil

def patch_bundle(dist, title_old, title_new):
    # 找主 bundle: index.html 当前引用的那个
    idx = io.open(os.path.join(dist, 'index.html'), encoding='utf-8').read()
    import re
    m = re.search(r'src="\./assets/(index-[^"?]+)\.js', idx)
    if not m:
        print('  跳过(找不到 index.html 中的 bundle 引用):', dist); return
    cur = m.group(1) + '.js'
    if cur.endswith('-ipw.js'):
        target = cur
    else:
        target = m.group(1) + '-ipw.js'
    bundle = os.path.join(dist, 'assets', cur)
    if not os.path.exists(bundle):
        print('  跳过(bundle 不存在):', bundle); return
    s = io.open(bundle, encoding='utf-8').read()
    changed = False
    for old, new in [('byline:"by iPolloWork"', 'byline:"by ShrimpTank"'),
                     (f'title:"{title_old}"', f'title:"{title_new}"'),
                     ('l.matches("h1,h2,h3,h4,h5,h6,p,li")||l8(l)&&l.children.length===0){l.innerText.trim()',
                      'l.matches("h1,h2,h3,h4,h5,h6,p,li,span,strong,b,em,i,small,sub,sup")||l8(l)&&l.children.length===0){l.innerText.trim()}')]:
        if old in s:
            s = s.replace(old, new); changed = True
    if changed:
        io.open(bundle, 'w', encoding='utf-8').write(s)
        print('  品牌字符串已应用:', os.path.basename(bundle))
    else:
        print('  品牌字符串已是最新(跳过)')
    if not os.path.exists(os.path.join(dist, 'assets', target)):
        shutil.copy(bundle, os.path.join(dist, 'assets', target))
        print('  已生成独立文件名:', target)
    # index.html 引用指向 -ipw.js
    if cur != target:
        idx2 = idx.replace('./assets/' + cur, './assets/' + target).replace('?v=', '?v=')
        io.open(os.path.join(dist, 'index.html'), 'w', encoding='utf-8').write(idx2)
        print('  index.html 已指向', target)

patch_bundle(sys.argv[1], 'iDesign', 'HTML')
patch_bundle(sys.argv[2], 'iPPT', '皮皮虾')
PY

echo "== 2/4 模板文本替换 iPolloWork -> ShrimpTank =="
/usr/bin/python3 - "$NPM" "$SHRIMP" << 'PY'
import os, sys, json, io, base64
NPM, SHRIMP = sys.argv[1], sys.argv[2]
OLD = b'iPolloWork'; NEW = b'ShrimpTank'
total = 0
for pkg in ('deepseek-idesign', 'deepseek-ippt'):
    root = os.path.join(NPM, pkg, 'lib', 'templates')
    if not os.path.isdir(root): continue
    for tdir in sorted(os.listdir(root)):
        base = os.path.join(root, tdir)
        if not os.path.isdir(base): continue
        ep = os.path.join(base, 'entry.html')
        if os.path.exists(ep):
            data = open(ep, 'rb').read()
            if OLD in data:
                open(ep, 'wb').write(data.replace(OLD, NEW)); total += data.count(OLD)
        mp = os.path.join(base, 'manifest.json')
        if os.path.exists(mp):
            try:
                m = json.load(io.open(mp, encoding='utf-8')); ch = False
                for k in ('title', 'description'):
                    if isinstance(m.get(k), str) and 'iPolloWork' in m[k]:
                        m[k] = m[k].replace('iPolloWork', 'ShrimpTank'); ch = True
                if ch:
                    io.open(mp, 'w', encoding='utf-8').write(json.dumps(m, ensure_ascii=False, indent=2)); total += 1
            except Exception: pass
print(f'  替换 {total} 处')
PY

echo "== 3/4 模板品牌图标 -> 无边框虾缸 logo =="
/usr/bin/python3 - "$NPM" "$SHRIMP" << 'PY'
import os, sys, base64
NPM, SHRIMP = sys.argv[1], sys.argv[2]
png_b64 = base64.b64encode(open(SHRIMP, 'rb').read()).decode()
svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 963 984" width="963" height="984">'
       '<image width="963" height="984" preserveAspectRatio="xMidYMid meet" '
       'href="data:image/png;base64,' + png_b64 + '"/></svg>').encode()
n = 0
for pkg in ('deepseek-idesign', 'deepseek-ippt'):
    root = os.path.join(NPM, pkg, 'lib', 'templates')
    if not os.path.isdir(root): continue
    for tdir in sorted(os.listdir(root)):
        logo = os.path.join(root, tdir, 'assets', 'ipollowork-logo.svg')
        if os.path.exists(logo) and open(logo, 'rb').read() != svg:
            open(logo, 'wb').write(svg); n += 1
print(f'  替换 {n} 个 logo')
PY

echo "== 4/4 校验 =="
LEFT=$(grep -rl "iPolloWork" "$BINDIR/../lib/templates" "$PPTDIR/../lib/templates" 2>/dev/null | grep -vE "LICENSE|NOTICE" || true)
if [ -n "$LEFT" ]; then echo "警告: 仍有残留:"; echo "$LEFT"; else echo "  模板无品牌残留 ✓"; fi
grep -q "皮皮虾" "$PPTDIR/assets/index-"*-ipw.js 2>/dev/null && echo "  PPT bundle 品牌 ✓" || echo "  警告: PPT bundle 品牌未应用"
grep -q "HTML" "$BINDIR/assets/index-"*-ipw.js 2>/dev/null && echo "  Design bundle 品牌 ✓" || echo "  警告: Design bundle 品牌未应用"

echo "== 5/4 品牌强制守护脚本(导出后不回退) =="
/usr/bin/python3 - "$BINDIR" "$PPTDIR" << 'PY'
import io, os, sys
ENFORCE = '''
<script>
/* [ipw-brand-guard] 本地品牌强制: 任何情况下(含缓存旧 bundle/导出重载)都不显示 iPPT/iDesign/by iPolloWork */
(function () {
  function fix() {
    document.querySelectorAll('strong,span,p,a,div').forEach(function (el) {
      if (el.children.length > 0) return;
      var t = el.textContent;
      if (t === 'iPPT') el.textContent = '皮皮虾';
      else if (t === 'iDesign') el.textContent = 'HTML';
      else if (t === 'by iPolloWork') el.textContent = 'by ShrimpTank';
    });
  }
  fix();
  var mo = new MutationObserver(fix);
  mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
})();
</script>
'''
for dist in sys.argv[1:]:
    html = os.path.join(dist, 'index.html')
    s = io.open(html, encoding='utf-8').read()
    if '[ipw-brand-guard]' in s:
        print('  守护脚本已存在:', os.path.basename(dist)); continue
    marker = '</body>' if '</body>' in s else '</html>'
    s = s.replace(marker, ENFORCE + '\n' + marker)
    io.open(html, 'w', encoding='utf-8').write(s)
    print('  守护脚本已注入:', os.path.basename(dist))
PY

echo "完成。刷新浏览器生效(无需重启服务)。"
