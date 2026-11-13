/* Durable, account-scoped snapshot outbox. No credentials are persisted here. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('../../model.js'));
    else root.CinemaOffline = factory(root.CinemaModel);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
    'use strict';
    const KEY = 'cinedairy.android.account.v1';
    const RECOVERY = KEY + '.recovery';
    const clone = value => JSON.parse(JSON.stringify(value));
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    const content = value => { const {revision, exportedAt, ...archive} = value; return JSON.stringify(canonical(archive)); };
    class Store {
        constructor(storage) {
            this.storage = storage;
            const raw = storage.getItem(KEY);
            this.record = raw ? JSON.parse(raw) : null;
            this.expected = raw;
            this.running = false;
            this.status = 'local';
            this.remote = null;
            if (this.record) {
                const r = this.record;
                if (r.version !== 1 || !r.session?.user?.id || !Number.isInteger(r.base) || r.base < 0 || typeof r.dirty !== 'boolean') throw Error('Не удалось прочитать локальный аккаунт. Исходные данные сохранены.');
                M.validate(r.data);
                if (r.flight) M.validate(r.flight);
            }
        }
        write(record) {
            if (this.storage.getItem(KEY) !== this.expected) throw Error('Локальная копия изменилась. Перезапустите приложение.');
            const raw = JSON.stringify(record);
            // Commit to durable storage before changing memory or acknowledging an edit.
            this.storage.setItem(KEY, raw);
            this.expected = raw;
            this.record = clone(record);
        }
        attach(session, data) {
            M.validate(data);
            if (!session.user?.id) throw Error('Требуется аккаунт.');
            if (this.record && this.record.session.user.id !== session.user.id) throw Error('На телефоне сохранён другой аккаунт. Сначала экспортируйте и удалите его локальную копию.');
            const {csrf, ...metadata} = session;
            this.write({version: 1, session: metadata, data, base: data.revision, dirty: false, flight: null});
        }
        save(data, expectedRaw) {
            M.validate(data);
            if (!this.record || this.raw !== expectedRaw) throw Error('Архив изменился. Откройте его заново.');
            this.write({...this.record, data, dirty: true});
            return this.raw;
        }
        get raw() { return this.record ? JSON.stringify(this.record.data) : null; }
        get pending() { return Boolean(this.record?.dirty); }
        clear() {
            if (this.running) throw Error('Дождитесь завершения синхронизации.');
            this.storage.removeItem(KEY);
            this.storage.removeItem(RECOVERY);
            this.record = null; this.expected = null; this.remote = null;
        }
        async sync(request, onSession) {
            if (this.running || !this.record) return;
            this.running = true;
            try {
                const session = await request('/api/session');
                if (session.user?.id !== this.record.session.user.id) {
                    this.status = 'auth'; return;
                }
                onSession(session);
                const remote = M.validate(await request('/api/archive'));
                let r = this.record;
                // A response can be lost after the server committed. Recognize the exact
                // durable in-flight snapshot, including after process death or newer edits.
                if (r.flight && remote.revision === r.base + 1 && content(remote) === content(r.flight)) {
                    this.write({...r, base: remote.revision, flight: null, dirty: content(r.data) !== content(r.flight)});
                    r = this.record;
                }
                if (!r.dirty) {
                    this.write({...r, data: remote, base: remote.revision, flight: null});
                    this.status = 'synced'; this.remote = null; return;
                }
                if (remote.revision !== r.base) {
                    this.remote = clone(remote); this.status = 'conflict'; return;
                }
                const payload = clone(r.data);
                this.write({...r, flight: payload});
                const result = await request('/api/archive', 'PUT', {archive: payload, expectedRevision: r.base});
                if (!Number.isInteger(result.revision) || result.revision !== r.base + 1) throw Error('Некорректная версия ответа сервера.');
                // Edits made during this request remain pending.
                this.write({...this.record, base: result.revision, flight: null, dirty: content(this.record.data) !== content(payload)});
                this.remote = null; this.status = this.pending ? 'pending' : 'synced';
            } catch (error) {
                this.status = [401, 403].includes(error.status) ? 'auth' : error.status === 409 ? 'conflict' : [400, 413, 422].includes(error.status) ? 'invalid' : 'offline';
                this.error = error;
            } finally { this.running = false; }
        }
        resolve(choice) {
            if (this.running || !this.remote || this.status !== 'conflict') throw Error('Сначала обновите сведения о конфликте.');
            // Keep both alternatives before an explicit choice. If quota is exceeded,
            // abort resolution and leave the outbox untouched.
            this.storage.setItem(RECOVERY, JSON.stringify({local: this.record.data, server: this.remote}));
            if (choice === 'server') this.write({...this.record, data: this.remote, base: this.remote.revision, dirty: false, flight: null});
            else if (choice === 'local') this.write({...this.record, base: this.remote.revision, dirty: true, flight: null});
            else throw Error('Неизвестный вариант.');
            this.remote = null; this.status = this.pending ? 'pending' : 'synced';
        }
    }
    return {Store, KEY, RECOVERY};
});
