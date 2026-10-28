(function () {
    'use strict';
    const KINOPOISK_API_URL = 'https://kinopoiskapiunofficial.tech/api/v2.2/films';
    const API_KEY_STORAGE = 'cinedairy.kinopoisk-key';
    const M = window.CinemaModel;
    const Account = window.CinemaAccount;
    let storage = localStorage;
    const $ = selector => document.querySelector(selector);
    const page = $('#page-content');
    const drawer = $('#movie-dialog');
    const formDialog = $('#form-dialog');
    const escape = value => M.text(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
    const types = {FILM: 'Фильм', TV_SERIES: 'Сериал', MINI_SERIES: 'Мини-сериал', TV_SHOW: 'ТВ-шоу'};
    const dateLabel = date => date ? new Intl.DateTimeFormat('ru', {day:'numeric', month:'long', year:'numeric'}).format(new Date(date + 'T12:00:00')) : 'Дата не указана';
    const fallback = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><defs><linearGradient id="g" x2=".8" y2="1"><stop stop-color="#74502d"/><stop offset="1" stop-color="#11110e"/></linearGradient></defs><rect width="400" height="600" fill="#16130e"/><circle cx="265" cy="180" r="65" fill="#c2a063"/><path d="M-70 490Q100 70 470 430V650H-70" fill="url(#g)" stroke="#b18d51" stroke-width="6"/><path d="M-50 590Q260 220 460 530V650H-50" fill="#211b12" stroke="#765a32" stroke-width="4"/><text x="32" y="64" fill="#e5cf9b" font-family="Georgia,serif" font-size="28">cine · dairy</text></svg>');
    let db, expectedRaw, loaded = false, currentPage = 'home', activeMovie = '', detailTab = 'overview';
    let filters = M.defaults(), layout = 'grid', diaryMonth = '', quoteSearch = '', quoteTag = '', activeCollection = '';
    let selected = new Set(), bulkIds = [], lastUndo = null, mutation = 0, searchTimer, apiTimer, apiVersion = 0;
    let formSubmit = null, importing = null;
    const revealedQuotes = new Set();
    const movieById = id => db.movies.find(m => m.id === id);
    const quoteById = id => db.quotes.find(q => q.id === id);
    const quoteCount = id => db.quotes.filter(q => q.movieId === id).length;
    const watched = () => db.movies.filter(m => db.views.some(v => v.movieId === m.id));
    const imageSource = value => { try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol) || /^data:image\//i.test(value)) return value; } catch (_) {} return fallback; };
    const poster = (movie, cls = 'movie-poster') => `<img class="${cls}" src="${escape(imageSource(movie.poster))}" alt="" loading="lazy" decoding="async">`;
    const action = (name, label, id = '', cls = 'btn btn-outline btn-small', extra = '') => `<button type="button" class="${cls}" data-action="${name}" data-id="${escape(id)}" ${extra}>${label}</button>`;
    const empty = (title, description, button = '') => `<div class="empty-state"><h3>${title}</h3><p>${description}</p>${button ? `<div class="spaced">${button}</div>` : ''}</div>`;
    const heading = (eyebrow, title, description = '', actions = '') => `<div class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1 class="page-title">${title}</h1>${description ? `<p class="page-description">${description}</p>` : ''}</div><div class="heading-actions">${actions}</div></div>`;
    function toast(message, undo = false) {
        const stack = drawer.open ? $('#drawer-notifications') : $('#notifications');
        const el = document.createElement('div'); el.className = 'notification';
        const label = document.createElement('span'); label.textContent = message; el.append(label);
        if (undo) { const b = document.createElement('button'); b.className = 'text-button'; b.type = 'button'; b.textContent = 'Отменить'; b.dataset.action = 'undo'; el.append(b); }
        if (stack.children.length >= 3) stack.firstElementChild.remove();
        stack.append(el); setTimeout(() => el.remove(), undo ? 15000 : 5000);
    }
    function commit(change, message, undo = false) {
        const before = structuredClone(db);
        const next = structuredClone(db);
        change(next); next.revision = db.revision + 1;
        const raw = Account?.user ? Account.persist(next, expectedRaw, () => { if(message)toast(message,undo); }) : M.persist(storage, next, expectedRaw);
        db = next; expectedRaw = raw; mutation++;
        lastUndo = undo ? {data: before, mutation} : null;
        document.querySelectorAll('[data-action="undo"]').forEach(b => b.remove());
        selected = new Set([...selected].filter(id => movieById(id)));
        if (message && !Account?.user) toast(message, undo);
    }
    function refresh() {
        const y = scrollY;
        renderPage();
        if (drawer.open) {
            if (movieById(activeMovie)) renderDetail();
            else drawer.close();
        }
        window.scrollTo(0, y);
    }
    function go(name) {
        $('#global-search').value = '';
        if (location.hash === '#' + name) navigate(); else location.hash = name;
    }
    function navigate() {
        const name = location.hash.slice(1);
        currentPage = ['home','movies','diary','quotes','collections','watchlist','stats','data','account'].includes(name) ? name : 'home';
        $('#global-search').value = '';
        document.querySelectorAll('.primary-nav a').forEach(a => { const active = a.hash === '#' + currentPage; a.classList.toggle('active', active); if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
        renderPage(); window.scrollTo(0, 0);
    }
    function ratingOptions(value) {
        return [0,1,2,3,4,5].map(n => `<option value="${n}" ${Number(value) === n ? 'selected' : ''}>${n ? '★ ' + n + '/5' : 'Без оценки'}</option>`).join('');
    }
    function movieCard(movie, selectable = false) {
        const views = M.movieViews(db, movie.id), view = views[0];
        return `<article class="movie-card ${layout === 'list' && currentPage === 'movies' ? 'list-card' : ''}">
            <button type="button" class="poster-button" data-action="open-movie" data-id="${escape(movie.id)}" aria-label="Открыть фильм: ${escape(movie.title)}">${poster(movie)}</button>
            <div class="movie-info"><div class="card-title-row"><button class="title-button" data-action="open-movie" data-id="${escape(movie.id)}">${escape(movie.title)}</button>${selectable ? `<label class="select-card"><input type="checkbox" data-select="${escape(movie.id)}" ${selected.has(movie.id) ? 'checked' : ''} aria-label="Выбрать: ${escape(movie.title)}"></label>` : ''}</div>
            <div class="movie-meta"><span>${types[movie.type]}</span><span>${escape(movie.year || 'Год не указан')}</span></div>
            ${view ? `<div class="card-rating"><label class="sr-only" for="rating-${escape(view.id)}">Оценка последнего просмотра: ${escape(movie.title)}</label><select id="rating-${escape(view.id)}" data-rating="${escape(view.id)}">${ratingOptions(view.rating)}</select><span>${views.length > 1 ? views.length + ' просмотра' : '1 просмотр'}</span></div>` : '<p class="small muted">Ещё не просмотрено</p>'}
            <div class="card-bottom"><span>${quoteCount(movie.id)} цитат</span>${action('new-quote','+ Цитата',movie.id,'text-button')}</div></div></article>`;
    }
    function viewRow(view, compact = false) {
        const movie = movieById(view.movieId);
        return `<article class="timeline-row"><div class="timeline-date">${escape(dateLabel(view.date))}</div><div class="timeline-body"><button class="title-button" data-action="open-movie" data-id="${escape(movie.id)}">${escape(movie.title)}</button><div class="small muted">${view.rating ? '★ ' + view.rating + '/5' : 'Без оценки'}${view.company ? ' · ' + escape(view.company) : ''}${view.mood ? ' · ' + escape(view.mood) : ''}</div>${view.note ? `<p class="view-note">${escape(compact && view.note.length > 160 ? view.note.slice(0,160) + '…' : view.note)}</p>` : ''}${compact ? '' : `<div class="inline-actions">${action('edit-view','Изменить',view.id,'text-button')}${action('delete-view','Удалить просмотр',view.id,'text-button danger-text')}</div>`}</div></article>`;
    }
    function quoteCard(quote, compact = false) {
        const movie = movieById(quote.movieId);
        const hidden = quote.spoiler && !revealedQuotes.has(quote.id);
        return `<article class="quote-card"><div class="quote-source"><button class="text-button" data-action="open-movie" data-id="${escape(movie.id)}">${escape(movie.title)}</button>${quote.spoiler ? '<span class="badge">Спойлер</span>' : ''}</div>
        ${hidden ? `<div class="spoiler-cover"><p>Цитата скрыта, чтобы сохранить интригу.</p>${action('reveal-quote','Показать цитату',quote.id)}</div>` : `<blockquote>${escape(quote.text)}</blockquote><p class="small muted">${escape([quote.character,quote.time].filter(Boolean).join(' · '))}</p>${quote.note && !compact ? `<p class="view-note">${escape(quote.note)}</p>` : ''}`}
        <div class="tag-row">${quote.tags.map(t => action('quote-tag',escape(t),t,'tag')).join('')}</div>
        <div class="inline-actions">${!hidden ? action('copy-quote','Копировать',quote.id,'text-button') : ''}${!compact ? action('edit-quote','Изменить',quote.id,'text-button') + action('delete-quote','Удалить',quote.id,'text-button danger-text') : ''}</div></article>`;
    }
    function renderHome() {
        const recent = M.filtered(db,M.defaults()).slice(0,4);
        const recentViews = [...db.views].sort((a,b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)).slice(0,3);
        const lastQuote = [...db.quotes].sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0];
        page.innerHTML = `<section class="center-hero"><div><p class="eyebrow">ВАШ ЛИЧНЫЙ ЦЕНТР КИНО</p><h1>Истории заканчиваются.<br><em>Ваши впечатления остаются.</em></h1><p>Просмотры, любимые фразы и мысли после титров — всё рядом.</p></div><div class="mini-screen" aria-hidden="true"></div></section>
            <div class="quick-stats">${[['movies',watched().length,'фильмов в коллекции'],['diary',db.views.length,'просмотров'],['quotes',db.quotes.length,'сохранённых цитат'],['collections',db.collections.length,'личных подборок']].map(([p,n,l]) => `<a href="#${p}"><strong>${n}</strong><span>${l}</span><b aria-hidden="true">↗</b></a>`).join('')}</div>
            ${db.presets.length ? `<div class="preset-shortcuts"><span class="small muted">Мои фильтры</span>${db.presets.map(p => action('apply-preset',escape(p.name),p.id,'tag')).join('')}</div>` : ''}
            <div class="section-heading"><h2>Недавно в вашей истории</h2><a href="#movies" class="text-link">Вся коллекция →</a></div>
            <div class="movies-grid">${recent.length ? recent.map(m => movieCard(m)).join('') : empty('Ваш киноархив начинается здесь','Добавьте первый просмотр. Дата, оценка и впечатления — по желанию.',action('new-view','+ Добавить просмотр','','btn'))}</div>
            <div class="home-columns"><section><div class="section-heading"><h2>Последние вечера</h2><a class="text-link" href="#diary">Дневник →</a></div>${recentViews.length ? recentViews.map(v => viewRow(v,true)).join('') : '<p class="muted">Здесь появятся даты и впечатления от просмотров.</p>'}</section><section><div class="section-heading"><h2>Осталось в памяти</h2><a class="text-link" href="#quotes">Цитатник →</a></div>${lastQuote ? quoteCard(lastQuote,true) : empty('Сохраните первую цитату','Откройте фильм и добавьте фразу, которую хочется запомнить.',action('new-quote','+ Добавить цитату','','btn btn-outline'))}</section></div>`;
    }
    const filterLabels = {query:'Поиск',type:'Тип',genre:'Жанр',rating:'Оценка от',from:'После',to:'До',quotes:'Цитаты',notes:'Заметки',repeat:'Повторный просмотр',tag:'Тег',company:'С кем',mood:'Настроение',collection:'Подборка'};
    function option(value,label,selectedValue) { return `<option value="${escape(value)}" ${value === selectedValue ? 'selected' : ''}>${escape(label)}</option>`; }
    function filterSelect(key,label,options) { return `<div class="filter-field"><label for="filter-${key}">${label}</label><select id="filter-${key}" data-filter="${key}">${options.map(([v,l]) => option(v,l,filters[key])).join('')}</select></div>`; }
    function filterCount(key,value) { return M.filtered(db,{...filters,[key]:value}).length; }
    function renderLibrary() {
        const genres = [...new Set(db.movies.flatMap(m => M.tags(m.genre)))].sort((a,b)=>a.localeCompare(b,'ru'));
        const personalTags = [...new Set(db.movies.flatMap(m => m.tags))].sort((a,b)=>a.localeCompare(b,'ru'));
        page.innerHTML = heading('ЛИЧНЫЙ АРХИВ','Моя коллекция','Фильтруйте фильмы по тому, что посмотрели и запомнили.',action('new-view','+ Добавить просмотр','','btn')) + `
            <div class="library-toolbar"><input id="collection-search" type="search" data-filter="query" value="${escape(filters.query)}" aria-label="Поиск в коллекции" placeholder="Название, заметка или цитата…"><div class="view-switch" aria-label="Вид коллекции">${action('layout','Постеры','grid','small-choice',`aria-pressed="${layout==='grid'}"`)}${action('layout','Список','list','small-choice',`aria-pressed="${layout==='list'}"`)}<a href="#diary">Хронология</a></div></div>
            <details class="filter-panel" ${Object.keys(filterLabels).some(k => k !== 'query' && filters[k]) ? 'open' : ''}><summary>Фильтры <span class="small muted">Жанры, цитаты, даты, теги и впечатления</span></summary><div class="filter-grid">
            ${filterSelect('type','Тип',[['','Все типы'],...Object.entries(types).map(([v,l])=>[v,`${l} (${filterCount('type',v)})`])])}
            ${filterSelect('genre','Жанр',[['','Все жанры'],...genres.map(g=>[g,`${g} (${filterCount('genre',g)})`])])}
            ${filterSelect('rating','Оценка последнего просмотра',[['','Любая'],['5','5 / 5'],['4','4 и выше'],['3','3 и выше'],['2','2 и выше'],['1','Есть оценка']])}
            ${filterSelect('quotes','Цитаты',[['','Неважно'],['yes','Есть цитаты'],['no','Без цитат']])}
            ${filterSelect('notes','Впечатления',[['','Неважно'],['yes','Есть заметки'],['no','Без заметок']])}
            ${filterSelect('repeat','Число просмотров',[['','Неважно'],['yes','Смотрел несколько раз'],['no','Смотрел один раз']])}
            ${filterSelect('tag','Личный тег',[['','Все теги'],...personalTags.map(t=>[t,t])])}
            ${filterSelect('collection','Подборка',[['','Все подборки'],...db.collections.map(c=>[c.id,c.name])])}
            <div><label for="filter-from">Просмотрено с</label><input id="filter-from" type="date" data-filter="from" value="${escape(filters.from)}"></div><div><label for="filter-to">Просмотрено до</label><input id="filter-to" type="date" data-filter="to" value="${escape(filters.to)}"></div>
            <div><label for="filter-company">С кем смотрели</label><input id="filter-company" data-filter="company" value="${escape(filters.company)}" placeholder="С друзьями"></div><div><label for="filter-mood">Настроение</label><input id="filter-mood" data-filter="mood" value="${escape(filters.mood)}" placeholder="Спокойствие"></div>
            </div><p class="field-hint">Условия применяются вместе. Дата, компания и настроение относятся к одному просмотру.</p></details>
            <div class="preset-bar"><label class="sr-only" for="saved-filter">Сохранённые фильтры</label><select id="saved-filter"><option value="">Мои сохранённые фильтры</option>${db.presets.map(p=>option(p.id,p.name,'')).join('')}</select>${action('save-preset','Сохранить текущий фильтр')}${action('clear-filters','Сбросить','','text-button')}<label class="sort-label" for="filter-sort">Порядок<select id="filter-sort" data-filter="sort">${[['recent','Сначала недавние'],['oldest','Сначала ранние'],['rating','По оценке'],['title','По названию']].map(([v,l])=>option(v,l,filters.sort)).join('')}</select></label></div>
            <div id="filter-chips" class="tag-row"></div><div id="selection-bar"></div><div id="library-results"></div>`;
        renderLibraryResults();
    }
    function renderSelection() {
        const el = $('#selection-bar'); if (!el) return;
        el.innerHTML = selected.size ? `<div class="selection-bar"><span>Выбрано: ${selected.size}</span>${action('bulk-add','В подборку','','btn btn-small')}${action('clear-selection','Снять выделение','','text-button')}</div>` : '';
    }
    function renderLibraryResults() {
        if (!$('#library-results')) return;
        const rows = M.filtered(db,filters);
        $('#filter-chips').innerHTML = Object.entries(filterLabels).filter(([key])=>filters[key]).map(([key,label])=> {
            let value = filters[key];
            if (key === 'type') value = types[value];
            if (['quotes','notes','repeat'].includes(key)) value = value === 'yes' ? 'да' : 'нет';
            if (key === 'collection') value = db.collections.find(c=>c.id===value)?.name || 'Удалённая подборка';
            return action('remove-filter',`${label}: ${escape(value)} ×`,key,'tag');
        }).join('');
        const invalidRange = filters.from && filters.to && filters.from > filters.to;
        $('#library-results').innerHTML = `<p class="result-count" role="status">Найдено: ${rows.length} из ${watched().length}</p>${invalidRange ? '<p class="form-error" role="alert">Дата начала должна быть не позже даты окончания.</p>' : ''}<div class="movies-grid ${layout === 'list' ? 'movie-list' : ''}">${rows.length ? rows.map(m=>movieCard(m,true)).join('') : empty('Ничего не найдено','Попробуйте убрать часть условий или добавьте просмотр.',action('clear-filters','Сбросить фильтры'))}</div>`;
        renderSelection();
        for (const key of ['type','genre']) {
            const control=$('#filter-'+key);
            if(control)for(const opt of control.options)if(opt.value){const name=key==='type'?types[opt.value]:opt.value;opt.textContent=`${name} (${filterCount(key,opt.value)})`;}
        }
    }
    function renderDiary() {
        const months = [...new Set(db.views.map(v=>v.date.slice(0,7)))].sort().reverse();
        const all = [...db.views].sort((a,b)=>b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
        const rows = all.filter(v=>!diaryMonth || (diaryMonth==='undated' ? !v.date : v.date.startsWith(diaryMonth)));
        page.innerHTML = heading('ИСТОРИЯ ВЕЧЕРОВ','Дневник просмотров','Каждый просмотр — отдельное воспоминание.',action('new-view','+ Записать просмотр','','btn')) + `<div class="diary-toolbar"><label for="diary-month">Месяц<select id="diary-month">${option('','Все месяцы',diaryMonth)}${months.map(m=>option(m || 'undated',m ? new Intl.DateTimeFormat('ru',{month:'long',year:'numeric'}).format(new Date(m+'-01T12:00:00')) : 'Без даты',diaryMonth)).join('')}</select></label><span class="muted">${rows.length} записей</span></div><div class="timeline">${rows.length ? rows.map(v=>viewRow(v)).join('') : empty('Здесь пока тихо','Добавьте просмотр или выберите другой месяц.')}</div>`;
    }
    function renderQuotes() {
        const themes = [...new Set(db.quotes.flatMap(q=>q.tags))].sort((a,b)=>a.localeCompare(b,'ru'));
        page.innerHTML = heading('ФРАЗЫ, КОТОРЫЕ ОСТАЛИСЬ','Мой цитатник','Слова из фильмов, персонажи и ваши мысли рядом.',action('new-quote','+ Сохранить цитату','','btn')) + `<div class="quote-filters"><input id="quote-search" type="search" value="${escape(quoteSearch)}" placeholder="Фраза, фильм или персонаж…" aria-label="Поиск цитат"><label class="sr-only" for="quote-tag-filter">Тема цитаты</label><select id="quote-tag-filter">${option('','Все темы',quoteTag)}${themes.map(t=>option(t,t,quoteTag)).join('')}</select></div><div id="quote-results"></div>`;
        renderQuoteResults();
    }
    function renderQuoteResults() {
        const q = M.lower(quoteSearch).trim();
        const rows = db.quotes.filter(c=>(!q || M.lower([c.text,c.character,c.note,movieById(c.movieId).title,...c.tags].join(' ')).includes(q)) && (!quoteTag || c.tags.includes(quoteTag))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
        $('#quote-results').innerHTML = `<p class="result-count" role="status">Цитат: ${rows.length}</p><div class="quote-grid">${rows.length ? rows.map(c=>quoteCard(c)).join('') : empty('Найдите слова, которые хочется сохранить','Добавьте цитату из карточки фильма или с помощью кнопки выше.')}</div>`;
    }
    function renderCollections() {
        if (activeCollection && !db.collections.some(c=>c.id===activeCollection)) activeCollection='';
        const collection = db.collections.find(c=>c.id===activeCollection);
        if (collection) {
            page.innerHTML = `${action('collections-back','← Все подборки','','text-button')} ` + heading('ЛИЧНАЯ ПОДБОРКА',escape(collection.name),escape(collection.description),action('edit-collection','Изменить',collection.id) + action('collection-pick','Добавить фильмы',collection.id,'btn')) + `<div class="collection-list">${collection.movieIds.length ? collection.movieIds.map((id,index)=>{const m=movieById(id);return `<article class="collection-row">${poster(m,'watchlist-poster')}<div class="collection-row-info"><button class="title-button" data-action="open-movie" data-id="${escape(id)}">${escape(m.title)}</button><p class="small muted">${escape(m.year)} · ${types[m.type]}</p></div><div class="inline-actions">${action('collection-up','↑',id,'btn btn-small btn-outline',`aria-label="Переместить вверх: ${escape(m.title)}" ${index===0?'disabled':''}`)}${action('collection-down','↓',id,'btn btn-small btn-outline',`aria-label="Переместить вниз: ${escape(m.title)}" ${index===collection.movieIds.length-1?'disabled':''}`)}${action('collection-remove','Убрать',id,'text-button danger-text')}</div></article>`}).join('') : empty('Подборка пока пуста','Добавьте фильмы из коллекции или списка планов.')}</div>`;
        } else {
            page.innerHTML = heading('КИНО ПО ВАШИМ ПРАВИЛАМ','Личные подборки','Любимые финалы, уютные вечера или фильмы для пересмотра.',action('new-collection','+ Создать подборку','','btn')) + `<div class="collections-grid">${db.collections.length ? db.collections.map(c=>`<article class="collection-card"><div class="collection-spines" aria-hidden="true">${c.movieIds.slice(0,3).map(id=>poster(movieById(id))).join('') || '<div class="empty-spine"></div>'}</div><button class="title-button" data-action="open-collection" data-id="${escape(c.id)}">${escape(c.name)}</button><p class="small muted">${c.movieIds.length} фильмов</p><p>${escape(c.description)}</p><div class="inline-actions">${action('open-collection','Открыть',c.id)}${action('delete-collection','Удалить',c.id,'text-button danger-text')}</div></article>`).join('') : empty('Соберите свою первую подборку','Например, «Хочу пересмотреть» или «Смотрели вместе».')}</div>`;
        }
    }
    function renderWatchlist() {
        const rows = db.movies.filter(m=>m.planned);
        page.innerHTML = heading('ДЛЯ БУДУЩИХ ВЕЧЕРОВ','Хочу посмотреть','Новые фильмы и истории, к которым хочется вернуться.',action('new-planned','+ Добавить в планы','','btn')) + `<div class="watchlist-grid">${rows.length ? rows.map(m=>`<article class="watchlist-item">${poster(m,'watchlist-poster')}<div class="watchlist-info"><button class="title-button" data-action="open-movie" data-id="${escape(m.id)}">${escape(m.title)}</button><div class="watchlist-meta">${escape(m.year)} · ${types[m.type]} · ${escape(m.genre)}</div></div><div class="watchlist-actions">${action('rewatch','Записать просмотр',m.id,'btn btn-small')}${action('unplan','Убрать из планов',m.id,'text-button')}</div></article>`).join('') : empty('Список будущих просмотров пуст','Добавьте фильм или отметьте знакомую историю для пересмотра.')}</div>`;
    }
    function renderStats() {
        const rated = db.views.filter(v=>v.rating>0);
        const average = rated.length ? (rated.reduce((sum,v)=>sum+v.rating,0)/rated.length).toFixed(1) : '—';
        const genres = new Map();
        watched().forEach(m=>M.tags(m.genre).forEach(g=>genres.set(g,(genres.get(g)||0)+1)));
        const sorted = [...genres].sort((a,b)=>b[1]-a[1]);
        page.innerHTML = heading('ВАШ ПУТЬ В КИНО','Мой киноопыт','Нажмите на жанр или показатель, чтобы открыть записи.') + `<div class="quick-stats">${[['movies',watched().length,'разных фильмов'],['diary',db.views.length,'всего просмотров'],['quotes',db.quotes.length,'цитат'],['repeat',watched().filter(m=>M.movieViews(db,m.id).length>1).length,'фильмов пересмотрено']].map(([p,n,l])=>`<button data-action="stat-open" data-id="${p}"><strong>${n}</strong><span>${l}</span><b aria-hidden="true">↗</b></button>`).join('')}</div><div class="average-rating"><strong>★ ${average}</strong><p>Средняя оценка по ${rated.length} оценённым просмотрам.<br><span class="muted">Повторные просмотры учитываются отдельно.</span></p></div><div class="section-heading"><h2>Жанры вашей коллекции</h2></div><div class="genre-stats">${sorted.length ? sorted.map(([g,n])=>`<button class="genre-row genre-button" data-action="genre-open" data-id="${escape(g)}"><span class="genre-name">${escape(g)}</span><span class="genre-track"><span class="genre-fill" style="width:${n/sorted[0][1]*100}%"></span></span><span class="genre-count">${n}</span></button>`).join('') : '<p class="muted">Укажите жанры у фильмов, чтобы увидеть статистику.</p>'}</div>`;
    }
    function renderData() {
        page.innerHTML = heading('ВАША КОЛЛЕКЦИЯ ПОД КОНТРОЛЕМ','Резервные копии',Account?.user?'Архив хранится в вашем аккаунте. Скачивайте резервные копии для дополнительной сохранности.':'Данные хранятся в этом браузере. Скачивайте копию, чтобы перенести архив или восстановить его.') + `<div class="data-panels"><section class="data-panel"><h2>Сохранить архив</h2><p>Фильмы, история просмотров, цитаты, подборки и сохранённые фильтры — в одном JSON-файле.</p>${action('export','Скачать полную копию','','btn')}</section><section class="data-panel"><h2>Восстановить архив</h2><p>Поддерживаются полные копии и старые выгрузки CineDairy. Перед заменой вы увидите состав файла.</p><label for="import-file">Выберите JSON-файл</label><input id="import-file" type="file" accept=".json,application/json"><p id="import-status" role="status"></p></section></div><section class="data-panel spaced"><h2>Сохранённые фильтры</h2>${db.presets.length ? db.presets.map(p=>`<div class="saved-filter-row"><span>${escape(p.name)}</span>${action('apply-preset','Открыть',p.id)}${action('delete-preset','Удалить',p.id,'text-button danger-text')}</div>`).join('') : '<p class="muted">Сохраните удобное сочетание условий в коллекции.</p>'}</section><section class="data-panel spaced"><h2>Копия перед восстановлением</h2><p>${Account?.user?'При восстановлении предыдущая версия остаётся в памяти этой вкладки до её закрытия. Скачайте её при необходимости.':'При импорте предыдущая версия архива сохраняется отдельно, если в браузере достаточно места.'}</p>${action('export-previous','Скачать предыдущую копию')}</section><section class="data-panel spaced"><h2>Поиск фильмов</h2><p>${Account?.enabled?'Автопоиск выполняется через сервер после входа в аккаунт. Ключ настраивает владелец сайта. Всегда доступно ручное добавление.':'Добавьте свой API-ключ Kinopoisk Unofficial для автоматического заполнения. Ключ хранится в этом браузере и не включается в резервные копии.'}</p>${action('api-settings','Настроить автопоиск','','btn btn-outline')}</section><section class="danger-zone"><h2>Очистить архив</h2><p>Удалятся все фильмы, просмотры, цитаты, подборки и фильтры текущего архива.</p>${action('reset','Очистить данные','','btn btn-danger')}</section>`;
    }
    function renderSearch(query) {
        const q = M.lower(query).trim();
        const movies = db.movies.filter(m=>M.lower([m.title,m.year,m.genre,...m.tags].join(' ')).includes(q));
        const views = db.views.filter(v=>M.lower(v.note).includes(q));
        const quotes = db.quotes.filter(c=>M.lower([c.text,c.character,c.note,...c.tags].join(' ')).includes(q));
        page.innerHTML = heading('ПО ВСЕМУ КИНОАРХИВУ','Результаты поиска',`Запрос: ${escape(query)}`) + `<p role="status" class="result-count">Фильмов: ${movies.length} · заметок: ${views.length} · цитат: ${quotes.length}</p><h2 class="search-group-title">Фильмы</h2><div class="movies-grid">${movies.length?movies.map(m=>movieCard(m)).join(''):'<p class="muted">Нет совпадений в названиях и сведениях.</p>'}</div><h2 class="search-group-title">Заметки о просмотрах</h2>${views.length?views.map(v=>viewRow(v)).join(''):'<p class="muted">Нет совпадений в заметках.</p>'}<h2 class="search-group-title">Цитаты</h2><div class="quote-grid">${quotes.length?quotes.map(c=>quoteCard(c)).join(''):'<p class="muted">Нет совпадений в цитатах.</p>'}</div>`;
    }
    function renderPage() {
        if (!loaded) return;
        const query = $('#global-search').value.trim();
        if (currentPage === 'account') return Account?.renderPage(page);
        if (query) return renderSearch(query);
        ({home:renderHome,movies:renderLibrary,diary:renderDiary,quotes:renderQuotes,collections:renderCollections,watchlist:renderWatchlist,stats:renderStats,data:renderData}[currentPage] || renderHome)();
    }
    function openMovie(id, tab = 'overview') {
        if (!movieById(id)) return;
        activeMovie=id;detailTab=tab;renderDetail();
        if (!drawer.open) drawer.showModal();
    }
    function renderDetail() {
        const m=movieById(activeMovie);if(!m)return;
        const scroll=drawer.scrollTop, views=M.movieViews(db,m.id), quotes=db.quotes.filter(q=>q.movieId===m.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
        const memberships=db.collections.filter(c=>c.movieIds.includes(m.id));
        $('#movie-detail').innerHTML=`<div class="detail-hero">${poster(m,'detail-poster')}<div><p class="eyebrow">${types[m.type]} · ${escape(m.year || 'Год не указан')}</p><h2 id="detail-title">${escape(m.title)}</h2><p class="muted">${escape(m.genre || 'Жанр не указан')}</p><div class="tag-row">${m.tags.map(t=>action('movie-tag',escape(t),t,'tag')).join('')}</div><p class="detail-numbers">${views.length} просмотров <span>·</span> ${quotes.length} цитат ${views[0]?.rating ? '<span>·</span> ★ '+views[0].rating+'/5' : ''}</p><div class="inline-actions">${action('rewatch',views.length?'+ Повторный просмотр':'+ Записать просмотр',m.id,'btn btn-small')}${action('new-quote','+ Цитата',m.id)}${action('add-to-collection','В подборку',m.id)}</div></div></div>
        <div class="detail-tabs" aria-label="Раздел карточки">${[['overview','Обзор'],['views','Просмотры · '+views.length],['quotes','Цитаты · '+quotes.length]].map(([id,label])=>action('detail-tab',label,id,'small-choice',`aria-pressed="${detailTab===id}"`)).join('')}</div>
        <div class="detail-section">${detailTab==='views' ? (views.length?views.map(v=>viewRow(v)).join(''):empty('Просмотров пока нет','Запишите первый просмотр этого фильма.')) : detailTab==='quotes' ? (quotes.length?quotes.map(q=>quoteCard(q)).join(''):empty('Какая фраза вам запомнилась?','Сохраните её вместе с персонажем, временем сцены и своими мыслями.',action('new-quote','+ Добавить цитату',m.id,'btn'))) : `<h3>Последнее впечатление</h3><p class="view-note">${escape(views[0]?.note || 'Пока без заметки. Добавьте впечатления к просмотру.')}</p>${views[0]?`<p class="small muted">${escape(dateLabel(views[0].date))}</p>${action('edit-view','Дополнить впечатления',views[0].id)}`:''}<h3 class="spaced">В ваших подборках</h3><div class="tag-row">${memberships.map(c=>action('open-collection',escape(c.name),c.id,'tag')).join('')||'<span class="muted">Пока не добавлен в подборки.</span>'}</div><div class="detail-management">${action('edit-meta','Изменить сведения',m.id)}${action(m.planned?'unplan':'plan',m.planned?'Убрать из планов':'Хочу посмотреть',m.id)}${action('delete-movie','Удалить фильм',m.id,'text-button danger-text')}</div>`}</div>`;
        drawer.scrollTop=scroll;
    }
    function field(name,label,value='',type='text',attrs='') {return `<div class="form-group"><label for="field-${name}">${label}</label><input id="field-${name}" name="${name}" type="${type}" value="${escape(value)}" ${attrs}></div>`;}
    function area(name,label,value='',attrs='') {return `<div class="form-group full-width"><label for="field-${name}">${label}</label><textarea id="field-${name}" name="${name}" ${attrs}>${escape(value)}</textarea></div>`;}
    function selectField(name,label,options,value='') {return `<div class="form-group"><label for="field-${name}">${label}</label><select id="field-${name}" name="${name}">${options.map(([v,l])=>option(v,l,String(value))).join('')}</select></div>`;}
    function showForm(title,body,onSubmit,submitLabel='Сохранить',danger=false) {
        apiVersion++;clearTimeout(apiTimer);
        $('#form-content').innerHTML=`<form id="active-form"><div class="modal-header"><h2 id="form-title" class="modal-title">${escape(title)}</h2><button class="close-modal" data-close type="button" aria-label="Закрыть форму">×</button></div>${body}<p class="form-error" role="alert"></p><div class="form-actions"><button type="submit" class="btn ${danger?'btn-danger':''}">${submitLabel}</button><button type="button" data-close class="btn btn-outline">Отмена</button></div></form>`;
        formSubmit=onSubmit;if(!formDialog.open)formDialog.showModal();
    }
    function closeForm(){formDialog.close();apiVersion++;clearTimeout(apiTimer);}
    function movieFields(movie={}) {
        return `<div class="form-grid">${field('title','Название *',movie.title,'text','required maxlength="300"')}${selectField('type','Тип',Object.entries(types),movie.type||'FILM')}${field('year','Год',movie.year,'number','min="1888" max="2100"')}${field('genre','Жанры через запятую',movie.genre,'text','maxlength="500"')}${field('tags','Личные теги',movie.tags?.join(', '),'text','maxlength="500" placeholder="уютное, хочу пересмотреть"')}${field('poster','Ссылка на постер',movie.poster,'url','placeholder="https://…"')}</div>`;
    }
    function viewFields(view={}) {
        return `<div class="form-grid spaced">${field('date','Дата просмотра',view.date??M.today(),'date')}${selectField('rating','Оценка этого просмотра',[['0','Без оценки'],...Array.from({length:5},(_,i)=>[String(i+1),'★ '+(i+1)+'/5'])],view.rating||0)}${field('company','С кем смотрели',view.company,'text','maxlength="300" placeholder="Один, с семьёй, с друзьями…"')}${field('mood','Настроение',view.mood,'text','maxlength="300" placeholder="Спокойствие, восторг…"')}${area('note','Что запомнилось',view.note,'maxlength="20000" placeholder="Мысли после титров…"')}</div><p class="field-hint">Не помните дату? Оставьте поле пустым.</p>`;
    }
    function openEntry(movieId='',viewId='',planned=false) {
        const existing=movieById(movieId),view=db.views.find(v=>v.id===viewId);
        const picker=!existing?`<label for="entry-existing">Фильм из моего архива</label><select id="entry-existing"><option value="">Новый фильм или сериал</option>${db.movies.map(m=>option(m.id,m.title+(m.year?' · '+m.year:''),'')).join('')}</select><div id="entry-new-fields"><div class="search-container spaced"><label for="api-search">Найти и заполнить сведения</label><input id="api-search" type="search" autocomplete="off" placeholder="Название фильма…" aria-controls="api-results"><div id="api-results" class="search-results" role="region" aria-live="polite" aria-label="Результаты поиска"></div><p class="field-hint">Можно заполнить сведения вручную ниже.</p></div>${movieFields()}</div>`:`<p class="entry-film-title">${escape(existing.title)}</p>`;
        showForm(view?'Изменить просмотр':existing?'Записать просмотр':planned?'Добавить в планы':'Добавить просмотр',picker+(planned?'':viewFields(view)),data=>{
            const chosen=existing?.id || $('#entry-existing')?.value;
            const title=data.get('title')?.trim();
            if(!chosen && !title)throw Error('Укажите название фильма.');
            const newMovieId=chosen||M.uid('movie');
            commit(next=>{
                if(!chosen)next.movies.unshift({id:newMovieId,title,type:data.get('type'),year:data.get('year')||'',genre:data.get('genre')||'',poster:data.get('poster')||'',tags:M.tags(data.get('tags')),planned,createdAt:new Date().toISOString()});
                const movie=next.movies.find(m=>m.id===newMovieId);
                movie.planned=planned;
                if(!planned){const record={id:view?.id||M.uid('view'),movieId:newMovieId,date:data.get('date')||'',rating:Number(data.get('rating')),note:data.get('note')||'',company:data.get('company')||'',mood:data.get('mood')||'',createdAt:view?.createdAt||new Date().toISOString()};if(view)next.views=next.views.map(v=>v.id===view.id?record:v);else next.views.unshift(record);}
            },planned?'Фильм добавлен в планы':view?'Просмотр обновлён':'Просмотр сохранён');
            closeForm();refresh();
        });
    }
    function openQuote(movieId='',quoteId='') {
        if(!db.movies.length){toast('Сначала добавьте фильм в коллекцию или планы.');return;}
        const quote=quoteById(quoteId);
        const selectedMovie=quote?.movieId||movieId||db.movies[0].id;
        showForm(quote?'Изменить цитату':'Сохранить цитату',selectField('movieId','Фильм *',db.movies.map(m=>[m.id,m.title]),selectedMovie)+`<div class="spaced">${area('text','Цитата *',quote?.text,'required maxlength="10000" placeholder="Фраза, которую хочется сохранить…"')}</div><div class="form-grid spaced">${field('character','Персонаж',quote?.character,'text','maxlength="300"')}${field('time','Время сцены',quote?.time,'text','pattern="([0-9]{1,2}:)?[0-5][0-9]:[0-5][0-9]" placeholder="01:24:10"')}${field('tags','Темы через запятую',quote?.tags.join(', '),'text','maxlength="500" placeholder="о выборе, дружба"')}${area('note','Личный комментарий',quote?.note,'maxlength="20000"')}</div><p class="field-hint">Время сцены: 24:10 или 01:24:10.</p><label class="check-label spaced"><input type="checkbox" name="spoiler" ${quote?.spoiler?'checked':''}> Содержит спойлер — скрывать до нажатия</label>`,data=>{
            if(!data.get('text').trim())throw Error('Введите текст цитаты.');
            commit(next=>{const record={id:quote?.id||M.uid('quote'),movieId:data.get('movieId'),text:data.get('text').trim(),character:data.get('character')||'',time:data.get('time')||'',note:data.get('note')||'',tags:M.tags(data.get('tags')),spoiler:data.has('spoiler'),createdAt:quote?.createdAt||new Date().toISOString()};if(quote)next.quotes=next.quotes.map(q=>q.id===quote.id?record:q);else next.quotes.unshift(record);},'Цитата сохранена');
            if(quote)revealedQuotes.delete(quote.id);closeForm();refresh();
        },'Сохранить цитату');
    }
    function confirm(title,description,operation,label='Удалить') {showForm(title,`<p class="spaced">${escape(description)}</p>`,()=>{operation();closeForm();refresh()},label,true);}
    function openCollectionForm(id='') {
        const item=db.collections.find(c=>c.id===id);
        showForm(item?'Изменить подборку':'Создать подборку',field('name','Название *',item?.name,'text','required maxlength="150"')+`<div class="spaced">${area('description','Описание',item?.description,'maxlength="3000"')}</div>`,data=>{
            if(!data.get('name').trim())throw Error('Введите название подборки.');
            const newId=item?.id||M.uid('collection');
            commit(next=>{const record={id:newId,name:data.get('name').trim(),description:data.get('description'),movieIds:item?.movieIds||[]};if(item)next.collections=next.collections.map(c=>c.id===id?record:c);else next.collections.push(record);},'Подборка сохранена');closeForm();activeCollection=newId;refresh();
        });
    }
    function openBulk(ids) {
        bulkIds=[...new Set(ids)].filter(id=>movieById(id));if(!bulkIds.length){toast('Выберите хотя бы один фильм.');return;}
        showForm('Добавить в подборку',`<p>Выбрано фильмов: ${bulkIds.length}</p>`+selectField('collection','Выберите подборку',[['','Выберите…'],...db.collections.map(c=>[c.id,c.name])])+`<div class="spaced">${field('newName','Или создайте новую','','text','maxlength="150" placeholder="Название новой подборки"')}</div>`,data=>{
            const newName=data.get('newName').trim(),id=data.get('collection');
            if(!newName&&!id)throw Error('Выберите подборку или введите название новой.');
            commit(next=>{let target=next.collections.find(c=>c.id===id);if(newName){target={id:M.uid('collection'),name:newName,description:'',movieIds:[]};next.collections.push(target)}target.movieIds=[...new Set([...target.movieIds,...bulkIds])]},'Фильмы добавлены в подборку');closeForm();selected.clear();refresh();
        },'Добавить');
    }
    function download(data,name) {
        const url=URL.createObjectURL(new Blob([typeof data==='string'?data:JSON.stringify(data,null,2)],{type:'application/json'}));
        const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }
    async function importFile(file) {
        if(!file)return;
        const status=$('#import-status');
        try{
            if(file.size>10*1024*1024)throw Error('Файл слишком большой. Максимум — 10 МБ.');
            const candidate=M.decodeBackup(JSON.parse(await file.text()));
            importing=structuredClone(candidate);
            const message=`В файле: ${candidate.movies.length} фильмов, ${candidate.views.length} просмотров, ${candidate.quotes.length} цитат, ${candidate.collections.length} подборок. Текущий архив будет заменён. Предыдущая версия сохранится в резервной копии.`;
            confirm('Восстановить архив?',message,()=>{
                storage.setItem('cinedairy.before-import',JSON.stringify(db));
                commit(next=>{const revision=next.revision;Object.assign(next,structuredClone(importing));next.revision=revision;},'Архив восстановлен',true);
                filters=M.defaults();selected.clear();activeCollection='';diaryMonth='';quoteTag='';quoteSearch='';
            },'Восстановить');
            status.textContent='Файл проверен. Подтвердите восстановление.';
        }catch(e){status.textContent=e.message;}
    }
    async function apiSearch(query,version) {
        const results=$('#api-results');if(!results)return;
        if(query.length<2){results.style.display='none';return;}
        const apiKey=Account?.enabled?'':localStorage.getItem(API_KEY_STORAGE)||'';
        if(!apiKey&&!Account?.enabled){results.style.display='block';results.innerHTML='<p class="api-message">Для автопоиска добавьте свой ключ Kinopoisk в разделе «Резервные копии и данные». Пока можно заполнить сведения вручную.</p>';return;}
        results.style.display='block';results.innerHTML='<p class="api-message">Поиск…</p>';
        try{
            let data;
            if(Account?.enabled){data=await Account.request('/api/catalog?q='+encodeURIComponent(query));}
            else {const response=await fetch(`${KINOPOISK_API_URL}?keyword=${encodeURIComponent(query)}`,{headers:{'X-API-KEY':apiKey,'Content-Type':'application/json'}});if(!response.ok)throw Error('Поиск недоступен.');data=await response.json();}if(version!==apiVersion||!formDialog.open)return;
            const rows=Array.isArray(data.items)?data.items.slice(0,8):[];
            results.replaceChildren();
            if(!rows.length){results.innerHTML='<p class="api-message">Ничего не найдено. Можно заполнить сведения вручную.</p>';return;}
            for(const item of rows){const b=document.createElement('button');b.type='button';b.className='search-result-item';const img=document.createElement('img');img.className='search-result-poster';img.src=imageSource(item.posterUrlPreview||item.posterUrl||'');img.alt='';img.loading='lazy';img.decoding='async';img.onerror=()=>{img.onerror=null;img.src=fallback;};const info=document.createElement('span');info.className='search-result-info';const title=document.createElement('span');title.className='search-result-title';title.textContent=item.nameRu||item.nameEn||'Без названия';const meta=document.createElement('span');meta.className='search-result-meta';const genre=(item.genres||[]).map(g=>typeof g==='string'?g:g?.genre).filter(Boolean).slice(0,2).join(', ');for(const value of [item.year,types[item.type]||'Фильм',genre].filter(Boolean)){const tag=document.createElement('span');tag.textContent=value;meta.append(tag);}info.append(title,meta);b.append(img,info);b.addEventListener('click',()=>{const f=$('#active-form');f.elements.title.value=item.nameRu||item.nameEn||'';f.elements.year.value=item.year||'';f.elements.type.value=M.TYPES.includes(item.type)?item.type:'FILM';f.elements.genre.value=(item.genres||[]).map(g=>g.genre).join(', ');f.elements.poster.value=item.posterUrl||item.posterUrlPreview||'';results.style.display='none';apiVersion++;$('#api-search').value='';f.elements.title.focus();});results.append(b);}
        }catch(e){if(version===apiVersion&&formDialog.open)results.innerHTML='<p class="api-message">Поиск недоступен. Заполните сведения вручную.</p>';}
    }
    function applyPreset(id) {
        const preset=db.presets.find(p=>p.id===id);if(!preset)return;
        filters={...M.defaults(),...preset.filters};selected.clear();go('movies');
    }
    const actions={
        'api-settings':()=>{if(Account?.enabled){toast('В серверной версии автопоиск настраивает владелец сайта. Для поиска войдите в аккаунт.');return;}showForm('Настроить автопоиск',field('apiKey','Ключ Kinopoisk Unofficial','','password','autocomplete="new-password" maxlength="300"')+'<p class="field-hint">Введите новый ключ. Пустое поле отключит автопоиск и удалит сохранённый ключ.</p>',data=>{const key=data.get('apiKey').trim();if(key)localStorage.setItem(API_KEY_STORAGE,key);else localStorage.removeItem(API_KEY_STORAGE);closeForm();toast(key?'Автопоиск настроен':'Автопоиск отключён')},'Сохранить настройку')},
        'new-view':()=>openEntry(), 'new-planned':()=>openEntry('','',true),
        'open-movie':id=>openMovie(id), 'rewatch':id=>openEntry(id),
        'edit-view':id=>{const v=db.views.find(v=>v.id===id);if(v)openEntry(v.movieId,id)},
        'new-quote':id=>openQuote(id), 'edit-quote':id=>openQuote('',id),
        'detail-tab':id=>{detailTab=id;renderDetail()},
        'edit-meta':id=>{const m=movieById(id);showForm('Сведения о фильме',movieFields(m),data=>{if(!data.get('title').trim())throw Error('Введите название.');commit(next=>{const movie=next.movies.find(m=>m.id===id);Object.assign(movie,{title:data.get('title').trim(),type:data.get('type'),year:data.get('year'),genre:data.get('genre'),poster:data.get('poster'),tags:M.tags(data.get('tags'))})},'Сведения обновлены');closeForm();refresh()})},
        'delete-view':id=>{const v=db.views.find(v=>v.id===id);confirm('Удалить просмотр?','Удалится только эта запись. Если она последняя, фильм останется в планах вместе с цитатами.',()=>commit(next=>{next.views=next.views.filter(v=>v.id!==id);if(!next.views.some(w=>w.movieId===v.movieId))next.movies.find(m=>m.id===v.movieId).planned=true},'Просмотр удалён',true))},
        'delete-quote':id=>confirm('Удалить цитату?','Цитата и её комментарий будут удалены. Действие можно отменить.',()=>commit(next=>{next.quotes=next.quotes.filter(q=>q.id!==id)},'Цитата удалена',true)),
        'delete-movie':id=>confirm('Удалить фильм из архива?','Будут удалены все его просмотры, цитаты и связи с подборками. Действие можно отменить.',()=>commit(next=>M.removeMovie(next,id),'Фильм удалён',true)),
        'plan':id=>{commit(next=>{next.movies.find(m=>m.id===id).planned=true},'Фильм добавлен в планы');refresh()},
        'unplan':id=>{if(!db.views.some(v=>v.movieId===id)){confirm('Убрать фильм из планов?','У фильма нет просмотров. Он будет удалён из архива вместе с цитатами и связями с подборками. Действие можно отменить.',()=>commit(next=>M.removeMovie(next,id),'Фильм убран из планов',true));}else{commit(next=>{next.movies.find(m=>m.id===id).planned=false},'Фильм убран из планов',true);refresh()}},
        'reveal-quote':id=>{revealedQuotes.add(id);refresh()},
        'copy-quote':async id=>{const q=quoteById(id);const value=q.text+'\n— '+movieById(q.movieId).title;try{await navigator.clipboard.writeText(value);toast('Цитата скопирована')}catch(_){showForm('Скопировать цитату',area('copy','Выделите и скопируйте текст',value,'readonly'),()=>closeForm(),'Готово');$('#field-copy').select()}},
        'quote-tag':tag=>{quoteTag=tag;if(drawer.open)drawer.close();go('quotes')},
        'movie-tag':tag=>{filters={...M.defaults(),tag};if(drawer.open)drawer.close();go('movies')},
        'layout':value=>{layout=value;renderLibrary()},
        'clear-filters':()=>{filters=M.defaults();selected.clear();renderLibrary()},
        'remove-filter':key=>{filters[key]='';selected.clear();renderLibrary()},
        'save-preset':()=>showForm('Сохранить фильтр',field('name','Название *','','text','required maxlength="120" placeholder="Любимые с цитатами"')+'<p class="field-hint">Сохранятся все текущие условия и сортировка.</p>',data=>{const name=data.get('name').trim();if(!name)throw Error('Введите название фильтра.');commit(next=>next.presets.push({id:M.uid('preset'),name,filters:{...filters}}),'Фильтр сохранён');closeForm();refresh()}),
        'apply-preset':applyPreset,
        'delete-preset':id=>{commit(next=>{next.presets=next.presets.filter(p=>p.id!==id)},'Фильтр удалён',true);refresh()},
        'clear-selection':()=>{selected.clear();renderLibraryResults()},
        'bulk-add':()=>openBulk([...selected]), 'add-to-collection':id=>openBulk([id]),
        'new-collection':()=>openCollectionForm(), 'edit-collection':openCollectionForm,
        'open-collection':id=>{activeCollection=id;if(drawer.open)drawer.close();go('collections')},
        'collections-back':()=>{activeCollection='';renderCollections()},
        'delete-collection':id=>confirm('Удалить подборку?','Фильмы, просмотры и цитаты останутся в архиве.',()=>commit(next=>{next.collections=next.collections.filter(c=>c.id!==id);next.presets.forEach(p=>{if(p.filters.collection===id)p.filters.collection=''})},'Подборка удалена',true)),
        'collection-pick':id=>{const c=db.collections.find(c=>c.id===id);showForm('Добавить фильмы',`<div class="movie-picker">${db.movies.filter(m=>!c.movieIds.includes(m.id)).map(m=>`<label class="check-label"><input type="checkbox" name="movies" value="${escape(m.id)}">${escape(m.title)}</label>`).join('')||'<p>Все фильмы архива уже в этой подборке.</p>'}</div>`,data=>{const ids=data.getAll('movies');if(!ids.length)throw Error('Выберите хотя бы один фильм.');commit(next=>{const collection=next.collections.find(c=>c.id===id);collection.movieIds=[...new Set([...collection.movieIds,...ids])]},'Фильмы добавлены');closeForm();refresh()},'Добавить')},
        'collection-remove':id=>{commit(next=>{const c=next.collections.find(c=>c.id===activeCollection);c.movieIds=c.movieIds.filter(mid=>mid!==id)},'Фильм убран из подборки',true);refresh()},
        'collection-up':id=>moveInCollection(id,-1), 'collection-down':id=>moveInCollection(id,1),
        'stat-open':id=>{if(id==='repeat'){filters={...M.defaults(),repeat:'yes'};go('movies')}else go(id)},
        'genre-open':genre=>{filters={...M.defaults(),genre};go('movies')},
        'export':()=>download({...db,exportedAt:new Date().toISOString()},'CineDairy-archive-'+M.today()+'.json'),
        'export-previous':()=>{const old=storage.getItem('cinedairy.before-import');if(!old){toast('Предыдущей копии пока нет. Она появится после импорта.');return}download(old,'CineDairy-before-import.json')},
        'reset':()=>confirm('Очистить весь архив?','Удалятся фильмы, просмотры, цитаты, подборки и фильтры. Сначала скачайте резервную копию на странице данных.',()=>{commit(next=>{Object.assign(next,M.blank())},'Архив очищен',true);filters=M.defaults();activeCollection='';selected.clear()},'Очистить архив'),
        'undo':()=>{if(!lastUndo||lastUndo.mutation!==mutation){toast('После удаления уже были другие изменения. Отмена недоступна.');return}const before=lastUndo.data;commit(next=>{Object.assign(next,structuredClone(before))},'Действие отменено');refresh()}
    };
    function moveInCollection(id,delta){commit(next=>{const ids=next.collections.find(c=>c.id===activeCollection).movieIds;const from=ids.indexOf(id),to=from+delta;if(from>=0&&to>=0&&to<ids.length)[ids[from],ids[to]]=[ids[to],ids[from]]},'Порядок сохранён');refresh();}
    document.addEventListener('click',async event=>{
        const close=event.target.closest('[data-close]');if(close){close.closest('dialog').close();return;}
        const button=event.target.closest('[data-action]');if(!button||!loaded)return;
        try{await actions[button.dataset.action]?.(button.dataset.id||'')}catch(e){toast(e.message||'Не удалось сохранить. Исходные данные не изменены.');}
    });
    document.addEventListener('submit',event=>{
        if(event.target.id!=='active-form')return;
        event.preventDefault();const form=event.target;
        if(!form.reportValidity())return;
        try{formSubmit(new FormData(form))}catch(e){form.querySelector('.form-error').textContent=e.message||'Не удалось сохранить. Проверьте свободное место в браузере.'}
    });
    document.addEventListener('input',event=>{
        const el=event.target;
        if(el.id==='global-search'){clearTimeout(searchTimer);searchTimer=setTimeout(renderPage,120)}
        if(el.dataset.filter&&el.tagName==='INPUT'){filters[el.dataset.filter]=el.value;selected.clear();renderLibraryResults()}
        if(el.id==='quote-search'){quoteSearch=el.value;renderQuoteResults()}
        if(el.id==='api-search'){clearTimeout(apiTimer);const version=++apiVersion;apiTimer=setTimeout(()=>apiSearch(el.value.trim(),version),400)}
    });
    document.addEventListener('change',event=>{
        const el=event.target;
        try{
            if(el.dataset.filter){filters[el.dataset.filter]=el.value;selected.clear();renderLibraryResults()}
            if(el.dataset.select){el.checked?selected.add(el.dataset.select):selected.delete(el.dataset.select);renderSelection()}
            if(el.dataset.rating){commit(next=>{next.views.find(v=>v.id===el.dataset.rating).rating=Number(el.value)},'Оценка сохранена');refresh()}
            if(el.id==='saved-filter'&&el.value)applyPreset(el.value);
            if(el.id==='diary-month'){diaryMonth=el.value;renderDiary()}
            if(el.id==='quote-tag-filter'){quoteTag=el.value;renderQuoteResults()}
            if(el.id==='entry-existing'){const block=$('#entry-new-fields');block.hidden=Boolean(el.value);block.querySelectorAll('input,select').forEach(i=>{i.disabled=Boolean(el.value)});apiVersion++;clearTimeout(apiTimer)}
            if(el.id==='import-file')importFile(el.files[0]);
        }catch(e){toast(e.message);refresh()}
    });
    document.addEventListener('error',event=>{const el=event.target;if(el instanceof HTMLImageElement&&!el.dataset.fallback){el.dataset.fallback='true';el.src=fallback}},true);
    document.addEventListener('keydown',event=>{
        if(event.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)&&!drawer.open&&!formDialog.open){event.preventDefault();$('#global-search').focus()}
        if(event.target.id==='api-search'&&event.key==='ArrowDown'){const b=$('#api-results button');if(b){event.preventDefault();b.focus()}}
    });
    formDialog.addEventListener('close',()=>{apiVersion++;clearTimeout(apiTimer)});
    drawer.addEventListener('close',()=>{for(const notice of [...$('#drawer-notifications').children])$('#notifications').append(notice)});
    window.addEventListener('hashchange',()=>{if(loaded)navigate()});
    window.addEventListener('storage',event=>{if(!Account?.user&&event.key===M.KEY&&event.newValue!==expectedRaw)toast('Архив обновлён в другой вкладке. Обновите страницу перед изменениями.')});
    async function initialize(){try{
        storage=Account?await Account.init():localStorage;
        const initial=M.load(storage);db=initial.data;expectedRaw=initial.raw;loaded=true;navigate();
    }catch(error){
        document.querySelectorAll('header button,header input').forEach(el=>{el.disabled=true});
        page.innerHTML=heading('ДАННЫЕ СОХРАНЕНЫ','Не удалось открыть архив','Сервис не перезаписал коллекцию. Скачайте исходные данные для восстановления.')+`<p class="form-error">${escape(error.message)}</p><button class="btn" id="rescue-export">Скачать исходные данные</button>`;
        $('#rescue-export').addEventListener('click',()=>{let raw={};try{raw={archive:localStorage.getItem(M.KEY),movies:localStorage.getItem('movies'),watchlist:localStorage.getItem('watchlist')}}catch(_){}download(raw,'CineDairy-recovery.json')});
    }}
    initialize();
})();
