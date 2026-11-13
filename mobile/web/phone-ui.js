/* Phone presentation layer. Archive, accounts and sync remain in shared modules. */
(function () {
    'use strict';
    const $ = selector => document.querySelector(selector);
    const glyphs = {
        home:'<path d="m3 10 9-7 9 7v10H7V10m3 10v-6h4v6"/>',
        movies:'<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M4 8h16M8 3v5m8-5v5m-6 4 5 3-5 3z"/>',
        diary:'<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 11h16m-11 4h2m3 0h2m-7 3h2"/>',
        quotes:'<path d="M9 5H3v8h4c0 3-1 4-3 5m17-13h-6v8h4c0 3-1 4-3 5"/>',
        more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
        search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
        filters:'<path d="M4 6h16M7 12h10m-7 6h4"/><circle cx="9" cy="6" r="2" fill="currentColor"/>',
        plus:'<path d="M12 5v14M5 12h14"/>',
        bookmark:'<path d="M6 4h12v17l-6-4-6 4z"/>',
        collection:'<rect x="3" y="7" width="18" height="14" rx="3"/><path d="M7 3h10m-12 2h14m-9 7 5 3-5 3z"/>',
        stats:'<path d="M5 20V10m7 10V4m7 16v-6"/>',
        account:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
        data:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>'
    };
    const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${glyphs[name] || glyphs.more}</svg>`;
    function button(label, fn, cls='phone-icon-button') {
        const b=document.createElement('button');b.type='button';b.className=cls;b.setAttribute('aria-label',label);b.addEventListener('click',fn);return b;
    }
    function sheet(id,title) {
        const d=document.createElement('dialog');d.id=id;d.className='phone-sheet';d.setAttribute('aria-labelledby',id+'-title');
        d.innerHTML=`<div class="phone-sheet-handle" aria-hidden="true"></div><div class="phone-sheet-heading"><h2 id="${id}-title">${title}</h2><button type="button" data-close class="close-modal" aria-label="Закрыть панель">×</button></div><div class="phone-sheet-content"></div>`;
        d.addEventListener('click',event=>{if(event.target===d){const r=d.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)d.close();}});
        document.body.append(d);return d;
    }
    const nav=$('.primary-nav');nav.classList.add('phone-nav');nav.setAttribute('aria-label','Основные разделы');
    nav.innerHTML=[['home','Главная'],['movies','Коллекция'],['diary','Дневник'],['quotes','Цитаты']].map(([id,label])=>`<a href="#${id}"><span class="phone-nav-icon">${icon(id)}</span><span>${label}</span></a>`).join('');
    const more=sheet('phone-more','Ещё в CineDairy');
    more.querySelector('.phone-sheet-content').innerHTML=[['watchlist','bookmark','Посмотреть','Ваши планы на вечер'],['collections','collection','Подборки','Кино по вашему настроению'],['stats','stats','Киноопыт','История в цифрах'],['account','account','Мой аккаунт','Вход и синхронизация'],['data','data','Резервные копии','Экспорт и восстановление']].map(([id,g,title,description])=>`<a class="phone-menu-item" href="#${id}">${icon(g)}<span><strong>${title}</strong><small>${description}</small></span><span aria-hidden="true">›</span></a>`).join('');
    const moreButton=button('Ещё',()=>{more.showModal();moreButton.setAttribute('aria-expanded','true');},'phone-more-button');
    moreButton.innerHTML=`<span class="phone-nav-icon">${icon('more')}</span><span>Ещё</span>`;moreButton.setAttribute('aria-haspopup','dialog');moreButton.setAttribute('aria-expanded','false');nav.append(moreButton);document.body.append(nav);
    more.addEventListener('close',()=>moreButton.setAttribute('aria-expanded','false'));
    more.addEventListener('click',event=>{if(event.target.closest('a'))more.close();});
    const search=$('.global-search');search.hidden=true;
    const searchButton=button('Поиск по киноархиву',()=>{
        search.hidden=!search.hidden;searchButton.setAttribute('aria-expanded',String(!search.hidden));
        if(!search.hidden)$('#global-search').focus();
        else {$('#global-search').value='';$('#global-search').dispatchEvent(new Event('input',{bubbles:true}));}
    });searchButton.innerHTML=icon('search');searchButton.setAttribute('aria-expanded','false');searchButton.setAttribute('aria-controls','global-search');$('.header-content').append(searchButton);
    const fab=button('Добавить просмотр',()=>{},'phone-fab');fab.dataset.action='new-view';fab.innerHTML=icon('plus')+'<span>Просмотр</span>';document.body.append(fab);
    const filters=sheet('phone-filters','Вид и фильтры');
    const filterDone=button('Показать фильмы',()=>filters.close(),'btn phone-sheet-done');filterDone.textContent='Показать фильмы';filters.append(filterDone);
    let currentPage='home', selecting=false, returnScroll=new Map(), previousPage='home';
    function updateFilters() {
        const count=$('#library-results .result-count');
        if(count)filterDone.textContent=count.textContent.replace('Найдено:','Показать:');
        const chips=$('#filter-chips');const n=chips?.children.length||0;
        const control=$('#phone-filter-button');
        if(control){control.setAttribute('aria-label',n?`Фильтры: активно ${n}`:'Фильтры и вид');control.dataset.count=n?String(n):'';}
    }
    function library() {
        const toolbar=$('.library-toolbar');if(!toolbar||toolbar.querySelector('#phone-filter-button'))return;
        const panel=$('#page-content .filter-panel'),presets=$('#page-content .preset-bar'),view=toolbar.querySelector('.view-switch');
        const content=filters.querySelector('.phone-sheet-content');content.replaceChildren();
        if(view)content.append(view);
        if(panel){panel.open=true;content.append(panel);}
        if(presets)content.append(presets);
        const control=button('Фильтры и вид',()=>filters.showModal());control.id='phone-filter-button';control.innerHTML=icon('filters');control.setAttribute('aria-haspopup','dialog');toolbar.append(control);
        const select=button('Выбрать фильмы',()=>{
            selecting=!selecting;document.body.classList.toggle('phone-selecting',selecting);
            select.textContent=selecting?'Готово':'Выбрать';select.setAttribute('aria-pressed',String(selecting));
            if(!selecting){const b=document.createElement('button');b.dataset.action='clear-selection';document.body.append(b);b.click();b.remove();}
        },'text-button phone-select-toggle');select.textContent=selecting?'Готово':'Выбрать';select.setAttribute('aria-pressed',String(selecting));toolbar.after(select);
        updateFilters();
    }
    function home() {
        const hero=$('.center-hero');if(!hero)return;
        hero.innerHTML='<div><p class="eyebrow">CINEDAIRY · ЛИЧНЫЙ КИНОДНЕВНИК</p><h1>Ваше кино.<br><em>Ваши истории.</em></h1><p>Оставьте впечатление после титров.</p></div><span class="phone-hero-mark" aria-hidden="true">✦</span>';
        const suggestion=$('.home-suggestion');
        const recent=suggestion?.nextElementSibling,grid=recent?.nextElementSibling;
        if(recent?.classList.contains('section-heading')&&grid?.classList.contains('movies-grid')){
            recent.querySelector('h2').textContent='Недавние фильмы';recent.querySelector('a').textContent='Все';
            grid.classList.add('phone-recent');suggestion.before(recent,grid);
        }
    }
    function render(page,query='') {
        currentPage=page;document.body.dataset.page=page;
        const titles={movies:'Коллекция',diary:'Дневник',quotes:'Цитаты',watchlist:'Посмотреть',stats:'Киноопыт',data:'Резервные копии'};
        const title=$('#page-content > .page-heading .page-title');if(title&&!query&&titles[page])title.textContent=titles[page];
        const primary=$('#page-content > .page-heading .heading-actions .btn:not(.btn-outline)');
        const fallback={quotes:['new-quote','Цитата'],watchlist:['new-planned','В планы'],collections:['new-collection','Подборка']};
        const [action,label]=fallback[page]||['new-view','Просмотр'];
        fab.dataset.action=primary?.dataset.action||action;fab.dataset.id=primary?.dataset.id||'';fab.querySelector('span').textContent=label;fab.setAttribute('aria-label',primary?.textContent.replace(/^\+\s*/,'')||'Добавить просмотр');
        fab.hidden=['account','data','stats'].includes(page);
        moreButton.classList.toggle('active',['watchlist','collections','stats','account','data'].includes(page));
        const account=$('.account-button');if(account){account.setAttribute('aria-label','Мой аккаунт');account.title='Мой аккаунт';}
        if(previousPage!==page){
            const y=returnScroll.get(page)||0;requestAnimationFrame(()=>window.scrollTo(0,y));previousPage=page;
            if(!search.hidden){search.hidden=true;searchButton.setAttribute('aria-expanded','false');}
        }
        updateFilters();
    }
    window.addEventListener('scroll',()=>returnScroll.set(currentPage,window.scrollY),{passive:true});
    document.addEventListener('click',event=>{
        if(event.target.closest('.phone-nav a, .phone-menu-item'))returnScroll.set(currentPage,window.scrollY);
    });
    function keyboard() {
        const v=window.visualViewport;
        document.body.classList.toggle('phone-keyboard',Boolean(v&&innerHeight-v.height>120));
    }
    window.visualViewport?.addEventListener('resize',keyboard);
    window.CinemaPhone={render,library,home,updateFilters};
})();
