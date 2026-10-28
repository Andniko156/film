const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'film-account-test-'));
const port=process.env.FILM_TEST_PORT||'8127',base='http://127.0.0.1:'+port;
const server=cp.spawn(process.env.FILM_PYTHON||'python',['tests/browser_server.py'],{cwd:root,env:{...process.env,FILM_TEST:'1',SQLITE_PATH:path.join(temp,'test.sqlite3'),FILM_TEST_MAILBOX:path.join(temp,'mail.json'),FILM_TEST_PORT:port},stdio:['ignore','pipe','pipe']});
let browser;
(async()=>{
 await new Promise((resolve,reject)=>{server.stdout.on('data',v=>{if(v.toString().includes('ready'))resolve()});server.on('exit',code=>reject(Error('Test server exited '+code)));setTimeout(()=>reject(Error('Test server startup timeout')),15000).unref()});
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
 const ctx=await browser.newContext({viewport:{width:1280,height:1000}}),page=await ctx.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const click=async(p,label)=>p.getByRole('button',{name:label,exact:true}).filter({visible:true}).first().click();
 const reloadClick=async(p,label)=>Promise.all([p.waitForEvent('load'),click(p,label)]);
 const loaded=async p=>p.locator('.account-banner').getByText(/Гостевой архив|Личный архив/).waitFor();
 const signin=async(p,email)=>{
  await click(p,'Войти');await click(p,'Войти по email');await p.locator('#account-email').fill(email);await click(p,'Получить код');await p.locator('#account-code').waitFor();
  const mail=JSON.parse(fs.readFileSync(path.join(temp,'mail.json'),'utf8'));assert.equal(mail.recipient,email);
  await p.locator('#account-code').fill(mail.body.match(/\b\d{8}\b/)[0]);await click(p,'Подтвердить');await p.locator('.account-banner').getByText('Личный архив · сохранён на сервере',{exact:true}).waitFor();
 };
 await page.goto(base);await loaded(page);
 await page.evaluate(()=>{localStorage.setItem('movies',JSON.stringify([{id:1,title:'Гостевой фильм',type:'FILM',year:2026,genre:'драма',rating:5,dateWatched:'2026-10-27',comment:'Гостевая заметка'}]));localStorage.removeItem('cinedairy.archive.v2')});await page.reload();await loaded(page);
 assert.equal(await page.locator('.movie-card').count(),1);
 const guest=await page.evaluate(()=>localStorage.getItem('cinedairy.archive.v2'));
 await signin(page,'alice@example.com');await page.goto(base+'/#home');await loaded(page);assert.equal(await page.locator('.movie-card').count(),0);
 await click(page,'alice@example.com');await click(page,'Перенести гостевой архив');await reloadClick(page,'Подтвердить перенос');await page.goto(base+'/#home');await loaded(page);assert.equal(await page.locator('.movie-card').count(),1);
 assert.equal(await page.evaluate(()=>localStorage.getItem('cinedairy.archive.v2')),guest);
 // No account archive persists to localStorage, including pre-import copies.
 await page.locator('header [data-action="new-view"]').click();await page.locator('#field-title').fill('Только в аккаунте');await page.locator('#active-form button[type="submit"]').click();await page.locator('.account-banner').getByText('Личный архив · сохранён на сервере',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>localStorage.getItem('cinedairy.archive.v2')),guest);
 await page.reload();await loaded(page);assert.equal(await page.locator('.movie-card').count(),2);
 const second=await browser.newContext(),p2=await second.newPage();await p2.goto(base);await loaded(p2);await signin(p2,'alice@example.com');await p2.goto(base+'/#home');await loaded(p2);assert.equal(await p2.locator('.movie-card').count(),2);
 // Stale archive revision on the first device must not overwrite a new save.
 await p2.locator('header [data-action="new-view"]').click();await p2.locator('#field-title').fill('Со второго устройства');await p2.locator('#active-form button[type="submit"]').click();await p2.locator('.account-banner').getByText('Личный архив · сохранён на сервере',{exact:true}).waitFor();
 await page.locator('header [data-action="new-view"]').click();await page.locator('#field-title').fill('Конфликтующая запись');await page.locator('#active-form button[type="submit"]').click();await page.getByRole('button',{name:'Скачать несохранённую копию'}).waitFor();
 const dl=page.waitForEvent('download');await click(page,'Скачать несохранённую копию');const download=await dl;const unsaved=JSON.parse(fs.readFileSync(await download.path(),'utf8'));assert.ok(unsaved.movies.some(m=>m.title==='Конфликтующая запись'));
 await click(page,'Загрузить архив с сервера');await reloadClick(page,'Заменить данными сервера');await page.goto(base+'/#home');await loaded(page);assert.equal(await page.locator('.movie-card').count(),3);
 // End all sessions and check both devices are anonymous.
 await click(page,'alice@example.com');await reloadClick(page,'Выйти на всех устройствах');await page.goto(base+'/#home');await loaded(page);assert.equal(await page.locator('.movie-card').count(),1);
 await p2.reload();await loaded(p2);assert.equal(await p2.locator('.movie-card').count(),0);
 // Another account on the same browser never inherits Alice's archive.
 await signin(page,'bob@example.com');await page.goto(base+'/#home');await loaded(page);assert.equal(await page.locator('.movie-card').count(),0);
 assert.ok(!(await page.evaluate(()=>JSON.stringify(localStorage))).includes('Только в аккаунте'));
 for(const width of [320,375,768,1280]){await page.setViewportSize({width,height:1000});await click(page,'bob@example.com');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)}
 if(process.env.SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,'cinema-account.png'),fullPage:true});
 await click(page,'bob@example.com');await click(page,'Удалить аккаунт');await reloadClick(page,'Подтвердить удаление аккаунта');await page.goto(base+'/#home');await loaded(page);assert.equal(await page.locator('.movie-card').count(),1);
 assert.deepEqual(errors,[]);
 console.log('Passed real HTTP/browser: email login, explicit guest import, private memory-only account, reload, two devices, conflict export/reload, logout-all, account isolation, account deletion, responsive account dialog.');
})().then(()=>finish(0),e=>{console.error(e);finish(1)});
async function finish(code){if(browser)await browser.close();server.kill();fs.rmSync(temp,{recursive:true,force:true});process.exit(code)}
