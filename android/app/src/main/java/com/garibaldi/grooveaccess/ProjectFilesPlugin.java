package com.garibaldi.grooveaccess;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * The project slots as files in the app's own storage (files/projects, one file per key of
 * src/storage/projects.ts) and backup files saved / opened through Android's file picker. See src/storage/native.ts.
 */
@CapacitorPlugin(name = "ProjectFiles")
public class ProjectFilesPlugin extends Plugin {
    private String pendingText;

    private File dir() {
        File d = new File(getContext().getFilesDir(), "projects");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    /** A plain file name only (the JS side URL-encodes the keys). */
    private File file(String name) throws IOException {
        if (name == null || name.isEmpty() || name.contains("/") || name.startsWith(".")) throw new IOException("bad name");
        return new File(dir(), name);
    }

    private static String readStream(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toString("UTF-8");
    }

    @PluginMethod
    public void readAll(PluginCall call) {
        JSObject files = new JSObject();
        File[] list = dir().listFiles();
        try {
            if (list != null) {
                for (File f : list) {
                    if (f.isFile() && !f.getName().endsWith(".tmp")) {
                        try (InputStream in = new FileInputStream(f)) {
                            files.put(f.getName(), readStream(in));
                        }
                    }
                }
            }
            JSObject ret = new JSObject();
            ret.put("files", files);
            call.resolve(ret);
        } catch (IOException e) {
            call.reject("read failed", e);
        }
    }

    /** Written to a temporary file first, then renamed over the old one: never half a file. */
    @PluginMethod
    public void write(PluginCall call) {
        try {
            File target = file(call.getString("name"));
            File tmp = new File(target.getPath() + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(call.getString("text", "").getBytes(StandardCharsets.UTF_8));
                out.getFD().sync();
            }
            if (!tmp.renameTo(target)) throw new IOException("rename failed");
            call.resolve();
        } catch (IOException e) {
            call.reject("write failed", e);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        try {
            File f = file(call.getString("name"));
            if (f.exists() && !f.delete()) throw new IOException("delete failed");
            call.resolve();
        } catch (IOException e) {
            call.reject("delete failed", e);
        }
    }

    @PluginMethod
    public void exportFile(PluginCall call) {
        pendingText = call.getString("text", "");
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "grooveaccess-projects.json"));
        startActivityForResult(call, intent, "exportResult");
    }

    @ActivityCallback
    private void exportResult(PluginCall call, ActivityResult result) {
        JSObject ret = new JSObject();
        Uri uri = result.getData() != null ? result.getData().getData() : null;
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            ret.put("saved", false);
            call.resolve(ret);
            return;
        }
        try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
            if (out == null) throw new IOException("no stream");
            out.write(pendingText.getBytes(StandardCharsets.UTF_8));
            ret.put("saved", true);
            call.resolve(ret);
        } catch (IOException e) {
            call.reject("export failed", e);
        } finally {
            pendingText = null;
        }
    }

    @PluginMethod
    public void importFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        startActivityForResult(call, intent, "importResult");
    }

    @ActivityCallback
    private void importResult(PluginCall call, ActivityResult result) {
        JSObject ret = new JSObject();
        Uri uri = result.getData() != null ? result.getData().getData() : null;
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            ret.put("text", JSObject.NULL);
            call.resolve(ret);
            return;
        }
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) throw new IOException("no stream");
            ret.put("text", readStream(in));
            call.resolve(ret);
        } catch (IOException e) {
            call.reject("import failed", e);
        }
    }
}
