/* Exercises the exact bundled UI with a mocked same-origin server. No production data. */
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const M=require('../model.js');
const {KEY}=require('../mobile/web/offline.js');
const root=path.resolve(__dirname,'..');
(async()=>{
    const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--disable-dev-shm-usage']});
    const context=await browser.newContext({viewport:{width:360,height:800},reducedMotion:'reduce'});
    let remote=M.blank(),failure=false,user={id:'alice',email:'alice@example.test',providers:['email']},puts=0;
    const errors=[];
    await context.route('**/*',async route=>{
        const url=new URL(route.request().url()),pathname=url.pathname;
        if(url.host!=='cinedairy.test')return route.abort();
        if(pathname.startsWith('/api/')){
            if(failure)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Сервер недоступен'})});
            let result;
            if(pathname==='/api/session')result={user,csrf:'test-csrf',emailEnabled:true,passwordEnabled:true,yandexEnabled:true};
            if(pathname==='/api/archive'){
                if(!user)return route.fulfill({status:401,contentType:'application/json',body:'{}'});
                if(route.request().method()==='PUT'){
                    const body=route.request().postDataJSON();
                    if(body.expectedRevision!==remote.revision)return route.fulfill({status:409,contentType:'application/json',body:'{"error":"conflict"}'});
                    remote={...body.archive,revision:remote.revision+1};puts++;result={revision:remote.revision};
                }else result=remote;
            }
            return route.fulfill({contentType:'application/json',body:JSON.stringify(result||{})});
        }
        const filename=pathname==='/'?'index.html':pathname.slice(1);
        const mobile=['offline.js','android-runtime.js','android.css'].includes(filename);
        const file=path.join(root,mobile?'mobile/web':'',filename);
        if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
        let body=fs.readFileSync(file);
        if(filename==='index.html')body=body.toString().replace('<script defer src="account.js"></script>','<script defer src="offline.js"></script><script defer src="android-runtime.js"></script><script defer src="account.js"></script>').replace('<link rel="stylesheet" href="quote-card.css">','<link rel="stylesheet" href="quote-card.css"><link rel="stylesheet" href="android.css">');
        return route.fulfill({contentType:filename.endsWith('.js')?'application/javascript':filename.endsWith('.css')?'text/css':filename.endsWith('.jpg')?'image/jpeg':'text/html',body});
    });
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    await page.goto('https://cinedairy.test/');
    await page.getByText('Архив сохранён на телефоне и сервере',{exact:true}).waitFor();
    failure=true;
    async function add(title){
        await page.locator('header [data-action="new-view"]').click();
        await page.locator('#field-title').fill(title);
        await page.locator('#field-rating').selectOption('5');
        await page.locator('#active-form button[type="submit"]').click();
    }
    await add('Солярис');
    await page.getByText('Сервер недоступен · работайте автономно, изменения сохранены на телефоне',{exact:true}).waitFor();
    await page.reload();
    await page.locator('[data-action="open-movie"]').first().waitFor();
    const read=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),KEY);
    assert.equal((await read()).data.movies[0].title,'Солярис');assert.equal((await read()).dirty,true);
    await add('Сталкер');assert.equal((await read()).data.movies.length,2);
    failure=false;await page.getByRole('button',{name:'Синхронизировать',exact:true}).click();
    await page.getByText('Архив сохранён на телефоне и сервере',{exact:true}).waitFor();
    assert.equal(remote.movies.length,2);assert.equal(puts,1);
    // Divergent remote + phone edits must display a choice without overwriting either.
    failure=true;await add('Прибытие');
    remote={...remote,revision:remote.revision+1,movies:remote.movies.map((m,i)=>i?m:{...m,title:'Серверная редакция'})};
    failure=false;await page.getByRole('button',{name:'Синхронизировать',exact:true}).click();
    await page.getByRole('button',{name:'Выбрать версию',exact:true}).click();
    assert.equal(remote.movies.length,2);assert.equal((await read()).data.movies.length,3);
    await page.getByRole('button',{name:'Оставить версию телефона',exact:true}).click();
    await page.getByText('Архив сохранён на телефоне и сервере',{exact:true}).waitFor();
    assert.equal(remote.movies.length,3);
    user=null;await page.getByRole('button',{name:'Синхронизировать',exact:true}).click();
    await page.getByRole('button',{name:'Войти снова',exact:true}).waitFor();
    await add('Дюна');await page.reload();assert.equal((await read()).data.movies.length,4);
    await page.locator('.primary-nav a[href="#movies"]').click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    if(process.env.SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,'android-offline.png'),fullPage:true});
    // Native export bridge receives the archive, including a detached account download link.
    await page.evaluate(()=>{window.CineDairyFiles={postMessage:s=>window.testExport=JSON.parse(s)};});
    await page.locator('.primary-nav a[href="#account"]').click();
    await page.getByRole('button',{name:'Скачать архив JSON',exact:true}).click();
    await page.waitForFunction(()=>window.testExport);
    assert.equal(await page.evaluate(()=>JSON.parse(atob(window.testExport.data)).movies.length),4);
    assert.equal(await page.getByRole('button',{name:'Войти через Яндекс',exact:true}).count(),0);
    // Fresh installation while server is down uses a durable guest archive.
    await page.evaluate(()=>localStorage.clear());failure=true;await page.reload();
    await page.getByText('Гостевой архив · сохранён на телефоне и доступен без интернета',{exact:true}).waitFor();
    await add('Первый фильм без сети');await page.reload();
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('cinedairy.archive.v2')).movies.length),1);
    assert.deepEqual(errors,[]);await browser.close();console.log('Android UI: offline restart, edits, sync, conflict, expired session, JSON bridge and first-run guest passed.');
})().catch(error=>{console.error(error);process.exit(1)});
