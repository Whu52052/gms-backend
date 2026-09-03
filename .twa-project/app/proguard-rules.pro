# Add project specific ProGuard rules here.
-keep class com.gms.twa.** { *; }
-keepclassmembers class com.gms.twa.** { *; }

# WebView
-keepattributes *Annotation*
-keep class android.webkit.** { *; }

# JavaScript interface
-keepclassmembers class com.gms.twa.MainActivity {
    public void *(android.view.View);
    public void *(org.json.JSONObject);
}
