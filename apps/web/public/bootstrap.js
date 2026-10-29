(() => {
  const root=document.querySelector('#app');let timer;
  function fail(){if(!root.querySelector('.loading'))return;root.replaceChildren();const main=document.createElement('main');main.className='boot-error';const title=document.createElement('h1');title.textContent='工作台加载超时';const message=document.createElement('p');message.textContent='网络连接暂时不稳定，已保存的项目不会丢失。';const retry=document.createElement('button');retry.className='button';retry.textContent='重新加载';retry.addEventListener('click',()=>location.reload());main.append(title,message,retry);root.append(main);}
  const observer=new MutationObserver(()=>{if(!root.querySelector('.loading')){clearTimeout(timer);observer.disconnect();}});observer.observe(root,{childList:true,subtree:true});
  timer=setTimeout(fail,30_000);
  const script=document.createElement('script');script.src='/app.bundle.js';script.onerror=fail;document.body.append(script);
})();
