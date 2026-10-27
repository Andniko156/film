/* npm install --no-save playwright; npx playwright install chromium; node tests/ui.test.cjs */
const {chromium}=require('playwright');
const fs=require('fs');
const path=require('path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const model=require('../model.js');
const screenshots=process.env.SCREENSHOT_DIR;
const legacy=[
 {id:1,title:'Прибытие',year:2016,type:'FILM',genre:'фантастика, драма',rating:5,dateWatched:'2026-10-20',comment:'О языке и выборе',dateAdded:'2026-10-20T12:00:00Z',poster:''},
 {id:2,title:'Интерстеллар',year:2014,type:'FILM',genre:'фантастика',rating:4,dateWatched:'2026-10-19',comment:'Тихий вечер',dateAdded:'2026-10-19T12:00:00Z',poster:''},
 {id:3,title:'Фильм с длинным названием и неожиданным финалом',year:2024,type:'FILM',genre:'драма',rating:3,dateWatched:'2026-10-18',comment:'',dateAdded:'2026-10-18T12:00:00Z',poster:''}
];
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--disable-dev-shm-usage','--no-zygote','--disable-gpu']});
 const context=await browser.newContext({viewport:{width:1280,height:1000},reducedMotion:'reduce'});
 let apiFailure=false;
 await context.route('**/*',route=>{
   const u=new URL(route.request().url());
   if(u.hostname==='cinema.test'){
     const filename=u.pathname==='/'?'index.html':u.pathname.slice(1);
     if(!['index.html','app.js','model.js','styles.css'].includes(filename))return route.fulfill({status:404,body:''});
     return route.fulfill({contentType:filename.endsWith('.js')?'application/javascript':filename.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(path.join(root,filename),'utf8')});
   }
   if(u.hostname==='kinopoiskapiunofficial.tech')return route.fulfill({status:apiFailure?503:200,contentType:'application/json',body:JSON.stringify({items:[{nameRu:'Солярис',year:1972,type:'FILM',genres:[{genre:'фантастика'}]}]})});
   return route.abort();
 });
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://cinema.test/');
 assert.equal(await page.locator('.movie-card').count(),0);
 await page.evaluate(data=>{localStorage.removeItem('cinedairy.archive.v2');localStorage.setItem('movies',JSON.stringify(data));localStorage.setItem('watchlist',JSON.stringify([{id:8,title:'Сталкер',type:'FILM',year:1979}]))},legacy);
 await page.reload();
 const getDB=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('cinedairy.archive.v2')));
 const nav=async id=>{await page.locator(`.primary-nav a[href="#${id}"]`).click();await page.waitForURL('**/#'+id);await page.locator(`.primary-nav a[href="#${id}"][aria-current="page"]`).waitFor();};
 const click=async(name,id,scope=page)=>scope.locator(`[data-action="${name}"]${id?`[data-id="${id}"]`:''}`).filter({visible:true}).first().click();
 const submit=()=>page.locator('#active-form button[type="submit"]').click();
 const closeForm=()=>page.locator('#active-form [data-close]').first().click();
 const closeMovie=()=>page.locator('#movie-dialog > .drawer-heading [data-close]').click();
 let db=await getDB();assert.equal(db.movies.length,4);assert.equal(db.views.length,3);assert.equal(await page.evaluate(()=>localStorage.getItem('movies')),JSON.stringify(legacy));
 const first=db.movies[0].id,second=db.movies[1].id;
 await click('open-movie',first);
 assert.equal(await page.locator('#detail-title').textContent(),'Прибытие');
 await click('rewatch',first,page.locator('#movie-dialog'));
 await page.locator('#field-note').fill('Несохранённое впечатление');await closeForm();
 assert.equal((await getDB()).views.length,3);
 await click('rewatch',first,page.locator('#movie-dialog'));
 await page.locator('#field-date').fill('2026-10-25');await page.locator('#field-rating').selectOption('4');
 await page.locator('#field-company').fill('С друзьями');await page.locator('#field-mood').fill('Восторг');await page.locator('#field-note').fill('Повторный просмотр открыл новые детали');await submit();
 db=await getDB();assert.equal(db.views.length,4);assert.equal(model.movieViews(db,first).length,2);assert.equal(model.movieViews(db,first)[1].note,legacy[0].comment);
 await click('new-quote',first,page.locator('#movie-dialog'));
 await page.locator('#field-text').fill('Секретная фраза <img src=x onerror=alert(1)>');await page.locator('#field-character').fill('Луиза');await page.locator('#field-time').fill('01:24:10');await page.locator('#field-tags').fill('о выборе, время');await page.locator('[name="spoiler"]').check();await submit();
 await click('detail-tab','quotes',page.locator('#movie-dialog'));
 assert.equal(await page.locator('#movie-detail blockquote').count(),0);
 const qid=(await getDB()).quotes[0].id;
 await click('reveal-quote',qid,page.locator('#movie-dialog'));
 assert.match(await page.locator('#movie-detail blockquote').textContent(),/Секретная/);assert.equal(await page.locator('#movie-detail blockquote img').count(),0);
 if(screenshots)await page.screenshot({path:path.join(screenshots,'cinema-detail.png'),fullPage:true});
 await closeMovie();await nav('quotes');
 await click('edit-quote',qid);await page.locator('#field-text').fill('Сохранённая цитата о времени');await page.locator('[name="spoiler"]').uncheck();await submit();
 await page.locator('#quote-search').fill('времени');assert.equal(await page.locator('#quote-results .quote-card').count(),1);
 await page.locator('#quote-tag-filter').selectOption('о выборе');assert.equal(await page.locator('#quote-results .quote-card').count(),1);
 await page.locator('#global-search').fill('детали');await page.locator('.search-group-title').first().waitFor();assert.equal(await page.locator('.timeline-row').count(),1);
 await nav('movies');
 await page.locator('.filter-panel summary').click();await page.locator('#filter-quotes').selectOption('yes');await page.locator('#filter-repeat').selectOption('yes');await page.locator('#filter-rating').selectOption('4');
 assert.equal(await page.locator('#library-results .movie-card').count(),1);
 await click('save-preset');await page.locator('#field-name').fill('Любимые с цитатами');await submit();
 const preset=(await getDB()).presets[0].id;
 await click('clear-filters');assert.equal(await page.locator('#library-results .movie-card').count(),3);
 await page.locator('#saved-filter').selectOption(preset);assert.equal(await page.locator('#library-results .movie-card').count(),1);
 await page.reload();await page.locator('#saved-filter').selectOption(preset);assert.equal(await page.locator('#library-results .movie-card').count(),1);
 await click('remove-filter','quotes');await click('remove-filter','repeat');await click('clear-filters');
 await click('layout','list');assert.equal(await page.locator('.list-card').count(),3);await click('layout','grid');
 await page.locator(`[data-select="${first}"]`).check();await page.locator(`[data-select="${second}"]`).check();await click('bulk-add');await page.locator('#field-newName').fill('Кино о времени');await submit();
 const cid=(await getDB()).collections[0].id;
 await nav('collections');await click('open-collection',cid);assert.equal(await page.locator('.collection-row').count(),2);
 await click('collection-up',second);assert.equal((await getDB()).collections[0].movieIds[0],second);
 await click('collection-remove',first);assert.equal((await getDB()).collections[0].movieIds.length,1);await click('undo');assert.equal((await getDB()).collections[0].movieIds.length,2);
 await nav('diary');await page.locator('#diary-month').selectOption('2026-10');assert.equal(await page.locator('.timeline-row').count(),4);
 const view=model.movieViews(await getDB(),first)[0];await click('edit-view',view.id);await page.locator('#field-note').fill('Исправленная заметка');await submit();assert.equal((await getDB()).views.find(v=>v.id===view.id).note,'Исправленная заметка');
 await click('delete-view',view.id);await submit();assert.equal(model.movieViews(await getDB(),first).length,1);await click('undo');assert.equal(model.movieViews(await getDB(),first).length,2);
 await nav('watchlist');const planned=(await getDB()).movies.find(m=>m.planned);await click('rewatch',planned.id);await submit();assert.equal((await getDB()).movies.find(m=>m.id===planned.id).planned,false);
 await page.locator('header [data-action="new-view"]').click();await page.locator('#api-search').fill('Проверка');await page.locator('#api-results').getByText('Для автопоиска',{exact:false}).waitFor();await closeForm();
 await page.locator('footer a[href="#data"]').click();await click('api-settings');await page.locator('#field-apiKey').fill('test-only-mocked-key');await submit();
 await page.locator('header [data-action="new-view"]').click();await page.locator('#api-search').fill('Сол');await page.locator('#api-results button').waitFor();await page.locator('#api-search').press('ArrowDown');await page.keyboard.press('Enter');assert.equal(await page.locator('#field-title').inputValue(),'Солярис');await submit();
 apiFailure=true;await page.locator('header [data-action="new-view"]').click();await page.locator('#api-search').fill('Ошибка');await page.locator('#api-results').getByText('Поиск недоступен.',{exact:false}).waitFor();await closeForm();
 await nav('home');if(screenshots)await page.screenshot({path:path.join(screenshots,'cinema-home-desktop.png'),fullPage:true});
 // Every page and drawer, including long titles, at four viewport widths.
 for(const width of [320,375,768,1280]){
   await page.setViewportSize({width,height:1000});
   for(const id of ['home','movies','diary','quotes','collections','watchlist','stats']){
     await nav(id);
     assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Overflow ${id}/${width}`);
   }
   await nav('movies');await click('open-movie',first);
   assert.equal(await page.locator('#movie-dialog').evaluate(el=>el.scrollWidth>el.clientWidth+1),false,`Drawer overflow/${width}`);
   await click('new-quote',first,page.locator('#movie-dialog'));
   assert.equal(await page.locator('#form-dialog').evaluate(el=>el.scrollWidth>el.clientWidth+1),false,`Form overflow/${width}`);
   await closeForm();await closeMovie();
 }
 await page.setViewportSize({width:375,height:1000});await nav('home');if(screenshots)await page.screenshot({path:path.join(screenshots,'cinema-home-mobile.png'),fullPage:true});
 await page.setViewportSize({width:1280,height:1000});await nav('movies');if(screenshots)await page.screenshot({path:path.join(screenshots,'cinema-library.png'),fullPage:true});
 await page.locator('footer a[href="#data"]').click();
 const downloadPromise=page.waitForEvent('download');await click('export');const download=await downloadPromise;const backup=JSON.parse(fs.readFileSync(await download.path(),'utf8'));assert.ok(backup.quotes.length===1&&backup.presets.length===1&&backup.collections.length===1);assert.ok(!JSON.stringify(backup).includes('test-only-mocked-key'));
 const beforeImport=JSON.stringify(await getDB());
 await page.locator('#import-file').setInputFiles({name:'broken.json',mimeType:'application/json',buffer:Buffer.from('{"other":1}')});
 await page.waitForFunction(()=>document.getElementById('import-status').textContent.includes('Выберите резервную'));
 assert.equal(JSON.stringify(await getDB()),beforeImport);
 await page.locator('#import-file').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});await page.locator('#form-dialog[open]').waitFor();await closeForm();assert.equal(JSON.stringify(await getDB()),beforeImport);
 await page.locator('#import-file').setInputFiles([]);await page.locator('#import-file').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});await page.locator('#form-dialog[open]').waitFor();await submit();assert.equal((await getDB()).quotes.length,1);
 await click('reset');await submit();assert.equal((await getDB()).movies.length,0);await click('undo');assert.equal((await getDB()).movies.length,backup.movies.length);
 // Optimistic concurrency and quota errors must never overwrite a committed archive.
 await nav('movies');await click('open-movie',first);await click('rewatch',first,page.locator('#movie-dialog'));
 await page.evaluate(()=>{const data=JSON.parse(localStorage.getItem('cinedairy.archive.v2'));data.revision++;localStorage.setItem('cinedairy.archive.v2',JSON.stringify(data))});const external=JSON.stringify(await getDB());await submit();await page.locator('.form-error').getByText('Коллекция изменилась',{exact:false}).waitFor();assert.equal(JSON.stringify(await getDB()),external);await closeForm();await closeMovie();await page.reload();
 await page.locator('header [data-action="new-view"]').click();await page.locator('#field-title').fill('Не должен сохраниться');
 const quotaBefore=JSON.stringify(await getDB());await page.evaluate(()=>{window.realSet=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new DOMException('Недостаточно места','QuotaExceededError')}});await submit();await page.locator('.form-error').getByText('Недостаточно места').waitFor();assert.equal(JSON.stringify(await getDB()),quotaBefore);await page.evaluate(()=>{Storage.prototype.setItem=window.realSet});await closeForm();
 assert.deepEqual(errors,[]);
 console.log('Passed: migration; separate rewatches; safe quote rendering; spoilers; search; saved filters; bulk collections; ordering; undo; diary edits; plans; API success/error (mocked); 7 pages and dialogs at 320/375/768/1280; full export/import; corrupt import; reset/undo; concurrent writes; quota failure.');
 await browser.close();
})().catch(error=>{console.error(error);process.exit(1)});
