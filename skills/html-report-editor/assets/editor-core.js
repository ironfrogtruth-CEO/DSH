// Editable HTML Report Deck Core
// Provides widget editing, asset replacement, page background controls,
// clean HTML saving and PDF-safe print preparation.

(function(){
  const deck = document.getElementById('deck');
  if(!deck) return;

  const toolbar = document.getElementById('textToolbar');
  let selected = null;
  let currentSlide = deck.querySelector('.slide');
  let drag = null, resize = null, savedRange = null, guideV = null, guideH = null;
  let assetPanel = null;

  function px(v){ return parseFloat(v || 0) || 0; }
  function getSlide(el){ return el && el.closest ? el.closest('.slide') : null; }
  function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }

  function activeSlide(){
    if(selected && getSlide(selected)) return getSlide(selected);
    const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    const visible = getSlide(hit);
    if(visible) return visible;
    return currentSlide || deck.querySelector('.slide');
  }

  function selectedImage(){
    if(!selected) return null;
    if(selected.matches && selected.matches('img')) return selected;
    return selected.querySelector ? selected.querySelector('img') : null;
  }

  function getAssetRoot(){
    return document.body.dataset.assetRoot || window.PA_ASSET_ROOT || 'resources/pingan-materials';
  }

  function normalizeJoin(root, path){
    if(!path) return '';
    if(/^data:|^https?:|^\//.test(path)) return path;
    return String(root || '').replace(/\/$/, '') + '/' + String(path).replace(/^\//, '');
  }

  function getAssetMap(){
    if(window.PA_ASSET_MAP) return window.PA_ASSET_MAP;
    const el = document.getElementById('paAssetMap');
    if(!el) return null;
    try{
      window.PA_ASSET_MAP = JSON.parse(el.textContent);
      return window.PA_ASSET_MAP;
    }catch(err){
      console.warn('Invalid paAssetMap JSON', err);
      return null;
    }
  }

  function initWidget(w){
    if(!w.classList.contains('widget') || w.dataset.inited) return;
    w.dataset.inited = '1';

    const label = document.createElement('div');
    label.className = 'widget-label';
    label.textContent = '组件：可拖动 / 可缩放';
    const handle = document.createElement('div');
    handle.className = 'drag-handle';
    handle.textContent = '拖动';
    const del = document.createElement('button');
    del.className = 'widget-delete';
    del.type = 'button';
    del.textContent = '×';
    del.title = '删除组件';
    w.append(label, handle, del);

    ['nw','n','ne','e','se','s','sw','w'].forEach(pos => {
      const h = document.createElement('span');
      h.className = 'resize-handle ' + pos;
      h.dataset.dir = pos;
      w.appendChild(h);
    });

    w.addEventListener('mousedown', () => selectWidget(w));
    handle.addEventListener('mousedown', e => startDrag(e, w));
    del.addEventListener('click', e => {
      e.stopPropagation();
      w.remove();
      if(selected === w) selected = null;
      hideAssetPanel();
    });
    w.querySelectorAll(':scope > .resize-handle').forEach(h => {
      h.addEventListener('mousedown', e => startResize(e, w, h.dataset.dir));
    });
  }

  function selectWidget(w){
    if(!w) return;
    if(selected && selected !== w) selected.classList.remove('selected');
    selected = w;
    selected.classList.add('selected');
    currentSlide = getSlide(w) || currentSlide;
    updateSelectionControls();
  }

  function deselectAll(){
    if(selected) selected.classList.remove('selected');
    selected = null;
    updateSelectionControls();
    hideAssetPanel();
  }

  function ensureGuides(slide){
    if(!guideV){
      guideV = document.createElement('div');
      guideV.className = 'guide v';
      guideH = document.createElement('div');
      guideH.className = 'guide h';
    }
    if(guideV.parentElement !== slide) slide.append(guideV, guideH);
  }

  function hideGuides(){
    if(guideV){
      guideV.style.display = 'none';
      guideH.style.display = 'none';
    }
  }

  function nearest(value, targets, threshold = 8){
    let best = null, dist = Infinity;
    for(const t of targets){
      const d = Math.abs(value - t);
      if(d < threshold && d < dist){ best = t; dist = d; }
    }
    return best;
  }

  function componentTargets(slide, w){
    const targetsX = [0,40,80,640,1200,1240,1280];
    const targetsY = [0,40,80,360,640,680,720];
    slide.querySelectorAll('.widget').forEach(o => {
      if(o === w) return;
      const l = px(o.style.left), t = px(o.style.top), wi = px(o.style.width), he = px(o.style.height);
      targetsX.push(l, l + wi / 2, l + wi);
      targetsY.push(t, t + he / 2, t + he);
    });
    return {targetsX, targetsY};
  }

  function snapBox(l,t,w,h,targetsX,targetsY){
    let guideX = null, guideY = null;
    const xCandidates = [{kind:'left', value:l}, {kind:'center', value:l+w/2}, {kind:'right', value:l+w}];
    const yCandidates = [{kind:'top', value:t}, {kind:'middle', value:t+h/2}, {kind:'bottom', value:t+h}];

    for(const c of xCandidates){
      const hit = nearest(c.value, targetsX);
      if(hit !== null){
        guideX = hit;
        if(c.kind === 'left') l = hit;
        if(c.kind === 'center') l = hit - w / 2;
        if(c.kind === 'right') l = hit - w;
        break;
      }
    }
    for(const c of yCandidates){
      const hit = nearest(c.value, targetsY);
      if(hit !== null){
        guideY = hit;
        if(c.kind === 'top') t = hit;
        if(c.kind === 'middle') t = hit - h / 2;
        if(c.kind === 'bottom') t = hit - h;
        break;
      }
    }
    return {l,t,guideX,guideY};
  }

  function showGuideFor(slide,x,y){
    ensureGuides(slide);
    if(x != null){ guideV.style.left = x + 'px'; guideV.style.display = 'block'; } else guideV.style.display = 'none';
    if(y != null){ guideH.style.top = y + 'px'; guideH.style.display = 'block'; } else guideH.style.display = 'none';
  }

  function startDrag(e,w){
    e.preventDefault();
    e.stopPropagation();
    selectWidget(w);
    const slide = getSlide(w);
    const {targetsX, targetsY} = componentTargets(slide, w);
    drag = {
      w, slide,
      startX:e.clientX, startY:e.clientY,
      left:px(w.style.left), top:px(w.style.top),
      width:px(w.style.width), height:px(w.style.height),
      targetsX, targetsY
    };
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', endDrag);
  }

  function onDrag(e){
    if(!drag) return;
    let nl = drag.left + (e.clientX - drag.startX);
    let nt = drag.top + (e.clientY - drag.startY);
    const s = snapBox(nl, nt, drag.width, drag.height, drag.targetsX, drag.targetsY);
    nl = clamp(s.l, 0, 1280 - drag.width);
    nt = clamp(s.t, 0, 720 - drag.height);
    drag.w.style.left = nl + 'px';
    drag.w.style.top = nt + 'px';
    showGuideFor(drag.slide, s.guideX, s.guideY);
  }

  function endDrag(){
    drag = null;
    hideGuides();
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', endDrag);
  }

  function startResize(e,w,dir){
    e.preventDefault();
    e.stopPropagation();
    selectWidget(w);
    const slide = getSlide(w);
    const {targetsX, targetsY} = componentTargets(slide, w);
    resize = {
      w, slide, dir,
      startX:e.clientX, startY:e.clientY,
      left:px(w.style.left), top:px(w.style.top),
      width:px(w.style.width), height:px(w.style.height),
      targetsX, targetsY,
      ratio:px(w.style.width) / Math.max(1, px(w.style.height))
    };
    document.addEventListener('mousemove', onResize);
    document.addEventListener('mouseup', endResize);
  }

  function onResize(e){
    if(!resize) return;
    let dx = e.clientX - resize.startX, dy = e.clientY - resize.startY;
    let l = resize.left, t = resize.top, w = resize.width, h = resize.height;

    if(resize.dir.includes('e')) w = resize.width + dx;
    if(resize.dir.includes('s')) h = resize.height + dy;
    if(resize.dir.includes('w')){ w = resize.width - dx; l = resize.left + dx; }
    if(resize.dir.includes('n')){ h = resize.height - dy; t = resize.top + dy; }

    if(e.shiftKey && resize.dir.length === 2){
      if(Math.abs(dx) > Math.abs(dy)) h = w / resize.ratio;
      else w = h * resize.ratio;
    }

    w = Math.max(48, w);
    h = Math.max(32, h);

    const s = snapBox(l, t, w, h, resize.targetsX, resize.targetsY);
    l = clamp(s.l, 0, 1280 - w);
    t = clamp(s.t, 0, 720 - h);

    resize.w.style.left = l + 'px';
    resize.w.style.top = t + 'px';
    resize.w.style.width = w + 'px';
    resize.w.style.height = h + 'px';
    showGuideFor(resize.slide, s.guideX, s.guideY);
  }

  function endResize(){
    resize = null;
    hideGuides();
    document.removeEventListener('mousemove', onResize);
    document.removeEventListener('mouseup', endResize);
  }

  function initImageSlot(slot){
    if(slot.dataset.inited) return;
    slot.dataset.inited = '1';
    slot.addEventListener('dblclick', () => pickImageForSlot(slot));
    slot.addEventListener('click', e => {
      if(e.altKey) slot.classList.toggle('contain');
    });
  }

  function pickImageForSlot(slot){
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = () => {
      const f = inp.files[0];
      if(!f) return;
      const r = new FileReader();
      r.onload = () => {
        let img = slot.querySelector('img');
        if(!img){ img = document.createElement('img'); slot.appendChild(img); }
        img.src = r.result;
        slot.classList.add('has-img');
      };
      r.readAsDataURL(f);
    };
    inp.click();
  }

  function initSlide(slide){
    if(slide.dataset.inited) return;
    slide.dataset.inited = '1';
    slide.addEventListener('mousedown', e => {
      currentSlide = slide;
      if(e.target === slide || e.target.classList.contains('slide-content')) deselectAll();
    });
    let layer = slide.querySelector('.slide-bg-layer');
    if(!layer){
      layer = document.createElement('div');
      layer.className = 'slide-bg-layer';
      slide.prepend(layer);
    }
    let tools = slide.querySelector('.page-tools');
    if(!tools){
      tools = document.createElement('div');
      tools.className = 'page-tools';
      slide.appendChild(tools);
    }
    tools.innerHTML = '';
    const del = makeButton('删页', () => deleteSlide(slide));
    const bg = makeButton('背景', () => chooseBackground(slide));
    const clear = makeButton('清背景', () => clearBackground(slide));
    const opacity = document.createElement('input');
    opacity.type = 'range';
    opacity.min = '0';
    opacity.max = '1';
    opacity.step = '0.05';
    opacity.value = layer.style.opacity || '0';
    opacity.title = '背景透明度';
    opacity.addEventListener('input', () => { layer.style.opacity = opacity.value; });
    tools.append(del, bg, opacity, clear);
  }

  function makeButton(text, fn){
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    btn.addEventListener('click', e => { e.stopPropagation(); fn(e); });
    return btn;
  }

  function deleteSlide(slide){
    const slides = deck.querySelectorAll('.slide');
    if(slides.length <= 1) return;
    if(!window.confirm('删除当前页？')) return;
    const next = slide.nextElementSibling || slide.previousElementSibling;
    slide.remove();
    currentSlide = next && next.classList.contains('slide') ? next : deck.querySelector('.slide');
    renumberSlides();
  }

  function renumberSlides(){
    deck.querySelectorAll('.slide').forEach((slide, idx) => {
      slide.dataset.page = String(idx + 1);
      const n = slide.querySelector('.pa-page-number');
      if(n) n.textContent = String(idx + 1);
    });
  }

  function chooseBackground(slide){
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = () => {
      const f = inp.files[0];
      if(!f) return;
      const r = new FileReader();
      r.onload = () => {
        const layer = slide.querySelector('.slide-bg-layer');
        layer.style.backgroundImage = `url("${r.result}")`;
        if(!layer.style.opacity || layer.style.opacity === '0') layer.style.opacity = '0.22';
        const range = slide.querySelector('.page-tools input[type="range"]');
        if(range) range.value = layer.style.opacity;
      };
      r.readAsDataURL(f);
    };
    inp.click();
  }

  function clearBackground(slide){
    const layer = slide.querySelector('.slide-bg-layer');
    if(!layer) return;
    layer.style.backgroundImage = '';
    layer.style.opacity = '0';
    const range = slide.querySelector('.page-tools input[type="range"]');
    if(range) range.value = '0';
  }

  function selectionInDeck(sel){
    return sel && sel.rangeCount && !sel.isCollapsed && sel.anchorNode && deck.contains(sel.anchorNode);
  }

  function saveSelection(){
    const sel = window.getSelection();
    if(selectionInDeck(sel)){
      savedRange = sel.getRangeAt(0).cloneRange();
      const rect = savedRange.getBoundingClientRect();
      if(toolbar && (rect.width || rect.height)){
        toolbar.style.left = (window.scrollX + rect.left) + 'px';
        toolbar.style.top = (window.scrollY + rect.top - 44) + 'px';
        toolbar.style.display = 'flex';
      }
    }
  }

  function applyStyle(styleObj){
    if(savedRange){
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
      const span = document.createElement('span');
      Object.assign(span.style, styleObj);
      try{
        savedRange.surroundContents(span);
      }catch(err){
        const frag = savedRange.extractContents();
        span.appendChild(frag);
        savedRange.insertNode(span);
      }
      sel.removeAllRanges();
      if(toolbar) toolbar.style.display = 'none';
      savedRange = null;
      return;
    }
    if(selected){
      const content = selected.querySelector('.widget-content') || selected;
      Object.assign(content.style, styleObj);
    }
  }

  function alignSelected(value){
    applyStyle({textAlign:value});
  }

  function insertFreeText(){
    const slide = activeSlide();
    if(!slide) return;
    const content = slide.querySelector('.slide-content') || slide;
    const w = document.createElement('div');
    w.className = 'widget';
    w.style.left = '80px';
    w.style.top = '120px';
    w.style.width = '260px';
    w.style.height = '64px';
    w.innerHTML = '<div class="widget-content pa-body" contenteditable="true">双击或直接编辑文字</div>';
    content.appendChild(w);
    initWidget(w);
    selectWidget(w);
  }

  function findAssetTarget(){
    if(!selected) return null;
    const img = selectedImage();
    if(img && img.dataset.replacementGroup) return img;
    return selected.querySelector('img[data-replacement-group]');
  }

  function updateSelectionControls(){
    const img = selectedImage();
    const widget = selected && selected.classList && selected.classList.contains('widget') ? selected : null;
    const replaceAsset = document.getElementById('replaceAsset');
    const replaceImage = document.getElementById('replaceImage');
    const imageFit = document.getElementById('imageFit');
    const imageOpacity = document.getElementById('imageOpacity');
    const widgetWidth = document.getElementById('widgetWidth');
    const widgetHeight = document.getElementById('widgetHeight');
    const layerUp = document.getElementById('layerUp');
    const layerDown = document.getElementById('layerDown');

    if(replaceAsset) replaceAsset.disabled = !findAssetTarget();
    if(replaceImage) replaceImage.disabled = !img;
    if(imageFit){
      imageFit.disabled = !img;
      if(img) imageFit.value = img.style.objectFit || getComputedStyle(img).objectFit || 'cover';
    }
    if(imageOpacity){
      imageOpacity.disabled = !img;
      if(img) imageOpacity.value = img.style.opacity || getComputedStyle(img).opacity || '1';
    }
    if(widgetWidth){
      widgetWidth.disabled = !widget;
      widgetWidth.value = widget ? Math.round(px(widget.style.width) || widget.getBoundingClientRect().width) : '';
    }
    if(widgetHeight){
      widgetHeight.disabled = !widget;
      widgetHeight.value = widget ? Math.round(px(widget.style.height) || widget.getBoundingClientRect().height) : '';
    }
    if(layerUp) layerUp.disabled = !selected;
    if(layerDown) layerDown.disabled = !selected;
  }

  function chooseLocalImage(callback){
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      if(!f) return;
      const r = new FileReader();
      r.onload = () => callback(r.result, f);
      r.readAsDataURL(f);
    };
    inp.click();
  }

  function insertFreeImage(){
    const slide = activeSlide();
    if(!slide) return;
    chooseLocalImage((src, file) => {
      const content = slide.querySelector('.slide-content') || slide;
      const w = document.createElement('div');
      const width = 300;
      const height = 190;
      const sr = slide.getBoundingClientRect();
      const left = clamp(window.innerWidth / 2 - sr.left - width / 2, 40, 1280 - width - 40);
      const top = clamp(window.innerHeight / 2 - sr.top - height / 2, 70, 720 - height - 40);
      w.className = 'widget image-widget';
      w.dataset.assetKind = 'free-image';
      w.style.left = Math.round(left) + 'px';
      w.style.top = Math.round(top) + 'px';
      w.style.width = width + 'px';
      w.style.height = height + 'px';
      w.innerHTML = `<div class="widget-content"><img class="pa-free-image" src="${src}" alt="${escapeAttr((file && file.name) || '插入图片')}"></div>`;
      content.appendChild(w);
      initWidget(w);
      selectWidget(w);
    });
  }

  function replaceLocalImage(){
    const img = selectedImage();
    if(!img) return;
    chooseLocalImage((src, file) => {
      img.src = src;
      if(file && file.name) img.alt = file.name;
      updateSelectionControls();
    });
  }

  function applyImageFit(value){
    const img = selectedImage();
    if(!img) return;
    img.style.objectFit = value;
    if(img.closest('.image-slot')){
      img.closest('.image-slot').classList.toggle('contain', value === 'contain');
    }
    updateSelectionControls();
  }

  function applyImageOpacity(value){
    const img = selectedImage();
    if(!img) return;
    img.style.opacity = value;
    updateSelectionControls();
  }

  function updateWidgetSize(kind, value){
    if(!selected || !selected.classList.contains('widget')) return;
    const numeric = Math.max(20, parseFloat(value) || 20);
    selected.style[kind] = numeric + 'px';
    updateSelectionControls();
  }

  function moveLayer(delta){
    if(!selected) return;
    const z = parseInt(selected.style.zIndex || getComputedStyle(selected).zIndex || '3', 10);
    selected.style.zIndex = String(Math.max(0, (Number.isFinite(z) ? z : 3) + delta));
    updateSelectionControls();
  }

  function ensureAssetPanel(){
    if(assetPanel) return assetPanel;
    assetPanel = document.createElement('div');
    assetPanel.className = 'asset-panel';
    assetPanel.innerHTML = '<div class="asset-panel-head"><b>替换素材</b><button type="button" data-close>×</button></div><div class="asset-panel-list"></div>';
    assetPanel.querySelector('[data-close]').addEventListener('click', hideAssetPanel);
    document.body.appendChild(assetPanel);
    return assetPanel;
  }

  function showAssetPanel(){
    const img = findAssetTarget();
    const map = getAssetMap();
    if(!img || !map) return;
    const group = img.dataset.replacementGroup;
    const items = (map.groups && map.groups[group]) || [];
    const root = document.body.dataset.assetRoot || map.library_root || getAssetRoot();
    const panel = ensureAssetPanel();
    const list = panel.querySelector('.asset-panel-list');
    list.innerHTML = '';
    items.forEach(item => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'asset-choice';
      const src = normalizeJoin(root, item.file_path);
      card.innerHTML = `<span class="asset-choice-thumb"><img src="${escapeAttr(src)}" alt=""></span><span>${escapeHtml(item.display_name || item.asset_id)}</span><em>${escapeHtml(item.license_status || '')}</em>`;
      card.addEventListener('click', () => {
        img.src = src;
        img.dataset.assetId = item.asset_id;
        img.alt = item.display_name || item.asset_id;
        updateSelectionControls();
        hideAssetPanel();
      });
      list.appendChild(card);
    });
    if(!items.length){
      list.innerHTML = '<p class="asset-panel-empty">当前元素没有可替换素材组。</p>';
    }
    panel.style.display = 'block';
  }

  function hideAssetPanel(){
    if(assetPanel) assetPanel.style.display = 'none';
  }

  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function escapeAttr(str){ return escapeHtml(str); }

  function cleanCloneForSave(){
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
    clone.querySelectorAll('.widget-label,.drag-handle,.widget-delete,.resize-handle,.guide,.asset-panel').forEach(el => el.remove());
    clone.querySelectorAll('.widget,.image-slot,.slide').forEach(el => el.removeAttribute('data-inited'));
    clone.querySelectorAll('.text-toolbar').forEach(el => el.style.display = 'none');
    return '<!doctype html>\n' + clone.outerHTML;
  }

  function saveHtml(){
    prepareForPrint();
    const html = cleanCloneForSave();
    const blob = new Blob([html], {type:'text/html;charset=utf-8'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = document.body.dataset.downloadName || 'report-edited.html';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 100);
  }

  function prepareForPrint(){
    deselectAll();
    hideGuides();
    hideAssetPanel();
    if(toolbar) toolbar.style.display = 'none';
    document.body.classList.add('print-clean');
  }

  function printPdf(){
    prepareForPrint();
    setTimeout(() => window.print(), 50);
  }

  function bindToolbar(){
    const byId = id => document.getElementById(id);
    byId('fontSelect')?.addEventListener('change', e => applyStyle({fontFamily:e.target.value}));
    byId('fontSizeSelect')?.addEventListener('change', e => applyStyle({fontSize:e.target.value}));
    byId('colorSelect')?.addEventListener('change', e => applyStyle({color:e.target.value}));
    byId('boldBtn')?.addEventListener('click', () => applyStyle({fontWeight:'800'}));
    byId('underlineBtn')?.addEventListener('click', () => applyStyle({textDecoration:'underline'}));
    byId('alignLeftBtn')?.addEventListener('click', () => alignSelected('left'));
    byId('alignCenterBtn')?.addEventListener('click', () => alignSelected('center'));
    byId('insertText')?.addEventListener('click', insertFreeText);
    byId('insertImage')?.addEventListener('click', insertFreeImage);
    byId('replaceImage')?.addEventListener('click', replaceLocalImage);
    byId('imageFit')?.addEventListener('change', e => applyImageFit(e.target.value));
    byId('imageOpacity')?.addEventListener('input', e => applyImageOpacity(e.target.value));
    byId('widgetWidth')?.addEventListener('change', e => updateWidgetSize('width', e.target.value));
    byId('widgetHeight')?.addEventListener('change', e => updateWidgetSize('height', e.target.value));
    byId('layerUp')?.addEventListener('click', () => moveLayer(1));
    byId('layerDown')?.addEventListener('click', () => moveLayer(-1));
    byId('saveHtml')?.addEventListener('click', saveHtml);
    byId('printPdf')?.addEventListener('click', printPdf);
    byId('replaceAsset')?.addEventListener('click', showAssetPanel);
  }

  window.EditableReportDeck = {
    initWidget,
    initImageSlot,
    initSlide,
    applyStyle,
    insertFreeText,
    insertFreeImage,
    replaceLocalImage,
    saveHtml,
    prepareForPrint,
    printPdf,
    showAssetPanel,
    get selected(){ return selected; },
    set selected(v){ selected = v; updateSelectionControls(); }
  };

  document.querySelectorAll('.slide').forEach(initSlide);
  document.querySelectorAll('.widget').forEach(initWidget);
  document.querySelectorAll('.image-slot').forEach(initImageSlot);
  bindToolbar();
  updateSelectionControls();

  document.addEventListener('mouseup', () => setTimeout(saveSelection, 10));
  document.addEventListener('keyup', () => setTimeout(saveSelection, 10));
  document.addEventListener('keydown', e => {
    if((e.key === 'Delete' || e.key === 'Backspace') && selected && !document.activeElement.closest('[contenteditable="true"]')){
      selected.remove();
      selected = null;
      updateSelectionControls();
      e.preventDefault();
    }
  });
  window.addEventListener('beforeprint', prepareForPrint);
})();
