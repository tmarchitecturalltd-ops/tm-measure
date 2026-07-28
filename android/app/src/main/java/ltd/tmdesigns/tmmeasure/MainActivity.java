package ltd.tmdesigns.tmmeasure;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

import java.util.ArrayList;
import java.util.List;

import ltd.tmdesigns.tmmeasure.BuildConfig;

/**
 * MainActivity
 *
 * Hosts the Capacitor WebView. Beyond the default bridge setup we ask
 * for the hardware permissions the measurement flow depends on:
 *
 *   • CAMERA        — room / wall photos and the AR scan flow
 *   • RECORD_AUDIO  — per-room voice memos (MediaRecorder in the WebView)
 *   • media read    — picking existing shots from the camera roll
 *
 * These are requested up front rather than lazily because the WebView's
 * own permission prompts (getUserMedia, <input type="file">) can only be
 * granted when the underlying Android permission is already held; without
 * it the request is denied silently and the feature appears broken.
 */
public class MainActivity extends BridgeActivity {

    private static final int PERMISSION_REQUEST_CODE = 9001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        requestMediaPermissions();
    }

    /** Asks for any of the required permissions not already granted. */
    private void requestMediaPermissions() {
        List<String> needed = new ArrayList<>();

        addIfMissing(needed, Manifest.permission.CAMERA);
        addIfMissing(needed, Manifest.permission.RECORD_AUDIO);

        // Android 13 (API 33) replaced READ_EXTERNAL_STORAGE with granular
        // media permissions; asking for the wrong one on either side of
        // that line results in an automatic denial.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            addIfMissing(needed, Manifest.permission.READ_MEDIA_IMAGES);
        } else {
            addIfMissing(needed, Manifest.permission.READ_EXTERNAL_STORAGE);
        }

        if (!needed.isEmpty()) {
            ActivityCompat.requestPermissions(
                    this,
                    needed.toArray(new String[0]),
                    PERMISSION_REQUEST_CODE);
        }
    }

    private void addIfMissing(List<String> target, String permission) {
        if (ContextCompat.checkSelfPermission(this, permission)
                != PackageManager.PERMISSION_GRANTED) {
            target.add(permission);
        }
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode,
            @NonNull String[] permissions,
            @NonNull int[] grantResults) {
        // Capacitor's bridge needs to see results for its own plugin
        // requests, so always delegate up the chain. A denial here is not
        // fatal: the relevant feature surfaces its own in-app message.
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }
}
