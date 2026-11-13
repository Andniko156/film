/* Only bundled into Android. The browser website keeps its current session policy. */
window.CINEDAIRY_ANDROID = true;
document.documentElement.classList.add('android-app');

function playLaunchAnimation() {
    const key = 'cinedairy.launch-seen';
    try {
        // Reloads in the same WebView should go directly to the archive.
        if (sessionStorage.getItem(key)) return;
        sessionStorage.setItem(key, '1');
    } catch (_) { return; }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const splash = document.createElement('div');
    splash.className = 'launch-splash';
    splash.setAttribute('aria-hidden', 'true');
    splash.innerHTML = `
        <span class="launch-beam"></span>
        <div class="launch-lockup">
            <div class="launch-lens"><span class="launch-play"></span></div>
            <div class="launch-wordmark">cine<span>·</span>dairy</div>
        </div>`;

    const listeners = new AbortController();
    const remove = () => {
        listeners.abort();
        splash.remove();
    };
    function onAnimationEnd(event) {
        if (event.target === splash) remove();
    }
    splash.addEventListener('animationend', onAnimationEnd);
    splash.addEventListener('animationcancel', onAnimationEnd);
    // The first tap or key press can go straight to the underlying screen.
    const options = {capture: true, signal: listeners.signal};
    window.addEventListener('pointerdown', remove, options);
    window.addEventListener('keydown', remove, options);
    document.body.append(splash);
}

playLaunchAnimation();

document.addEventListener('click', async event => {
    const link = event.target.closest('a[download]');
    if (!link || !window.CineDairyFiles) return;
    event.preventDefault();
    try {
        const blob = await (await fetch(link.href)).blob();
        if (blob.size > 15 * 1024 * 1024) throw Error('Файл слишком большой для экспорта (максимум 15 МБ).');
        const reader = new FileReader();
        reader.onload = () => window.CineDairyFiles.postMessage(JSON.stringify({name: link.download, mime: blob.type, data: reader.result.split(',')[1]}));
        reader.readAsDataURL(blob);
    } catch (error) { alert('Не удалось экспортировать файл: ' + error.message); }
}, true);
window.addEventListener('cinedairy:resume', () => window.dispatchEvent(new Event('online')));
