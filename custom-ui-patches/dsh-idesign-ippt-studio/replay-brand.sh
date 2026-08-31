#!/bin/bash
# =============================================================
# DeepSeek Design/PPT Studio 品牌补丁重放脚本
# 用途: 插件升级后, 一键把品牌改回 ShrimpTank 版
#   - Studio 左上角: HTML(Design) / 皮皮虾(PPT) + by ShrimpTank
#   - 全部模板: iPolloWork -> ShrimpTank；保留原模板图标、尺寸与位置
#   - 导出后品牌不回退(bundle 重命名为独立文件名, 规避 immutable 缓存)
# 幂等: 可反复执行; 已应用过的步骤自动跳过
# 用法: bash replay-brand.sh [/path/to/dsh-root]
# =============================================================
set -euo pipefail

DSH_ROOT="${1:-/Users/marcus/.dsh}"
NPM="$DSH_ROOT/profiles/web/node_modules"
ORIGINAL_TEMPLATE_LOGO="$DSH_ROOT/custom-ui-patches/dsh-idesign-ippt-studio/original/ipollowork-logo.svg"
MODIFIED_TEMPLATES_ROOT="$DSH_ROOT/custom-ui-patches/dsh-idesign-ippt-studio/modified/templates"
BINDIR="$NPM/deepseek-idesign/studio/dist"
PPTDIR="$NPM/deepseek-ippt/studio/dist"
PINGAN_TEMPLATE_SRC="$DSH_ROOT/custom-ui-patches/dsh-idesign-ippt-studio/templates/deepseek-ippt/shrimptank.pptx-pingan-health"
PINGAN_TEMPLATE_DST="$NPM/deepseek-ippt/lib/templates/shrimptank.pptx-pingan-health"
IPPT_HOST="$NPM/deepseek-ippt/lib/index.js"

if [ ! -f "$ORIGINAL_TEMPLATE_LOGO" ]; then
  echo "错误: 找不到原模板 logo $ORIGINAL_TEMPLATE_LOGO"; exit 1
fi

echo "== 1/4 Studio bundle 品牌字符串 + 重命名(缓存根治) =="
/usr/bin/python3 - "$BINDIR" "$PPTDIR" << 'PY'
import hashlib, io, os, re, sys

