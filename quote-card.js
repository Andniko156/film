/* The poster is drawn locally: no quote text or image is sent to a server. */
(function () {
    'use strict';
    const themes = {
        gold: {name: 'Золото', background: '#17130f', accent: '#cfa96b', text: '#fff5df', secondary: '#d8c9af'},
        cognac: {name: 'Коньяк', background: '#3a1f17', accent: '#e6ad77', text: '#fff3e6', secondary: '#e8c7b4'},
        midnight: {name: 'Ночь', background: '#111a20', accent: '#9bbfc2', text: '#f2f7f5', secondary: '#c5d7d5'}
    };
    const make = (tag, className, value) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (value !== undefined) element.textContent = value;
        return element;
    };
    function wrap(ctx, text, maxWidth) {
        const lines = [];
        for (const paragraph of String(text).split(/\r?\n/)) {
            let line = '';
            for (const word of paragraph.split(/\s+/).filter(Boolean)) {
                const candidate = line ? `${line} ${word}` : word;
                if (ctx.measureText(candidate).width <= maxWidth) { line = candidate; continue; }
                if (line) { lines.push(line); line = ''; }
                // Break long words without discarding characters.
                for (const character of Array.from(word)) {
                    if (line && ctx.measureText(line + character).width > maxWidth) { lines.push(line); line = ''; }
                    line += character;
                }
            }
            lines.push(line);
        }
        return lines;
    }
    function paint(canvas, quote, movie, theme) {
        const ctx = canvas.getContext('2d');
        const c = themes[theme] || themes.gold;
        const W = canvas.width, H = canvas.height;
        ctx.fillStyle = c.background; ctx.fillRect(0, 0, W, H);
        const glow = ctx.createRadialGradient(W * .85, H * .06, 0, W * .85, H * .06, 850);
        glow.addColorStop(0, c.accent + '33'); glow.addColorStop(1, c.accent + '00');
        ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = c.accent; ctx.lineWidth = 3; ctx.strokeRect(45, 45, W - 90, H - 90);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = c.accent; ctx.font = 'bold 24px Arial, sans-serif';
        ctx.fillText('CINE DAIRY  /  ЦИТАТНИК', 90, 115);
        if (quote.spoiler) { ctx.textAlign = 'right'; ctx.fillText('СПОЙЛЕР', W - 90, 115); ctx.textAlign = 'left'; }
        ctx.fillStyle = c.accent; ctx.font = '110px Georgia, serif'; ctx.fillText('“', 85, 235);
        let lines, fontSize;
        for (fontSize = 62; fontSize >= 28; fontSize -= 2) {
            ctx.font = `${fontSize}px Georgia, serif`;
            lines = wrap(ctx, quote.text, W - 180);
            if (lines.length * fontSize * 1.3 <= 550) break;
        }
        if (fontSize < 28) return false;
        ctx.fillStyle = c.text;
        ctx.textBaseline = 'top';
        lines.forEach((line, i) => ctx.fillText(line, 90, 250 + i * fontSize * 1.3));
        ctx.textBaseline = 'alphabetic';
        ctx.strokeStyle = c.accent; ctx.beginPath(); ctx.moveTo(90, 875); ctx.lineTo(240, 875); ctx.stroke();
        ctx.fillStyle = c.text; ctx.font = 'bold 30px Arial, sans-serif';
        // Attribution also wraps so long titles are not silently clipped.
        const titleLines = wrap(ctx, movie.title || 'Фильм', W - 180);
        if (titleLines.length > 2) return false;
        titleLines.forEach((line, i) => ctx.fillText(line, 90, 930 + i * 38));
        if (quote.character) {
            ctx.fillStyle = c.secondary; ctx.font = '24px Arial, sans-serif';
            const characterLines = wrap(ctx, quote.character, W - 180);
            if (characterLines.length > 2 || 930 + titleLines.length * 38 + characterLines.length * 30 > 1045) return false;
            characterLines.forEach((line, i) => ctx.fillText(line, 90, 930 + titleLines.length * 38 + i * 30));
        }
        return true;
    }
    function open(quote, movie) {
        const previous = document.activeElement;
        const dialog = make('dialog', 'quote-poster-dialog');
        dialog.setAttribute('aria-labelledby', 'quote-poster-title');
        const header = make('div', 'quote-poster-header');
        const title = make('h2', '', 'Карточка цитаты'); title.id = 'quote-poster-title';
        const close = make('button', 'quote-poster-close', 'Закрыть'); close.type = 'button';
        header.append(title, close); dialog.append(header);
        dialog.append(make('p', 'quote-poster-hint', 'Выберите оформление. Изображение создаётся на вашем устройстве.'));
        if (quote.spoiler) dialog.append(make('p', 'quote-poster-spoiler', 'Цитата содержит спойлер. Предупреждение будет на изображении.'));
        const label = make('label', 'quote-poster-label', 'Оформление ');
        const select = make('select');
        Object.entries(themes).forEach(([value, config]) => { const option = make('option', '', config.name); option.value = value; select.append(option); });
        label.append(select); dialog.append(label);
        const canvas = make('canvas', 'quote-poster-preview'); canvas.width = 1080; canvas.height = 1080;
        canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Предпросмотр карточки цитаты'); dialog.append(canvas);
        const error = make('p', 'quote-poster-error'); error.setAttribute('role', 'status'); dialog.append(error);
        const actions = make('div', 'quote-poster-actions');
        const download = make('button', 'btn', 'Скачать PNG'); download.type = 'button';
        const share = make('button', 'btn btn-outline', 'Поделиться'); share.type = 'button';
        actions.append(download, share); dialog.append(actions); document.body.append(dialog);
        const update = () => {
            const fits = paint(canvas, quote, movie, select.value);
            error.textContent = fits ? '' : 'Текст слишком длинный для карточки. Сократите цитату, название фильма или имя персонажа и попробуйте снова.';
            download.disabled = !fits; share.disabled = !fits;
        };
        const blob = () => new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        download.addEventListener('click', async () => {
            const image = await blob(); if (!image) { error.textContent = 'Не удалось создать изображение.'; return; }
            const url = URL.createObjectURL(image); const link = document.createElement('a'); link.href = url; link.download = 'cinedairy-citata.png';
            document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
        });
        if (!navigator.share || !navigator.canShare || typeof File === 'undefined') share.hidden = true;
        share.addEventListener('click', async () => {
            try {
                const image = await blob(); if (!image) throw new Error('image');
                const file = new File([image], 'cinedairy-citata.png', {type: 'image/png'});
                if (!navigator.canShare({files: [file]})) { error.textContent = 'Этот браузер не поддерживает отправку изображения. Скачайте PNG.'; return; }
                await navigator.share({files: [file], title: 'Цитата из CineDairy'});
            } catch (err) { if (err.name !== 'AbortError') error.textContent = 'Не удалось открыть отправку. Скачайте PNG.'; }
        });
        select.addEventListener('change', update); close.addEventListener('click', () => dialog.close());
        dialog.addEventListener('close', () => { dialog.remove(); if (previous && previous.isConnected) previous.focus(); });
        update(); dialog.showModal(); close.focus();
    }
    window.CinemaQuotePoster = {open};
}());
