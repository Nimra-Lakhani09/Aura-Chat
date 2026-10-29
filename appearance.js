/* =========================================================
   AuraChat — appearance: light/dark theme + chat wallpaper
   (independent of app.js, works on the login screen too)
   ========================================================= */
(function () {
    "use strict";

    var root = document.documentElement;
    var THEME_KEY = "aura-theme";
    var WALLPAPER_KEY = "aura-wallpaper";
    var CUSTOM_KEY = "aura-wallpaper-custom";
    var PRESETS = ["aura", "silk", "sunset", "dots", "stripes", "plain", "custom"];

    /* ---------- safe localStorage ---------- */
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
    function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

    function notify(title, icon) {
        if (window.Swal) {
            Swal.fire({ toast: true, position: "top-end", icon: icon || "info", title: title, showConfirmButton: false, timer: 2600 });
        }
    }

    /* =====================================================
       THEME
    ===================================================== */
    var themeButtons = document.querySelectorAll(".theme-switch");
    var metaTheme = document.querySelector('meta[name="theme-color"]');

    function currentTheme() {
        return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
    }

    function paintThemeButtons() {
        var dark = currentTheme() === "dark";
        var label = dark ? "Switch to light theme" : "Switch to dark theme";
        themeButtons.forEach(function (btn) {
            btn.innerHTML = '<i class="fa-solid ' + (dark ? "fa-sun" : "fa-moon") + '"></i>';
            btn.title = label;
            btn.setAttribute("aria-label", label);
        });
        if (metaTheme) metaTheme.setAttribute("content", dark ? "#171012" : "#f6ebe6");
    }

    function setTheme(theme, animate) {
        if (animate) {
            root.classList.add("theme-anim");
            setTimeout(function () { root.classList.remove("theme-anim"); }, 650);
        }
        root.setAttribute("data-theme", theme);
        lsSet(THEME_KEY, theme);
        paintThemeButtons();
    }

    themeButtons.forEach(function (btn) {
        btn.addEventListener("click", function () {
            btn.classList.add("spin");
            setTheme(currentTheme() === "dark" ? "light" : "dark", true);
            setTimeout(function () { btn.classList.remove("spin"); }, 700);
        });
    });

    /* =====================================================
       WALLPAPER
    ===================================================== */
    var box = document.getElementById("messages");
    var panel = document.getElementById("appearancePanel");
    var openBtn = document.getElementById("wallpaperBtn");
    var closeBtn = document.getElementById("closeAppearanceBtn");
    var grid = document.getElementById("wpGrid");
    var customTile = document.getElementById("wpCustomTile");
    var uploadBtn = document.getElementById("wallpaperUploadBtn");
    var removeBtn = document.getElementById("wpRemoveBtn");
    var fileInput = document.getElementById("wallpaperInput");

    function hasCustom() { return !!lsGet(CUSTOM_KEY); }

    function syncCustom() {
        var data = lsGet(CUSTOM_KEY);
        if (data) {
            root.style.setProperty("--wp-custom", 'url("' + data + '")');
            customTile.hidden = false;
            removeBtn.hidden = false;
        } else {
            root.style.removeProperty("--wp-custom");
            customTile.hidden = true;
            removeBtn.hidden = true;
        }
    }

    function applyWallpaper(name, save) {
        if (PRESETS.indexOf(name) === -1 || (name === "custom" && !hasCustom())) name = "aura";
        box.setAttribute("data-wallpaper", name);
        box.classList.toggle("has-photo", name === "custom");
        grid.querySelectorAll(".wp-tile").forEach(function (tile) {
            tile.classList.toggle("active", tile.getAttribute("data-wallpaper") === name);
        });
        if (save !== false) lsSet(WALLPAPER_KEY, name);
    }

    function togglePanel(force) {
        var show = typeof force === "boolean" ? force : panel.classList.contains("hidden");
        panel.classList.toggle("hidden", !show);
        openBtn.classList.toggle("active", show);
    }

    openBtn.addEventListener("click", function (e) { e.stopPropagation(); togglePanel(); });
    closeBtn.addEventListener("click", function () { togglePanel(false); });
    document.addEventListener("click", function (e) {
        if (!panel.classList.contains("hidden") && !panel.contains(e.target) && !openBtn.contains(e.target)) togglePanel(false);
    });
    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") togglePanel(false);
    });

    grid.addEventListener("click", function (e) {
        var tile = e.target.closest(".wp-tile");
        if (tile) applyWallpaper(tile.getAttribute("data-wallpaper"));
    });

    /* ---------- custom photo ---------- */
    function fileToDataUrl(file, maxSide, quality) {
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(file);
            var img = new Image();
            img.onload = function () {
                var scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
                var canvas = document.createElement("canvas");
                canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
                canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
                canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
                URL.revokeObjectURL(url);
                resolve(canvas.toDataURL("image/jpeg", quality));
            };
            img.onerror = function () {
                URL.revokeObjectURL(url);
                reject(new Error("Could not read image"));
            };
            img.src = url;
        });
    }

    uploadBtn.addEventListener("click", function () { fileInput.click(); });

    fileInput.addEventListener("change", async function () {
        var file = fileInput.files[0];
        if (!file) return;
        if (!/^image\//.test(file.type)) {
            notify("Please choose an image file", "error");
            fileInput.value = "";
            return;
        }
        try {
            var data = await fileToDataUrl(file, 1600, 0.82);
            if (!lsSet(CUSTOM_KEY, data)) {
                data = await fileToDataUrl(file, 1000, 0.7); // smaller retry if storage is tight
                if (!lsSet(CUSTOM_KEY, data)) throw new Error("Storage is full");
            }
            syncCustom();
            applyWallpaper("custom");
            notify("Wallpaper updated", "success");
        } catch (err) {
            console.error(err);
            notify("Couldn't use that image", "error");
        } finally {
            fileInput.value = "";
        }
    });

    removeBtn.addEventListener("click", function () {
        lsDel(CUSTOM_KEY);
        syncCustom();
        applyWallpaper("aura");
        notify("Custom wallpaper removed", "success");
    });

    /* ---------- init ---------- */
    paintThemeButtons();
    syncCustom();
    applyWallpaper(lsGet(WALLPAPER_KEY) || "aura", false);
})();

