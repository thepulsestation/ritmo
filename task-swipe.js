// A short swipe reveals an action; crossing the threshold commits only on release.
const WIDTH=96;
export function bindTaskSwipes({root=document,now=()=>Date.now(),onCommit=()=>{},touchEvents=typeof window!=='undefined'&&'TouchEvent' in window}={}){
  let gesture=null,suppressed=null,ignoreMouseUntil=0;
  const rows=()=>[...root.querySelectorAll('.task-swipe')];
  const sideOf=row=>row.classList.contains('is-open')?(row.classList.contains('is-postpone')?1:-1):0;
  function reveal(row,side){
    const open=!!side;
    row.classList.remove('is-dragging');row.classList.remove('is-armed');row.classList.toggle('is-open',open);row.classList.toggle('is-postpone',side===1);
    row.style.removeProperty('--swipe-x');row.style.removeProperty('--reveal-width');
    const actions=row.querySelector('.task-swipe-actions');
    actions.inert=side!==-1;actions.setAttribute('aria-hidden',String(side!==-1));
    const tomorrow=row.querySelector('.task-swipe-tomorrow');
    tomorrow.inert=side!==1;tomorrow.setAttribute('aria-hidden',String(side!==1));
    row.querySelector('[data-action="swipe-toggle"]').setAttribute('aria-expanded',String(open));
  }
  function closeOthers(except=null){for(const row of rows())if(row!==except)reveal(row,false);}
  function cancel(){if(gesture){reveal(gesture.row,gesture.wasSide);gesture=null;}}
  function begin(target,x,y,kind,id,pointerType){
    suppressed=null;
    cancel();
    const row=target.closest('.task-swipe');closeOthers(row);
    const card=target.closest('.task-row');
    if(!row||!card||target.closest('input,select,textarea'))return;
    const width=row.getBoundingClientRect().width;
    gesture={row,card,kind,id,pointerType,x,y,control:!!target.closest('button,a'),wasSide:sideOf(row),side:sideOf(row),width,threshold:Math.max(144,Math.min(width*.65,width-28)),active:false,offset:0,captured:false};
  }
  function draw(x,y,e){
    const g=gesture,dx=x-g.x,dy=y-g.y;
    if(!g.row.isConnected){gesture=null;return;}
    if(!g.active){
      if(Math.abs(dy)>=10&&Math.abs(dy)>=Math.abs(dx)){gesture=null;return;}
      if(Math.abs(dx)<10||Math.abs(dx)<Math.abs(dy)*1.3)return;
      g.side=g.wasSide||Math.sign(dx);
      g.active=true;
      // Touch/stylus already capture their original target. Transferring capture
      // from a title or icon fires lostpointercapture and used to cancel the swipe.
      if(g.kind==='pointer'&&g.pointerType==='mouse'){g.captured=true;g.card.setPointerCapture(g.id);}
      g.row.classList.add('is-dragging');
      g.row.classList.toggle('is-postpone',g.side===1);
    }
    const raw=g.wasSide*WIDTH+dx;
    g.offset=g.side<0?Math.max(-g.width,Math.min(0,raw)):Math.min(g.width,Math.max(0,raw));
    g.row.classList.toggle('is-armed',Math.abs(g.offset)>=g.threshold);
    g.row.style.setProperty('--swipe-x',g.offset+'px');g.row.style.setProperty('--reveal-width',Math.max(WIDTH,Math.abs(g.offset))+'px');if(e.cancelable!==false)e.preventDefault();
  }
  function finish(x,y,e){
    const g=gesture;if(!g)return;
    draw(x,y,e);
    if(!gesture)return;
    const commit=g.active&&Math.abs(g.offset)>=g.threshold;
    if(g.active){reveal(g.row,commit?0:Math.abs(g.offset)>=WIDTH/2?g.side:0);suppressed={row:g.row,until:now()+450};}
    else if(g.wasSide&&!g.control)reveal(g.row,0);
    gesture=null;
    if(commit)onCommit(g.row,g.side===1?'tomorrow':'delete');
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
    if(toggle&&row){const side=sideOf(row)?0:-1;closeOthers(row);reveal(row,side);e.preventDefault();e.stopImmediatePropagation();return;}
    if(!row)closeOthers();
  },{capture:true});
  root.addEventListener('keydown',e=>{if(e.key==='Escape'){cancel();closeOthers();}});
}