def patch_bundle(dist, title_old, title_new):
    # 找主 bundle: index.html 当前引用的那个
    idx = io.open(os.path.join(dist, 'index.html'), encoding='utf-8').read()
    m = re.search(r'src="\./assets/(index-[^"?]+)\.js', idx)
    if not m:
        print('  跳过(找不到 index.html 中的 bundle 引用):', dist); return
    cur = m.group(1) + '.js'
    bundle = os.path.join(dist, 'assets', cur)
    if not os.path.exists(bundle):
        print('  跳过(bundle 不存在):', bundle); return
    s = io.open(bundle, encoding='utf-8').read()
    changed = False
    for old, new in [('byline:"by iPolloWork"', 'byline:"by ShrimpTank"'),
                     (f'title:"{title_old}"', f'title:"{title_new}"'),
                     ('l.matches("h1,h2,h3,h4,h5,h6,p,li")||l8(l)&&l.children.length===0){l.innerText.trim()',
                      'l.matches("h1,h2,h3,h4,h5,h6,p,li,span,strong,b,em,i,small,sub,sup")||l8(l)&&l.children.length===0){l.innerText.trim()'),
                     ('l.matches("h1,h2,h3,h4,h5,h6,p,li,span,strong,b,em,i,small,sub,sup")||l8(l)&&l.children.length===0){l.innerText.trim()}&&!vb(d)',
                      'l.matches("h1,h2,h3,h4,h5,h6,p,li,span,strong,b,em,i,small,sub,sup")||l8(l)&&l.children.length===0){l.innerText.trim()&&!vb(d)'),
                     ('Te(null),ss(null),ts(!1),ie(!1)},[x,e,Ue,a])',
                      'Te(null),ss(null),ts(!1),ie(!1),setTimeout(()=>{const te=w.current;if(!te)return;const xe=te.getBoundingClientRect();E({width:xe.width,height:xe.height})},80)},[x,e,Ue,a])'),
                     ('Te(null),ss(null),ts(!1),ie(!1),window.requestAnimationFrame(()=>{const te=w.current;if(!te)return;const xe=te.getBoundingClientRect();E({width:xe.width,height:xe.height})})},[x,e,Ue,a])',
                      'Te(null),ss(null),ts(!1),ie(!1),setTimeout(()=>{const te=w.current;if(!te)return;const xe=te.getBoundingClientRect();E({width:xe.width,height:xe.height})},80)},[x,e,Ue,a])'),
                     ('e.load(e.template.manifest.id).then',
                      'e.load(e.template.manifest.id,e.template.manifest.version).then'),
                     ('[e.load,e.template.manifest.id,a])',
                      '[e.load,e.template.manifest.id,e.template.manifest.version,a])'),
                     ('B=v.useCallback(A=>h?h(e.workspaceId,A):Promise.reject',
                      'B=v.useCallback((A,N)=>h?h(e.workspaceId,A,N):Promise.reject'),
                     ('getDesignStudioTemplateCover:async(e,s)=>{const a=await fetch(`${ex}/template-cover${Ki({workspaceId:e,templateId:s})}`',
                      'getDesignStudioTemplateCover:async(e,s,r)=>{const a=await fetch(`${ex}/template-cover${Ki({workspaceId:e,templateId:s,version:r})}`')]:
        if old in s:
            s = s.replace(old, new); changed = True
    source_stem = re.sub(r'-ipw(?:-[0-9a-f]{12})?$', '', m.group(1))
    digest = hashlib.sha256(s.encode('utf-8')).hexdigest()[:12]
    target = f'{source_stem}-ipw-{digest}.js'
    target_path = os.path.join(dist, 'assets', target)
    if not os.path.exists(target_path) or io.open(target_path, encoding='utf-8').read() != s:
        io.open(target_path, 'w', encoding='utf-8').write(s)
        print('  品牌 bundle 已生成:', target)
    else:
        print('  品牌 bundle 已是最新:', target)
    # index.html 引用指向内容寻址文件，插件/模板更新后不会命中旧 immutable 缓存
    if cur != target:
        idx2 = idx.replace('./assets/' + cur, './assets/' + target)
        io.open(os.path.join(dist, 'index.html'), 'w', encoding='utf-8').write(idx2)
        print('  index.html 已指向', target)

patch_bundle(sys.argv[1], 'iDesign', 'HTML')
patch_bundle(sys.argv[2], 'iPPT', '皮皮虾')
PY

echo "== 2/4 模板文本替换 iPolloWork -> ShrimpTank =="
/usr/bin/python3 - "$NPM" << 'PY'
import os, sys, json, io, base64
NPM = sys.argv[1]
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

echo "== 3/4 恢复全部模板原图标 + 刷新图标缓存 =="
/usr/bin/python3 - "$NPM" "$ORIGINAL_TEMPLATE_LOGO" "$MODIFIED_TEMPLATES_ROOT" << 'PY'
import os, re, sys
NPM, ORIGINAL_TEMPLATE_LOGO, MODIFIED_TEMPLATES_ROOT = sys.argv[1:4]
svg = open(ORIGINAL_TEMPLATE_LOGO, 'rb').read()
restored = 0
cache_busted = 0
for pkg in ('deepseek-idesign', 'deepseek-ippt'):
    roots = (
        os.path.join(NPM, pkg, 'lib', 'templates'),
        os.path.join(MODIFIED_TEMPLATES_ROOT, pkg),
    )
    for root in roots:
        if not os.path.isdir(root): continue
        for tdir in sorted(os.listdir(root)):
            base = os.path.join(root, tdir)
            logo = os.path.join(base, 'assets', 'ipollowork-logo.svg')
            if os.path.exists(logo) and open(logo, 'rb').read() != svg:
                open(logo, 'wb').write(svg); restored += 1
            entry = os.path.join(base, 'entry.html')
            if os.path.exists(logo) and os.path.exists(entry):
                data = open(entry, 'rb').read()
                updated = re.sub(rb'ipollowork-logo\.svg\?v=[^"\']+', b'ipollowork-logo.svg?v=20260831-logo-fix-1', data)
                if updated != data:
                    open(entry, 'wb').write(updated)
                    cache_busted += 1