/* =========================================================
   CHAT FONT STYLE + SIZE (saved on this device)
   ========================================================= */
(function () {
    "use strict";
    var root = document.documentElement;
    var FONTS = {
        "default": "",
        system: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        nunito: "'Nunito', sans-serif",
        merri: "'Merriweather', Georgia, serif",
        caveat: "'Caveat', cursive",
        pacifico: "'Pacifico', cursive",
        fira: "'Fira Code', monospace"
    };
    var DEFAULT_SIZE = 15, MIN = 12, MAX = 24;
    function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function put(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ }  }
    function del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

    var select = document.getElementById("fontSelect");
    var range = document.getElementById("fontSizeRange");
    var minus = document.getElementById("fontMinus");
    var plus = document.getElementById("fontPlus");
    var reset = document.getElementById("fontResetBtn");
    if (!select || !range) return;

    function applyFont(name, save) {
        if (!(name in FONTS)) name = "default";
        if (FONTS[name]) root.style.setProperty("--chat-font", FONTS[name]); else root.style.removeProperty("--chat-font");
        select.value = name;
        if (save) { if (name === "default") del("aura-font"); else put("aura-font", name); }
    }
    function applySize(px, save) {
        px = Math.max(MIN, Math.min(MAX, Math.round(Number(px) || DEFAULT_SIZE)));
        root.style.setProperty("--chat-size", px + "px");
        range.value = String(px);
        if (save) put("aura-fsize", String(px));
    }

    select.addEventListener("change", function () { applyFont(select.value, true); });
    range.addEventListener("input", function () { applySize(range.value, true); });
    minus.addEventListener("click", function () { applySize(Number(range.value) - 1, true); });
    plus.addEventListener("click", function () { applySize(Number(range.value) + 1, true); });
    reset.addEventListener("click", function () {
        del("aura-font"); del("aura-fsize");
        root.style.removeProperty("--chat-font");
        root.style.removeProperty("--chat-size");
        select.value = "default";
        range.value = String(DEFAULT_SIZE);
    });

    applyFont(get("aura-font") || "default", false);
    if (get("aura-fsize")) applySize(get("aura-fsize"), false);
})();