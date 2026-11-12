/* Only bundled into Android. The browser website keeps its current session policy. */
window.CINEDAIRY_ANDROID = true;
document.documentElement.classList.add('android-app');
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
