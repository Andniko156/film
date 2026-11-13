package ru.cinedairy.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import android.widget.FrameLayout;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.OutputStream;
import java.util.Set;
import java.util.HashSet;
import java.util.Arrays;
import java.util.Collections;

/** Bundled app UI, HTTPS same-origin API, no unrestricted JavaScript interface. */
public final class MainActivity extends Activity {
    private static final int IMPORT_FILE = 10, EXPORT_FILE = 11;
    private static final String ORIGIN = "https://" + BuildConfig.SITE_HOST;
    private static final Set<String> ASSETS = set("index.html", "styles.css", "quote-card.css",
        "model.js", "account.js", "quote-card.js", "app.js", "favicon.jpg",
        "offline.js", "android-runtime.js", "phone-ui.js", "android.css");
    private static Set<String> set(String... values) { return new HashSet<>(Arrays.asList(values)); }
    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private byte[] pendingExport;

    private boolean sameOrigin(Uri uri) {
        return "https".equals(uri.getScheme()) && BuildConfig.SITE_HOST.equals(uri.getHost())
            && (uri.getPort() == -1 || uri.getPort() == 443);
    }
    private boolean appPage(Uri uri) {
        return sameOrigin(uri) && ("/".equals(uri.getPath()) || "/index.html".equals(uri.getPath()));
    }
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(12, 12, 11));
        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(Color.rgb(12, 12, 11));
        frame.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(frame);
        // Respect status/navigation bars and the keyboard on edge-to-edge Android 15.
        frame.setOnApplyWindowInsetsListener((v, insets) -> {
            v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebViewAssetLoader loader = new WebViewAssetLoader.Builder().setDomain(BuildConfig.SITE_HOST)
            .addPathHandler("/", path -> {
                String name = path.isEmpty() ? "index.html" : path;
                if (!ASSETS.contains(name)) return null;
                return new WebViewAssetLoader.AssetsPathHandler(this).handle(name);
            }).build();
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (!sameOrigin(request.getUrl())) return null;
                WebResourceResponse local = loader.shouldInterceptRequest(request.getUrl());
                if (local != null) return local;
                // Fail closed for missing bundled UI. Only API calls go to the server.
                if (!request.getUrl().getPath().startsWith("/api/")) {
                    return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                        Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
                }
                return null;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (appPage(uri)) return false;
                if (request.isForMainFrame() && set("https", "mailto").contains(uri.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
                    catch (Exception ignored) { toast("Не удалось открыть ссылку"); }
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("application/json")
                    .addCategory(Intent.CATEGORY_OPENABLE);
                try { startActivityForResult(intent, IMPORT_FILE); }
                catch (Exception error) { callback.onReceiveValue(null); fileCallback = null; toast("Не удалось открыть выбор файла"); }
                return true;
            }
        });
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "CineDairyFiles", set(ORIGIN),
                (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                    if (!isMainFrame || !sameOrigin(sourceOrigin) || !appPage(Uri.parse(view.getUrl()))) return;
                    try {
                        if (pendingExport != null) { toast("Сначала завершите сохранение файла"); return; }
                        String payload = message.getData();
                        if (payload == null || payload.length() > 22 * 1024 * 1024) throw new IllegalArgumentException();
                        JSONObject data = new JSONObject(payload);
                        String mime = data.getString("mime").split(";")[0];
                        if (!set("application/json", "image/png", "text/plain").contains(mime)) throw new IllegalArgumentException();
                        String name = data.getString("name").replaceAll("[^a-zA-Z0-9._-]", "_");
                        if (name.isEmpty() || name.length() > 160) throw new IllegalArgumentException();
                        byte[] bytes = Base64.decode(data.getString("data"), Base64.DEFAULT);
                        if (bytes.length > 15 * 1024 * 1024) throw new IllegalArgumentException();
                        pendingExport = bytes;
                        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).setType(mime)
                            .addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE, name);
                        startActivityForResult(intent, EXPORT_FILE);
                    } catch (Exception error) { pendingExport = null; toast("Не удалось подготовить файл"); }
                });
        } else {
            new AlertDialog.Builder(this).setMessage("Обновите Android System WebView для экспорта резервных копий.")
                .setPositiveButton("Понятно", null).show();
        }
        web.loadUrl(ORIGIN + "/");
    }
    private void toast(String text) { Toast.makeText(this, text, Toast.LENGTH_LONG).show(); }
    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == IMPORT_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(resultCode == RESULT_OK && data != null && data.getData() != null ? new Uri[]{data.getData()} : null);
            fileCallback = null;
        }
        if (requestCode == EXPORT_FILE) {
            byte[] bytes = pendingExport; pendingExport = null;
            if (resultCode == RESULT_OK && data != null && bytes != null) {
                try (OutputStream output = getContentResolver().openOutputStream(data.getData(), "wt")) {
                    if (output == null) throw new IllegalStateException();
                    output.write(bytes); toast("Файл сохранён");
                } catch (Exception error) { toast("Не удалось сохранить файл. Повторите экспорт."); }
            }
        }
    }
    @Override protected void onResume() {
        super.onResume();
        if (web != null) { web.onResume(); web.evaluateJavascript("window.dispatchEvent(new Event('cinedairy:resume'))", null); }
    }
    @Override protected void onPause() {
        CookieManager.getInstance().flush();
        if (web != null) web.onPause();
        super.onPause();
    }
    @Override public void onBackPressed() {
        web.evaluateJavascript("(function(){const d=document.activeElement?.closest('dialog[open]')||Array.from(document.querySelectorAll('dialog[open]')).pop();if(d){d.close();return true;}if(location.hash&&location.hash!=='#home'){location.hash='home';return true;}return false;})()", result -> {
            if (!"true".equals(result)) finish();
        });
    }
    @Override protected void onDestroy() {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
