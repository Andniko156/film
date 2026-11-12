/* Same-origin sessions. Website: memory only. Bundled Android: durable offline outbox. */
(function () {
    'use strict';
    const M = window.CinemaModel;
    let state = null, raw = null, saving = false, failed = false, revision = 0, archive = null;
    let beforeImport = null, initialized = false, mergeOfferPending = false;
    let channel;
    const mobile = Boolean(window.CINEDAIRY_ANDROID && window.CinemaOffline);
    let offline = null, retryTimer = null, retryDelay = 5000;
    function mobileSession(value) { return {...value, yandexEnabled: false}; }
    function scheduleSync(delay = 500) {
        if (!mobile || !offline?.record) return;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(syncMobile, delay);
    }
    function publishMobile() {
        const changed = raw !== offline.raw;
        raw = offline.raw; archive = structuredClone(offline.record.data); revision = offline.record.base;
        normalStatus();
        if (changed && initialized) window.dispatchEvent(new CustomEvent('cinedairy:archive', {detail: archive}));
    }
    async function syncMobile() {
        if (!offline?.record || offline.running || document.hidden) return;
        await offline.sync(request, next => { state = mobileSession(next); });
        publishMobile();
        if (offline.status === 'synced') retryDelay = 5000;
        else if (offline.status === 'offline') retryDelay = Math.min(retryDelay * 2, 300000);
        if (!['auth', 'conflict', 'invalid'].includes(offline.status)) scheduleSync(offline.pending ? retryDelay : 30000);
    }
    function confirmMobileExit() {
        if (mobile && (offline?.pending || offline?.running)) throw Error('Сначала синхронизируйте изменения. Для удаления только локальной копии используйте отдельную кнопку в разделе архива.');
    }
    function forgetMobile() { if (mobile) { clearTimeout(retryTimer); offline?.clear(); } }
    function resolveMobile() {
        const content = shell('Архив изменён на двух устройствах');
        paragraph(content, 'Изменения телефона сохранены. Сначала скачайте обе версии. Выбранная версия заменит другую целиком; автоматического объединения нет.');
        addButton(content, 'Скачать версию телефона', () => download(offline.record.data, 'CineDairy-phone.json'));
        if (offline.remote) {
            addButton(content, 'Скачать серверную версию', () => download(offline.remote, 'CineDairy-server.json'));
            addButton(content, 'Оставить версию телефона', () => {
                if (!confirm('Заменить серверный архив версией телефона?')) return;
                offline.resolve('local'); dialog.close(); publishMobile(); scheduleSync();
            });
            addButton(content, 'Оставить серверную версию', () => {
                if (!confirm('Заменить локальный архив серверной версией?')) return;
                offline.resolve('server'); dialog.close(); publishMobile(); scheduleSync();
            });
        } else addButton(content, 'Получить серверную версию', async () => { await syncMobile(); resolveMobile(); });
    }
    const memory = {
        getItem(key) { return key === M.KEY ? raw : key === 'cinedairy.before-import' ? beforeImport : null; },
        setItem(key, value) { if (key === M.KEY) raw = value; else if (key === 'cinedairy.before-import') { if (mobile && offline?.record) offline.write({...offline.record, beforeImport: value}); beforeImport = value; } }
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
        const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function clearAccount() { raw = null; archive = null; beforeImport = null; saving = false; failed = false; }
    function leave() { clearAccount(); document.querySelector('main').replaceChildren(); dialog.close(); location.reload(); }
    function broadcast() { channel?.postMessage('session-changed'); }
    async function request(path, method = 'GET', payload) {
        if (mobile && method !== 'GET' && !state?.csrf) {
            const fresh = await request('/api/session');
            state = {...state, csrf: fresh.csrf};
        }
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), mobile ? 8000 : 20000);
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
        if (mobile && offline?.record) {
            button.textContent = state.user.email || 'Мой аккаунт';
            const messages = {
                local: 'Архив на телефоне · проверяем связь',
                synced: 'Всё синхронизировано',
                pending: 'Сохранено на телефоне · ожидает отправки',
                offline: 'Нет связи · изменения сохранены на телефоне',
                auth: 'Локальная копия · войдите для синхронизации',
                conflict: 'Конфликт версий · выберите, что сохранить',
                invalid: 'Сервер не принял архив · локальная копия сохранена. ' + (offline.error?.message || '')
            };
            banner.dataset.status=offline.status;
            showStatus(messages[offline.status] || messages.local);
            addButton(banner, 'Синхронизировать', syncMobile, 'btn btn-outline btn-small phone-sync').setAttribute('aria-label','Синхронизировать');
            if (offline.status === 'auth') addButton(banner, 'Войти снова', () => passwordDialog(false));
            if (offline.status === 'conflict') addButton(banner, 'Выбрать версию', resolveMobile);
            return;
        }
        if (state?.user) {
            button.textContent = state.user.email || 'Мой аккаунт';
            showStatus('Личный архив · сохранён на сервере');
        } else { button.textContent = 'Войти'; showStatus(mobile ? 'Гостевой архив · сохранён на телефоне и доступен без интернета' : 'Гостевой архив · хранится в этом браузере. На общем устройстве скачайте копию и очистите гостевые данные.'); }
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
    async function yandex(link) { const data = await request('/api/auth/yandex/start','POST',{link,remember:true}); location.assign(data.url); }
    function registerDialog() {
        const content=shell('Регистрация в CineDairy');
        paragraph(content,'Укажите email и придумайте пароль. Затем подтвердите адрес восьмизначным кодом из письма.');
        const form=document.createElement('form');content.append(form);
        const email=field(form,'Email','email','register-email');email.autocomplete='email';email.maxLength=254;
        const pass=field(form,'Пароль (от 12 символов)','password','register-password');pass.minLength=12;pass.maxLength=128;pass.autocomplete='new-password';
        const repeat=field(form,'Повторите пароль','password','register-repeat');repeat.autocomplete='new-password';
        const submit=document.createElement('button');submit.type='submit';submit.className='btn spaced';submit.textContent='Получить код подтверждения';form.append(submit);
        form.addEventListener('submit',async e=>{
            e.preventDefault();if(!form.reportValidity())return;
            if(pass.value!==repeat.value){dialog.querySelector('[role="alert"]').textContent='Пароли не совпадают.';return;}
            submit.disabled=true;
            try {const value=pass.value;await request('/api/auth/email/start','POST',{email:email.value,link:false});registerCode(email.value,value);}
            catch(err){dialog.querySelector('[role="alert"]').textContent=err.message;}
            finally{submit.disabled=false;}
        });
    }
    function registerCode(email,password) {
        const content=shell('Подтвердите email');
        paragraph(content,'Код отправлен на '+email+'. Он действует 10 минут. Аккаунт будет создан только после подтверждения.');
        const form=document.createElement('form');content.append(form);
        const code=field(form,'Восьмизначный код','text','register-code');code.pattern='[0-9]{8}';code.maxLength=8;code.inputMode='numeric';code.autocomplete='one-time-code';
        const submit=document.createElement('button');submit.type='submit';submit.className='btn spaced';submit.textContent='Завершить регистрацию';form.append(submit);
        form.addEventListener('submit',async e=>{
            e.preventDefault();if(!form.reportValidity())return;submit.disabled=true;
            try{await request('/api/auth/register/verify','POST',{email,code:code.value,password});broadcast();leave();}
            catch(err){dialog.querySelector('[role="alert"]').textContent=err.message;}
            finally{submit.disabled=false;}
        });
    }
    function passwordDialog(setup) {
        const content=shell(setup ? (state.hasPassword?'Изменить пароль':'Установить пароль') : 'Войти с паролем');
        paragraph(content,setup?'Пароль устанавливается для подтверждённого email. Требуется недавний вход.':'Используйте email, уже подтверждённый в CineDairy.');
        const form=document.createElement('form');content.append(form);
        const email=setup?null:field(form,'Email','email','login-email');
        if(email) email.autocomplete='username';
        const pass=field(form,setup?'Новый пароль':'Пароль','password','login-password');
        pass.autocomplete=setup?'new-password':'current-password';
        if(setup){pass.minLength=12;pass.maxLength=128;}
        const repeat=setup?field(form,'Повторите пароль','password','repeat-password'):null;
        if(repeat)repeat.autocomplete='new-password';
        const remember=document.createElement('input');remember.type='checkbox';remember.id='account-remember';remember.checked=true;
        if(!setup){const label=document.createElement('label');label.htmlFor=remember.id;label.textContent=' Запомнить меня на 30 дней';label.prepend(remember);form.append(label);}
        const submit=document.createElement('button');submit.type='submit';submit.className='btn spaced';submit.textContent=setup?'Сохранить пароль':'Войти';form.append(submit);
        form.addEventListener('submit',async e=>{
            e.preventDefault();if(!form.reportValidity())return;
            if(repeat&&pass.value!==repeat.value){dialog.querySelector('[role="alert"]').textContent='Пароли не совпадают.';return;}
            submit.disabled=true;
            try {
                const next=await request(setup?'/api/auth/password/set':'/api/auth/password/login','POST',setup?{password:pass.value}:{email:email.value,password:pass.value,remember:remember.checked});
                if(setup){state=next;dialog.close();normalStatus();broadcast();}else{broadcast();leave();}
            }catch(err){dialog.querySelector('[role="alert"]').textContent=err.message;}
            finally{pass.value='';if(repeat)repeat.value='';submit.disabled=false;}
        });
        if(!setup&&state.emailEnabled)addButton(content,'Войти по коду из письма',()=>openEmail(false));
    }
    function guestTransfer() {
        if (mobile && (offline?.pending || offline?.running)) throw Error('Сначала синхронизируйте архив телефона.');
        if (saving || failed) throw Error('Сначала завершите сохранение или разрешите конфликт.');
        const guest = M.load(localStorage).data;
        const content = shell('Перенести гостевой архив?');
        paragraph(content, `В аккаунте: ${archive.movies.length} фильмов, ${archive.views.length} просмотров, ${archive.quotes.length} цитат. В этом браузере: ${guest.movies.length} фильмов, ${guest.views.length} просмотров, ${guest.quotes.length} цитат. Записи будут добавлены к архиву аккаунта. Одинаковые фильмы останутся отдельными записями. Исходная копия останется в браузере до её явного удаления.`);
        addButton(content, 'Скачать копию аккаунта', () => download(archive,'CineDairy-account.json'));
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
    function accountPage(container) {
        container.replaceChildren();
        const head = document.createElement('section'); head.className = 'page-heading account-page-heading';
        const heading = document.createElement('div');
        const eyebrow = document.createElement('p'); eyebrow.className = 'eyebrow'; eyebrow.textContent = 'НАСТРОЙКИ ПРОФИЛЯ';
        const title = document.createElement('h1'); title.className = 'page-title'; title.textContent = 'Мой аккаунт';
        const desc = paragraph(heading, 'Управление способами входа, личным архивом и безопасностью.');
        desc.className = 'page-description'; heading.prepend(eyebrow, title); head.append(heading); container.append(head);
        const grid = document.createElement('div'); grid.className = 'account-settings-grid'; container.append(grid);
        const section = (name, subtitle) => {
            const card = document.createElement('section'); card.className = 'account-settings-card';
            const h = document.createElement('h2'); h.textContent = name; card.append(h);
            paragraph(card, subtitle).className = 'muted'; grid.append(card); return card;
        };
        const identity = section('Способы входа', 'Привязанные методы должны открывать один и тот же архив.');
        if (!state?.user) {
            paragraph(identity, 'Вы используете гостевой режим. Чтобы синхронизировать фильмы между устройствами, войдите в аккаунт.');
            if(state?.emailEnabled)addButton(identity,'Создать аккаунт',registerDialog,'btn');
            if(state?.passwordEnabled)addButton(identity,'Войти с паролем',()=>passwordDialog(false));
            if (state?.emailEnabled) addButton(identity, 'Войти по email', () => openEmail(false), 'btn');
            if (state?.yandexEnabled) addButton(identity, 'Войти через Яндекс', () => yandex(false));
        } else {
            const providers = state.user.providers || [];
            paragraph(identity, 'ID аккаунта: ' + state.user.id);
            paragraph(identity, 'Email: ' + (providers.includes('email') ? state.user.email : 'не привязан'));
            paragraph(identity, 'Яндекс ID: ' + (providers.includes('yandex') ? 'привязан' : 'не привязан'));
            if (state.emailEnabled) addButton(identity, providers.includes('email') ? 'Подтвердить email повторно' : 'Привязать email', () => openEmail(true));
            if(providers.includes('email'))addButton(identity,state.hasPassword?'Изменить пароль':'Установить пароль',()=>passwordDialog(true));
            if (state.yandexEnabled && !providers.includes('yandex')) addButton(identity, 'Привязать Яндекс ID', () => yandex(true));
            if (providers.includes('yandex')) paragraph(identity, 'Вход через Яндекс уже связан с этим аккаунтом.');
            paragraph(identity, 'Если при входе другим способом виден пустой архив — сравните ID аккаунта. Не удаляйте записи: это может быть другой аккаунт.');
        }
        if (state?.user && mergeOfferPending) {
            const merge = section('Объединение аккаунтов', 'Яндекс ID уже связан с другим вашим киноархивом.');
            paragraph(merge, 'Перед объединением проверьте количество записей. Перенос выполняется только после подтверждения. Ничего не заменяется автоматически.');
            const details = paragraph(merge, 'Получение сведений об архивах…');
            request('/api/account/merge/preview').then(info => {
                details.textContent = 'Основной аккаунт: '+info.primary.movies+' фильмов, '+info.primary.views+' просмотров, '+info.primary.quotes+' цитат. Аккаунт Яндекса: '+info.secondary.movies+' фильмов, '+info.secondary.views+' просмотров, '+info.secondary.quotes+' цитат.';
                addButton(merge, 'Подтвердить объединение архивов', async () => {
                    if (!window.confirm('Объединить два аккаунта? Записи обоих архивов сохранятся. Операция требует повторного входа при истечении срока подтверждения.')) return;
                    await request('/api/account/merge/confirm','POST',{confirm:'MERGE',expectedRevision:info.expectedRevision,expectedSecondaryRevision:info.expectedSecondaryRevision});
                    mergeOfferPending=false;broadcast();location.reload();
                }, 'btn');
            }).catch(err => {details.textContent = err.message;});
        }
        const records = section('Личный архив', 'Экспортируйте данные перед любыми изменениями способов входа.');
        if (state?.user) {
            if (archive) addButton(records, 'Скачать архив JSON', () => download(archive, 'CineDairy-account.json'));
            addButton(records, 'Перенести гостевой архив', guestTransfer);
        } else paragraph(records, 'Гостевые фильмы хранятся только в этом браузере.');
        addButton(records, 'Управление гостевыми данными', eraseGuest);
        if (mobile) {
            paragraph(identity, 'В Android используйте email и пароль или код из письма. Вход через Яндекс доступен на сайте; привяжите email там для входа в этот же аккаунт.');
            if (offline?.record) {
                addButton(records, 'Синхронизировать сейчас', syncMobile);
                addButton(records, 'Скачать копии до разрешения конфликта', () => {
                    const value = localStorage.getItem(window.CinemaOffline.RECOVERY);
                    if (!value) throw Error('Сохранённых версий конфликта пока нет.');
                    download(JSON.parse(value), 'CineDairy-conflict-backup.json');
                });
                addButton(records, 'Удалить локальную копию аккаунта', () => {
                    if (!confirm('Удалить с телефона архив аккаунта, включая неотправленные изменения и резервные версии? Сначала скачайте JSON. Серверные данные сохранятся.')) return;
                    forgetMobile(); leave();
                });
            }
        }
        if (state?.user) {
            const security = section('Безопасность', 'Управляйте активными сессиями и удалением аккаунта.');
            addButton(security, 'Выйти', async () => { confirmMobileExit(); await request('/api/auth/logout','POST',{});forgetMobile();broadcast();leave(); });
            addButton(security, 'Выйти на всех устройствах', async () => { confirmMobileExit(); await request('/api/auth/logout-all','POST',{});forgetMobile();broadcast();leave(); });
            addButton(security, 'Удалить аккаунт', () => {
                const content = shell('Удалить аккаунт и весь архив?');
                paragraph(content, 'Просмотры, цитаты и подборки будут удалены без возможности отмены. Подтвердите вход не более 10 минут назад.');
                addButton(content, 'Скачать архив перед удалением', () => download(archive,'CineDairy-account.json'));
                addButton(content, 'Подтвердить удаление аккаунта', async () => {
                    confirmMobileExit(); await request('/api/account/delete','POST',{confirm:'DELETE'}); forgetMobile(); broadcast(); leave();
                }, 'btn btn-danger');
            }, 'text-button danger-text');
        }
    }
    button.addEventListener('click', () => { location.hash = 'account'; });
    window.addEventListener('beforeunload',e=>{if(saving||failed){e.preventDefault();e.returnValue=''}});
    async function checkSession() {
        if (mobile && initialized) { if (offline?.record) scheduleSync(0); return; }
        if(!initialized||!state||document.hidden||saving)return;
        try { const next=await request('/api/session'); if(next.user?.id!==state.user?.id)leave(); else state.csrf=next.csrf; } catch(_) {}
    }
    try { channel = new BroadcastChannel('film-session'); channel.onmessage=()=>checkSession(); } catch(_) {}
    document.addEventListener('visibilitychange',checkSession);
    window.addEventListener('online', () => { retryDelay = 5000; if (offline?.record) scheduleSync(0); else if (mobile && initialized) location.reload(); });
    window.addEventListener('pageshow',e=>{if(e.persisted)leave()});
    setInterval(checkSession,30000);
    window.CinemaAccount = {
        get enabled() { return Boolean(state); },
        get user() { return state?.user; },
        get busy() { return saving || failed; },
        request,
        open:() => {location.hash='account';},
        renderPage:accountPage,
        async init() {
            if (mobile) {
                offline = new window.CinemaOffline.Store(localStorage);
                if (offline.record) {
                    state = mobileSession({...offline.record.session, csrf: ''});
                    beforeImport = offline.record.beforeImport || null;
                    publishMobile(); initialized = true; scheduleSync(0); return memory;
                }
            }
            const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),mobile ? 2000 : 8000);
            try {
                const response=await fetch('/api/session',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
                if(response.status===404 && !mobile){state=null;normalStatus();initialized=true;return localStorage;}
                if(!response.ok)throw Error('Не удалось проверить аккаунт. Обновите страницу; локальный архив не изменён.');
                state=await response.json();
                if (mobile) state = mobileSession(state);
                if(typeof state.csrf!=='string')throw Error('Неверный ответ сервера.');
                if(state.user){archive=M.validate(await request('/api/archive'));revision=archive.revision;raw=JSON.stringify(archive);if(mobile){offline.attach(state,archive);offline.status='synced';scheduleSync(30000);}}
                initialized=true;normalStatus();
                if(location.hash==='#account-error'){showStatus('Не удалось подтвердить вход через Яндекс. Попробуйте снова.');history.replaceState(null,'','#account');}
                if(location.hash==='#account-merge'){mergeOfferPending=true;history.replaceState(null,'','#account');}
                if(location.hash==='#account-link-conflict'){showStatus('Этот Яндекс ID уже привязан к другому аккаунту. Архивы не объединены и не удалены. Войдите прежним способом и проверьте ID аккаунта в настройках.');history.replaceState(null,'','#account');}
                return state.user?memory:localStorage;
            } catch(e){
                if (mobile && !state?.user) {
                    state = {user:null, csrf:'', emailEnabled:true, passwordEnabled:true, yandexEnabled:false};
                    initialized=true; normalStatus(); return localStorage;
                }
                showStatus('Аккаунт временно недоступен. Данные не перезаписаны.');throw e;
            }
            finally{clearTimeout(timer);}
        },
        persist(next, expectedRaw, onSaved) {
            if (mobile && offline?.record) {
                offline.save(next, expectedRaw);
                raw=offline.raw; archive=structuredClone(next);
                if (!['conflict','auth','invalid'].includes(offline.status)) offline.status='pending';
                normalStatus(); scheduleSync(); queueMicrotask(() => onSaved?.()); return raw;
            }
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