print(f'  恢复 {restored} 个模板图标；刷新 {cache_busted} 个引用缓存键')
PY

echo "== 4/6 安装平安企业健康 PPT 模板 =="
if [ ! -d "$PINGAN_TEMPLATE_SRC" ]; then
  echo "错误: 找不到平安模板源 $PINGAN_TEMPLATE_SRC"; exit 1
fi
/usr/bin/rsync -a --delete "$PINGAN_TEMPLATE_SRC/" "$PINGAN_TEMPLATE_DST/"
echo "  平安模板已同步: $PINGAN_TEMPLATE_DST"

echo "== 5/7 登记平安模板并关闭封面陈旧缓存 =="
/usr/bin/python3 - "$IPPT_HOST" << 'PY'
import io, sys
path = sys.argv[1]
template_id = 'shrimptank.pptx-pingan-health'
text = io.open(path, encoding='utf-8').read()
changed = False
if f'"{template_id}"' in text:
    print('  平安模板目录登记已存在')
else:
    anchor = '\t"ipollowork.html-anything.deck-presenter-mode"\n]);'
    replacement = '\t"ipollowork.html-anything.deck-presenter-mode",\n\t"shrimptank.pptx-pingan-health"\n]);'
    if anchor not in text:
        raise SystemExit('错误: iPPT 客户可见模板白名单结构已变化，必须重新兼容审查')
    text = text.replace(anchor, replacement, 1)
    changed = True
    print('  平安模板已登记到客户可见目录')
old_cache = '"cache-control": "public, max-age=86400"'
new_cache = '"cache-control": "no-store"'
if old_cache in text:
    text = text.replace(old_cache, new_cache, 1)
    changed = True
    print('  模板封面缓存已改为 no-store')
elif new_cache in text:
    print('  模板封面缓存策略已是 no-store')
else:
    raise SystemExit('错误: iPPT 模板封面缓存结构已变化，必须重新兼容审查')
if changed:
    io.open(path, 'w', encoding='utf-8').write(text)
PY

echo "== 6/7 校验 =="
LEFT=$(grep -rl "iPolloWork" "$BINDIR/../lib/templates" "$PPTDIR/../lib/templates" 2>/dev/null | grep -vE "LICENSE|NOTICE" || true)
if [ -n "$LEFT" ]; then echo "警告: 仍有残留:"; echo "$LEFT"; else echo "  模板无品牌残留 ✓"; fi
grep -q "皮皮虾" "$PPTDIR/assets/index-"*-ipw-*.js 2>/dev/null && echo "  PPT bundle 品牌 ✓" || echo "  警告: PPT bundle 品牌未应用"
grep -q "HTML" "$BINDIR/assets/index-"*-ipw-*.js 2>/dev/null && echo "  Design bundle 品牌 ✓" || echo "  警告: Design bundle 品牌未应用"
if grep -Rql 'viewBox="0 0 963 984"' "$NPM/deepseek-idesign/lib/templates" "$NPM/deepseek-ippt/lib/templates" 2>/dev/null; then
  echo "错误: 仍有巨型虾缸模板图标残留"; exit 1
fi

echo "== 7/7 品牌强制守护脚本(下载/模板/导出/重载后不回退) =="
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
