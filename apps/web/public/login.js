const form=document.querySelector('form');
const password=document.querySelector('#password');
const toggle=document.querySelector('.password-toggle');
toggle.addEventListener('click',()=>{
  const visible=password.type==='password';password.type=visible?'text':'password';
  toggle.setAttribute('aria-label',visible?'隐藏密码':'显示密码');toggle.setAttribute('aria-pressed',String(visible));
});
const error=new URLSearchParams(location.search).get('error');
if(error){const message=document.querySelector('.form-error');message.textContent=error==='limited'?'尝试次数较多，请稍等一分钟再登录。':'账号或密码不正确，请重新输入。';message.hidden=false;}
form.addEventListener('submit',()=>{const button=form.querySelector('.submit');button.disabled=true;button.querySelector('span').textContent='正在进入…';});
window.addEventListener('pageshow',()=>{const button=form.querySelector('.submit');button.disabled=false;button.querySelector('span').textContent='进入工作台';});
