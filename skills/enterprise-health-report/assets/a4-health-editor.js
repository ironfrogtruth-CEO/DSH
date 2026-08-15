(function(){
  const body=document.body;
  let edit=false, selected=null, drag=null, lastPage=null, uid=0, selectionBox=null, snapLayer=null;
  const SNAP_TOLERANCE=6;
  const byId=id=>document.getElementById(id);
  const toggle=byId('toggleEdit');
  const selectedInfo=byId('selectedInfo');
  const imageFit=byId('imageFit');
  const imageOpacity=byId('imageOpacity');
  const widgetWidth=byId('widgetWidth');
  const widgetHeight=byId('widgetHeight');
  const footerTopOpacity=byId('footerTopOpacity');
  const footerBottomOpacity=byId('footerBottomOpacity');

  function ensureFileInput(id,accept){
    let input=byId(id);
    if(!input){
      input=document.createElement('input');
      input.id=id;
      input.type='file';
      document.body.appendChild(input);
    }
    input.type='file';
    input.accept=accept||'image/*';
    input.hidden=false;
    input.tabIndex=-1;
    input.setAttribute('aria-hidden','true');
    input.style.position='fixed';
    input.style.left='-9999px';
    input.style.top='-9999px';
    input.style.width='1px';
    input.style.height='1px';
    input.style.opacity='0';
    input.style.pointerEvents='none';
    return input;
  }
  function replaceInput(){return ensureFileInput('replaceImage','image/*')}
  function insertInput(){return ensureFileInput('insertImage','image/*')}
  function px(v){return parseFloat(v||0)||0}
  function injectEditorRuntimeStyle(){
    if(document.getElementById('a4EditorRuntimeStyle'))return;
    const style=document.createElement('style');
    style.id='a4EditorRuntimeStyle';
    style.textContent=[
      '.selection-box{position:absolute;z-index:9998;border:1.5px solid #2563eb;pointer-events:auto;box-shadow:0 0 0 9999px rgba(37,99,235,.02)}',
      '.selection-box .selection-label{position:absolute;left:0;top:-24px;background:#152031;color:#fff;border-radius:6px;padding:3px 7px;font-size:12px;font-weight:800;line-height:1;white-space:nowrap}',
      '.selection-box .resize-handle{position:absolute;width:9px;height:9px;border-radius:999px;background:#fff;border:1.5px solid #2563eb}',
      '.selection-box .resize-handle.nw{left:-5px;top:-5px;cursor:nwse-resize}.selection-box .resize-handle.n{left:50%;top:-5px;transform:translateX(-50%);cursor:ns-resize}.selection-box .resize-handle.ne{right:-5px;top:-5px;cursor:nesw-resize}.selection-box .resize-handle.e{right:-5px;top:50%;transform:translateY(-50%);cursor:ew-resize}.selection-box .resize-handle.se{right:-5px;bottom:-5px;cursor:nwse-resize}.selection-box .resize-handle.s{left:50%;bottom:-5px;transform:translateX(-50%);cursor:ns-resize}.selection-box .resize-handle.sw{left:-5px;bottom:-5px;cursor:nesw-resize}.selection-box .resize-handle.w{left:-5px;top:50%;transform:translateY(-50%);cursor:ew-resize}',
      '.snap-guide-layer{position:absolute;inset:0;z-index:9997;pointer-events:none}',
      '.snap-guide{position:absolute;background:#22c55e;box-shadow:0 0 0 1px rgba(255,255,255,.75)}',
      '.snap-guide.v{top:0;bottom:0;width:1px}.snap-guide.h{left:0;right:0;height:1px}',
      '@media print{.selection-box,.snap-guide-layer{display:none!important}.selected{outline:none!important}}'
    ].join('');
    document.head.appendChild(style);
  }
  injectEditorRuntimeStyle();
  function nameOf(el){
    if(!el)return '未选中元素';
    if(el.dataset.editorName)return el.dataset.editorName;
    if(el.classList.contains('image-widget'))return '图片：自由图片';
    if(el.tagName==='IMG')return '图片：'+(el.alt||'未命名图片');
    if(el.classList.contains('editable-image-layer')){
      return ({background:'图片：背景图层',top:'图片：顶图',footer:'图片：底图',pageFooter:'图片：页脚图'}[el.dataset.layer])||'图片：图层';
    }
    if(el.closest?.('.report-note'))return '组件：解读模块';
    if(el.dataset.component)return '组件：'+el.dataset.component;
    const text=(el.innerText||'').trim().replace(/\s+/g,' ').slice(0,18);
    return text?'组件：'+text:'页面元素';
  }
  function selectedImage(){
    if(!selected)return null;
    if(selected.tagName==='IMG')return selected;
    return selected.querySelector?selected.querySelector('img'):null;
  }
  function isImageLayer(el){return !!el?.classList?.contains('editable-image-layer')}
  function isFooterLayer(el){return isImageLayer(el)&&el.dataset.layer==='pageFooter'}
  function isTopLayer(el){return isImageLayer(el)&&el.dataset.layer==='top'}
  function backgroundFit(el){
    const size=el.style.backgroundSize||getComputedStyle(el).backgroundSize||'cover';
    if(size==='contain')return 'contain';
    if(size==='100% 100%')return 'fill';
    return 'cover';
  }
  function setBackgroundFit(el,value){el.style.backgroundSize=value==='fill'?'100% 100%':value}
  function imageReplaceTarget(el){
    if(!el)return null;
    if(el.matches?.('img'))return el;
    if(el.closest?.('.image-widget'))return el.closest('.image-widget');
    const imageBlock=el.closest?.('.photo-card,.image-card,.activity-photo,.photo-tile,[data-image-editable="true"]');
    if(imageBlock)return imageBlock;
    if(el.classList?.contains('editable-image-layer'))return el;
    return el.closest?.('.editable-image-layer');
  }
  function isBackgroundImageTarget(el){
    if(!el||isImageLayer(el))return false;
    if(el.classList?.contains('photo-card')||el.classList?.contains('image-card')||el.classList?.contains('activity-photo')||el.classList?.contains('photo-tile')||el.dataset?.imageEditable==='true')return true;
    const inlineBg=el.style?.backgroundImage;
    if(inlineBg&&inlineBg!=='none')return true;
    return false;
  }
  function syncTopLayers(cb){document.querySelectorAll('.top-image-slot').forEach(layer=>cb(layer))}
  function syncFooterLayers(cb){document.querySelectorAll('.page-footer-slot').forEach(layer=>cb(layer))}
  function updateControls(){
    const img=selectedImage();
    const layer=isImageLayer(selected);
    const bgTarget=isBackgroundImageTarget(selected);
    const footer=isFooterLayer(selected);
    const box=selected&&!layer?selected:null;
    const imageLike=!!img||layer||bgTarget;
    [imageFit,imageOpacity,widgetWidth,widgetHeight,footerTopOpacity,footerBottomOpacity].forEach(c=>{if(c)c.disabled=true});
    if(byId('triggerReplace'))byId('triggerReplace').disabled=!imageLike;
    if(byId('bringForward'))byId('bringForward').disabled=!selected;
    if(byId('sendBackward'))byId('sendBackward').disabled=!selected;
    if(byId('deleteSelected'))byId('deleteSelected').disabled=!selected;
    if(imageLike&&imageFit&&imageOpacity){
      imageFit.disabled=false;
      imageOpacity.disabled=false;
      imageFit.value=layer||bgTarget?backgroundFit(selected):(img.style.objectFit||getComputedStyle(img).objectFit||'cover');
      imageOpacity.value=layer||bgTarget?(selected.style.opacity||getComputedStyle(selected).opacity||'1'):(img.style.opacity||getComputedStyle(img).opacity||'1');
    }
    if(box&&widgetWidth&&widgetHeight){
      const r=box.getBoundingClientRect();
      widgetWidth.disabled=false;
      widgetHeight.disabled=false;
      widgetWidth.value=Math.round(px(box.style.width)||r.width);
      widgetHeight.value=Math.round(px(box.style.height)||r.height);
    }
    if(footer&&footerTopOpacity&&footerBottomOpacity){
      footerTopOpacity.disabled=false;
      footerBottomOpacity.disabled=false;
      footerTopOpacity.value=getComputedStyle(selected).getPropertyValue('--footer-top-opacity').trim()||'0';
      footerBottomOpacity.value=getComputedStyle(selected).getPropertyValue('--footer-bottom-opacity').trim()||'1';
    }
  }
  function removeSelectionBox(){selectionBox?.remove();selectionBox=null}
  function positionSelectionBox(){
    if(!selectionBox||!selected)return;
    const page=selected.closest('.page');
    if(!page)return;
    const pr=page.getBoundingClientRect();
    const r=selected.getBoundingClientRect();
    selectionBox.style.left=(r.left-pr.left)+'px';
    selectionBox.style.top=(r.top-pr.top)+'px';
    selectionBox.style.width=r.width+'px';
    selectionBox.style.height=r.height+'px';
  }
  function createSelectionBox(){
    removeSelectionBox();
    const page=selected.closest('.page');
    if(!page)return;
    selectionBox=document.createElement('div');
    selectionBox.className='selection-box';
    selectionBox.innerHTML='<span class="selection-label"></span>'+['nw','n','ne','e','se','s','sw','w'].map(d=>`<i class="resize-handle ${d}" data-dir="${d}"></i>`).join('');
    selectionBox.querySelector('.selection-label').textContent=nameOf(selected);
    page.appendChild(selectionBox);
    positionSelectionBox();
  }
  function clearSelection(){
    document.querySelectorAll('.selected').forEach(e=>e.classList.remove('selected'));
    removeSelectionBox();
    clearSnapGuides();
    selected=null;
    if(selectedInfo)selectedInfo.textContent='未选中元素';
    updateControls();
  }
  function select(el){
    clearSelection();
    selected=el;
    selected.classList.add('selected');
    if(selectedInfo)selectedInfo.textContent='已选：'+nameOf(el);
    createSelectionBox();
    updateControls();
  }
  function activePage(){
    if(selected?.closest('.page'))return selected.closest('.page');
    if(lastPage)return lastPage;
    const el=document.elementFromPoint(Math.floor(window.innerWidth/2),Math.floor(window.innerHeight/2));
    return el?.closest?.('.page')||document.querySelector('.page');
  }
  function snapParent(el){return el.closest('.content')||el.closest('.page')}
  function clearSnapGuides(){
    snapLayer?.remove();
    snapLayer=null;
  }
  function ensureSnapLayer(page){
    if(!page)return null;
    if(snapLayer&&snapLayer.parentElement===page)return snapLayer;
    clearSnapGuides();
    snapLayer=document.createElement('div');
    snapLayer.className='snap-guide-layer';
    page.appendChild(snapLayer);
    return snapLayer;
  }
  function addSnapGuide(page,axis,pos,parent){
    const layer=ensureSnapLayer(page);
    if(!layer)return;
    const parentRect=parent.getBoundingClientRect();
    const pageRect=page.getBoundingClientRect();
    const guide=document.createElement('i');
    guide.className='snap-guide '+(axis==='x'?'v':'h');
    if(axis==='x')guide.style.left=(parentRect.left-pageRect.left+pos)+'px';
    else guide.style.top=(parentRect.top-pageRect.top+pos)+'px';
    layer.appendChild(guide);
  }
  function collectSnapLines(el){
    const parent=snapParent(el);
    const parentRect=parent.getBoundingClientRect();
    const x=[0,parentRect.width/2,parentRect.width];
    const y=[0,parentRect.height/2,parentRect.height];
    parent.querySelectorAll('.moveable,.editable-image-layer,.image-widget,img').forEach(item=>{
      if(item===el||item===selectionBox||item.closest?.('.selection-box')||el.contains?.(item)||item.contains?.(el))return;
      const r=item.getBoundingClientRect();
      if(!r.width||!r.height)return;
      const left=r.left-parentRect.left;
      const top=r.top-parentRect.top;
      x.push(left,left+r.width/2,left+r.width);
      y.push(top,top+r.height/2,top+r.height);
    });
    return {parent,x,y};
  }
  function nearestSnap(value, lines){
    let best=null;
    for(const line of lines){
      const diff=Math.abs(value-line);
      if(diff<=SNAP_TOLERANCE&&(!best||diff<best.diff))best={line,diff};
    }
    return best;
  }
  function applySnap(el,left,top,width,height){
    clearSnapGuides();
    const page=el.closest('.page');
    const {parent,x,y}=collectSnapLines(el);
    const candidatesX=[
      {value:left,apply:v=>v},
      {value:left+width/2,apply:v=>v-width/2},
      {value:left+width,apply:v=>v-width}
    ];
    const candidatesY=[
      {value:top,apply:v=>v},
      {value:top+height/2,apply:v=>v-height/2},
      {value:top+height,apply:v=>v-height}
    ];
    let bestX=null,bestY=null;
    for(const c of candidatesX){
      const hit=nearestSnap(c.value,x);
      if(hit&&(!bestX||hit.diff<bestX.hit.diff))bestX={hit,c};
    }
    for(const c of candidatesY){
      const hit=nearestSnap(c.value,y);
      if(hit&&(!bestY||hit.diff<bestY.hit.diff))bestY={hit,c};
    }
    if(bestX){left=bestX.c.apply(bestX.hit.line);addSnapGuide(page,'x',bestX.hit.line,parent)}
    if(bestY){top=bestY.c.apply(bestY.hit.line);addSnapGuide(page,'y',bestY.hit.line,parent)}
    return {left:Math.max(0,left),top:Math.max(0,top),width:Math.max(36,width),height:Math.max(24,height)};
  }
  function pickTarget(ev){
    if(ev.target.closest?.('.selection-box'))return selected;
    if(ev.target.closest?.('.image-widget'))return ev.target.closest('.image-widget');
    if(ev.target.matches?.('img'))return ev.target;
    const target=ev.target.closest?.('.moveable,.editable-image-layer');
    if(target)return target;
    const page=ev.target.closest?.('.page');
    if(page){
      const pr=page.getBoundingClientRect();
      if(ev.clientY-pr.top>=pr.height-300)return page.querySelector('.page-footer-slot');
    }
    return null;
  }
  function ensureAbsolute(target){
    const cs=getComputedStyle(target);
    if(cs.position==='absolute'||isImageLayer(target))return;
    const page=target.closest('.page');
    const content=target.closest('.content')||page;
    const cr=content.getBoundingClientRect();
    const r=target.getBoundingClientRect();
    if(!target.dataset.placeholderId){
      const ph=document.createElement('span');
      ph.className='layout-placeholder';
      ph.dataset.placeholderFor='ph'+(++uid);
      ph.style.display=cs.display==='inline'?'inline-block':'block';
      ph.style.width=r.width+'px';
      ph.style.height=r.height+'px';
      ph.style.margin=cs.margin;
      target.dataset.placeholderId=ph.dataset.placeholderFor;
      target.parentNode.insertBefore(ph,target);
    }
    target.style.position='absolute';
    target.style.left=(r.left-cr.left)+'px';
    target.style.top=(r.top-cr.top)+'px';
    target.style.width=r.width+'px';
    target.style.height=r.height+'px';
    target.style.margin='0';
    target.style.zIndex=target.style.zIndex||'5';
  }
  function replaceImageWithFile(file){
    if(!selected||!file)return;
    const img=selectedImage();
    const bgTarget=isBackgroundImageTarget(selected);
    if(!isImageLayer(selected)&&!img&&!bgTarget){alert('当前选中元素不是图片或图片图层');return}
    const reader=new FileReader();
    reader.onload=()=>{
        if(img)img.src=reader.result;
      else{
        if(isTopLayer(selected)){
          syncTopLayers(layer=>{
            layer.style.backgroundImage=`url(${reader.result})`;
            layer.style.opacity=layer.style.opacity==='0'?'0.75':(layer.style.opacity||'0.75');
            layer.dataset.globalDeleted='0';
          });
        }else if(isFooterLayer(selected)){
          syncFooterLayers(layer=>{
            layer.style.backgroundImage=`url(${reader.result})`;
            if(getComputedStyle(layer).getPropertyValue('--footer-bottom-opacity').trim()==='0')layer.style.setProperty('--footer-bottom-opacity','1');
          });
        }else if(isImageLayer(selected)||bgTarget){
          selected.style.backgroundImage=`url(${reader.result})`;
        }
      }
      positionSelectionBox();
      updateControls();
    };
    reader.readAsDataURL(file);
  }
  function triggerReplacePicker(target){
    if(!edit)toggle?.click();
    if(target){
      lastPage=target.closest?.('.page')||lastPage;
      select(target);
    }
    if(!selected){alert('请先选中要替换的图片或图层');return}
    const img=selectedImage();
    if(!isImageLayer(selected)&&!img&&!isBackgroundImageTarget(selected)){alert('当前选中元素不是图片或图片图层');return}
    const input=replaceInput();
    input.value='';
    input.click();
  }

  toggle?.addEventListener('click',()=>{
    edit=!edit;
    body.classList.toggle('edit-mode',edit);
    document.querySelectorAll('.editable-text').forEach(el=>el.contentEditable=edit);
    toggle.textContent=edit?'关闭编辑':'开启编辑';
    if(!edit)clearSelection();
  });
  document.addEventListener('click',ev=>{const p=ev.target.closest?.('.page');if(p)lastPage=p},{capture:true});
  document.addEventListener('dblclick',ev=>{
    const target=imageReplaceTarget(ev.target);
    if(!target)return;
    ev.preventDefault();
    ev.stopPropagation();
    triggerReplacePicker(target);
  },{capture:true});
  document.addEventListener('pointerdown',ev=>{
    if(!edit)return;
    const handle=ev.target.closest('.resize-handle');
    const target=handle?selected:pickTarget(ev);
    if(!target)return;
    lastPage=target.closest('.page')||lastPage;
    if(target!==selected)select(target);
    const r=target.getBoundingClientRect();
    if(handle){
      ensureAbsolute(target);
      const cs=getComputedStyle(target);
      drag={mode:'resize',dir:handle.dataset.dir,el:target,startX:ev.clientX,startY:ev.clientY,w:r.width,h:r.height,left:px(target.style.left),top:px(target.style.top),pos:cs.position};
    }else if(ev.target.closest('.selection-box')&&!ev.target.closest('.resize-handle')){
      ensureAbsolute(target);
      drag={mode:'move',el:target,startX:ev.clientX,startY:ev.clientY,left:px(target.style.left),top:px(target.style.top)};
    }
    if(drag)ev.preventDefault();
  });
  document.addEventListener('pointermove',ev=>{
    if(!drag)return;
    const dx=ev.clientX-drag.startX,dy=ev.clientY-drag.startY;
    if(drag.mode==='move'){
      const r=drag.el.getBoundingClientRect();
      const snapped=applySnap(drag.el,drag.left+dx,drag.top+dy,r.width,r.height);
      drag.el.style.left=snapped.left+'px';
      drag.el.style.top=snapped.top+'px';
    }else{
      let w=drag.w,h=drag.h,l=drag.left,t=drag.top;
      if(drag.dir.includes('e'))w=drag.w+dx;
      if(drag.dir.includes('s'))h=drag.h+dy;
      if(drag.dir.includes('w')){w=drag.w-dx;l=drag.left+dx}
      if(drag.dir.includes('n')){h=drag.h-dy;t=drag.top+dy}
      const snapped=applySnap(drag.el,l,t,Math.max(36,w),Math.max(24,h));
      drag.el.style.width=snapped.width+'px';
      drag.el.style.height=snapped.height+'px';
      if(drag.pos==='absolute'){
        drag.el.style.left=snapped.left+'px';
        drag.el.style.top=snapped.top+'px';
      }
    }
    positionSelectionBox();
    updateControls();
  });
  document.addEventListener('pointerup',()=>{drag=null;clearSnapGuides();positionSelectionBox();updateControls()});
  byId('triggerReplace')?.addEventListener('click',()=>triggerReplacePicker());
  replaceInput()?.addEventListener('change',ev=>{replaceImageWithFile(ev.target.files[0]);ev.target.value=''});
  byId('addText')?.addEventListener('click',()=>{
    if(!edit)toggle.click();
    const page=activePage();
    const box=document.createElement('div');
    box.className='insight-card moveable';
    box.dataset.component='text-box';
    box.style.position='absolute';
    box.style.left='80px';
    box.style.top='180px';
    box.style.width='260px';
    box.style.minHeight='90px';
    box.innerHTML='<b class="editable-text" contenteditable="true">新增标题</b><p class="editable-text" contenteditable="true">点击编辑正文。</p>';
    page.querySelector('.content').appendChild(box);
    select(box);
  });
  byId('addImage')?.addEventListener('click',()=>{if(!edit)toggle.click();const input=insertInput();input.value='';input.click()});
  insertInput()?.addEventListener('change',ev=>{
    const file=ev.target.files[0];
    if(!file)return;
    const reader=new FileReader();
    reader.onload=()=>{
      const page=activePage();
      const box=document.createElement('div');
      box.className='image-widget moveable';
      box.dataset.component='free-image';
      box.style.left='90px';
      box.style.top='220px';
      box.style.width='260px';
      box.style.height='160px';
      box.style.zIndex='12';
      box.innerHTML=`<img class="free-image" alt="新增图片" src="${reader.result}">`;
      page.querySelector('.content').appendChild(box);
      select(box);
    };
    reader.readAsDataURL(file);
    ev.target.value='';
  });
  byId('setTopImage')?.addEventListener('click',()=>{
    const layer=activePage()?.querySelector('.top-image-slot');
    if(!layer){alert('当前页没有顶部图片层');return}
    triggerReplacePicker(layer);
  });
  byId('setFooterImage')?.addEventListener('click',()=>{
    const layer=activePage()?.querySelector('.page-footer-slot');
    if(!layer){alert('当前页没有页脚图片层');return}
    triggerReplacePicker(layer);
  });
  imageFit?.addEventListener('change',ev=>{
    const img=selectedImage();
    if(img)img.style.objectFit=ev.target.value;
    else if(isTopLayer(selected))syncTopLayers(layer=>setBackgroundFit(layer,ev.target.value));
    else if(isFooterLayer(selected))syncFooterLayers(layer=>setBackgroundFit(layer,ev.target.value));
    else if(isImageLayer(selected)||isBackgroundImageTarget(selected))setBackgroundFit(selected,ev.target.value);
  });
  imageOpacity?.addEventListener('input',ev=>{
    const img=selectedImage();
    if(img)img.style.opacity=ev.target.value;
    else if(isTopLayer(selected))syncTopLayers(layer=>layer.style.opacity=ev.target.value);
    else if(isFooterLayer(selected))syncFooterLayers(layer=>layer.style.opacity=ev.target.value);
    else if(isImageLayer(selected)||isBackgroundImageTarget(selected))selected.style.opacity=ev.target.value;
  });
  widgetWidth?.addEventListener('change',ev=>{if(!selected||isImageLayer(selected))return;selected.style.width=Math.max(36,px(ev.target.value))+'px';positionSelectionBox();updateControls()});
  widgetHeight?.addEventListener('change',ev=>{if(!selected||isImageLayer(selected))return;selected.style.height=Math.max(24,px(ev.target.value))+'px';positionSelectionBox();updateControls()});
  footerTopOpacity?.addEventListener('input',ev=>{if(isFooterLayer(selected))syncFooterLayers(layer=>layer.style.setProperty('--footer-top-opacity',ev.target.value))});
  footerBottomOpacity?.addEventListener('input',ev=>{if(isFooterLayer(selected))syncFooterLayers(layer=>layer.style.setProperty('--footer-bottom-opacity',ev.target.value))});
  byId('bringForward')?.addEventListener('click',()=>{if(!selected)return;selected.style.zIndex=String((parseInt(selected.style.zIndex||'1',10)||1)+1);positionSelectionBox()});
  byId('sendBackward')?.addEventListener('click',()=>{if(!selected)return;selected.style.zIndex=String(Math.max(0,(parseInt(selected.style.zIndex||'1',10)||1)-1));positionSelectionBox()});
  byId('deleteSelected')?.addEventListener('click',()=>{
    if(!selected)return;
    if(isTopLayer(selected)){
      document.querySelectorAll('.top-image-slot').forEach(layer=>{
        layer.style.backgroundImage='none';
        layer.style.opacity='0';
        layer.dataset.globalDeleted='1';
      });
      clearSelection();
      return;
    }
    if(isFooterLayer(selected)){
      syncFooterLayers(layer=>layer.style.backgroundImage='none');
      clearSelection();
      return;
    }
    if(isImageLayer(selected)){selected.style.backgroundImage='none';clearSelection();return}
    const el=selected, phId=el.dataset.placeholderId;
    clearSelection();
    if(phId)document.querySelector(`[data-placeholder-for="${phId}"]`)?.remove();
    el.remove();
  });
  byId('saveHtml')?.addEventListener('click',()=>{
    clearSelection();
    const clone=document.documentElement.cloneNode(true);
    clone.querySelectorAll('.selection-box,.resize-handle,.selection-label').forEach(el=>el.remove());
    const blob=new Blob(['<!doctype html>\n'+clone.outerHTML],{type:'text/html;charset=utf-8'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=document.body.dataset.downloadName||'enterprise-health-report-edited.html';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  byId('printPdf')?.addEventListener('click',()=>{
    clearSelection();
    window.print();
  });
  window.addEventListener('scroll',positionSelectionBox);
  window.addEventListener('resize',positionSelectionBox);
  window.A4HealthReportEditor={select,clearSelection,activePage,replaceImageWithFile};
  updateControls();
})();
