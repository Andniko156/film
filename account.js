/* Same-origin sessions. Account archives live in memory only, never localStorage. */
(function () {
    'use strict';
    const M = window.CinemaModel;
    let state = null, raw = null, saving = false, failed = false, revision = 0, archive = null;
    let beforeImport = null, initialized = false;
    let channel;
    const memory = {
        getItem(key) { return key === M.KEY ? raw : key === 'cinedairy.before-import' ? beforeImport : null; },
        setItem(key, value) { if (key === M.KEY) raw = value; else if (key === 'cinedairy.before-import') beforeImport = value; }
    };
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-outline account-button'; button.textContent = 'Аккаунт';
    const banner = document.createElement('div'); banner.className = 'account-banner container'; banner.setAttribute('role', 'status');
    const dialog = document.createElement('dialog'); dialog.className = 'modal form-dialog'; dialog.setAttribute('aria-labelledby', 'account-title');
    document.querySelector('.header-content').append(button);
    document.querySelector('header').after(banner); document.body.append(dialog);
    function showStatus(message) { banner.replaceChildren(); const text = document.createElement('span'); text.textContent = message; banner.append(text); }
    function addButton(parent, label, fn, cls = 'btn btn-outline btn-small') {
        const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = label;
        b.addEventListener('click', async () => { b.disabled = true; try { await fn(); } catch (e) { const out = dialog.open ? dialog.querySelector('[role="alert"]') : banner; out.textContent = e.message; } finally { b.disabled = false; } });
        parent.append(b); return b;
    }
    function download(value, name) {
        const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type:'application/json'}));
        const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function clearAccount() { raw = null; archive = null; beforeImport = null; saving = false; failed = false; }
    function leave() { clearAccount(); document.querySelector('main').replaceChildren(); dialog.close(); location.reload(); }
    function broadcast() { channel?.postMessage('session-changed'); }
    async function request(path, method = 'GET', payload) {
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20000);
        try {
            const response = await fetch(path, {method, credentials:'same-origin', cache:'no-store', signal:controller.signal,
                headers:{'Content-Type':'application/json', 'X-CSRFToken':state?.csrf || '', 'X-Film-Account':state?.user?.id || ''},
                ...(payload === undefined ? {} : {body:JSON.stringify(payload)})});
            let data; try { data = await response.json(); } catch (_) { throw Error('Сервер вернул неожиданный ответ. Данные не перезаписаны.'); }
            if (!response.ok) { const e = new Error(data.error || 'Не удалось выполнить запрос.'); e.status = response.status; e.data = data; throw e; }
            return data;
        } catch (e) { if (e.name === 'AbortError') throw Error('Сервер не ответил вовремя. Проверьте состояние архива перед повтором.'); throw e; }
        finally { clearTimeout(timer); }
    }
    function normalStatus() {
        if (state?.user) {
            button.textContent = state.user.email || 'Мой аккаунт';
            showStatus('Личный архив · сохранён на сервере');
        } else { button.textContent = 'Войти'; showStatus('Гостевой архив · хранится в этом браузере. На общем устройстве скачайте копию и очистите гостевые данные.'); }
    }
    function failure(e) {
        failed = true;
        showStatus(e.message + ' Несохранённые изменения остаются в этой вкладке.');
        addButton(banner, 'Скачать несохранённую копию', () => download(archive, 'CineDairy-unsaved.json'));
        addButton(banner, 'Загрузить архив с сервера', () => openReload());
    }
    function shell(title) {
        dialog.replaceChildren();
        const wrap = document.createElement('div'); wrap.className = 'modal-content'; dialog.append(wrap);
        const head = document.createElement('div'); head.className = 'modal-header'; wrap.append(head);
        const h = document.createElement('h2'); h.id = 'account-title'; h.textContent = title; head.append(h);
        addButton(head, '×', () => dialog.close(), 'close-modal').setAttribute('aria-label','Закрыть');
        const content = document.createElement('div'); content.className = 'account-content'; wrap.append(content);
        const err = document.createElement('p'); err.className = 'form-error'; err.setAttribute('role','alert'); wrap.append(err);
        if (!dialog.open) dialog.showModal();
        return content;
    }
    function paragraph(parent, text) { const p = document.createElement('p'); p.textContent = text; parent.append(p); return p; }
    function field(parent, label, type, name) {
        const l = document.createElement('label'); l.textContent = label; l.htmlFor = 'account-' + name;
        const input = document.createElement('input'); input.id = l.htmlFor; input.name = name; input.type = type; input.required = true;
        parent.append(l, input); return input;
    }
    function openReload() {
        const content = shell('Загрузить актуальный архив?');
        paragraph(content, 'Несохранённая версия в этой вкладке будет заменена. Сначала скачайте её, если хотите сохранить изменения.');
        addButton(content, 'Скачать мою версию', () => download(archive, 'CineDairy-unsaved.json'));
        addButton(content, 'Заменить данными сервера', async () => { const next = await request('/api/archive'); M.validate(next); failed = false; saving = false; location.reload(); });
    }
    function openEmail(link) {
        const content = shell(link ? 'Подтвердить почту аккаунта' : 'Вход по email');
        paragraph(content, 'Отправим одноразовый код. Он действует 10 минут.');
        const form = document.createElement('form'); content.append(form);
        const email = field(form, 'Email', 'email', 'email'); email.autocomplete = 'email'; email.maxLength = 254;
        if (link && state.user.email) email.value = state.user.email;
        const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'btn spaced'; submit.textContent = 'Получить код'; form.append(submit);
        form.addEventListener('submit', async e => {
            e.preventDefault(); if (!form.reportValidity()) return; submit.disabled = true;
            try { await request('/api/auth/email/start','POST',{email:email.value,link}); openCode(email.value); }
            catch (error) { dialog.querySelector('[role="alert"]').textContent = error.message; }
            finally { submit.disabled = false; }
        });
    }
    function openCode(email) {
        const content = shell('Введите код из письма'); paragraph(content, 'Письмо отправлено на ' + email + '. Не сообщайте код другим людям.');
        const form = document.createElement('form'); content.append(form);
        const code = field(form, 'Восьмизначный код', 'text', 'code'); code.inputMode = 'numeric'; code.pattern = '[0-9]{8}'; code.maxLength = 8; code.autocomplete = 'one-time-code';
        const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'btn spaced'; submit.textContent = 'Подтвердить'; form.append(submit);
        form.addEventListener('submit', async e => {
            e.preventDefault(); if (!form.reportValidity()) return; submit.disabled = true;
            try { await request('/api/auth/email/verify','POST',{email,code:code.value}); broadcast(); leave(); }
            catch(error) { dialog.querySelector('[role="alert"]').textContent = error.message; }
            finally { submit.disabled = false; }
        });
        addButton(content, 'Изменить email', () => openEmail(Boolean(state.user)));
    }
    async function yandex(link) { const data = await request('/api/auth/yandex/start','POST',{link}); location.assign(data.url); }
    function guestTransfer() {
        if (saving || failed) throw Error('Сначала завершите сохранение или разрешите конфликт.');
        const guest = M.load(localStorage).data;
        const content = shell('Перенести гостевой архив?');
        paragraph(content, `В этом браузере: ${guest.movies.length} фильмов, ${guest.views.length} просмотров, ${guest.quotes.length} цитат. Перенос возможен в пустой аккаунт. Исходная копия останется в браузере до её явного удаления.`);
        addButton(content, 'Скачать гостевую копию', () => download(guest,'CineDairy-guest.json'));
        addButton(content, 'Подтвердить перенос', async () => {
            await request('/api/archive','POST',{archive:guest,expectedRevision:revision}); location.reload();
        }, 'btn');
    }
    function eraseGuest() {
        const content = shell('Очистить гостевые данные этого браузера?');
        paragraph(content, 'Удалятся локальный гостевой архив, старые записи, локальная резервная копия и сохранённый ключ автопоиска. Архив аккаунта останется на сервере. Сначала скачайте гостевую копию.');
        addButton(content,'Скачать гостевую копию',()=>download(M.load(localStorage).data,'CineDairy-guest.json'));
        addButton(content,'Очистить гостевые данные',()=>{for(const key of [M.KEY,'movies','watchlist','cinedairy.before-import','cinedairy.kinopoisk-key'])localStorage.removeItem(key);dialog.close();if(!state.user)location.reload();});
    }
    function accountPanel() {
        if (saving || failed) { if(failed)openReload(); else showStatus('Подождите завершения сохранения.'); return; }
        const content = shell(state?.user ? 'Мой аккаунт' : 'Сохраните свою историю кино');
        if (!state) { paragraph(content,'Здесь доступен гостевой режим. Вход появится после развёртывания серверной версии сайта.'); return; }
        if (!state.user) {
            paragraph(content,'Войдите, чтобы хранить архив на сервере и открывать его с разных устройств. Гостевые записи переносятся только после вашего подтверждения.');
            if (state.emailEnabled) addButton(content,'Войти по email',()=>openEmail(false),'btn');
            if (state.yandexEnabled) addButton(content,'Войти через Яндекс',()=>yandex(false));
            if (!state.emailEnabled && !state.yandexEnabled) paragraph(content,'Способы входа ещё не настроены владельцем сайта. Гостевой режим доступен.');
            addButton(content,'Очистить гостевые данные',eraseGuest);
        } else {
            paragraph(content,state.user.email || 'Вход через Яндекс');
            paragraph(content,'Архив приватный. Данные аккаунта не записываются в постоянное хранилище этого браузера.');
            addButton(content,'Перенести гостевой архив',guestTransfer);
            addButton(content,'Очистить гостевые данные',eraseGuest);
            if(state.emailEnabled) addButton(content,state.user.email?'Повторно подтвердить вход':'Привязать email',()=>openEmail(true));
            if(state.yandexEnabled) addButton(content,state.user.providers.includes('yandex')?'Подтвердить вход через Яндекс':'Привязать Яндекс ID',()=>yandex(true));
            addButton(content,'Выйти',async()=>{await request('/api/auth/logout','POST',{});broadcast();leave()});
            addButton(content,'Выйти на всех устройствах',async()=>{await request('/api/auth/logout-all','POST',{});broadcast();leave()});
            addButton(content,'Удалить аккаунт',()=>{
                const c=shell('Удалить аккаунт и весь архив?');
                paragraph(c,'Все просмотры, цитаты и подборки аккаунта будут удалены. Отмена недоступна. Для удаления нужно подтверждение входа за последние 10 минут. Резервные копии сервера удаляются по сроку хранения, описанному владельцем сайта.');
                addButton(c,'Скачать архив',()=>download(archive,'CineDairy-account.json'));
                addButton(c,'Удалить без возможности отмены',async()=>{await request('/api/account/delete','POST',{confirm:'DELETE'});broadcast();leave()},'btn btn-danger');
            },'text-button danger-text');
        }
    }
    button.addEventListener('click',accountPanel);
    window.addEventListener('beforeunload',e=>{if(saving||failed){e.preventDefault();e.returnValue=''}});
    async function checkSession() {
        if(!initialized||!state||document.hidden||saving)return;
        try { const next=await request('/api/session'); if(next.user?.id!==state.user?.id)leave(); else state.csrf=next.csrf; } catch(_) {}
    }
    try { channel = new BroadcastChannel('film-session'); channel.onmessage=()=>checkSession(); } catch(_) {}
    document.addEventListener('visibilitychange',checkSession);
    window.addEventListener('pageshow',e=>{if(e.persisted)leave()});
    setInterval(checkSession,30000);
    window.CinemaAccount = {
        get enabled() { return Boolean(state); },
        get user() { return state?.user; },
        get busy() { return saving || failed; },
        request,
        open:accountPanel,
        async init() {
            const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
            try {
                const response=await fetch('/api/session',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
                if(response.status===404){state=null;normalStatus();initialized=true;return localStorage;}
                if(!response.ok)throw Error('Не удалось проверить аккаунт. Обновите страницу; локальный архив не изменён.');
                state=await response.json();
                if(typeof state.csrf!=='string')throw Error('Неверный ответ сервера.');
                if(state.user){archive=M.validate(await request('/api/archive'));revision=archive.revision;raw=JSON.stringify(archive);}
                initialized=true;normalStatus();
                if(location.hash==='#account-error'){showStatus('Не удалось подтвердить вход через Яндекс. Попробуйте снова.');history.replaceState(null,'','#home');}
                return state.user?memory:localStorage;
            } catch(e){showStatus('Аккаунт временно недоступен. Данные не перезаписаны.');throw e;}
            finally{clearTimeout(timer);}
        },
        persist(next, expectedRaw, onSaved) {
            if(!state?.user)throw Error('Войдите в аккаунт.');
            if(saving||failed)throw Error('Дождитесь сохранения или разрешите конфликт в сообщении над страницей.');
            M.validate(next);
            if(raw!==expectedRaw)throw Error('Архив изменился. Обновите страницу.');
            const payload=structuredClone(next), expectedRevision=revision;
            raw=JSON.stringify(next);archive=structuredClone(next);saving=true;showStatus('Сохранение на сервере…');
            request('/api/archive','PUT',{archive:payload,expectedRevision}).then(result=>{
                revision=result.revision;saving=false;normalStatus();onSaved?.();
            }).catch(e=>{saving=false;failure(e)});
            return raw;
        }
    };
})();
