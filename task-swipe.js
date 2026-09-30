// A horizontal gesture reveals an action; it never deletes a task on its own.
const WIDTH=96;
export function bindTaskSwipes({root=document,now=()=>Date.now(),touchEvents=typeof window!=='undefined'&&'TouchEvent' in window}={}){
  let gesture=null,suppressed=null,ignoreMouseUntil=0;
  const rows=()=>[...root.querySelectorAll('.task-swipe')];
  function reveal(row,open){
    row.classList.remove('is-dragging');row.classList.toggle('is-open',open);
    row.style.removeProperty('--swipe-x');
    const actions=row.querySelector('.task-swipe-actions');
    actions.inert=!open;actions.setAttribute('aria-hidden',String(!open));
    row.querySelector('[data-action="swipe-toggle"]').setAttribute('aria-expanded',String(open));
  }
  function closeOthers(except=null){for(const row of rows())if(row!==except)reveal(row,false);}
  function cancel(){if(gesture){reveal(gesture.row,gesture.wasOpen);gesture=null;}}
  function begin(target,x,y,kind,id,pointerType){
    suppressed=null;
    cancel();
    const row=target.closest('.task-swipe');closeOthers(row);
    const card=target.closest('.task-row');
    if(!row||!card||target.closest('input,select,textarea'))return;
    gesture={row,card,kind,id,pointerType,x,y,control:!!target.closest('button,a'),wasOpen:row.classList.contains('is-open'),active:false,offset:0,captured:false};
  }
  function draw(x,y,e){
    const g=gesture,dx=x-g.x,dy=y-g.y;
    if(!g.row.isConnected){gesture=null;return;}
    if(!g.active){
      if(Math.abs(dy)>=10&&Math.abs(dy)>=Math.abs(dx)){gesture=null;return;}
      if(Math.abs(dx)<10||Math.abs(dx)<Math.abs(dy)*1.3)return;
      if(dx>0&&!g.wasOpen){gesture=null;return;}
      g.active=true;
      // Touch/stylus already capture their original target. Transferring capture
      // from a title or icon fires lostpointercapture and used to cancel the swipe.
      if(g.kind==='pointer'&&g.pointerType==='mouse'){g.captured=true;g.card.setPointerCapture(g.id);}
      g.row.classList.add('is-dragging');
      g.row.querySelector('.task-swipe-actions').setAttribute('aria-hidden','false');
    }
    g.offset=Math.max(-WIDTH,Math.min(0,(g.wasOpen?-WIDTH:0)+dx));
    g.row.style.setProperty('--swipe-x',g.offset+'px');if(e.cancelable!==false)e.preventDefault();
  }
  function finish(x,y,e){
    const g=gesture;if(!g)return;
    draw(x,y,e);
    if(!gesture)return;
    if(g.active){reveal(g.row,g.offset<=-WIDTH/2);suppressed={row:g.row,until:now()+450};}
    else if(g.wasOpen&&!g.control)reveal(g.row,false);
    gesture=null;
  }
  // Safari sends Touch Events directly; keep them separate from its parallel
  // Pointer Events so pointer cancellation cannot interrupt a finger swipe.
  if(touchEvents){
    root.addEventListener('touchstart',e=>{
      ignoreMouseUntil=now()+800;
      if(e.touches.length!==1){cancel();return;}
      const touch=e.touches[0];begin(e.target,touch.clientX,touch.clientY,'touch',touch.identifier);
    },{passive:true});
    root.addEventListener('touchmove',e=>{
      if(gesture?.kind!=='touch')return;
      if(e.touches.length!==1){cancel();return;}
      const touch=Array.from(e.touches).find(t=>t.identifier===gesture.id);
      if(touch)draw(touch.clientX,touch.clientY,e);
    },{passive:false});
    root.addEventListener('touchend',e=>{
      ignoreMouseUntil=now()+800;
      if(gesture?.kind!=='touch')return;
      const touch=Array.from(e.changedTouches).find(t=>t.identifier===gesture.id);
      if(touch)finish(touch.clientX,touch.clientY,e);
    },{passive:false});
    root.addEventListener('touchcancel',()=>{if(gesture?.kind==='touch')cancel();});
  }
  root.addEventListener('pointerdown',e=>{
    if((touchEvents&&e.pointerType==='touch')||!e.isPrimary||e.button!==0||(e.pointerType==='mouse'&&now()<ignoreMouseUntil))return;
    begin(e.target,e.clientX,e.clientY,'pointer',e.pointerId,e.pointerType||'mouse');
  });
  root.addEventListener('pointermove',e=>{if(gesture?.kind==='pointer'&&gesture.id===e.pointerId)draw(e.clientX,e.clientY,e);},{passive:false});
  root.addEventListener('pointerup',e=>{if(gesture?.kind==='pointer'&&gesture.id===e.pointerId)finish(e.clientX,e.clientY,e);});
  root.addEventListener('pointercancel',e=>{if(gesture?.kind==='pointer'&&gesture.id===e.pointerId)cancel();});
  root.addEventListener('lostpointercapture',e=>{if(gesture?.kind==='pointer'&&gesture.id===e.pointerId&&gesture.captured&&e.target===gesture.card)cancel();});
  root.addEventListener('click',e=>{
    const row=e.target.closest('.task-swipe');
    if(e.detail!==0&&suppressed&&suppressed.until>now()&&row===suppressed.row&&e.target.closest('.task-row')){e.preventDefault();e.stopImmediatePropagation();return;}
    const toggle=e.target.closest('[data-action="swipe-toggle"]');
    if(toggle&&row){const open=!row.classList.contains('is-open');closeOthers(row);reveal(row,open);e.preventDefault();e.stopImmediatePropagation();return;}
    if(!row)closeOthers();
  },{capture:true});
  root.addEventListener('keydown',e=>{if(e.key==='Escape'){cancel();closeOthers();}});
}
