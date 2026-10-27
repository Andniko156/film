/* Data model shared by the browser and the regression tests. No network calls. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.CinemaModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const KEY = 'cinedairy.archive.v2';
    const TYPES = ['FILM', 'TV_SERIES', 'MINI_SERIES', 'TV_SHOW'];
    const text = value => String(value ?? '');
    const lower = value => text(value).toLocaleLowerCase('ru');
    const tags = value => [...new Set((Array.isArray(value) ? value : text(value).split(',')).map(v => text(v).trim()).filter(Boolean))];
    const uid = prefix => prefix + '_' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));
    function today() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    function validDate(value) {
        if (value === '') return true;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const d = new Date(value + 'T12:00:00Z');
        return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
    }
    function blank() { return {version: 2, revision: 0, movies: [], views: [], quotes: [], collections: [], presets: []}; }
    function defaults() {
        return {query: '', type: '', genre: '', rating: '', from: '', to: '', quotes: '', notes: '', repeat: '', tag: '', company: '', mood: '', collection: '', sort: 'recent'};
    }
    function validate(data) {
        const fail = () => { throw new Error('Файл содержит некорректные или неподдерживаемые данные. Коллекция не изменена.'); };
        if (!data || data.version !== 2 || !Number.isInteger(data.revision) || data.revision < 0) fail();
        const listNames = ['movies', 'views', 'quotes', 'collections', 'presets'];
        for (const name of listNames) {
            if (!Array.isArray(data[name])) fail();
            const ids = new Set();
            for (const item of data[name]) {
                if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id)) fail();
                ids.add(item.id);
            }
        }
        const movieIds = new Set(data.movies.map(m => m.id));
        const stringFields = (item, fields) => fields.every(key => typeof item[key] === 'string');
        const stringArray = v => Array.isArray(v) && v.every(t => typeof t === 'string');
        for (const m of data.movies) {
            if (!stringFields(m, ['title', 'type', 'year', 'genre', 'poster', 'createdAt']) || !m.title.trim() || !TYPES.includes(m.type) || !stringArray(m.tags) || typeof m.planned !== 'boolean') fail();
        }
        for (const v of data.views) {
            if (!movieIds.has(v.movieId) || !stringFields(v, ['date', 'note', 'company', 'mood', 'createdAt']) || !validDate(v.date) || !Number.isInteger(v.rating) || v.rating < 0 || v.rating > 5) fail();
        }
        for (const q of data.quotes) {
            if (!movieIds.has(q.movieId) || !stringFields(q, ['text', 'character', 'time', 'note', 'createdAt']) || !q.text.trim() || !stringArray(q.tags) || typeof q.spoiler !== 'boolean') fail();
        }
        for (const c of data.collections) {
            if (!stringFields(c, ['name', 'description']) || !c.name.trim() || !stringArray(c.movieIds) || new Set(c.movieIds).size !== c.movieIds.length || c.movieIds.some(id => !movieIds.has(id))) fail();
        }
        const filterKeys = Object.keys(defaults());
        for (const p of data.presets) {
            if (typeof p.name !== 'string' || !p.name.trim() || !p.filters || typeof p.filters !== 'object' || filterKeys.some(k => typeof p.filters[k] !== 'string')) fail();
        }
        return data;
    }
    function migrate(legacyMovies, legacyWatchlist) {
        if (!Array.isArray(legacyMovies) || !Array.isArray(legacyWatchlist)) throw new Error('Не удалось прочитать старую коллекцию. Исходные записи сохранены.');
        const db = blank();
        function convert(item, index, planned) {
            if (!item || typeof item.title !== 'string' || !item.title.trim()) throw new Error('В старой коллекции есть запись без названия. Исходные данные сохранены.');
            const id = (planned ? 'planned_' : 'legacy_') + index + '_' + text(item.id);
            const movie = {id, title: item.title, type: TYPES.includes(item.type) ? item.type : 'FILM', year: text(item.year), genre: text(item.genre), poster: text(item.poster), tags: [], planned, createdAt: text(item.dateAdded)};
            db.movies.push(movie);
            if (!planned) db.views.push({id: 'view_' + id, movieId: id, date: text(item.dateWatched), rating: Math.min(5, Math.max(0, Math.round(Number(item.rating) || 0))), note: text(item.comment), company: '', mood: '', createdAt: text(item.dateAdded)});
        }
        legacyMovies.forEach((item, i) => convert(item, i, false));
        legacyWatchlist.forEach((item, i) => convert(item, i, true));
        return validate(db);
    }
    function decodeBackup(value) {
        if (value?.version === 2) return validate(value);
        if (value && !('version' in value) && Array.isArray(value.movies) && Array.isArray(value.watchlist)) return migrate(value.movies, value.watchlist);
        throw new Error('Выберите резервную копию CineDairy в формате JSON.');
    }
    function load(storage) {
        const current = storage.getItem(KEY);
        if (current !== null) return {data: validate(JSON.parse(current)), raw: current};
        const oldMovies = storage.getItem('movies');
        const oldWatchlist = storage.getItem('watchlist');
        const data = migrate(JSON.parse(oldMovies || '[]'), JSON.parse(oldWatchlist || '[]'));
        // Legacy keys are deliberately left intact, even after a successful migration.
        const raw = JSON.stringify(data);
        storage.setItem(KEY, raw);
        return {data, raw};
    }
    function persist(storage, data, expectedRaw) {
        if (storage.getItem(KEY) !== expectedRaw) throw new Error('Коллекция изменилась в другой вкладке. Обновите страницу перед сохранением.');
        const raw = JSON.stringify(validate(data));
        storage.setItem(KEY, raw);
        return raw;
    }
    function movieViews(db, id) {
        return db.views.filter(v => v.movieId === id).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    }
    function latest(db, id) { return movieViews(db, id)[0]; }
    function matches(db, movie, f) {
        const views = movieViews(db, movie.id);
        const quotes = db.quotes.filter(q => q.movieId === movie.id);
        const q = lower(f.query).trim();
        const haystack = [movie.title, movie.year, movie.genre, ...movie.tags, ...views.map(v => v.note), ...quotes.map(c => c.text)].join(' ');
        if (q && !lower(haystack).includes(q)) return false;
        if (f.type && movie.type !== f.type) return false;
        if (f.genre && !tags(movie.genre).some(g => lower(g) === lower(f.genre))) return false;
        if (f.rating && (!views[0] || views[0].rating < Number(f.rating))) return false;
        if (f.quotes === 'yes' && !quotes.length || f.quotes === 'no' && quotes.length) return false;
        if (f.notes === 'yes' && !views.some(v => v.note.trim()) || f.notes === 'no' && views.some(v => v.note.trim())) return false;
        if (f.repeat === 'yes' && views.length < 2 || f.repeat === 'no' && views.length !== 1) return false;
        if (f.tag && !movie.tags.some(t => lower(t) === lower(f.tag))) return false;
        if (f.collection && !db.collections.find(c => c.id === f.collection)?.movieIds.includes(movie.id)) return false;
        if (f.from || f.to || f.company || f.mood) {
            if (!views.some(v => (!(f.from || f.to) || v.date) && (!f.from || v.date >= f.from) && (!f.to || v.date <= f.to) && (!f.company || lower(v.company).includes(lower(f.company))) && (!f.mood || lower(v.mood).includes(lower(f.mood))))) return false;
        }
        return true;
    }
    function filtered(db, filters) {
        const f = {...defaults(), ...filters};
        const movies = db.movies.filter(m => db.views.some(v => v.movieId === m.id) && matches(db, m, f));
        return movies.sort((a, b) => {
            if (f.sort === 'title') return a.title.localeCompare(b.title, 'ru');
            if (f.sort === 'rating') return (latest(db, b.id)?.rating || 0) - (latest(db, a.id)?.rating || 0);
            const av = latest(db, a.id), bv = latest(db, b.id);
            const order = text(bv?.date).localeCompare(text(av?.date)) || text(bv?.createdAt).localeCompare(text(av?.createdAt));
            return f.sort === 'oldest' ? -order : order;
        });
    }
    function removeMovie(db, id) {
        db.movies = db.movies.filter(m => m.id !== id);
        db.views = db.views.filter(v => v.movieId !== id);
        db.quotes = db.quotes.filter(q => q.movieId !== id);
        db.collections.forEach(c => { c.movieIds = c.movieIds.filter(mid => mid !== id); });
    }
    return {KEY, TYPES, text, lower, tags, uid, today, validDate, blank, defaults, validate, migrate, decodeBackup, load, persist, movieViews, latest, matches, filtered, removeMovie};
});
