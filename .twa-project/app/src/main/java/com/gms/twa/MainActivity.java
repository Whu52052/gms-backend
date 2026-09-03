package com.gms.twa;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends AppCompatActivity {
    
    private WebView webView;
    private String homeUrl = "http://10.5.51.216:8765/mobile.html";
    private String baseUrl = "http://10.5.51.216:8765";
    private ValueCallback<Uri[]> filePathCallback;
    private static final int CURRENT_VERSION_CODE = 11;
    private static final String CURRENT_VERSION_NAME = "1.0.11";
    private static final int FILE_CHOOSER_REQUEST = 1;
    private static final int CAMERA_PERMISSION_REQUEST = 100;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 200;
    private static final int UPDATE_INSTALL_REQUEST = 300;
    private long downloadId = -1;
    private BroadcastReceiver downloadReceiver;
    
    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setUserAgentString(settings.getUserAgentString() + " GMS-Android");

        // 标准移动端 WebView 配置：启用宽视口 + overview 让页面正确填满屏幕
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setBuiltInZoomControls(false);
        settings.setSupportZoom(false);

        webView.setWebViewClient(new GMSWebViewClient());
        webView.setWebChromeClient(new GMSWebChromeClient());

        checkAndRequestPermissions();
        checkForUpdate();

        handleIntent(getIntent());
    }
    
    // ==================== OTA Update ====================
    
    private void checkForUpdate() {
        new Thread(() -> {
            try {
                URL url = new URL(baseUrl + "/api/app/latest-version");
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);
                conn.setRequestMethod("GET");
                
                BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) sb.append(line);
                reader.close();
                conn.disconnect();
                
                JSONObject json = new JSONObject(sb.toString());
                int serverVersion = json.optInt("versionCode", 0);
                String versionName = json.optString("versionName", "");
                final String apkUrl = json.optString("apkUrl", "");
                
                int currentVersion = CURRENT_VERSION_CODE;
                if (serverVersion > currentVersion && !apkUrl.isEmpty()) {
                    final String fullUrl = baseUrl + apkUrl;
                    final int sVer = serverVersion;
                    final String vName = versionName;
                    runOnUiThread(() -> showUpdateDialog(sVer, vName, fullUrl));
                }
            } catch (Exception ignored) {
                // Network unavailable or server not reachable — silently skip
            }
        }).start();
    }
    
    private void showUpdateDialog(int newVersion, String versionName, String apkUrl) {
        new AlertDialog.Builder(this)
            .setTitle("发现新版本 v" + versionName)
            .setMessage("是否立即下载更新？\n\n当前版本: v" + CURRENT_VERSION_NAME + "\n最新版本: v" + versionName)
            .setPositiveButton("立即更新", (d, w) -> startDownload(apkUrl))
            .setNegativeButton("稍后", null)
            .setCancelable(false)
            .show();
    }
    
    private void startDownload(String apkUrl) {
        // Register receiver BEFORE enqueuing download to avoid race
        downloadReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (id == downloadId) {
                    installApk(id);
                    unregisterReceiver(this);
                    downloadReceiver = null;
                }
            }
        };
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(downloadReceiver, new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE), Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(downloadReceiver, new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE));
        }
        
        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(apkUrl));
        request.setTitle("GMS 更新");
        request.setDescription("正在下载 v" + CURRENT_VERSION_NAME + "...");
        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        request.setDestinationUri(Uri.fromFile(new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "GMS-update.apk")));
        request.setAllowedNetworkTypes(DownloadManager.Request.NETWORK_WIFI | DownloadManager.Request.NETWORK_MOBILE);
        
        DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        downloadId = dm.enqueue(request);
        Toast.makeText(this, "下载已开始，完成后自动安装", Toast.LENGTH_SHORT).show();
    }
    
    private void installApk(long downloadId) {
        DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        DownloadManager.Query query = new DownloadManager.Query();
        query.setFilterById(downloadId);
        Cursor cursor = dm.query(query);
        if (cursor.moveToFirst()) {
            int statusIdx = cursor.getColumnIndex(DownloadManager.COLUMN_STATUS);
            int uriIdx = cursor.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI);
            if (statusIdx >= 0 && uriIdx >= 0) {
                int status = cursor.getInt(statusIdx);
                if (status == DownloadManager.STATUS_SUCCESSFUL) {
                    String uriStr = cursor.getString(uriIdx);
                    cursor.close();
                    File file = new File(Uri.parse(uriStr).getPath());
                    Uri apkUri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", file);
                    
                    Intent intent = new Intent(Intent.ACTION_VIEW);
                    intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                    intent.setFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
                    startActivity(intent);
                    return;
                }
            }
        }
        cursor.close();
        Toast.makeText(this, "下载失败，请重试", Toast.LENGTH_SHORT).show();
    }
    
    // ==================== Permissions ====================
    
    private void checkAndRequestPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) 
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, 
                    new String[]{Manifest.permission.POST_NOTIFICATIONS}, 
                    NOTIFICATION_PERMISSION_REQUEST);
            }
        }
        // Android 8+ needs permission to install APKs from unknown sources
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (!getPackageManager().canRequestPackageInstalls()) {
                new AlertDialog.Builder(this)
                    .setTitle("需要安装权限")
                    .setMessage("为了自动更新，请允许从本应用安装软件包")
                    .setPositiveButton("去设置", (d, w) -> {
                        Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
                        intent.setData(Uri.parse("package:" + getPackageName()));
                        startActivity(intent);
                    })
                    .setNegativeButton("取消", null)
                    .show();
            }
        }
    }
    
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }
    
    private void handleIntent(Intent intent) {
        String action = intent.getAction();
        Uri data = intent.getData();
        
        if (Intent.ACTION_VIEW.equals(action) && data != null) {
            webView.loadUrl(data.toString());
        } else {
            webView.loadUrl(homeUrl);
        }
    }
    
    // ==================== WebView Client ====================
    
    private class GMSWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String host = uri.getHost();
            
            if (host != null && (host.equals("localhost") || host.equals("127.0.0.1") || 
                host.equals("gms.example.com") || host.equals("10.5.51.216"))) {
                return false;
            }
            
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            startActivity(intent);
            return true;
        }
    }
    
    // ==================== WebChrome Client ====================
    
    private class GMSWebChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView webView,
                                         ValueCallback<Uri[]> callback,
                                         FileChooserParams fileChooserParams) {
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(null);
            }
            filePathCallback = callback;
            
            Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            
            startActivityForResult(
                Intent.createChooser(intent, "选择文件"),
                FILE_CHOOSER_REQUEST
            );
            
            return true;
        }
        
        @Override
        public void onPermissionRequest(final android.webkit.PermissionRequest request) {
            runOnUiThread(() -> request.grant(request.getResources()));
        }
    }
    
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        
        if (requestCode == FILE_CHOOSER_REQUEST) {
            if (filePathCallback != null) {
                Uri[] results = null;
                if (resultCode == Activity.RESULT_OK && data != null) {
                    String dataString = data.getDataString();
                    if (dataString != null) {
                        results = new Uri[]{Uri.parse(dataString)};
                    }
                }
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
        }
    }
    
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (webView.canGoBack()) {
                webView.goBack();
                return true;
            }
        }
        return super.onKeyDown(keyCode, event);
    }
    
    @Override
    protected void onDestroy() {
        if (downloadReceiver != null) {
            try { unregisterReceiver(downloadReceiver); } catch (Exception ignored) {}
        }
        if (webView != null) {
            webView.stopLoading();
            webView.clearCache(true);
            webView.removeAllViews();
            webView.destroy();
        }
        super.onDestroy();
    }
}
