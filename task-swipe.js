// A horizontal gesture reveals an action; it never deletes a task on its own.
const WIDTH=96;
export function bindTaskSwipes({root=document,now=()=>Date.now()}={}){
  let gesture=null,suppressed=null;
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
  function draw(e){
    const g=gesture,dx=e.clientX-g.x,dy=e.clientY-g.y;
    if(!g.row.isConnected){gesture=null;return;}
    if(!g.active){
      if(Math.abs(dy)>=10&&Math.abs(dy)>=Math.abs(dx)){gesture=null;return;}
      if(Math.abs(dx)<10||Math.abs(dx)<Math.abs(dy)*1.3)return;
      if(dx>0&&!g.wasOpen){gesture=null;return;}
      g.active=true;g.card.setPointerCapture(e.pointerId);g.row.classList.add('is-dragging');
      g.row.querySelector('.task-swipe-actions').setAttribute('aria-hidden','false');
    }
    g.offset=Math.max(-WIDTH,Math.min(0,(g.wasOpen?-WIDTH:0)+dx));
    g.row.style.setProperty('--swipe-x',g.offset+'px');e.preventDefault();
  }
  root.addEventListener('pointerdown',e=>{
    if(!e.isPrimary||e.button!==0)return;
    cancel();
    const row=e.target.closest('.task-swipe');closeOthers(row);
    if(!row||e.target.closest('button,a,input,select,textarea'))return;
    const card=e.target.closest('.task-row');if(!card)return;
    gesture={row,card,pointer:e.pointerId,x:e.clientX,y:e.clientY,wasOpen:row.classList.contains('is-open'),active:false,offset:0};
  });
  root.addEventListener('pointermove',e=>{if(gesture?.pointer===e.pointerId)draw(e);},{passive:false});
  root.addEventListener('pointerup',e=>{
    if(gesture?.pointer!==e.pointerId)return;
    const g=gesture;if(g.active){draw(e);reveal(g.row,g.offset<=-WIDTH/2);suppressed={row:g.row,until:now()+450};}
    else if(g.wasOpen)reveal(g.row,false);
    gesture=null;
  });
  root.addEventListener('pointercancel',cancel);
  root.addEventListener('lostpointercapture',cancel);
  root.addEventListener('click',e=>{
    const row=e.target.closest('.task-swipe');
    if(e.detail!==0&&suppressed&&suppressed.until>now()&&row===suppressed.row){e.preventDefault();e.stopImmediatePropagation();return;}
    const toggle=e.target.closest('[data-action="swipe-toggle"]');
    if(toggle&&row){const open=!row.classList.contains('is-open');closeOthers(row);reveal(row,open);e.preventDefault();e.stopImmediatePropagation();return;}
    if(!row)closeOthers();
  },{capture:true});
  root.addEventListener('keydown',e=>{if(e.key==='Escape'){cancel();closeOthers();}});
}
