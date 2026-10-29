import { initializeApp } from "https://www.gstatic.com/firebasejs/11.4.0/firebase-app.js";
import {
    getDatabase,
    ref,
    push,
    onChildAdded,
    onChildChanged,
    onChildRemoved,
    set,
    remove,
    onValue,
    update,
    get,
    onDisconnect,
    query,
    limitToLast,
    runTransaction,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.4.0/firebase-database.js";
import {
    initializeAuth,
    inMemoryPersistence,
    browserPopupRedirectResolver,
    onAuthStateChanged,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signInWithPopup,
    GoogleAuthProvider,
    signOut,
    updateProfile,
    sendPasswordResetEmail,
    deleteUser
} from "https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyCr59a3OI-za-tV4A74TJ5k_qLBP2HCvyg",
    authDomain: "chat-application-2ab63.firebaseapp.com",
    projectId: "chat-application-2ab63",
    storageBucket: "chat-application-2ab63.firebasestorage.app",
    messagingSenderId: "463090935436",
    appId: "1:463090935436:web:c105b7ba3e6573ba5afda9",
    measurementId: "G-SBCV50QJZP"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
// In-memory persistence: the login is NOT remembered between visits,
// so the authentication form appears every time the site is opened.
const auth = initializeAuth(app, {
    persistence: inMemoryPersistence,
    popupRedirectResolver: browserPopupRedirectResolver
});

const CLOUDINARY_CLOUD_NAME = "nbxrq2d0";
const CLOUDINARY_UPLOAD_PRESET = "chat-app";
const DEFAULT_BIO = "Hey there! I am using AuraChat.";

/* ---------------------------------------------------------
   State
--------------------------------------------------------- */
let me = null;                    // { uid, name, avatar, bio, email }
let pendingAvatar = null;         // avatar chosen in profile modal, saved on "Save"
let currentChatRoom = "global";   // "global" or the other user's uid
let selectedMember = null;        // { uid, name }
let authMode = "login";           // "login" | "signup"
let signupName = "";

let usersCache = {};              // uid -> profile (live)
let groupsCache = {};             // gid -> group (only groups I belong to)
let roomCache = {};               // messageKey -> data of the open room
let currentRoomName = "";         // fallback title for a private chat
let pinnedIndex = 0;              // which pinned message the top banner shows
let groupPick = new Set();        // members ticked in the "New group" dialog
let aiPending = 0;                // AI replies still being written
let replyDraft = null;            // message I'm replying to {key, name, preview}
let translations = {};            // messageKey -> {lang, text} (only on my screen)
let roomTTL = 0;                  // disappearing-messages timer of the open chat (ms, 0 = off)
let typingState = {};             // uid -> {name, ts} of people typing in the open chat
let typingTimer = null;
let lastTypingWrite = 0;
let viewOncePending = false;      // next chosen photo is sent as view-once

let statusCache = {};             // uid -> { statusId: status }
let sv = null;                    // status viewer state
let showArchived = false;         // archived section expanded?
let pendingStatusCaption = "";    // caption typed before choosing a photo

/* ---------- Aura AI (mini assistant, like Meta AI) ----------
   endpoint: an OpenAI-compatible chat endpoint (POST {model, messages} -> choices[0].message.content).
   Never put a secret API key in browser code — point this at your own backend/proxy instead.
   If the endpoint is empty or unreachable, a small built-in offline brain answers basic questions. */
const AI_UID = "aura-ai";
const AI_NAME = "Aura AI";
const AI_CONFIG = {
    endpoint: "https://text.pollinations.ai/openai",
    apiKey: "",
    model: "openai",
    timeoutMs: 20000,
    system: "You are Aura AI, a friendly and concise assistant inside the AuraChat messaging app. Reply in the same language and script the user writes in (Roman Urdu / Hinglish is fine). Keep answers short — under 120 words unless asked for more. Plain text only, no markdown headings."
};

let roomUnsubs = [];              // listeners of the open chat room
let sessionUnsubs = [];           // listeners that live while logged in
let callUnsubs = [];              // listeners of the running call

let localStream = null;
let peerConnection = null;
let pendingCandidates = [];
let incomingPrompt = false;

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

const rtcServers = {
    iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }]
};

/* ---------------------------------------------------------
   DOM
--------------------------------------------------------- */
const $ = (id) => document.getElementById(id);

const authModal = $("authModal");
const authCard = $("authCard");
const authForm = $("authForm");
const authName = $("authName");
const authEmail = $("authEmail");
const authPassword = $("authPassword");
const authError = $("authError");
const authSubmitBtn = $("authSubmitBtn");
const googleBtn = $("googleBtn");
const forgotBtn = $("forgotBtn");
const switchModeBtn = $("switchModeBtn");
const switchModeText = $("switchModeText");
const togglePasswordBtn = $("togglePasswordBtn");
const tabLogin = $("tabLogin");
const tabSignup = $("tabSignup");

const messageInput = $("message");
const sendBtn = $("sendBtn");
const messageBox = $("messages");
const activeUsersList = $("activeUsersList");
const currentChatTitle = $("currentChatTitle");
const searchInput = $("searchInput");

const profileModal = $("profileModal");
const openMyProfileBtn = $("openMyProfileBtn");
const closeProfileModalBtn = $("closeProfileModalBtn");
const profileImgInput = $("profileImgInput");
const profileModalImg = $("profileModalImg");
const profileBioInput = $("profileBioInput");
const saveProfileBtn = $("saveProfileBtn");
const deleteMyAccountBtn = $("deleteMyAccountBtn");
const logoutBtn = $("logoutBtn");

const viewUserModal = $("viewUserModal");
const closeViewUserModalBtn = $("closeViewUserModalBtn");
const startDirectChatBtn = $("startDirectChatBtn");

const pinnedBar = $("pinnedBar");
const chatMenu = $("chatMenu");
const attachMenu = $("attachMenu");
const groupModal = $("groupModal");
const groupNameInput = $("groupNameInput");
const groupPicker = $("groupPicker");

/* ---------------------------------------------------------
   Helpers
--------------------------------------------------------- */
const swalTheme = {
    background: "#fffaf7",
    color: "#4a2f32",
    confirmButtonColor: "#b4707a"
};

const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const defaultAvatar = (name) =>
    `https://ui-avatars.com/api/?name=${encodeURIComponent(name || "User")}&background=b4707a&color=fff`;

function toast(title, icon = "success", timer = 2500) {
    Swal.fire({ toast: true, position: "top-end", icon, title, showConfirmButton: false, timer, ...swalTheme });
}

function alertError(title, text) {
    Swal.fire({ icon: "error", title, text, ...swalTheme });
}

function roomKeyFor(room) {
    if (room === "global") return "global";
    if (room === "ai") return `ai_${me.uid}`;
    if (room.startsWith("group:")) return `group_${room.slice(6)}`;
    if (room.startsWith("channel:")) return `channel_${room.slice(8)}`;
    return `dm_${[me.uid, room].sort().join("_")}`;
}

function roomPathFor(room) {
    return `messages/${roomKeyFor(room)}`;
}

/* ---------------------------------------------------------
   Cloudinary upload
--------------------------------------------------------- */
async function uploadToCloudinary(file) {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

    try {
        const response = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/auto/upload`, {
            method: "POST",
            body: formData,
            credentials: "omit"
        });
        const data = await response.json();
        if (response.ok && data.secure_url) return data.secure_url;
        throw new Error(data.error?.message || "Upload Failed");
    } catch (error) {
        console.error("Cloudinary Error:", error);
        alertError("Upload Failed", error.message || "Error uploading file to Cloudinary.");
        return null;
    }
}

/* =========================================================
   AUTHENTICATION
========================================================= */
function friendlyAuthError(code) {
    const map = {
        "auth/invalid-email": "That email address doesn't look right.",
        "auth/missing-email": "Please enter your email address.",
        "auth/user-not-found": "No account found with this email.",
        "auth/wrong-password": "Incorrect password. Please try again.",
        "auth/invalid-credential": "Incorrect email or password.",
        "auth/email-already-in-use": "An account with this email already exists. Try logging in.",
        "auth/weak-password": "Password is too weak — use at least 6 characters.",
        "auth/too-many-requests": "Too many attempts. Please wait a bit and try again.",
        "auth/network-request-failed": "Network error. Check your connection.",
        "auth/user-disabled": "This account has been disabled.",
        "auth/unauthorized-domain": "This domain isn't authorized in Firebase (Authentication → Settings → Authorized domains).",
        "auth/operation-not-allowed": "This sign-in method isn't enabled in the Firebase console yet.",
        "auth/account-exists-with-different-credential": "This email is registered with a different sign-in method."
    };
    return map[code] || "Something went wrong. Please try again.";
}

function showAuthError(msg) {
    authError.textContent = msg;
    authError.classList.toggle("show", !!msg);
    if (msg) {
        authError.classList.remove("shake");
        void authError.offsetWidth; // restart animation
        authError.classList.add("shake");
    }
}

function setAuthMode(mode) {
    authMode = mode;
    authCard.dataset.mode = mode;
    tabLogin.classList.toggle("active", mode === "login");
    tabSignup.classList.toggle("active", mode === "signup");
    authSubmitBtn.querySelector("span").textContent = mode === "login" ? "Log In" : "Create Account";
    switchModeText.textContent = mode === "login" ? "Don't have an account?" : "Already have an account?";
    switchModeBtn.textContent = mode === "login" ? "Sign up" : "Log in";
    authPassword.autocomplete = mode === "login" ? "current-password" : "new-password";
    showAuthError("");
}

function setAuthLoading(loading) {
    authSubmitBtn.classList.toggle("loading", loading);
    [authSubmitBtn, googleBtn, tabLogin, tabSignup, forgotBtn, switchModeBtn].forEach((el) => (el.disabled = loading));
}

tabLogin.addEventListener("click", () => setAuthMode("login"));
tabSignup.addEventListener("click", () => setAuthMode("signup"));
switchModeBtn.addEventListener("click", () => setAuthMode(authMode === "login" ? "signup" : "login"));

togglePasswordBtn.addEventListener("click", () => {
    const show = authPassword.type === "password";
    authPassword.type = show ? "text" : "password";
    togglePasswordBtn.innerHTML = `<i class="fa-regular ${show ? "fa-eye-slash" : "fa-eye"}"></i>`;
});

authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    showAuthError("");

    const email = authEmail.value.trim();
    const password = authPassword.value;
    const name = authName.value.trim();

    if (authMode === "signup" && name.length < 2) return showAuthError("Please enter a display name (at least 2 characters).");
    if (!email) return showAuthError("Please enter your email address.");
    if (!password) return showAuthError("Please enter your password.");
    if (authMode === "signup" && password.length < 6) return showAuthError("Password must be at least 6 characters.");

    setAuthLoading(true);
    try {
        if (authMode === "signup") {
            signupName = name; // read by startSession() when the auth state fires
            const cred = await createUserWithEmailAndPassword(auth, email, password);
            await updateProfile(cred.user, { displayName: name });
        } else {
            await signInWithEmailAndPassword(auth, email, password);
        }
    } catch (err) {
        signupName = "";
        console.error(err);
        showAuthError(friendlyAuthError(err.code));
    } finally {
        setAuthLoading(false);
    }
});

googleBtn.addEventListener("click", async () => {
    showAuthError("");
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });

    setAuthLoading(true);
    try {
        await signInWithPopup(auth, provider);
    } catch (err) {
        if (err.code === "auth/popup-blocked") {
            showAuthError("Your browser blocked the Google popup. Please allow popups for this site and try again.");
            return;
        }
        if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") {
            console.error(err);
            showAuthError(friendlyAuthError(err.code));
        }
    } finally {
        setAuthLoading(false);
    }
});

forgotBtn.addEventListener("click", async () => {
    const email = authEmail.value.trim();
    if (!email) return showAuthError("Enter your email above first, then tap “Forgot password?”.");
    try {
        await sendPasswordResetEmail(auth, email);
        showAuthError("");
        toast("Password reset email sent!", "success", 3500);
    } catch (err) {
        showAuthError(friendlyAuthError(err.code));
    }
});

logoutBtn.addEventListener("click", async () => {
    try {
        if (me) await update(ref(db, `users/${me.uid}`), { status: "offline", lastSeenAt: Date.now() });
    } catch (_) { /* ignore */ }
    profileModal.classList.add("hidden");
    await signOut(auth);
});

/* ---------- Session lifecycle ---------- */
onAuthStateChanged(auth, async (user) => {
    if (user) {
        await startSession(user);
    } else {
        endSession();
        authModal.classList.remove("hidden");
        setTimeout(() => authEmail.focus(), 350);
    }
});

async function startSession(user) {
    if (me && me.uid === user.uid) return;

    const fallbackName = (user.email || "user").split("@")[0];
    const name = (user.displayName || signupName || fallbackName).slice(0, 20);
    signupName = "";

    const userRef = ref(db, `users/${user.uid}`);
    let profile = null;
    try {
        profile = (await get(userRef)).val();
    } catch (err) {
        console.error("Could not read profile:", err);
    }

    me = {
        uid: user.uid,
        email: user.email || "",
        name: profile?.name || name,
        avatar: profile?.avatar || user.photoURL || defaultAvatar(name),
        bio: profile?.bio || DEFAULT_BIO,
        cleared: profile?.cleared || {},
        favorites: profile?.favorites || {},
        archived: profile?.archived || {},
        blocked: profile?.blocked || {},
        starred: profile?.starred || {},
        nicknames: profile?.nicknames || {},
        closeFriends: profile?.closeFriends || {},
        muted: profile?.muted || {},
        reminders: profile?.reminders || {},
        privacy: profile?.privacy || {}
    };

    try {
        await update(userRef, { name: me.name, avatar: me.avatar, bio: me.bio, status: "online" });
        // the server flips me to offline automatically when I close the tab / lose connection
        onDisconnect(ref(db, `users/${me.uid}/status`)).set("offline");
        onDisconnect(ref(db, `users/${me.uid}/lastSeenAt`)).set(serverTimestamp());
    } catch (err) {
        console.error("Could not save profile:", err);
    }

    $("displayUsername").innerText = me.name;
    $("myAvatarImg").src = me.avatar;

    authModal.classList.add("hidden");
    authForm.reset();
    showAuthError("");
    setAuthMode("login");

    loadMessages("global");
    subscribeUsers();
    subscribeGroups();
    subscribeChannels();
    subscribeStatuses();
    subscribeCalls();

    toast(`Welcome, ${me.name}!`, "success", 3000);
    sessionStart = Date.now();
    setTimeout(maybeOfferNotifications, 3500);
}

function endSession() {
    roomUnsubs.forEach((fn) => fn());
    sessionUnsubs.forEach((fn) => fn());
    roomUnsubs = [];
    sessionUnsubs = [];
    cleanupCallUI();
    resetSessionExtras();
    stopTyping();
    replyDraft = null;
    hideReplyBar();
    translations = {};
    typingState = {};
    roomTTL = 0;

    me = null;
    selectedMember = null;
    currentChatRoom = "global";
    usersCache = {};
    groupsCache = {};
    roomCache = {};
    statusCache = {};
    showArchived = false;
    closeStatusViewer();
    $("statusStrip").innerHTML = "";
    pinnedIndex = 0;
    pinnedBar.hidden = true;
    closeMenus();
    groupModal.classList.add("hidden");
    $("typingIndicator").classList.add("hidden");
    $("roomStatus").textContent = "Everyone's lounge";
    $("roomStatus").classList.remove("is-active");
    messageBox.innerHTML = "";
    activeUsersList.innerHTML = "";
    activeUsersList.classList.remove("rendered");
    delete activeUsersList.dataset.animated;
    $("displayUsername").innerText = "Guest";
    currentChatTitle.innerText = "Global Lounge";

    profileModal.classList.add("hidden");
    viewUserModal.classList.add("hidden");
    $("sidebar")?.classList.remove("open");
    $("sidebarBackdrop")?.classList.remove("show");
}

/* =========================================================
   PROFILE
========================================================= */
openMyProfileBtn.addEventListener("click", () => {
    if (!me) return;
    pendingAvatar = null;
    $("profileModalName").innerText = me.name;
    $("profileModalEmail").innerText = me.email;
    profileModalImg.src = me.avatar;
    profileBioInput.value = me.bio;
    profileModal.classList.remove("hidden");
});

closeProfileModalBtn.addEventListener("click", () => profileModal.classList.add("hidden"));

profileImgInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    Swal.fire({
        title: "Uploading Avatar...",
        text: "Please wait...",
        allowOutsideClick: false,
        ...swalTheme,
        didOpen: () => Swal.showLoading()
    });

    const url = await uploadToCloudinary(file);
    Swal.close();
    profileImgInput.value = "";

    if (url) {
        pendingAvatar = url;
        profileModalImg.src = url;
    }
});

saveProfileBtn.addEventListener("click", async () => {
    if (!me) return;
    const newBio = profileBioInput.value.trim();
    if (newBio) me.bio = newBio;
    if (pendingAvatar) me.avatar = pendingAvatar;
    pendingAvatar = null;

    try {
        await update(ref(db, `users/${me.uid}`), { avatar: me.avatar, bio: me.bio });
        $("myAvatarImg").src = me.avatar;
        profileModal.classList.add("hidden");
        toast("Profile Updated!");
    } catch (err) {
        console.error(err);
        alertError("Couldn't save profile", "Please try again.");
    }
});

deleteMyAccountBtn.addEventListener("click", async () => {
    if (!me) return;
    const res = await Swal.fire({
        title: "Delete Account?",
        text: "This permanently deletes your account and profile!",
        icon: "warning",
        showCancelButton: true,
        confirmButtonColor: "#ef4444",
        cancelButtonColor: "#6b7280",
        confirmButtonText: "Yes, Delete My Account",
        background: swalTheme.background,
        color: swalTheme.color
    });
    if (!res.isConfirmed) return;

    const user = auth.currentUser;
    const userRef = ref(db, `users/${me.uid}`);
    const backup = { name: me.name, avatar: me.avatar, bio: me.bio, status: "online" };

    try {
        try { await onDisconnect(ref(db, `users/${me.uid}/status`)).cancel(); await onDisconnect(ref(db, `users/${me.uid}/lastSeenAt`)).cancel(); } catch (_) { /* ignore */ }
        await remove(userRef);          // must happen while we are still signed in
        await deleteUser(user);         // triggers onAuthStateChanged(null)
        profileModal.classList.add("hidden");
    } catch (err) {
        console.error(err);
        try { await set(userRef, backup); } catch (_) { /* ignore */ }
        if (err.code === "auth/requires-recent-login") {
            alertError("Please log in again", "For security, log out, log in again, and then delete your account.");
        } else {
            alertError("Couldn't delete account", err.message || "Please try again.");
        }
    }
});

closeViewUserModalBtn.addEventListener("click", () => viewUserModal.classList.add("hidden"));
startDirectChatBtn.addEventListener("click", () => {
    if (selectedMember) {
        loadMessages(selectedMember.uid, selectedMember.name);
        viewUserModal.classList.add("hidden");
    }
});

/* =========================================================
   ROOMS & MESSAGES
========================================================= */
function highlightActiveRoom() {
    activeUsersList.querySelectorAll("li").forEach((li) => li.classList.toggle("active-dm", li.dataset.room === currentChatRoom));
}

function loadMessages(room, roomName = "") {
    if (!me) return;
    roomUnsubs.forEach((fn) => fn());
    roomUnsubs = [];

    currentChatRoom = room;
    currentRoomName = roomName;
    roomCache = {};
    clearUnread(room);
    stopTyping();
    typingState = {};
    roomTTL = 0;
    translations = {};
    replyDraft = null;
    hideReplyBar();
    pinnedIndex = 0;
    messageBox.innerHTML = "";
    searchInput.value = "";
    $("typingIndicator").classList.add("hidden");
    closeMenus();
    updateRoomHeader();
    updatePinnedBar();
    highlightActiveRoom();
    subscribeRoomExtras(room);

    const roomRef = ref(db, roomPathFor(room));
    roomUnsubs.push(onChildAdded(roomRef, (snap) => renderMessage(snap.key, snap.val())));
    roomUnsubs.push(onChildChanged(roomRef, (snap) => renderMessage(snap.key, snap.val())));
    roomUnsubs.push(
        onChildRemoved(roomRef, (snap) => {
            delete roomCache[snap.key];
            document.getElementById(`msg-${snap.key}`)?.remove();
            updatePinnedBar();
        })
    );
}

function handleSendMessage(customContent = null, type = "text", extra = {}) {
    if (!me) return;
    if (isDMRoom(currentChatRoom) && blockedByMe(currentChatRoom)) {
        toast("You blocked this contact. Unblock to send messages.", "info", 3000);
        return;
    }
    if (isReadOnlyRoom()) {
        toast("Only the channel admin can post here", "info", 2500);
        return;
    }
    const text = customContent ?? messageInput.value.trim();
    if (!text) return;

    const room = currentChatRoom;
    const msg = { uid: me.uid, name: me.name, content: text, type, timestamp: Date.now(), ...extra };
    if (replyDraft) {
        msg.replyTo = { key: replyDraft.key, name: replyDraft.name, preview: replyDraft.preview };
        replyDraft = null;
        hideReplyBar();
    }
    if (roomTTL > 0 && room !== "global") msg.expiresAt = msg.timestamp + roomTTL;
    stopTyping();

    push(ref(db, roomPathFor(room)), msg)
        .then(() => {
            if (customContent === null) messageInput.value = "";
        })
        .catch((err) => {
            console.error(err);
            toast("Message failed to send", "error", 3000);
        });

    // typed text can summon Aura AI (private AI chat, or "@ai ..." in any chat)
    if (type === "text" && customContent === null) maybeAskAI(room, text);
}

sendBtn.addEventListener("click", () => handleSendMessage(null, "text"));
messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) handleSendMessage(null, "text");
});

function addReaction(msgKey, emoji) {
    if (!me) return;
    const base = `${roomPathFor(currentChatRoom)}/${msgKey}/reactions`;
    // tapping the emoji I already reacted with removes my reaction
    if (roomCache[msgKey]?.reactions?.[me.uid] === emoji) remove(ref(db, `${base}/${me.uid}`));
    else update(ref(db, base), { [me.uid]: emoji });
}

const isMine = (d) => (d.uid ? d.uid === me.uid : d.name === me.name);

/* hidden for me = "deleted for me" or older than my last "clear chat" */
function isVisibleToMe(d) {
    if (!d || !me) return false;
    if (d.deletedFor && d.deletedFor[me.uid]) return false;
    const clearedAt = me.cleared?.[roomKeyFor(currentChatRoom)] || 0;
    // messages a blocked contact sent AFTER I blocked them stay hidden (private chats only)
    const blockedAt = me.blocked?.[d.uid];
    if (blockedAt && isDMRoom(currentChatRoom) && (d.timestamp || 0) > Number(blockedAt)) return false;
    if (d.expiresAt && d.expiresAt <= Date.now()) return false;   // disappearing message
    return (d.timestamp || 0) > clearedAt;
}

function previewOf(d) {
    if (d.viewOnce) return "📷 View-once photo";
    switch (d.type) {
        case "location": return "📍 Location";
        case "game": return `🎮 ${GAME_NAMES[d.game] || "Game"} invite`;
        case "image": return "📷 Photo";
        case "video": return "🎥 Video";
        case "audio": return "🎤 Voice note";
        case "poll": return `📊 ${d.poll?.question || d.content || "Poll"}`;
        default: return String(d.content ?? "").replace(" (edited)", "");
    }
}

function pollHtml(d) {
    const poll = d.poll || {};
    const options = poll.options || {};
    const votes = d.votes || {};
    const total = Object.keys(votes).length;
    const mine = votes[me.uid];
    const counts = {};
    Object.values(votes).forEach((v) => { counts[v] = (counts[v] || 0) + 1; });

    const rows = Object.entries(options).map(([id, label]) => {
        const c = counts[id] || 0;
        const pct = total ? Math.round((c / total) * 100) : 0;
        const picked = mine === id;
        return `
            <button type="button" class="poll-option${picked ? " voted" : ""}" data-opt="${esc(id)}">
                <span class="poll-fill" style="width:${pct}%"></span>
                <span class="poll-row">
                    <span class="poll-label">${picked ? '<i class="fa-solid fa-circle-check"></i>' : ""}${esc(label)}</span>
                    <span class="poll-pct">${c} · ${pct}%</span>
                </span>
            </button>`;
    }).join("");

    return `
        <div class="poll-card">
            <div class="poll-title"><i class="fa-solid fa-square-poll-vertical"></i><span>${esc(poll.question || d.content)}</span></div>
            <div class="poll-sub">Tap an option to vote · tap again to undo</div>
            <div class="poll-options">${rows}</div>
            <div class="poll-foot">${total} vote${total === 1 ? "" : "s"}</div>
        </div>`;
}

function renderMessage(key, data) {
    if (!me || !data) return;
    roomCache[key] = data;

    const existing = document.getElementById(`msg-${key}`);
    if (!isVisibleToMe(data)) {
        existing?.remove();
        updatePinnedBar();
        return;
    }

    const isSelf = isMine(data);
    const isAI = data.uid === AI_UID;
    const isDeleted = !!data.deleted;
    const isSystem = data.type === "system" || data.type === "call-log";
    const starred = !!me.starred?.[starKey(key)];

    // only follow the conversation if the reader is already at the bottom
    const nearBottom = messageBox.scrollHeight - messageBox.scrollTop - messageBox.clientHeight < 140;

    let div = existing;
    const isNew = !div;
    if (isNew) {
        div = document.createElement("div");
        div.className = `message-item ${isSelf ? "self" : "other"}`;
        div.id = `msg-${key}`;
        messageBox.appendChild(div);
    }
    div.classList.toggle("is-pinned", !!data.pinned && !isDeleted);
    div.classList.toggle("is-deleted", isDeleted);
    div.classList.toggle("is-ai", isAI);

    const formattedTime = new Date(data.timestamp || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const content = esc(data.content);

    let bodyContent;
    if (isDeleted) {
        bodyContent = `<span class="msg-deleted"><i class="fa-solid fa-ban"></i> ${isSelf ? "You deleted this message" : `${esc(data.name)} deleted this message`}</span>`;
    } else if (data.type === "poll") bodyContent = pollHtml(data);
    else if (data.type === "image" && data.viewOnce) bodyContent = viewOnceHtml(data, isSelf);
    else if (data.type === "game") bodyContent = `<div class="game-invite"><i class="fa-solid fa-gamepad"></i><span><b>${esc(GAME_NAMES[data.game] || "Game")}</b><small>${isSelf ? "You sent an invite" : `${esc(dispName(data.uid, data.name))} challenged you`}</small></span><button type="button" class="game-join">${isSelf ? "Open" : "Play"}</button></div>`;
    else if (data.type === "location") bodyContent = locationHtml(data);
    else if (data.type === "image") bodyContent = `<img src="${content}" alt="Attachment">`;
    else if (data.type === "video") bodyContent = `<video src="${content}" controls></video>`;
    else if (data.type === "audio") bodyContent = `<audio src="${content}" controls></audio>`;
    else if (isSystem) bodyContent = `<div style="font-style: italic; color: #b4707a;">${content}</div>`;
    else bodyContent = `<span class="msg-text${isEmojiOnly(data.content) ? " emoji-only" : ""}">${content.replace(/\n/g, "<br>")}</span>`;

    let reactionsHtml = "";
    if (data.reactions && !isDeleted) {
        const tally = {};
        Object.values(data.reactions).forEach((e) => { tally[e] = (tally[e] || 0) + 1; });
        const mineEmoji = data.reactions[me.uid];
        reactionsHtml = Object.entries(tally)
            .map(([e, n]) => `<span class="reaction-pill${mineEmoji === e ? " mine" : ""}">${esc(e)}${n > 1 ? ` <small>${n}</small>` : ""}</span>`)
            .join("");
    }

    const quoteHtml = data.replyTo && !isDeleted
        ? `<div class="reply-quote" role="button" data-key="${esc(data.replyTo.key)}"><b>${esc(data.replyTo.name)}</b><span>${esc(data.replyTo.preview)}</span></div>`
        : "";
    const fwdHtml = data.forwarded && !isDeleted ? `<div class="fwd-label"><i class="fa-solid fa-share"></i> Forwarded</div>` : "";
    const tr = translations[key];
    const transHtml = tr && !isDeleted
        ? `<div class="msg-translation"><i class="fa-solid fa-language"></i><b>${esc(tr.lang)}</b><p>${esc(tr.text)}</p></div>`
        : "";

    const canEdit = isSelf && data.type === "text" && !isDeleted;
    const canReply = !isDeleted && !isSystem;
    const canForward = !isDeleted && !data.viewOnce && !isSystem && data.type !== "poll" && data.type !== "game";
    const canStar = !isDeleted && !isSystem;
    const canTranslate = !isDeleted && data.type === "text" && String(data.content || "").trim().length > 0;
    const ib = (cls, icon, tip, on = false) =>
        `<button type="button" class="${cls}${on ? " on" : ""}" title="${tip}" aria-label="${tip}"><i class="${icon}"></i></button>`;

    div.innerHTML = `
        <div class="msg-header">
            <span title="${esc(data.name)}">${esc(isSelf || isAI ? data.name : dispName(data.uid, data.name))}${isAI ? ' <b class="ai-tag">AI</b>' : ""}</span>
            ${data.pinned && !isDeleted ? `<span class="pin-flag"><i class="fa-solid fa-thumbtack"></i> Pinned</span>` : ""}
            ${starred && !isDeleted ? `<span class="star-flag" title="Starred"><i class="fa-solid fa-star"></i></span>` : ""}
            <span>${formattedTime}</span>
        </div>
        <div class="msg-body">
            ${fwdHtml}${quoteHtml}${bodyContent}${transHtml}
            <div class="msg-reactions-bar">${reactionsHtml}</div>
        </div>
        <div class="msg-actions">
            ${canReply ? ib("reply-msg-btn", "fa-solid fa-reply", "Reply") : ""}
            ${canForward ? ib("fwd-msg-btn", "fa-solid fa-share", "Forward") : ""}
            ${canStar ? ib("star-msg-btn", starred ? "fa-solid fa-star" : "fa-regular fa-star", starred ? "Unstar" : "Star", starred) : ""}
            ${canTranslate ? ib("trans-msg-btn", "fa-solid fa-language", tr ? "Hide translation" : "Translate", !!tr) : ""}
            ${canEdit ? ib("edit-msg-btn", "fa-solid fa-pen", "Edit") : ""}
            ${isDeleted ? "" : ib("pin-msg-btn", "fa-solid fa-thumbtack", data.pinned ? "Unpin" : "Pin", !!data.pinned)}
            ${ib("del-msg-btn", "fa-solid fa-trash", "Delete")}
        </div>
        ${isDeleted ? "" : `
        <div class="reaction-picker">
            <span class="react-opt" data-emoji="❤️">❤️</span>
            <span class="react-opt" data-emoji="👍">👍</span>
            <span class="react-opt" data-emoji="🔥">🔥</span>
            <span class="react-opt" data-emoji="😂">😂</span>
            <span class="react-opt" data-emoji="🎉">🎉</span>
            <span class="react-more" title="More emojis" role="button"><i class="fa-solid fa-plus"></i></span>
        </div>`}
    `;

    div.querySelector(".react-more")?.addEventListener("click", () => openEmojiSheet({ mode: "react", key }));
    div.querySelectorAll(".react-opt").forEach((opt) => {
        opt.addEventListener("click", () => addReaction(key, opt.getAttribute("data-emoji")));
    });
    div.querySelectorAll(".poll-option").forEach((btn) => {
        btn.addEventListener("click", () => votePoll(key, btn.dataset.opt));
    });
    div.querySelector(".reply-quote")?.addEventListener("click", (e) => jumpToMessage(e.currentTarget.dataset.key));
    div.querySelector(".view-once-btn")?.addEventListener("click", () => openViewOnce(key));
    div.querySelector(".loc-show")?.addEventListener("click", (e) => showLocMap(e.currentTarget));
    div.querySelector(".game-join")?.addEventListener("click", () => openMultiplayer(data.content));
    div.querySelector(".reply-msg-btn")?.addEventListener("click", () => startReply(key));
    div.querySelector(".fwd-msg-btn")?.addEventListener("click", () => forwardMessage(key));
    div.querySelector(".star-msg-btn")?.addEventListener("click", () => toggleStar(key));
    div.querySelector(".trans-msg-btn")?.addEventListener("click", () => translateMessage(key));
    div.querySelector(".pin-msg-btn")?.addEventListener("click", () => togglePin(key));
    div.querySelector(".edit-msg-btn")?.addEventListener("click", () => editMessage(key));
    div.querySelector(".del-msg-btn")?.addEventListener("click", () => deleteMessage(key));

    if (isNew && (nearBottom || isSelf)) {
        messageBox.scrollTop = messageBox.scrollHeight;
        div.querySelectorAll("img").forEach((img) =>
            img.addEventListener("load", () => { messageBox.scrollTop = messageBox.scrollHeight; }, { once: true })
        );
    }
    updatePinnedBar();
}

// Search messages
searchInput.addEventListener("input", (e) => {
    const term = e.target.value.toLowerCase();
    messageBox.querySelectorAll(".message-item").forEach((item) => {
        item.style.display = item.innerText.toLowerCase().includes(term) ? "flex" : "none";
    });
});

/* =========================================================
   MEDIA, VOICE, EMOJI
========================================================= */
const mediaInput = $("mediaInput");
const mediaAccept = mediaInput.accept || "image/*,video/*";

mediaInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    const once = viewOncePending;
    viewOncePending = false;
    mediaInput.accept = mediaAccept;
    if (!file) return;
    const fileType = file.type.startsWith("image") ? "image" : "video";
    if (once && fileType !== "image") {
        mediaInput.value = "";
        return toast("View-once works with photos only", "info", 2500);
    }

    Swal.fire({
        title: `Uploading ${fileType}...`,
        text: "Please wait while the file uploads...",
        allowOutsideClick: false,
        ...swalTheme,
        didOpen: () => Swal.showLoading()
    });

    const url = await uploadToCloudinary(file);
    Swal.close();
    mediaInput.value = "";
    if (url) handleSendMessage(url, fileType, once ? { viewOnce: true } : {});
});

const voiceBtn = $("voiceRecordBtn");
voiceBtn.addEventListener("click", async () => {
    if (!me) return;

    if (!isRecording) {
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
            return alertError("Microphone blocked", "Please allow microphone access to record voice notes.");
        }

        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
        mediaRecorder.onstop = async () => {
            stream.getTracks().forEach((t) => t.stop());
            const audioBlob = new Blob(audioChunks, { type: "audio/webm" });

            Swal.fire({
                title: "Uploading Voice Note...",
                text: "Please wait...",
                allowOutsideClick: false,
                ...swalTheme,
                didOpen: () => Swal.showLoading()
            });

            const url = await uploadToCloudinary(audioBlob);
            Swal.close();
            if (url) handleSendMessage(url, "audio");
        };

        mediaRecorder.start();
        isRecording = true;
        voiceBtn.style.color = "#ef4444";
    } else {
        mediaRecorder.stop();
        isRecording = false;
        voiceBtn.style.color = "#fff";
    }
});

/* ---------- Emoji sheet (all emojis: typing, send-as-message, reactions) ---------- */
const emojiToggleBtn = $("emojiToggleBtn");
const emojiSheet = $("emojiSheet");
const emojiPickerEl = $("emojiPickerEl");
let emojiMode = { mode: "insert" };   // { mode: "insert" } | { mode: "react", key }

function openEmojiSheet(mode) {
    if (!me) return;
    if (!customElements.get("emoji-picker")) {
        toast("Emoji picker couldn't load. Check your internet connection.", "error", 3500);
        return;
    }
    emojiMode = mode;
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    emojiPickerEl.classList.toggle("dark", dark);
    emojiPickerEl.classList.toggle("light", !dark);
    $("emojiSendWrap").hidden = mode.mode !== "insert";
    closeMenus();
    emojiSheet.classList.remove("hidden");
}

function closeEmojiSheet() {
    emojiSheet.classList.add("hidden");
}

function insertAtCursor(text) {
    const start = messageInput.selectionStart ?? messageInput.value.length;
    const end = messageInput.selectionEnd ?? messageInput.value.length;
    messageInput.value = messageInput.value.slice(0, start) + text + messageInput.value.slice(end);
    const pos = start + text.length;
    messageInput.setSelectionRange(pos, pos);
}

emojiToggleBtn.addEventListener("click", () => openEmojiSheet({ mode: "insert" }));
$("closeEmojiSheet").addEventListener("click", closeEmojiSheet);
emojiSheet.addEventListener("click", (e) => { if (e.target === emojiSheet) closeEmojiSheet(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeEmojiSheet(); });

emojiPickerEl.addEventListener("emoji-click", (e) => {
    const emoji = e.detail?.unicode;
    if (!emoji || !me) return;
    if (emojiMode.mode === "react") {
        addReaction(emojiMode.key, emoji);
        closeEmojiSheet();
    } else if ($("emojiSendToggle").checked) {
        handleSendMessage(emoji, "text");          // send the emoji as its own message
    } else {
        insertAtCursor(emoji);                      // add it to what I'm typing
        messageInput.focus();
    }
});

// a message made only of emojis is shown big (like WhatsApp)
const isEmojiOnly = (s) => {
    const t = String(s ?? "").trim();
    return !!t && t.length <= 24 && /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️⃣\s]+$/u.test(t);
};

/* =========================================================
   ACTIVE MEMBERS
========================================================= */
/* =========================================================
   MESSAGE TOOLS: reply · forward · star · translate · export
========================================================= */
const TTL_OPTIONS = { 0: "Off", 60000: "1 minute", 3600000: "1 hour", 86400000: "24 hours", 604800000: "7 days" };
const ttlLabel = (ms) => TTL_OPTIONS[ms] || `${Math.max(1, Math.round(ms / 60000))} min`;
const starKey = (key) => `${roomKeyFor(currentChatRoom)}__${key}`;
const expiryTried = new Set();

/* a small list picker used by Forward and Starred (rows are pre-escaped HTML) */
function pickIndex(title, rows, cancelText = "Cancel") {
    return new Promise((resolve) => {
        Swal.fire({
            titleText: title,
            html: `<ul class="pick-list">${rows.map((r, i) => `<li><button type="button" data-i="${i}">${r}</button></li>`).join("")}</ul>`,
            showConfirmButton: false,
            showCancelButton: true,
            cancelButtonText: cancelText,
            ...swalTheme,
            didOpen: () => {
                document.querySelector(".pick-list")?.addEventListener("click", (e) => {
                    const b = e.target.closest("button[data-i]");
                    if (!b) return;
                    resolve(Number(b.dataset.i));
                    Swal.close();
                });
            }
        }).then(() => resolve(-1));
    });
}

function jumpToMessage(key) {
    const el = key && document.getElementById(`msg-${key}`);
    if (!el) return toast("That message isn't in this chat anymore", "info", 2500);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
}

/* ---------- reply (quote) ---------- */
function startReply(key) {
    if (isReadOnlyRoom()) return toast("Only the channel admin can post here", "info", 2200);
    const d = roomCache[key];
    if (!d || d.deleted || d.type === "system" || d.type === "call-log") return;
    replyDraft = { key, name: String(d.name || "User"), preview: previewOf(d).slice(0, 80) };
    $("replyName").textContent = isMine(d) ? "yourself" : replyDraft.name;
    $("replyText").textContent = replyDraft.preview;
    $("replyBar").classList.remove("hidden");
    messageInput.focus();
}
function hideReplyBar() {
    $("replyBar")?.classList.add("hidden");
}
$("replyCancel").addEventListener("click", () => { replyDraft = null; hideReplyBar(); });

/* ---------- forward ---------- */
async function forwardMessage(key) {
    const d = roomCache[key];
    if (!me || !d || d.deleted || d.viewOnce || ["poll", "system", "call-log"].includes(d.type)) {
        return toast("This message can't be forwarded", "info", 2500);
    }
    const choices = [{ room: "global", name: "Global Lounge", icon: "fa-earth-americas" }];
    Object.entries(groupsCache).forEach(([gid, g]) => choices.push({ room: `group:${gid}`, name: g.name || "Group", icon: "fa-user-group" }));
    Object.entries(usersCache)
        .filter(([uid, u]) => uid !== me.uid && u.name && !blockedByMe(uid))
        .forEach(([uid, u]) => choices.push({ room: uid, name: dispName(uid, u.name), icon: "fa-user" }));

    const idx = await pickIndex("Forward to…", choices.map((c) => `<i class="fa-solid ${c.icon}"></i> <span>${esc(c.name)}</span>`));
    if (idx < 0) return;
    const dest = choices[idx];
    try {
        await push(ref(db, roomPathFor(dest.room)), {
            uid: me.uid,
            name: me.name,
            content: String(d.content).replace(" (edited)", ""),
            type: d.type,
            forwarded: true,
            timestamp: Date.now()
        });
        toast(`Forwarded to ${dest.name}`, "success", 2200);
    } catch (err) {
        console.error(err);
        toast("Couldn't forward the message", "error", 3000);
    }
}

/* ---------- starred messages (personal bookmarks) ---------- */
function toggleStar(key) {
    const d = roomCache[key];
    if (!me || !d || d.deleted) return;
    const k = starKey(key);
    const on = !me.starred?.[k];
    const r = ref(db, `users/${me.uid}/starred/${k}`);
    me.starred = { ...(me.starred || {}) };
    if (on) {
        me.starred[k] = {
            room: currentChatRoom, key, name: String(d.name || "User"),
            preview: previewOf(d).slice(0, 120), ts: d.timestamp || Date.now(), title: currentChatTitle.innerText
        };
    } else {
        delete me.starred[k];
    }
    renderMessage(key, d);
    (on ? set(r, me.starred[k]) : remove(r)).catch((err) => { console.error(err); toast("Couldn't save the star", "error", 3000); });
    toast(on ? "Message starred" : "Star removed", "success", 1500);
}

async function openStarredList() {
    const items = Object.values(me?.starred || {}).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (!items.length) {
        return Swal.fire({ icon: "info", title: "No starred messages", text: "Tap the ☆ on a message to keep it here.", ...swalTheme });
    }
    const idx = await pickIndex(
        "Starred messages",
        items.map((s) => `<b>${esc(s.name)}</b> <small>${esc(s.title || "")}</small><span class="pick-sub">${esc(s.preview)}</span>`),
        "Close"
    );
    if (idx < 0) return;
    const s = items[idx];
    if (currentChatRoom !== s.room) loadMessages(s.room, usersCache[s.room]?.name || "");
    let tries = 0;
    const t = setInterval(() => {
        if (document.getElementById(`msg-${s.key}`) || ++tries > 25) { clearInterval(t); jumpToMessage(s.key); }
    }, 120);
}

/* ---------- translate (uses the Aura AI service) ---------- */
const TRANSLATE_LANGS = {
    "Urdu": "Urdu (اردو)", "Roman Urdu": "Roman Urdu", "English": "English", "Hindi": "Hindi",
    "Arabic": "Arabic", "Spanish": "Spanish", "French": "French", "German": "German", "Turkish": "Turkish"
};

async function aiTranslate(text, lang) {
    if (!AI_CONFIG.endpoint) throw new Error("no AI endpoint");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), AI_CONFIG.timeoutMs);
    try {
        const headers = { "Content-Type": "application/json" };
        if (AI_CONFIG.apiKey) headers.Authorization = `Bearer ${AI_CONFIG.apiKey}`;
        const res = await fetch(AI_CONFIG.endpoint, {
            method: "POST",
            headers,
            signal: ctrl.signal,
            body: JSON.stringify({
                model: AI_CONFIG.model,
                messages: [
                    { role: "system", content: `Translate the user's message into ${lang}. Reply with ONLY the translation — no notes, no quotes.` },
                    { role: "user", content: text }
                ]
            })
        });
        if (!res.ok) throw new Error(`AI service returned ${res.status}`);
        const out = (await res.json())?.choices?.[0]?.message?.content;
        if (typeof out !== "string" || !out.trim()) throw new Error("empty translation");
        return out.trim().slice(0, 1500);
    } finally {
        clearTimeout(timer);
    }
}

async function translateMessage(key) {
    const d = roomCache[key];
    if (!d || d.deleted || d.type !== "text") return;
    if (translations[key]) { delete translations[key]; return renderMessage(key, d); } // tap again = hide

    let saved = "Urdu";
    try { saved = localStorage.getItem("aura-trans-lang") || "Urdu"; } catch (_) { /* ignore */ }
    const res = await Swal.fire({
        title: "Translate to…",
        input: "select",
        inputOptions: TRANSLATE_LANGS,
        inputValue: saved,
        showCancelButton: true,
        confirmButtonText: "Translate",
        ...swalTheme
    });
    if (!res.isConfirmed || !res.value) return;
    const lang = res.value;
    try { localStorage.setItem("aura-trans-lang", lang); } catch (_) { /* ignore */ }

    translations[key] = { lang, text: "Translating…" };
    renderMessage(key, d);
    try {
        translations[key] = { lang, text: await aiTranslate(String(d.content).replace(" (edited)", ""), lang) };
    } catch (err) {
        console.warn("Translate failed:", err);
        delete translations[key];
        toast("Translation needs the online AI service, which couldn't be reached.", "error", 3500);
    }
    if (roomCache[key]) renderMessage(key, roomCache[key]);
}

/* ---------- export chat to a .txt file ---------- */
function exportChat() {
    const rows = Object.values(roomCache)
        .filter((d) => isVisibleToMe(d))
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    if (!rows.length) return toast("Nothing to export yet", "info", 2500);

    const body = rows.map((d) => {
        let c;
        if (d.deleted) c = "[message deleted]";
        else if (d.type === "poll") c = `[Poll] ${d.poll?.question || d.content} — ${Object.values(d.poll?.options || {}).join(" / ")}`;
        else if (d.viewOnce) c = "[View-once photo]";
        else if (d.type === "image") c = `[Photo] ${d.content}`;
        else if (d.type === "location") c = `[Location] ${d.content}`;
        else if (d.type === "game") c = `[Game invite] ${GAME_NAMES[d.game] || "Game"}`;
        else if (d.type === "video") c = `[Video] ${d.content}`;
        else if (d.type === "audio") c = `[Voice note] ${d.content}`;
        else c = String(d.content ?? "");
        const quote = d.replyTo && !d.deleted ? ` (replying to ${d.replyTo.name}: “${d.replyTo.preview}”)` : "";
        return `[${new Date(d.timestamp || 0).toLocaleString()}] ${d.name}: ${d.forwarded ? "(forwarded) " : ""}${c}${quote}`;
    }).join("\n");

    const title = currentChatTitle.innerText;
    const text = `AuraChat — ${title}\nExported by ${me.name} on ${new Date().toLocaleString()}\n\n${body}\n`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    a.download = `aurachat-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "chat"}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast("Chat exported", "success", 1800);
}

/* =========================================================
   DISAPPEARING MESSAGES
========================================================= */
async function openDisappearingDialog() {
    if (!me || currentChatRoom === "global") return;
    const res = await Swal.fire({
        title: "Disappearing messages",
        text: "New messages in this chat vanish after the time you choose.",
        input: "radio",
        inputOptions: TTL_OPTIONS,
        inputValue: String(roomTTL),
        showCancelButton: true,
        confirmButtonText: "Save",
        ...swalTheme
    });
    if (!res.isConfirmed || res.value === undefined || res.value === null) return;
    const ttl = Number(res.value) || 0;
    if (ttl === roomTTL) return;
    try {
        await set(ref(db, `chatSettings/${roomKeyFor(currentChatRoom)}`), { ttl, by: me.uid, byName: me.name, at: Date.now() });
        await push(ref(db, roomPathFor(currentChatRoom)), {
            uid: me.uid, name: me.name, type: "system", timestamp: Date.now(),
            content: ttl ? `⏳ ${me.name} turned on disappearing messages: ${ttlLabel(ttl)}` : `⏳ ${me.name} turned off disappearing messages`
        });
    } catch (err) {
        console.error(err);
        toast("Couldn't change the timer. Check Firebase rules.", "error", 3500);
    }
}

// hide expired messages everywhere; the sender's own device also deletes them for good
setInterval(() => {
    if (!me) return;
    const now = Date.now();
    Object.entries(roomCache).forEach(([k, d]) => {
        if (!d || !d.expiresAt || d.expiresAt > now) return;
        if ((isMine(d) || (currentChatRoom === "ai" && d.uid === AI_UID)) && !expiryTried.has(k)) {
            expiryTried.add(k);
            remove(ref(db, `${roomPathFor(currentChatRoom)}/${k}`)).catch(() => {});
        }
        // gone from my screen and cache (the DB copy is removed by the sender's device)
        delete roomCache[k];
        document.getElementById(`msg-${k}`)?.remove();
        updatePinnedBar();
    });
    updateTypingIndicator();
}, 2000);

/* =========================================================
   TYPING INDICATOR
========================================================= */
let typingRoom = null;
let aiThinkingRoom = null;

function stopTyping() {
    clearTimeout(typingTimer);
    typingTimer = null;
    if (me && typingRoom) remove(ref(db, `typing/${roomKeyFor(typingRoom)}/${me.uid}`)).catch(() => {});
    typingRoom = null;
    lastTypingWrite = 0;
}

messageInput.addEventListener("input", () => {
    if (!me || currentChatRoom === "ai" || !messageInput.value.trim()) { stopTyping(); return; }
    const now = Date.now();
    if (!typingRoom || now - lastTypingWrite > 2500) {
        typingRoom = currentChatRoom;
        lastTypingWrite = now;
        const r = ref(db, `typing/${roomKeyFor(currentChatRoom)}/${me.uid}`);
        set(r, { name: me.name, ts: now }).catch(() => {});
        onDisconnect(r).remove().catch(() => {});
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, 3500);
});

function updateTypingIndicator() {
    if (!me) return;
    const now = Date.now();
    const names = Object.entries(typingState)
        .filter(([uid, t]) => now - (t.ts || 0) < 7000 && !blockedEitherWay(uid))
        .map(([uid, t]) => dispName(uid, t.name || "Someone"));

    let text = "";
    if (aiPending > 0 && aiThinkingRoom === currentChatRoom) text = `${AI_NAME} is thinking…`;
    else if (names.length === 1) text = `${names[0]} is typing…`;
    else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing…`;
    else if (names.length > 2) text = "Several people are typing…";

    $("typingText").textContent = text || "Typing...";
    $("typingIndicator").classList.toggle("hidden", !text);
}

/* per-chat live data: disappearing timer + who is typing */
function subscribeRoomExtras(room) {
    const key = roomKeyFor(room);
    roomUnsubs.push(onValue(ref(db, `chatSettings/${key}`), (snap) => {
        roomTTL = Number(snap.val()?.ttl) || 0;
        updateRoomHeader();
    }));
    if (room !== "ai") {
        roomUnsubs.push(onValue(ref(db, `typing/${key}`), (snap) => {
            const next = {};
            snap.forEach((c) => { if (c.key !== me?.uid) next[c.key] = c.val() || {}; });
            typingState = next;
            updateTypingIndicator();
        }));
    }
    updateTypingIndicator();
}

/* =========================================================
   VIEW-ONCE PHOTOS
========================================================= */
function viewOnceHtml(d, isSelf) {
    const opened = d.viewedBy?.[me.uid];
    const count = Object.keys(d.viewedBy || {}).length;
    if (isSelf) {
        return `<span class="view-once"><i class="fa-solid fa-eye"></i> View-once photo${count ? ` · opened by ${count}` : ""}</span>`;
    }
    if (opened) return `<span class="view-once done"><i class="fa-regular fa-eye-slash"></i> Photo opened</span>`;
    return `<button type="button" class="view-once view-once-btn"><i class="fa-solid fa-eye"></i> Tap to view photo (once)</button>`;
}

async function openViewOnce(key) {
    const d = roomCache[key];
    if (!me || !d || isMine(d) || d.viewedBy?.[me.uid]) return;
    const url = String(d.content || "");
    if (!/^https:\/\//.test(url)) return;
    try {
        // mark as opened first, so it can never be opened a second time
        await set(ref(db, `${roomPathFor(currentChatRoom)}/${key}/viewedBy/${me.uid}`), Date.now());
    } catch (err) {
        console.error(err);
        return toast("Couldn't open the photo", "error", 3000);
    }
    await Swal.fire({
        title: "View once",
        text: "This photo disappears when you close it.",
        imageUrl: url,
        imageAlt: "View-once photo",
        confirmButtonText: "Close",
        ...swalTheme
    });
}

/* =========================================================
   WIRING
========================================================= */
$("attachViewOnceBtn").addEventListener("click", () => {
    closeMenus();
    viewOncePending = true;
    mediaInput.accept = "image/*";
    mediaInput.click();
});
$("menuStarred").addEventListener("click", () => { closeMenus(); openStarredList(); });
$("menuDisappear").addEventListener("click", () => { closeMenus(); openDisappearingDialog(); });
$("menuExport").addEventListener("click", () => { closeMenus(); exportChat(); });

/* =========================================================
   HEADER STATUS, MENUS, CLEAR CHAT
========================================================= */
const isOnline = (u) => u?.status === "online";

function closeMenus() {
    chatMenu.classList.add("hidden");
    attachMenu.classList.add("hidden");
}

const isDMRoom = (room) => room !== "global" && room !== "ai" && !room.startsWith("group:") && !room.startsWith("channel:");
const blockedByMe = (uid) => !!me?.blocked?.[uid];
const blockedMe = (uid) => !!usersCache[uid]?.blocked?.[me?.uid];
const blockedEitherWay = (uid) => blockedByMe(uid) || blockedMe(uid);
// "Active" is hidden between two people when either has blocked the other
const showActive = (uid, u) => isOnline(u) && !blockedEitherWay(uid) && canSeePresence(uid);

function updateRoomHeader() {
    if (!me) return;
    const room = currentChatRoom;
    const status = $("roomStatus");
    const dm = isDMRoom(room);
    let title = "Global Lounge";
    let text = "Everyone's lounge";
    let active = false;

    if (room === "global") {
        const n = Object.entries(usersCache).filter(([uid, u]) => isOnline(u) && (uid === me.uid || canSeePresence(uid))).length;
        text = n ? `${n} active now` : "Everyone's lounge";
    } else if (room === "ai") {
        title = `${AI_NAME} ✨`;
        text = "Your private AI assistant — ask me anything";
    } else if (isChannelRoom(room)) {
        const c = channelsCache[room.slice(8)];
        title = `${c?.icon || "📢"} ${c?.name || "Channel"}`;
        const n = followerCount(c);
        text = `${n} follower${n === 1 ? "" : "s"}${isChannelAdmin(room) ? " · you're the admin" : ""}`;
    } else if (room.startsWith("group:")) {
        const g = groupsCache[room.slice(6)];
        const members = Object.keys(g?.members || {});
        const n = members.filter((uid) => isOnline(usersCache[uid]) && (uid === me.uid || canSeePresence(uid))).length;
        title = g?.name || "Group";
        text = `${members.length} member${members.length === 1 ? "" : "s"} · ${n} active`;
    } else {
        const u = usersCache[room];
        title = `Private Chat with ${dispName(room, u?.name || currentRoomName || "User")}`;
        active = showActive(room, u);
        text = blockedByMe(room) ? "Blocked" : active ? "Active now" : lastSeenText(room, u) || "Private chat";
    }

    if (roomTTL && room !== "global") text += ` · ⏳ ${ttlLabel(roomTTL)}`;
    currentChatTitle.innerText = title;
    status.textContent = text;
    status.classList.toggle("is-active", active);
    $("menuGroupInfo").hidden = !room.startsWith("group:");

    // favourite / archive / block entries of the ⋮ menu
    const fav = !!me.favorites?.[room];
    const arch = !!me.archived?.[room];
    $("menuFav").innerHTML = `<i class="${fav ? "fa-solid" : "fa-regular"} fa-star"></i> ${fav ? "Remove from favourites" : "Add to favourites"}`;
    $("menuArchive").innerHTML = `<i class="fa-solid fa-box-archive"></i> ${arch ? "Unarchive chat" : "Archive chat"}`;
    $("menuChannel").hidden = !isChannelRoom(room);
    $("menuDisappear").hidden = room === "global" || isReadOnlyRoom(room);
    $("menuDisappear").innerHTML = `<i class="fa-solid fa-hourglass-half"></i> Disappearing messages${roomTTL ? ` · ${ttlLabel(roomTTL)}` : ""}`;
    $("menuClose").hidden = !dm;
    $("menuNick").hidden = !dm;
    $("menuMute").hidden = room === "ai";
    const isCf = !!me.closeFriends?.[room];
    $("menuClose").innerHTML = `<i class="${isCf ? "fa-solid" : "fa-regular"} fa-heart"></i> ${isCf ? "Remove from Close Friends" : "Add to Close Friends"}`;
    $("menuNick").innerHTML = `<i class="fa-solid fa-signature"></i> ${me.nicknames?.[room] ? "Edit nickname" : "Set nickname"}`;
    const isMuted = !!me.muted?.[room];
    $("menuMute").innerHTML = `<i class="fa-solid ${isMuted ? "fa-bell" : "fa-bell-slash"}"></i> ${isMuted ? "Unmute notifications" : "Mute notifications"}`;
    $("menuBlock").hidden = !dm;
    $("menuBlock").innerHTML = `<i class="fa-solid fa-ban"></i> ${blockedByMe(room) ? "Unblock" : "Block"}`;

    // composer is locked while the open private chat is blocked by me
    const readOnly = isReadOnlyRoom(room);
    const locked = (dm && blockedByMe(room)) || readOnly;
    [messageInput, sendBtn, $("attachBtn"), $("voiceRecordBtn"), $("emojiToggleBtn")].forEach((el) => { el.disabled = locked; });
    messageInput.placeholder = locked
        ? `You blocked ${usersCache[room]?.name || currentRoomName || "this contact"}. Unblock to send messages.`
        : "Type a message...";
    if (readOnly) messageInput.placeholder = "Only the channel admin can post here";
}

$("chatMenuBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    attachMenu.classList.add("hidden");
    chatMenu.classList.toggle("hidden");
});
$("attachBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    chatMenu.classList.add("hidden");
    attachMenu.classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
    if (!e.target.closest(".menu-wrap")) chatMenu.classList.add("hidden");
    if (!e.target.closest(".attach-wrap")) attachMenu.classList.add("hidden");
});
$("attachMediaBtn").addEventListener("click", () => { closeMenus(); viewOncePending = false; mediaInput.accept = mediaAccept; mediaInput.click(); });
$("attachPollBtn").addEventListener("click", () => { closeMenus(); openPollDialog(); });
$("menuClearChat").addEventListener("click", () => { closeMenus(); clearChat(); });
$("menuGroupInfo").addEventListener("click", () => { closeMenus(); openGroupInfo(); });

/* "Clear chat" hides everything older than now — for ME only, others keep their messages */
async function clearChat() {
    if (!me) return;
    const res = await Swal.fire({
        title: "Clear this chat?",
        text: "All current messages will disappear from your screen. Other people still keep their copy.",
        icon: "warning",
        showCancelButton: true,
        ...swalTheme,
        confirmButtonColor: "#ef4444",
        confirmButtonText: "Clear chat"
    });
    if (!res.isConfirmed) return;

    const key = roomKeyFor(currentChatRoom);
    const ts = Date.now();
    try {
        await set(ref(db, `users/${me.uid}/cleared/${key}`), ts);
        me.cleared = { ...(me.cleared || {}), [key]: ts };
        loadMessages(currentChatRoom, currentRoomName);
        toast("Chat cleared");
    } catch (err) {
        console.error(err);
        toast("Couldn't clear chat. Check Firebase rules.", "error", 3500);
    }
}

/* =========================================================
   PINNED MESSAGES (banner at the top of the chat)
========================================================= */
function pinnedList() {
    return Object.entries(roomCache)
        .filter(([, d]) => d && d.pinned && !d.deleted && isVisibleToMe(d))
        .sort((a, b) => (b[1].pinnedAt || 0) - (a[1].pinnedAt || 0));
}

function updatePinnedBar() {
    const list = pinnedList();
    if (!list.length) {
        pinnedBar.hidden = true;
        delete pinnedBar.dataset.key;
        return;
    }
    if (pinnedIndex >= list.length) pinnedIndex = 0;
    const [key, d] = list[pinnedIndex];
    pinnedBar.hidden = false;
    pinnedBar.dataset.key = key;
    $("pinnedCount").textContent = list.length > 1 ? `${pinnedIndex + 1} of ${list.length}` : "";
    $("pinnedAuthor").textContent = `${d.name || "User"}:`;
    $("pinnedText").textContent = previewOf(d);
}

function togglePin(key) {
    if (!me) return;
    if (isReadOnlyRoom()) return toast("Only the channel admin can pin", "info", 2200);
    const data = roomCache[key];
    if (!data || data.deleted) return;
    const r = ref(db, `${roomPathFor(currentChatRoom)}/${key}`);
    const job = data.pinned
        ? update(r, { pinned: null, pinnedAt: null, pinnedBy: null, pinnedByName: null })
        : update(r, { pinned: true, pinnedAt: Date.now(), pinnedBy: me.uid, pinnedByName: me.name });
    job.then(() => toast(data.pinned ? "Message unpinned" : "Message pinned", "success", 1800))
        .catch((err) => { console.error(err); toast("Couldn't update pin", "error", 3000); });
}

$("pinnedMain").addEventListener("click", () => {
    const key = pinnedBar.dataset.key;
    const el = key && document.getElementById(`msg-${key}`);
    if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.remove("flash");
        void el.offsetWidth;
        el.classList.add("flash");
    }
    const list = pinnedList();
    if (list.length > 1) {
        pinnedIndex = (pinnedIndex + 1) % list.length;
        updatePinnedBar();
    }
});
$("pinnedUnpin").addEventListener("click", () => {
    if (pinnedBar.dataset.key) togglePin(pinnedBar.dataset.key);
});

/* =========================================================
   EDIT / DELETE (for me, for everyone)
========================================================= */
async function editMessage(key) {
    const data = roomCache[key];
    if (!data || data.deleted) return;
    const { value } = await Swal.fire({
        title: "Edit Message",
        input: "text",
        inputValue: String(data.content).replace(" (edited)", ""),
        ...swalTheme,
        showCancelButton: true
    });
    if (value && value.trim()) {
        update(ref(db, `${roomPathFor(currentChatRoom)}/${key}`), { content: value.trim() + " (edited)" });
    }
}

async function deleteMessage(key) {
    const data = roomCache[key];
    if (!me || !data) return;
    const canEveryone = isMine(data) && !data.deleted;

    const opts = {
        title: "Delete message?",
        text: canEveryone ? "Choose how you want to delete it." : "This removes it only from your chat.",
        icon: "warning",
        showCancelButton: true,
        cancelButtonText: "Cancel",
        ...swalTheme,
        confirmButtonColor: "#ef4444",
        confirmButtonText: canEveryone ? "Delete for everyone" : "Delete for me"
    };
    if (canEveryone) {
        opts.showDenyButton = true;
        opts.denyButtonText = "Delete for me";
        opts.denyButtonColor = "#b4707a";
    }
    const res = await Swal.fire(opts);

    const r = ref(db, `${roomPathFor(currentChatRoom)}/${key}`);
    try {
        if (res.isConfirmed && canEveryone) {
            await update(r, {
                deleted: true, deletedAt: Date.now(), deletedBy: me.uid,
                content: "", poll: null, votes: null, reactions: null,
                pinned: null, pinnedAt: null, pinnedBy: null, pinnedByName: null
            });
        } else if (res.isConfirmed || res.isDenied) {
            await update(r, { [`deletedFor/${me.uid}`]: true });
        }
    } catch (err) {
        console.error(err);
        toast("Couldn't delete message", "error", 3000);
    }
}

/* =========================================================
   POLLS
========================================================= */
function votePoll(key, optId) {
    const data = roomCache[key];
    if (!me || !data || data.deleted) return;
    const r = ref(db, `${roomPathFor(currentChatRoom)}/${key}/votes/${me.uid}`);
    const job = data.votes?.[me.uid] === optId ? remove(r) : set(r, optId);
    job.catch((err) => { console.error(err); toast("Vote failed", "error", 3000); });
}

async function openPollDialog() {
    if (!me) return;
    const MAX = 6;
    const res = await Swal.fire({
        title: "Create a poll",
        html: `
            <input id="pollQ" class="swal2-input" maxlength="120" placeholder="Ask a question">
            <div id="pollOpts">
                <input class="swal2-input poll-opt-in" maxlength="60" placeholder="Option 1">
                <input class="swal2-input poll-opt-in" maxlength="60" placeholder="Option 2">
            </div>
            <button type="button" id="pollAddOpt" class="poll-add-btn"><i class="fa-solid fa-plus"></i> Add option</button>`,
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: "Send poll",
        ...swalTheme,
        didOpen: () => {
            const addBtn = document.getElementById("pollAddOpt");
            addBtn.addEventListener("click", () => {
                const wrap = document.getElementById("pollOpts");
                const n = wrap.querySelectorAll(".poll-opt-in").length;
                if (n >= MAX) return;
                const inp = document.createElement("input");
                inp.className = "swal2-input poll-opt-in";
                inp.maxLength = 60;
                inp.placeholder = `Option ${n + 1}`;
                wrap.appendChild(inp);
                inp.focus();
                if (n + 1 >= MAX) addBtn.style.display = "none";
            });
            document.getElementById("pollQ").focus();
        },
        preConfirm: () => {
            const question = document.getElementById("pollQ").value.trim();
            const seen = new Set();
            const options = [];
            document.querySelectorAll("#pollOpts .poll-opt-in").forEach((i) => {
                const v = i.value.trim();
                if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); options.push(v); }
            });
            if (!question) return Swal.showValidationMessage("Please type a question");
            if (options.length < 2) return Swal.showValidationMessage("Add at least 2 different options");
            return { question, options };
        }
    });
    if (!res.isConfirmed || !res.value) return;

    const options = {};
    res.value.options.forEach((label, i) => { options[`o${i}`] = label; });
    push(ref(db, roomPathFor(currentChatRoom)), {
        uid: me.uid,
        name: me.name,
        type: "poll",
        content: res.value.question,
        poll: { question: res.value.question, options },
        timestamp: Date.now()
    }).catch((err) => { console.error(err); toast("Couldn't create poll", "error", 3000); });
}

/* =========================================================
   GROUPS
========================================================= */
function subscribeGroups() {
    const unsub = onValue(ref(db, "groups"), (snap) => {
        if (!me) return;
        const next = {};
        snap.forEach((child) => {
            const g = child.val();
            if (g && g.members && g.members[me.uid]) next[child.key] = g;
        });
        const prev = groupsCache;
        groupsCache = next;

        if (currentChatRoom.startsWith("group:")) {
            const gid = currentChatRoom.slice(6);
            if (prev[gid] && !next[gid]) {
                toast("You're no longer in that group", "info", 3000);
                loadMessages("global");
            }
        }
        renderSidebar();
        updateRoomHeader();
    });
    sessionUnsubs.push(unsub);
}

function openGroupModal() {
    if (!me) return;
    groupPick = new Set();
    groupNameInput.value = "";
    renderGroupPicker();
    groupModal.classList.remove("hidden");
    setTimeout(() => groupNameInput.focus(), 200);
}
function closeGroupModal() { groupModal.classList.add("hidden"); }

function renderGroupPicker() {
    groupPicker.innerHTML = "";
    const people = Object.entries(usersCache)
        .filter(([uid, u]) => uid !== me.uid && u.name)
        .sort((a, b) => (isOnline(b[1]) - isOnline(a[1])) || String(a[1].name).localeCompare(String(b[1].name)));

    if (!people.length) {
        const empty = document.createElement("li");
        empty.className = "group-empty";
        empty.textContent = "No other members have joined yet.";
        groupPicker.appendChild(empty);
    }
    people.forEach(([uid, u]) => {
        const li = document.createElement("li");
        li.classList.toggle("selected", groupPick.has(uid));
        const img = document.createElement("img");
        img.className = "member-list-img";
        img.alt = "";
        img.src = avatarFor(uid, u);
        const name = document.createElement("span");
        name.textContent = u.name;
        const check = document.createElement("span");
        check.className = "pick-check";
        check.innerHTML = '<i class="fa-solid fa-check"></i>';
        li.append(img, name, check);
        li.addEventListener("click", () => {
            if (groupPick.has(uid)) groupPick.delete(uid); else groupPick.add(uid);
            li.classList.toggle("selected", groupPick.has(uid));
            $("groupPickCount").textContent = `${groupPick.size} selected`;
        });
        groupPicker.appendChild(li);
    });
    $("groupPickCount").textContent = `${groupPick.size} selected`;
}

async function createGroup() {
    if (!me) return;
    const name = groupNameInput.value.trim();
    if (name.length < 2) return toast("Give your group a name (2+ characters)", "warning", 3000);
    if (!groupPick.size) return toast("Pick at least one member", "warning", 3000);

    const btn = $("createGroupBtn");
    btn.disabled = true;
    try {
        const members = { [me.uid]: true };
        groupPick.forEach((uid) => { members[uid] = true; });
        const gRef = push(ref(db, "groups"));
        await set(gRef, { name, createdBy: me.uid, createdAt: Date.now(), members });
        await push(ref(db, `messages/group_${gRef.key}`), {
            uid: me.uid, name: me.name, type: "system",
            content: `👥 ${me.name} created the group “${name}”`, timestamp: Date.now()
        });
        closeGroupModal();
        loadMessages(`group:${gRef.key}`);
        toast("Group created!");
    } catch (err) {
        console.error(err);
        alertError("Couldn't create group", "Please check your Firebase rules allow the 'groups' node.");
    } finally {
        btn.disabled = false;
    }
}

async function openGroupInfo() {
    if (!me || !currentChatRoom.startsWith("group:")) return;
    const gid = currentChatRoom.slice(6);
    const g = groupsCache[gid];
    if (!g) return;

    const rows = Object.keys(g.members || {}).map((uid) => {
        const u = usersCache[uid] || {};
        const nm = uid === me.uid ? "You" : (u.name || "User");
        return `<li><img src="${esc(uid === me.uid ? me.avatar : avatarFor(uid, u))}" alt=""><span>${esc(nm)}${uid === g.createdBy ? "<em>ADMIN</em>" : ""}</span>${isOnline(u) && (uid === me.uid || canSeePresence(uid)) ? '<b class="active-tag">Active</b>' : ""}</li>`;
    }).join("");

    const isAdmin = g.createdBy === me.uid;
    const res = await Swal.fire({
        titleText: g.name,
        html: `<ul class="group-info-list">${rows}</ul>`,
        showCancelButton: true,
        cancelButtonText: "Close",
        confirmButtonText: "Leave group",
        showDenyButton: isAdmin,
        denyButtonText: "Delete group",
        ...swalTheme,
        confirmButtonColor: "#ef4444",
        denyButtonColor: "#b3454f"
    });
    if (res.isConfirmed) leaveGroup(gid);
    else if (res.isDenied) deleteGroup(gid);
}

async function leaveGroup(gid) {
    const g = groupsCache[gid];
    if (!me || !g) return;
    try {
        await push(ref(db, `messages/group_${gid}`), {
            uid: me.uid, name: me.name, type: "system", content: `🚪 ${me.name} left the group`, timestamp: Date.now()
        });
        const others = Object.keys(g.members || {}).filter((u) => u !== me.uid);
        loadMessages("global");
        await remove(ref(db, `groups/${gid}/members/${me.uid}`));
        if (!others.length) {
            await remove(ref(db, `groups/${gid}`));
            await remove(ref(db, `messages/group_${gid}`));
        }
        toast("You left the group");
    } catch (err) {
        console.error(err);
        toast("Couldn't leave the group", "error", 3000);
    }
}

async function deleteGroup(gid) {
    try {
        loadMessages("global");
        await remove(ref(db, `groups/${gid}`));
        await remove(ref(db, `messages/group_${gid}`));
        toast("Group deleted");
    } catch (err) {
        console.error(err);
        toast("Couldn't delete the group", "error", 3000);
    }
}

$("newGroupBtn").addEventListener("click", openGroupModal);
$("closeGroupModalBtn").addEventListener("click", closeGroupModal);
$("createGroupBtn").addEventListener("click", createGroup);
groupNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") createGroup(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeGroupModal(); closeMenus(); } });

/* =========================================================
   AURA AI  (mini assistant — private chat, or "@ai ..." anywhere)
========================================================= */
function maybeAskAI(room, text) {
    if (room === "ai") return askAI(room, text);
    const m = /^@(ai|aura)\b[\s,:-]*/i.exec(text);
    if (m) askAI(room, text.slice(m[0].length).trim());
}

function setAiThinking(room, on) {
    aiPending = Math.max(0, aiPending + (on ? 1 : -1));
    if (on) aiThinkingRoom = room;
    updateTypingIndicator();
}

function aiHistory(room, prompt) {
    if (room !== "ai" || currentChatRoom !== "ai") return [{ role: "user", content: prompt }];
    const turns = Object.values(roomCache)
        .filter((d) => d && !d.deleted && d.type === "text" && isVisibleToMe(d))
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
        .slice(-10)
        .map((d) => ({ role: d.uid === AI_UID ? "assistant" : "user", content: String(d.content).replace(" (edited)", "") }));
    const last = turns[turns.length - 1];
    if (!last || last.role !== "user" || last.content !== prompt) turns.push({ role: "user", content: prompt });
    return turns;
}

async function fetchAIReply(room, prompt) {
    if (!AI_CONFIG.endpoint) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), AI_CONFIG.timeoutMs);
    try {
        const headers = { "Content-Type": "application/json" };
        if (AI_CONFIG.apiKey) headers.Authorization = `Bearer ${AI_CONFIG.apiKey}`;
        const res = await fetch(AI_CONFIG.endpoint, {
            method: "POST",
            headers,
            signal: ctrl.signal,
            body: JSON.stringify({
                model: AI_CONFIG.model,
                messages: [{ role: "system", content: AI_CONFIG.system }, ...aiHistory(room, prompt)]
            })
        });
        if (!res.ok) throw new Error(`AI service returned ${res.status}`);
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
        return typeof text === "string" && text.trim() ? text.trim().slice(0, 1500) : null;
    } finally {
        clearTimeout(timer);
    }
}

async function askAI(room, prompt) {
    if (!me) return;
    const path = roomPathFor(room);
    setAiThinking(room, true);
    let reply = null;
    try {
        reply = await fetchAIReply(room, prompt);
    } catch (err) {
        console.warn("Aura AI online service unavailable, using offline brain:", err);
    }
    if (!reply) reply = localAI(prompt);
    setAiThinking(room, false);
    if (!me) return;
    push(ref(db, path), {
        uid: AI_UID, name: AI_NAME, type: "text", content: reply, isAI: true, timestamp: Date.now(),
        ...(roomTTL > 0 && room === currentChatRoom && room !== "global" ? { expiresAt: Date.now() + roomTTL } : {})
    }).catch((err) => { console.error(err); toast("Aura AI couldn't reply", "error", 3000); });
}

/* tiny arithmetic parser (no eval) */
function calc(expr) {
    const s = expr.replace(/[x×]/gi, "*").replace(/÷/g, "/").replace(/\s+/g, "");
    let i = 0;
    const peek = () => s[i];
    const number = () => {
        const m = /^\d*\.?\d+/.exec(s.slice(i));
        if (!m) throw new Error("num");
        i += m[0].length;
        return parseFloat(m[0]);
    };
    const factor = () => {
        if (peek() === "-") { i++; return -factor(); }
        if (peek() === "+") { i++; return factor(); }
        if (peek() === "(") {
            i++;
            const v = sum();
            if (peek() !== ")") throw new Error("paren");
            i++;
            return v;
        }
        return number();
    };
    const power = () => { let v = factor(); while (peek() === "^") { i++; v = Math.pow(v, factor()); } return v; };
    const term = () => {
        let v = power();
        while (peek() === "*" || peek() === "/" || peek() === "%") {
            const op = s[i++];
            const r = power();
            v = op === "*" ? v * r : op === "/" ? v / r : v % r;
        }
        return v;
    };
    const sum = () => {
        let v = term();
        while (peek() === "+" || peek() === "-") {
            const op = s[i++];
            const r = term();
            v = op === "+" ? v + r : v - r;
        }
        return v;
    };
    const out = sum();
    if (i !== s.length || !Number.isFinite(out)) throw new Error("bad");
    return out;
}

const AI_JOKES = [
    "Teacher: Tum late kyun ho? Student: Sir, sign board par likha tha 'School ahead, go slow'! 😄",
    "WiFi aur meri kismat mein ek cheez common hai — jab sabse zyada zaroorat hoti hai tab disconnect ho jate hain. 😅",
    "Computer ne doctor se kaha: mujhe virus ho gaya hai. Doctor: Ghabrao mat, restart karo aur araam karo! 💻",
    "Aaj maine diet shuru ki... phir kal ke liye hold kar di. 🍕"
];

function localAI(q) {
    const t = String(q || "").trim();
    const l = t.toLowerCase();
    if (!t) return "Haan, boliye! Main kya madad kar sakta hoon? 😊";

    const expr = l.replace(/(calculate|calc|kitna hai|kya hai|equals?|=|\?)/g, "").trim();
    if (/^[\d\s+\-*/().%^x×÷]+$/.test(expr) && /\d/.test(expr) && /[+\-*/%^x×÷]/.test(expr)) {
        try { return `${expr} = ${Math.round(calc(expr) * 1e8) / 1e8}`; } catch (_) { /* fall through */ }
    }
    if (/^(hi|hello|hey|salam|assalam|aoa|hola)\b/.test(l)) return `Assalam o Alaikum! 👋 Main ${AI_NAME} hoon. Mujhse kuch bhi poochiye.`;
    if (/\b(time|waqt|samay)\b/.test(l)) return `Abhi ka waqt ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} hai. 🕒`;
    if (/\b(date|tareekh|tarikh|today|aaj)\b/.test(l)) return `Aaj ki tareekh: ${new Date().toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" })} 📅`;
    if (/\b(joke|mazaq|hasao|latifa)\b/.test(l)) return AI_JOKES[Math.floor(Math.random() * AI_JOKES.length)];
    if (/\b(thanks|thank you|shukriya|shukria)\b/.test(l)) return "Koi baat nahi! 😊 Aur kuch poochna ho to batayein.";
    if (/\b(who are you|tum kon|aap kon|name)\b/.test(l)) return `Main ${AI_NAME} hoon — AuraChat ka mini AI assistant. ✨`;
    if (/\b(help|madad|kya kar sakte)\b/.test(l)) return "Main waqt/tareekh bata sakta hoon, hisaab kar sakta hoon (jaise 12*(3+4)), jokes suna sakta hoon, aur online AI se jude hone par har sawal ka jawab de sakta hoon.";
    return "Abhi main AI server se connect nahi ho pa raha, isliye sirf basic sawalon ke jawab de sakta hoon (waqt, tareekh, hisaab, jokes). Thori der baad dobara try karein. 🙏";
}

/* =========================================================
   ACTIVE MEMBERS / SIDEBAR
========================================================= */
function subscribeUsers() {
    const unsub = onValue(ref(db, "users"), (snapshot) => {
        if (!me) return;
        const next = {};
        snapshot.forEach((child) => { next[child.key] = child.val() || {}; });
        usersCache = next;
        const mine = next[me.uid];
        let nickChanged = false;
        if (mine) {
            nickChanged = JSON.stringify(me.nicknames || {}) !== JSON.stringify(mine.nicknames || {});
            me.favorites = mine.favorites || {};
            me.archived = mine.archived || {};
            me.blocked = mine.blocked || {};
            me.starred = mine.starred || {};
            me.nicknames = mine.nicknames || {};
            me.closeFriends = mine.closeFriends || {};
            me.muted = mine.muted || {};
            me.reminders = mine.reminders || {};
            me.privacy = mine.privacy || {};
        }
        renderSidebar();
        renderStatusStrip();
        updateRoomHeader();
        if (nickChanged) refreshNames();
        if (!reminderModal.classList.contains("hidden")) renderReminders();
        checkReminders();
        if (!groupModal.classList.contains("hidden")) renderGroupPicker();
    });
    sessionUnsubs.push(unsub);
}

function renderSidebar() {
    if (!me) return;
    syncNotifyWatchers();
    activeUsersList.innerHTML = "";
    const fav = me.favorites || {};
    const cf = me.closeFriends || {};
    const muted = me.muted || {};
    const arch = me.archived || {};

    const label = (text) => {
        const li = document.createElement("li");
        li.className = "list-label";
        li.textContent = text;
        activeUsersList.appendChild(li);
        return li;
    };
    const starHtml = (room) => (fav[room] ? '<i class="fa-solid fa-star fav-star" title="Favourite"></i>' : "");

    const roomItem = (room, icon, name, tagHtml = "") => {
        const li = document.createElement("li");
        li.dataset.room = room;
        li.innerHTML = `<i class="fa-solid ${icon}"></i> <span></span>${starHtml(room)}${muted[room] ? '<i class="fa-solid fa-bell-slash mute-mark" title="Muted"></i>' : ""}${tagHtml}${unreadHtml(room)}`;
        li.querySelector("span").textContent = name;
        li.addEventListener("click", () => loadMessages(room));
        return li;
    };

    const personItem = (uid, u) => {
        const realName = u.name || "User";
        const name = dispName(uid, realName);
        const avatarUrl = avatarFor(uid, u);
        const online = showActive(uid, u);

        const li = document.createElement("li");
        li.dataset.room = uid;

        const wrap = document.createElement("span");
        wrap.className = "avatar-wrap";
        const img = document.createElement("img");
        img.src = avatarUrl;
        img.alt = "";
        img.className = "member-list-img";
        wrap.appendChild(img);
        if (online) {
            const dot = document.createElement("i");
            dot.className = "presence-dot";
            wrap.appendChild(dot);
        }

        const nameSpan = document.createElement("span");
        nameSpan.textContent = name;
        li.append(wrap, nameSpan);
        if (nameSpan && me.nicknames?.[uid]) li.title = realName;
        if (cf[uid]) li.insertAdjacentHTML("beforeend", '<i class="fa-solid fa-heart cf-heart" title="Close friend"></i>');
        if (fav[uid]) li.insertAdjacentHTML("beforeend", '<i class="fa-solid fa-star fav-star" title="Favourite"></i>');
        if (muted[uid]) li.insertAdjacentHTML("beforeend", '<i class="fa-solid fa-bell-slash mute-mark" title="Muted"></i>');

        if (blockedByMe(uid)) {
            const tag = document.createElement("b");
            tag.className = "blocked-tag";
            tag.textContent = "Blocked";
            li.appendChild(tag);
        } else if (online) {
            const tag = document.createElement("b");
            tag.className = "active-tag";
            tag.textContent = "Active";
            li.appendChild(tag);
        }

        if (unread[uid]) li.insertAdjacentHTML("beforeend", unreadHtml(uid));

        li.addEventListener("click", () => {
            selectedMember = { uid, name: realName };
            fillViewUser(uid);
            viewUserModal.classList.remove("hidden");
        });
        return li;
    };

    const people = Object.entries(usersCache)
        .filter(([uid, u]) => uid !== me.uid && u.name)
        .sort((a, b) => (showActive(b[0], b[1]) - showActive(a[0], a[1])) || String(a[1].name).localeCompare(String(b[1].name)));
    const groups = Object.entries(groupsCache).sort((a, b) => String(a[1].name).localeCompare(String(b[1].name)));

    const channels = Object.entries(channelsCache)
        .filter(([, c]) => c.followers?.[me.uid])
        .sort((a, b) => String(a[1].name).localeCompare(String(b[1].name)));

    const entries = [
        { room: "global", section: "chats", build: () => roomItem("global", "fa-earth-americas", "Global Lounge") },
        { room: "ai", section: "chats", build: () => roomItem("ai", "fa-wand-magic-sparkles", AI_NAME, '<b class="ai-tag">AI</b>') },
        ...groups.map(([gid, g]) => ({ room: `group:${gid}`, section: "groups", build: () => roomItem(`group:${gid}`, "fa-user-group", g.name || "Group") })),
        ...channels.map(([cid, c]) => ({
            room: `channel:${cid}`, section: "channels",
            build: () => roomItem(`channel:${cid}`, "fa-bullhorn", c.name || "Channel", `<small class="ch-count">${followerCount(c)}</small>`)
        })),
        ...people.map(([uid, u]) => ({ room: uid, section: "members", build: () => personItem(uid, u) }))
    ];

    const plain = (e) => !cf[e.room] && !fav[e.room] && !arch[e.room];
    const sections = [
        ["Close Friends", (e) => cf[e.room] && !arch[e.room]],
        ["Favourites", (e) => fav[e.room] && !cf[e.room] && !arch[e.room]],
        ["Chats", (e) => e.section === "chats" && plain(e)],
        ["Groups", (e) => e.section === "groups" && plain(e)],
        ["Channels", (e) => e.section === "channels" && plain(e)],
        ["Members", (e) => e.section === "members" && plain(e)]
    ];
    sections.forEach(([title, test]) => {
        const list = entries.filter(test);
        if (!list.length) return;
        label(title);
        list.forEach((e) => activeUsersList.appendChild(e.build()));
    });

    if (!people.length) {
        const empty = document.createElement("li");
        empty.className = "sidebar-empty";
        empty.textContent = "No one else has joined yet.";
        activeUsersList.appendChild(empty);
    }

    const archived = entries.filter((e) => arch[e.room]);
    if (archived.length) {
        const toggle = label(`Archived (${archived.length})`);
        toggle.classList.add("archive-toggle");
        toggle.insertAdjacentHTML("beforeend", ` <i class="fa-solid fa-chevron-${showArchived ? "up" : "down"}"></i>`);
        toggle.addEventListener("click", (ev) => {
            ev.stopPropagation(); // keep the mobile drawer open
            showArchived = !showArchived;
            renderSidebar();
        });
        if (showArchived) archived.forEach((e) => activeUsersList.appendChild(e.build()));
    }

    if (!activeUsersList.dataset.animated) {
        activeUsersList.dataset.animated = "1";
        setTimeout(() => activeUsersList.classList.add("rendered"), 900);
    }
    highlightActiveRoom();
}

/* =========================================================
   FAVOURITES · ARCHIVE · BLOCK
========================================================= */
async function setPref(kind, id, on) {
    if (!me) return;
    const next = { ...(me[kind] || {}) };
    if (on) next[id] = kind === "blocked" ? Date.now() : true; else delete next[id];
    me[kind] = next; // optimistic, the users listener will confirm
    renderSidebar();
    updateRoomHeader();
    renderStatusStrip();
    try {
        const r = ref(db, `users/${me.uid}/${kind}/${id}`);
        if (on) await set(r, next[id]); else await remove(r);
    } catch (err) {
        console.error(err);
        toast("Couldn't save that change. Check Firebase rules.", "error", 3500);
    }
}

function toggleFavorite(id) {
    const on = !me.favorites?.[id];
    setPref("favorites", id, on);
    toast(on ? "Added to favourites" : "Removed from favourites", "success", 1800);
}

function toggleArchive(id) {
    const on = !me.archived?.[id];
    setPref("archived", id, on);
    toast(on ? "Chat archived" : "Chat unarchived", "success", 1800);
}

async function toggleBlock(uid, name) {
    if (!me || !uid) return;
    const on = !blockedByMe(uid);
    if (on) {
        const res = await Swal.fire({
            title: `Block ${name || "this contact"}?`,
            text: "They won't reach you in private chat, and you won't see each other's Active status or statuses. They won't be told.",
            icon: "warning",
            showCancelButton: true,
            ...swalTheme,
            confirmButtonColor: "#ef4444",
            confirmButtonText: "Block"
        });
        if (!res.isConfirmed) return;
    }
    await setPref("blocked", uid, on);
    if (currentChatRoom === uid) loadMessages(uid, name || currentRoomName);
    toast(on ? `${name || "Contact"} blocked` : `${name || "Contact"} unblocked`, "success", 2000);
}

function refreshViewUserButtons() {
    if (!selectedMember) return;
    const { uid } = selectedMember;
    $("viewFavBtn").innerHTML = me.favorites?.[uid]
        ? '<i class="fa-solid fa-star"></i> Remove from favourites'
        : '<i class="fa-regular fa-star"></i> Add to favourites';
    $("viewBlockBtn").innerHTML = blockedByMe(uid)
        ? '<i class="fa-solid fa-unlock"></i> Unblock'
        : '<i class="fa-solid fa-ban"></i> Block';
    const cf = !!me.closeFriends?.[uid];
    $("viewCloseBtn").innerHTML = `<i class="${cf ? "fa-solid" : "fa-regular"} fa-heart"></i> ${cf ? "Remove from Close Friends" : "Add to Close Friends"}`;
    $("viewNickBtn").innerHTML = `<i class="fa-solid fa-signature"></i> ${me.nicknames?.[uid] ? "Edit nickname" : "Set nickname"}`;
}

$("viewFavBtn").addEventListener("click", () => {
    if (!selectedMember) return;
    toggleFavorite(selectedMember.uid);
    refreshViewUserButtons();
});
$("viewBlockBtn").addEventListener("click", async () => {
    if (!selectedMember) return;
    await toggleBlock(selectedMember.uid, selectedMember.name);
    refreshViewUserButtons();
});
$("menuFav").addEventListener("click", () => { closeMenus(); toggleFavorite(currentChatRoom); });
$("menuArchive").addEventListener("click", () => { closeMenus(); toggleArchive(currentChatRoom); });
$("menuBlock").addEventListener("click", () => {
    closeMenus();
    toggleBlock(currentChatRoom, usersCache[currentChatRoom]?.name || currentRoomName);
});

/* =========================================================
   STATUS (24-hour stories, with "seen by")
========================================================= */
const DAY_MS = 24 * 60 * 60 * 1000;
const STATUS_SECONDS = 5;
const STATUS_BG = [
    "linear-gradient(135deg,#d9a0a0,#b4707a)",
    "linear-gradient(135deg,#f6c6bf,#e3a1a8)",
    "linear-gradient(135deg,#7f5a83,#0d324d)",
    "linear-gradient(135deg,#43cea2,#185a9d)",
    "linear-gradient(135deg,#f7971e,#d4a017)"
];

function activeStatuses(uid) {
    const cutoff = Date.now() - DAY_MS;
    return Object.entries(statusCache[uid] || {})
        .filter(([, s]) => s && s.timestamp > cutoff && (s.type === "text" || s.type === "image"))
        .map(([id, s]) => ({ id, ...s }))
        .sort((a, b) => a.timestamp - b.timestamp);
}

function timeAgo(ts) {
    const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (m < 1) return "Just now";
    if (m < 60) return `${m}m ago`;
    return `${Math.floor(m / 60)}h ago`;
}

function subscribeStatuses() {
    let cleaned = false;
    const unsub = onValue(ref(db, "statuses"), (snap) => {
        if (!me) return;
        const next = {};
        snap.forEach((child) => { next[child.key] = child.val() || {}; });
        statusCache = next;

        if (!cleaned) { // drop my own expired statuses once per session
            cleaned = true;
            const cutoff = Date.now() - DAY_MS;
            Object.entries(next[me.uid] || {}).forEach(([id, s]) => {
                if (s && s.timestamp <= cutoff) remove(ref(db, `statuses/${me.uid}/${id}`)).catch(() => {});
            });
        }
        renderStatusStrip();
        if (sv) updateViewerViews();
    });
    sessionUnsubs.push(unsub);
}

function statusBubble({ name, avatar, state, own, onOpen, onAdd }) {
    const b = document.createElement("div");
    b.className = "status-bubble";
    b.setAttribute("role", "button");
    b.tabIndex = 0;

    const ring = document.createElement("span");
    ring.className = `status-ring ${state}`;
    const img = document.createElement("img");
    img.src = avatar;
    img.alt = "";
    ring.appendChild(img);
    if (own) {
        const add = document.createElement("button");
        add.type = "button";
        add.className = "status-add";
        add.title = "Add status";
        add.setAttribute("aria-label", "Add status");
        add.innerHTML = '<i class="fa-solid fa-plus"></i>';
        add.addEventListener("click", (e) => { e.stopPropagation(); onAdd(); });
        ring.appendChild(add);
    }

    const text = document.createElement("span");
    text.className = "sb-name";
    text.textContent = name;
    b.append(ring, text);
    b.addEventListener("click", onOpen);
    b.addEventListener("keydown", (e) => { if (e.key === "Enter") onOpen(); });
    return b;
}

function renderStatusStrip() {
    const strip = $("statusStrip");
    if (!strip || !me) return;
    strip.innerHTML = "";

    const mine = activeStatuses(me.uid);
    strip.appendChild(statusBubble({
        name: "My status",
        avatar: me.avatar,
        state: mine.length ? "seen" : "empty",
        own: true,
        onOpen: () => (mine.length ? openStatusViewer([me.uid]) : openStatusComposer()),
        onAdd: openStatusComposer
    }));

    const others = Object.keys(statusCache)
        .filter((uid) => uid !== me.uid && usersCache[uid]?.name && !blockedEitherWay(uid) && canSee(uid, "status"))
        .map((uid) => {
            const list = activeStatuses(uid);
            return { uid, list, unseen: list.some((s) => !s.views?.[me.uid]), last: list.length ? list[list.length - 1].timestamp : 0 };
        })
        .filter((o) => o.list.length)
        .sort((a, b) => (b.unseen - a.unseen) || (b.last - a.last));

    others.forEach((o, i) => {
        const u = usersCache[o.uid];
        strip.appendChild(statusBubble({
            name: u.name,
            avatar: avatarFor(o.uid, u),
            state: o.unseen ? "unseen" : "seen",
            own: false,
            onOpen: () => openStatusViewer(others.slice(i).map((x) => x.uid))
        }));
    });
}

async function openStatusComposer() {
    if (!me) return;
    let bg = 0;
    let caption = "";
    const res = await Swal.fire({
        title: "New status",
        html: `
            <textarea id="stText" class="swal2-textarea" maxlength="200" placeholder="Type a status… (or add a caption for a photo)"></textarea>
            <div class="st-swatches" id="stSwatches">
                ${STATUS_BG.map((g, i) => `<button type="button" class="st-swatch${i === 0 ? " active" : ""}" data-i="${i}" style="background:${g}" aria-label="Colour ${i + 1}"></button>`).join("")}
            </div>`,
        showCancelButton: true,
        showDenyButton: true,
        confirmButtonText: "Post text",
        denyButtonText: "📷 Photo",
        ...swalTheme,
        denyButtonColor: "#8f4f5c",
        didOpen: () => {
            const ta = document.getElementById("stText");
            ta.addEventListener("input", () => { caption = ta.value.trim(); });
            document.getElementById("stSwatches").addEventListener("click", (e) => {
                const b = e.target.closest(".st-swatch");
                if (!b) return;
                bg = Number(b.dataset.i) || 0;
                document.querySelectorAll(".st-swatch").forEach((x) => x.classList.toggle("active", x === b));
            });
            ta.focus();
        },
        preConfirm: () => {
            const t = document.getElementById("stText").value.trim();
            if (!t) return Swal.showValidationMessage("Type something first");
            return t;
        }
    });

    if (res.isConfirmed && res.value) {
        postStatus({ type: "text", content: res.value, bg });
    } else if (res.isDenied) {
        pendingStatusCaption = caption;
        $("statusFileInput").click();
    }
}

$("statusFileInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || !me) return;
    if (!file.type.startsWith("image/")) return alertError("Photos only", "Please choose an image for your status.");

    Swal.fire({ title: "Uploading status...", text: "Please wait...", allowOutsideClick: false, ...swalTheme, didOpen: () => Swal.showLoading() });
    const url = await uploadToCloudinary(file);
    Swal.close();
    if (url) postStatus({ type: "image", content: url, caption: pendingStatusCaption });
    pendingStatusCaption = "";
});

function postStatus({ type, content, bg, caption }) {
    if (!me) return;
    const data = { type, content, timestamp: Date.now() };
    if (type === "text") data.bg = bg || 0;
    if (caption) data.caption = caption;
    push(ref(db, `statuses/${me.uid}`), data)
        .then(() => toast("Status posted — visible for 24 hours", "success", 2500))
        .catch((err) => { console.error(err); toast("Couldn't post status. Check Firebase rules.", "error", 3500); });
}

/* ---------- full-screen viewer ---------- */
function openStatusViewer(queue) {
    if (!me || !queue.length) return;
    sv = { queue, qi: 0, list: [], si: 0, timer: null };
    $("statusViewer").classList.remove("hidden");
    loadViewerUser();
}

function closeStatusViewer() {
    if (sv) clearTimeout(sv.timer);
    sv = null;
    $("statusViewer").classList.add("hidden");
    $("svStage").innerHTML = "";
}

function loadViewerUser() {
    if (!sv) return;
    sv.list = activeStatuses(sv.queue[sv.qi]);
    if (!sv.list.length) return nextViewerUser();
    const own = sv.queue[sv.qi] === me.uid;
    const firstUnseen = sv.list.findIndex((s) => !s.views?.[me.uid]);
    sv.si = own || firstUnseen < 0 ? 0 : firstUnseen;
    showStatus();
}

function nextViewerUser() {
    if (!sv) return;
    sv.qi += 1;
    if (sv.qi < sv.queue.length) loadViewerUser(); else closeStatusViewer();
}

function nextStatus() {
    if (!sv) return;
    if (sv.si + 1 < sv.list.length) { sv.si += 1; showStatus(); } else nextViewerUser();
}

function prevStatus() {
    if (!sv) return;
    if (sv.si > 0) sv.si -= 1;
    showStatus();
}

function showStatus() {
    if (!sv || !me) return;
    clearTimeout(sv.timer);
    const uid = sv.queue[sv.qi];
    const s = sv.list[sv.si];
    if (!s) return closeStatusViewer();
    const own = uid === me.uid;
    const u = own ? me : (usersCache[uid] || {});

    $("svAvatar").src = own ? me.avatar : avatarFor(uid, u);
    $("svName").textContent = own ? "My status" : (u.name || "User");
    $("svTime").textContent = timeAgo(s.timestamp);
    $("svBars").innerHTML = sv.list
        .map((_, i) => `<span class="${i < sv.si ? "done" : i === sv.si ? "active" : ""}"><i></i></span>`)
        .join("");

    if (s.type === "image") {
        $("svStage").innerHTML = `<div class="sv-image"><img src="${esc(s.content)}" alt="Status photo">${s.caption ? `<p class="sv-caption">${esc(s.caption)}</p>` : ""}</div>`;
    } else {
        const bgCss = STATUS_BG[Number(s.bg) || 0] || STATUS_BG[0];
        $("svStage").innerHTML = `<div class="sv-text" style="background:${bgCss}"><p>${esc(s.content).replace(/\n/g, "<br>")}</p></div>`;
    }

    $("svViewsBtn").hidden = !own;
    $("svDeleteBtn").hidden = !own;
    updateViewerViews();

    if (!own && !s.views?.[me.uid]) {
        set(ref(db, `statuses/${uid}/${s.id}/views/${me.uid}`), Date.now()).catch((err) => console.warn("Couldn't mark status as seen:", err));
    }
    sv.timer = setTimeout(nextStatus, STATUS_SECONDS * 1000);
}

function updateViewerViews() {
    if (!sv) return;
    const s = activeStatuses(sv.queue[sv.qi]).find((x) => sv.list[sv.si] && x.id === sv.list[sv.si].id);
    if (s) $("svViews").textContent = Object.keys(s.views || {}).length;
}

async function showStatusViews() {
    if (!sv) return;
    clearTimeout(sv.timer);
    const s = sv.list[sv.si];
    const live = (statusCache[me.uid] || {})[s.id] || s;
    const rows = Object.entries(live.views || {})
        .sort((a, b) => b[1] - a[1])
        .map(([uid, ts]) => {
            const u = usersCache[uid] || {};
            const nm = u.name || "User";
            return `<li><img src="${esc(avatarFor(uid, u))}" alt=""><span>${esc(nm)}</span><b class="sv-seen-time">${esc(timeAgo(ts))}</b></li>`;
        }).join("");
    await Swal.fire({
        titleText: `Seen by ${Object.keys(live.views || {}).length}`,
        html: rows ? `<ul class="group-info-list">${rows}</ul>` : "<p>No one has viewed this yet.</p>",
        confirmButtonText: "Close",
        ...swalTheme
    });
    if (sv) showStatus();
}

async function deleteCurrentStatus() {
    if (!sv) return;
    clearTimeout(sv.timer);
    const s = sv.list[sv.si];
    const res = await Swal.fire({
        title: "Delete this status?",
        text: "It will be removed for everyone.",
        icon: "warning",
        showCancelButton: true,
        ...swalTheme,
        confirmButtonColor: "#ef4444",
        confirmButtonText: "Delete"
    });
    if (!sv) return;
    if (!res.isConfirmed) return showStatus();
    try {
        await remove(ref(db, `statuses/${me.uid}/${s.id}`));
        sv.list.splice(sv.si, 1);
        if (!sv.list.length) return closeStatusViewer();
        sv.si = Math.min(sv.si, sv.list.length - 1);
        showStatus();
    } catch (err) {
        console.error(err);
        toast("Couldn't delete status", "error", 3000);
        showStatus();
    }
}

$("svClose").addEventListener("click", closeStatusViewer);
$("svNext").addEventListener("click", nextStatus);
$("svPrev").addEventListener("click", prevStatus);
$("svViewsBtn").addEventListener("click", showStatusViews);
$("svDeleteBtn").addEventListener("click", deleteCurrentStatus);
$("statusViewer").addEventListener("click", (e) => { if (e.target.id === "statusViewer") closeStatusViewer(); });
document.addEventListener("keydown", (e) => {
    if (!sv || Swal.isVisible()) return;
    if (e.key === "Escape") closeStatusViewer();
    else if (e.key === "ArrowRight") nextStatus();
    else if (e.key === "ArrowLeft") prevStatus();
});

/* =========================================================
   TOASTS · SOUND · NOTIFICATIONS · UNREAD
========================================================= */
const lsRead = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
const lsWrite = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } };

const prefs = {
    notif: lsRead("aura-notif") === "1",
    sound: lsRead("aura-sound") !== "0",
    tone: lsRead("aura-tone") || "chime"
};
let unread = {};                 // roomId -> unread count
let sessionStart = 0;
const notifyWatch = {};          // roomId -> unsubscribe fn
const notified = new Set();
const firedAt = {};              // reminderId -> the `at` that already rang

/* small stack of in-page toasts (Swal is a singleton, so it would close open dialogs) */
function pushToast({ title, sub = "", img = "", icon = "fa-comment", cls = "", onClick = null, actions = [], ms = 5500 }) {
    let stack = document.getElementById("toastStack");
    if (!stack) {
        stack = document.createElement("div");
        stack.id = "toastStack";
        document.body.appendChild(stack);
    }
    while (stack.children.length >= 4) stack.firstElementChild.remove();

    const el = document.createElement("div");
    el.className = `msg-toast ${cls}`.trim();
    el.setAttribute("role", "status");

    const lead = img ? Object.assign(document.createElement("img"), { src: img, alt: "" }) : document.createElement("i");
    if (!img) lead.className = `fa-solid ${icon}`;
    const text = document.createElement("span");
    text.className = "mt-text";
    const b = document.createElement("b");
    b.textContent = title;
    const s = document.createElement("small");
    s.textContent = sub;
    text.append(b, s);
    el.append(lead, text);

    const close = () => el.remove();
    if (actions.length) {
        const row = document.createElement("span");
        row.className = "mt-actions";
        actions.forEach((a) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.textContent = a.label;
            btn.addEventListener("click", (e) => { e.stopPropagation(); a.fn?.(); close(); });
            row.appendChild(btn);
        });
        el.appendChild(row);
    }
    if (onClick) {
        el.classList.add("clickable");
        el.addEventListener("click", () => { onClick(); close(); });
    }
    stack.appendChild(el);
    if (ms) setTimeout(close, ms);
    return el;
}

/* ---------- sounds (generated in the browser, no audio files needed) ---------- */
let audioCtx = null;
function getAudio() {
    if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        audioCtx = new AC();
    }
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return audioCtx;
}
// [frequency, start (s), length (s), wave, volume]
const TONES = {
    chime: [[784, 0, 0.22], [1175, 0.12, 0.4]],
    pop: [[520, 0, 0.09, "triangle"], [780, 0.07, 0.13, "triangle"]],
    bell: [[988, 0, 0.6], [1480, 0, 0.5, "sine", 0.12], [1976, 0, 0.35, "sine", 0.08]],
    ding: [[1318, 0, 0.55]],
    alarm: [[880, 0, 0.18, "square", 0.07], [880, 0.26, 0.18, "square", 0.07], [880, 0.52, 0.18, "square", 0.07], [1100, 0.9, 0.35, "square", 0.07]]
};
function playTone(name = prefs.tone) {
    const ctx = getAudio();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    (TONES[name] || TONES.chime).forEach(([freq, at, len, wave = "sine", vol = 0.22]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = wave;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0 + at);
        gain.gain.exponentialRampToValueAtTime(vol, t0 + at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0 + at);
        osc.stop(t0 + at + len + 0.05);
    });
}
// browsers only allow sound after the person has touched the page once
["pointerdown", "keydown"].forEach((ev) => document.addEventListener(ev, () => { getAudio(); }, { passive: true }));

/* ---------- browser notifications ---------- */
const notifPermission = () => ("Notification" in window ? Notification.permission : "unsupported");
async function requestNotifPermission() {
    if (!("Notification" in window)) return "unsupported";
    if (Notification.permission !== "default") return Notification.permission;
    try { return await Notification.requestPermission(); } catch (_) { return "denied"; }
}

function paintAlertSettings() {
    const perm = notifPermission();
    $("notifToggle").checked = prefs.notif && perm === "granted";
    $("soundToggle").checked = prefs.sound;
    $("soundSelect").value = prefs.tone;
    $("notifHint").textContent =
        perm === "unsupported" ? "This browser doesn't support notifications."
        : perm === "denied" ? "Notifications are blocked. Allow them in your browser's site settings."
        : $("notifToggle").checked ? "You'll get an alert when a message arrives while AuraChat is in the background."
        : "Turn on to get alerts while AuraChat is in the background.";
}

$("notifToggle").addEventListener("change", async (e) => {
    if (e.target.checked) prefs.notif = (await requestNotifPermission()) === "granted";
    else prefs.notif = false;
    lsWrite("aura-notif", prefs.notif ? "1" : "0");
    paintAlertSettings();
});
$("soundToggle").addEventListener("change", (e) => {
    prefs.sound = e.target.checked;
    lsWrite("aura-sound", prefs.sound ? "1" : "0");
    if (prefs.sound) playTone();
});
$("soundSelect").addEventListener("change", (e) => {
    prefs.tone = e.target.value;
    lsWrite("aura-tone", prefs.tone);
    playTone();
});
$("soundTestBtn").addEventListener("click", () => playTone());
paintAlertSettings();

async function maybeOfferNotifications() {
    if (!me || !("Notification" in window)) return;
    if (Notification.permission === "granted" && lsRead("aura-notif") === null) {
        prefs.notif = true;
        lsWrite("aura-notif", "1");
        paintAlertSettings();
        return;
    }
    if (Notification.permission !== "default" || lsRead("aura-notif-asked")) return;
    lsWrite("aura-notif-asked", "1");
    const res = await Swal.fire({
        icon: "question",
        title: "Turn on message notifications?",
        text: "You'll hear a sound and get an alert when new messages arrive.",
        showCancelButton: true,
        confirmButtonText: "Turn on",
        cancelButtonText: "Not now",
        ...swalTheme
    });
    if (res.isConfirmed) {
        prefs.notif = (await requestNotifPermission()) === "granted";
        lsWrite("aura-notif", prefs.notif ? "1" : "0");
        paintAlertSettings();
    }
}

/* ---------- unread counters ---------- */
const unreadHtml = (room) => (unread[room] ? `<b class="unread-badge">${unread[room] > 99 ? "99+" : unread[room]}</b>` : "");
function updateTitleBadge() {
    const n = Object.values(unread).reduce((a, b) => a + b, 0);
    document.title = `${n ? `(${n}) ` : ""}Aura Chat`;
}
function clearUnread(room) {
    if (!unread[room]) return;
    delete unread[room];
    updateTitleBadge();
    renderSidebar();
}
window.addEventListener("focus", () => { if (me) clearUnread(currentChatRoom); });
document.addEventListener("visibilitychange", () => { if (me && document.visibilityState === "visible") clearUnread(currentChatRoom); });

/* ---------- watch every chat I'm part of for new messages ---------- */
function syncNotifyWatchers() {
    if (!me) return;
    const want = new Set(["global"]);
    Object.keys(groupsCache).forEach((gid) => want.add(`group:${gid}`));
    Object.entries(usersCache).forEach(([uid, u]) => { if (uid !== me.uid && u?.name) want.add(uid); });
    Object.entries(channelsCache).forEach(([cid, c]) => { if (c.followers?.[me.uid]) want.add(`channel:${cid}`); });

    Object.keys(notifyWatch).forEach((room) => {
        if (!want.has(room)) { notifyWatch[room](); delete notifyWatch[room]; }
    });
    want.forEach((room) => {
        if (notifyWatch[room]) return;
        const q = query(ref(db, roomPathFor(room)), limitToLast(1));
        notifyWatch[room] = onChildAdded(q, (snap) => onIncoming(room, snap.key, snap.val()));
    });
}

function roomLabel(room) {
    if (room === "global") return "Global Lounge";
    if (room.startsWith("group:")) return groupsCache[room.slice(6)]?.name || "Group";
    if (isChannelRoom(room)) { const c = channelsCache[room.slice(8)]; return `${c?.icon || "📢"} ${c?.name || "Channel"}`; }
    return "";
}

function onIncoming(room, key, d) {
    if (!me || !d || d.uid === me.uid || d.deleted) return;
    if (d.type === "system" || d.type === "call-log") return;
    if ((d.timestamp || 0) < sessionStart - 10000) return;           // history, not new
    const id = `${roomKeyFor(room)}/${key}`;
    if (notified.has(id)) return;
    notified.add(id);

    if (d.expiresAt && d.expiresAt <= Date.now()) return;
    if (d.deletedFor?.[me.uid]) return;
    if ((d.timestamp || 0) <= (me.cleared?.[roomKeyFor(room)] || 0)) return;
    if (isDMRoom(room) && blockedByMe(room)) return;
    if (me.muted?.[room]) return;

    const watching = room === currentChatRoom && document.visibilityState === "visible" && document.hasFocus();
    if (watching) return;                                             // already reading it

    unread[room] = (unread[room] || 0) + 1;
    updateTitleBadge();
    renderSidebar();

    const sender = dispName(d.uid, d.name);
    const where = roomLabel(room);
    const title = isChannelRoom(room) ? where : where ? `${sender} · ${where}` : sender;
    const body = previewOf(d).slice(0, 140);
    const avatar = usersCache[d.uid] ? avatarFor(d.uid, usersCache[d.uid]) : defaultAvatar(sender);
    const open = () => { window.focus(); loadMessages(room, usersCache[room]?.name || ""); };

    if (prefs.sound) playTone();
    if (document.visibilityState === "visible") {
        pushToast({ title, sub: body, img: avatar, onClick: open });
    } else if (prefs.notif && notifPermission() === "granted") {
        try {
            const n = new Notification(title, { body, icon: avatar, tag: roomKeyFor(room) });
            n.onclick = () => { open(); n.close(); };
        } catch (_) { /* some mobile browsers only allow service-worker notifications */ }
    }
}

/* =========================================================
   NICKNAMES · CLOSE FRIENDS · MUTE
========================================================= */
// my private nickname for a contact wins over their real name
const dispName = (uid, fallback = "User") => (uid && me?.nicknames?.[uid]) || usersCache[uid]?.name || fallback;

function fillViewUser(uid) {
    const u = usersCache[uid];
    if (!u || !me) return;
    const nick = me.nicknames?.[uid];
    $("viewUserName").textContent = nick || u.name || "User";
    $("viewUserReal").textContent = nick ? `Aura name: ${u.name}` : "";
    $("viewUserReal").hidden = !nick;
    $("viewUserImg").src = avatarFor(uid, u);
    $("viewUserBio").textContent = canSee(uid, "about") ? u.bio || "No status bio" : "—";
    $("viewUserBadge").style.display = showActive(uid, u) ? "" : "none";
    refreshViewUserButtons();
}

function refreshNames() {
    renderSidebar();
    updateRoomHeader();
    Object.entries(roomCache).forEach(([k, d]) => renderMessage(k, d));
    if (selectedMember && !viewUserModal.classList.contains("hidden")) fillViewUser(selectedMember.uid);
}

async function saveNickname(uid, nick) {
    if (!me) return;
    me.nicknames = { ...(me.nicknames || {}) };
    if (nick) me.nicknames[uid] = nick; else delete me.nicknames[uid];
    refreshNames();
    try {
        const r = ref(db, `users/${me.uid}/nicknames/${uid}`);
        if (nick) await set(r, nick); else await remove(r);
        toast(nick ? `Saved as “${nick}”` : "Nickname removed", "success", 1800);
    } catch (err) {
        console.error(err);
        toast("Couldn't save the nickname. Check Firebase rules.", "error", 3500);
    }
}

async function editNickname(uid) {
    const u = usersCache[uid];
    if (!me || !u) return;
    const has = !!me.nicknames?.[uid];
    const res = await Swal.fire({
        title: "Contact nickname",
        text: `Only you will see it. Their name: ${u.name}`,
        input: "text",
        inputValue: me.nicknames?.[uid] || "",
        inputPlaceholder: u.name,
        inputAttributes: { maxlength: 30, autocomplete: "off" },
        showCancelButton: true,
        showDenyButton: has,
        denyButtonText: "Remove",
        confirmButtonText: "Save",
        ...swalTheme
    });
    if (res.isDenied) saveNickname(uid, "");
    else if (res.isConfirmed) saveNickname(uid, String(res.value || "").trim().slice(0, 30));
}

function toggleCloseFriend(uid) {
    if (!me || !uid) return;
    const on = !me.closeFriends?.[uid];
    setPref("closeFriends", uid, on);
    toast(on ? "Added to Close Friends 💚" : "Removed from Close Friends", "success", 1800);
}

function toggleMute(room) {
    if (!me || room === "ai") return;
    const on = !me.muted?.[room];
    setPref("muted", room, on);
    toast(on ? "Notifications muted for this chat" : "Notifications on for this chat", "success", 1800);
}

$("viewCloseBtn").addEventListener("click", () => { if (selectedMember) { toggleCloseFriend(selectedMember.uid); refreshViewUserButtons(); } });
$("viewNickBtn").addEventListener("click", () => { if (selectedMember) editNickname(selectedMember.uid); });
$("menuClose").addEventListener("click", () => { closeMenus(); toggleCloseFriend(currentChatRoom); });
$("menuNick").addEventListener("click", () => { closeMenus(); editNickname(currentChatRoom); });
$("menuMute").addEventListener("click", () => { closeMenus(); toggleMute(currentChatRoom); });

/* =========================================================
   REMINDERS (events)
========================================================= */
const REPEAT_MS = { daily: 86400000, weekly: 604800000 };
const reminderModal = $("reminderModal");
const toLocalInput = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);

function renderReminders() {
    const list = $("reminderList");
    list.innerHTML = "";
    const items = Object.entries(me?.reminders || {}).sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
    if (!items.length) {
        list.innerHTML = '<li class="reminder-empty">No reminders yet</li>';
        return;
    }
    items.forEach(([id, r]) => {
        const li = document.createElement("li");
        li.className = `reminder-item${r.done ? " done" : ""}`;
        li.innerHTML = `<i class="fa-solid ${r.done ? "fa-circle-check" : "fa-bell"}"></i>
            <span class="r-main"><b></b><small></small></span>
            <button type="button" class="r-del" aria-label="Delete reminder" title="Delete"><i class="fa-solid fa-trash"></i></button>`;
        li.querySelector("b").textContent = r.title || "Reminder";
        const when = new Date(r.at || 0).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
        li.querySelector("small").textContent =
            `${when}${r.repeat && r.repeat !== "none" ? ` · repeats ${r.repeat}` : ""}${r.done ? " · done" : ""}`;
        li.querySelector(".r-del").addEventListener("click", () => {
            delete me.reminders[id];
            renderReminders();
            remove(ref(db, `users/${me.uid}/reminders/${id}`)).catch(() => toast("Couldn't delete the reminder", "error", 3000));
        });
        list.appendChild(li);
    });
}

function openReminders() {
    if (!me) return;
    $("reminderTitle").value = "";
    $("reminderWhen").value = toLocalInput(Date.now() + 3600000);
    $("reminderRepeat").value = "none";
    renderReminders();
    reminderModal.classList.remove("hidden");
}

async function addReminder() {
    if (!me) return;
    const title = $("reminderTitle").value.trim();
    const at = new Date($("reminderWhen").value).getTime();
    if (!title) return toast("Give the reminder a title", "info", 2200);
    if (!at || at < Date.now() + 5000) return toast("Pick a time in the future", "info", 2200);
    const item = { title: title.slice(0, 80), at, repeat: $("reminderRepeat").value || "none", done: false, createdAt: Date.now() };
    try {
        const r = await push(ref(db, `users/${me.uid}/reminders`), item);
        me.reminders = { ...(me.reminders || {}), [r.key]: item };
        $("reminderTitle").value = "";
        renderReminders();
        toast("Reminder set ⏰", "success", 1800);
    } catch (err) {
        console.error(err);
        toast("Couldn't save the reminder. Check Firebase rules.", "error", 3500);
    }
}

function fireReminder(id, r, missed) {
    const path = ref(db, `users/${me.uid}/reminders/${id}`);
    const step = REPEAT_MS[r.repeat];
    if (step) {
        let next = r.at;
        while (next <= Date.now()) next += step;
        update(path, { at: next }).catch(() => {});
    } else {
        update(path, { done: true }).catch(() => {});
    }

    if (prefs.sound) playTone("alarm");
    if (document.visibilityState !== "visible" && prefs.notif && notifPermission() === "granted") {
        try { new Notification(`⏰ ${r.title}`, { body: missed ? "Missed reminder" : "Reminder", tag: `rem_${id}` }); } catch (_) { /* ignore */ }
    }
    pushToast({
        title: `⏰ ${r.title}`,
        sub: missed ? "Missed reminder" : "Reminder",
        icon: "fa-bell",
        cls: "reminder",
        ms: 0,
        actions: [
            {
                label: "Snooze 10 min",
                fn: () => push(ref(db, `users/${me.uid}/reminders`), { title: r.title, at: Date.now() + 600000, repeat: "none", done: false, createdAt: Date.now() }).catch(() => {})
            },
            { label: "Dismiss" }
        ]
    });
}

function checkReminders() {
    if (!me) return;
    const now = Date.now();
    Object.entries(me.reminders || {}).forEach(([id, r]) => {
        if (!r || r.done || !r.at || r.at > now || firedAt[id] === r.at) return;
        firedAt[id] = r.at;
        fireReminder(id, r, now - r.at > 120000);
    });
}
setInterval(checkReminders, 10000);

$("remindersBtn").addEventListener("click", openReminders);
$("closeReminderModalBtn").addEventListener("click", () => reminderModal.classList.add("hidden"));
reminderModal.addEventListener("click", (e) => { if (e.target === reminderModal) reminderModal.classList.add("hidden"); });
$("reminderForm").addEventListener("submit", (e) => { e.preventDefault(); addReminder(); });

/* =========================================================
   CALL RECORDING (saved on my device only)
========================================================= */
let callRec = null;

function fmtClock(ms) {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function paintRecUI(on) {
    $("recordCallBtn").classList.toggle("recording", on);
    $("recordCallBtn").title = on ? "Stop recording" : "Record call";
    $("recordCallBtn").innerHTML = `<i class="fa-solid ${on ? "fa-stop" : "fa-circle-dot"}"></i>`;
    $("recBadge").classList.toggle("hidden", !on);
    if (!on) $("recTime").textContent = "00:00";
}

function saveRecording(chunks, mime, hasVideo) {
    if (!chunks.length) return toast("Nothing was recorded", "info", 2500);
    const type = (mime || (hasVideo ? "video/webm" : "audio/webm")).split(";")[0];
    const ext = type.includes("mp4") ? "mp4" : "webm";
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(chunks, { type }));
    a.download = `aurachat-call-${stamp}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("Recording saved to your device", "success", 2500);
}

function startCallRecording() {
    if (callRec) return;
    const remote = $("remoteVideo").srcObject;
    if (!localStream || !peerConnection || !remote) return toast("You can record once the other person has joined", "info", 3000);
    if (!window.MediaRecorder) return toast("This browser can't record calls", "error", 3000);

    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const dest = ctx.createMediaStreamDestination();
    [localStream, remote].forEach((s) => {
        if (s.getAudioTracks().length) ctx.createMediaStreamSource(new MediaStream(s.getAudioTracks())).connect(dest);
    });
    const tracks = [...dest.stream.getAudioTracks()];

    const hasVideo = localStream.getVideoTracks().length > 0 || remote.getVideoTracks().length > 0;
    let drawTimer = null;
    if (hasVideo) {
        // both people side by side in one picture
        const canvas = document.createElement("canvas");
        canvas.width = 1280;
        canvas.height = 360;
        const g = canvas.getContext("2d");
        const rv = $("remoteVideo");
        const lv = $("localVideo");
        const paint = (v, x) => {
            if (!v.videoWidth) return;
            const k = Math.min(640 / v.videoWidth, 360 / v.videoHeight);
            const w = v.videoWidth * k;
            const h = v.videoHeight * k;
            g.drawImage(v, x + (640 - w) / 2, (360 - h) / 2, w, h);
        };
        drawTimer = setInterval(() => {
            g.fillStyle = "#1c1011";
            g.fillRect(0, 0, 1280, 360);
            paint(rv, 0);
            paint(lv, 640);
        }, 40);
        tracks.push(...canvas.captureStream(25).getVideoTracks());
    }

    const mimes = hasVideo
        ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
        : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    const mime = mimes.find((m) => MediaRecorder.isTypeSupported(m)) || "";

    let recorder;
    try {
        recorder = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime } : undefined);
    } catch (err) {
        console.error(err);
        clearInterval(drawTimer);
        ctx.close().catch(() => {});
        return toast("Couldn't start recording", "error", 3000);
    }

    const chunks = [];
    const startedAt = Date.now();
    const tick = setInterval(() => { $("recTime").textContent = fmtClock(Date.now() - startedAt); }, 500);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
        clearInterval(drawTimer);
        clearInterval(tick);
        ctx.close().catch(() => {});
        saveRecording(chunks, recorder.mimeType, hasVideo);
    };
    recorder.start(1000);
    callRec = { recorder, tick };
    paintRecUI(true);
    // the other person is always told that the call is being recorded
    handleSendMessage(`🔴 ${me.name} started recording this call`, "call-log");
}

function stopCallRecording(silent = false) {
    if (!callRec) return;
    const r = callRec;
    callRec = null;
    clearInterval(r.tick);
    try { if (r.recorder.state !== "inactive") r.recorder.stop(); } catch (_) { /* ignore */ }
    paintRecUI(false);
    if (!silent && me) handleSendMessage("⏹️ Recording stopped", "call-log");
}

$("recordCallBtn").addEventListener("click", () => (callRec ? stopCallRecording() : startCallRecording()));

/* clears everything that belongs to one login session */
function resetSessionExtras() {
    Object.keys(notifyWatch).forEach((room) => { notifyWatch[room](); delete notifyWatch[room]; });
    notified.clear();
    unread = {};
    updateTitleBadge();
    sessionStart = 0;
    Object.keys(firedAt).forEach((k) => delete firedAt[k]);
    reminderModal.classList.add("hidden");
    document.getElementById("toastStack")?.replaceChildren();
    channelsCache = {};
    channelModal.classList.add("hidden");
    closeGames();
    privacyModal.classList.add("hidden");
}

/* =========================================================
   CHANNELS (one-way broadcast: the admin posts, followers read + react)
========================================================= */
let channelsCache = {};           // cid -> channel (every channel, so they can be discovered)
const channelModal = $("channelModal");
const isChannelRoom = (room) => String(room).startsWith("channel:");
const isChannelAdmin = (room) => isChannelRoom(room) && !!me && channelsCache[room.slice(8)]?.ownerUid === me.uid;
const isReadOnlyRoom = (room = currentChatRoom) => isChannelRoom(room) && !isChannelAdmin(room);
const followerCount = (c) => Object.keys(c?.followers || {}).length;

function subscribeChannels() {
    const unsub = onValue(ref(db, "channels"), (snap) => {
        if (!me) return;
        const next = {};
        snap.forEach((child) => {
            const v = child.val();
            if (v && v.name) next[child.key] = v;
        });
        const prev = channelsCache;
        channelsCache = next;

        if (isChannelRoom(currentChatRoom)) {
            const cid = currentChatRoom.slice(8);
            if (prev[cid] && !next[cid]) {
                toast("That channel was deleted", "info", 3000);
                loadMessages("global");
            }
        }
        renderSidebar();
        updateRoomHeader();
        if (!channelModal.classList.contains("hidden")) renderChannelList();
    });
    sessionUnsubs.push(unsub);
}

function renderChannelList() {
    const list = $("channelList");
    list.innerHTML = "";
    const items = Object.entries(channelsCache).sort(
        (a, b) => followerCount(b[1]) - followerCount(a[1]) || String(a[1].name).localeCompare(String(b[1].name))
    );
    if (!items.length) {
        list.innerHTML = '<li class="reminder-empty">No channels yet. Create the first one!</li>';
        return;
    }
    items.forEach(([cid, c]) => {
        const owner = c.ownerUid === me.uid;
        const following = !!c.followers?.[me.uid];
        const li = document.createElement("li");
        li.className = "channel-item";
        li.innerHTML = `<span class="ch-icon"></span>
            <span class="ch-main"><b></b><small class="ch-desc"></small><small class="ch-meta"></small></span>
            <span class="ch-actions"></span>`;
        li.querySelector(".ch-icon").textContent = c.icon || "📢";
        li.querySelector("b").textContent = c.name;
        li.querySelector(".ch-desc").textContent = c.description || "";
        li.querySelector(".ch-meta").textContent =
            `${followerCount(c)} follower${followerCount(c) === 1 ? "" : "s"} · by ${owner ? "you" : c.ownerName || "admin"}`;

        const actions = li.querySelector(".ch-actions");
        const open = document.createElement("button");
        open.type = "button";
        open.className = "mini-btn";
        open.textContent = "Open";
        open.addEventListener("click", () => { channelModal.classList.add("hidden"); loadMessages(`channel:${cid}`); });
        actions.appendChild(open);
        if (!owner) {
            const f = document.createElement("button");
            f.type = "button";
            f.className = `mini-btn follow-btn${following ? " on" : ""}`;
            f.textContent = following ? "Following ✓" : "Follow";
            f.addEventListener("click", () => toggleFollow(cid));
            actions.appendChild(f);
        }
        list.appendChild(li);
    });
}

async function createChannel() {
    if (!me) return;
    const name = $("channelName").value.trim().slice(0, 40);
    const description = $("channelDesc").value.trim().slice(0, 140);
    const icon = ($("channelIcon").value.trim() || "📢").slice(0, 4);
    if (!name) return toast("Give your channel a name", "info", 2200);
    try {
        const r = await push(ref(db, "channels"), {
            name, description, icon,
            ownerUid: me.uid, ownerName: me.name, createdAt: Date.now(),
            followers: { [me.uid]: Date.now() }
        });
        $("channelName").value = "";
        $("channelDesc").value = "";
        channelModal.classList.add("hidden");
        toast(`Channel “${name}” created`, "success", 2200);
        loadMessages(`channel:${r.key}`);
    } catch (err) {
        console.error(err);
        toast("Couldn't create the channel. Check Firebase rules.", "error", 3500);
    }
}

async function toggleFollow(cid) {
    const c = channelsCache[cid];
    if (!me || !c || c.ownerUid === me.uid) return;
    const r = ref(db, `channels/${cid}/followers/${me.uid}`);
    const on = !c.followers?.[me.uid];
    try {
        if (on) await set(r, Date.now()); else await remove(r);
        toast(on ? `Following ${c.name}` : `Unfollowed ${c.name}`, "success", 1800);
        if (!on && currentChatRoom === `channel:${cid}`) loadMessages("global");
    } catch (err) {
        console.error(err);
        toast("Couldn't update. Check Firebase rules.", "error", 3500);
    }
}

async function openChannelInfo() {
    const cid = currentChatRoom.slice(8);
    const c = channelsCache[cid];
    if (!me || !c) return;
    const admin = c.ownerUid === me.uid;
    const res = await Swal.fire({
        title: `${c.icon || "📢"} ${c.name}`,
        html: `<p style="margin-bottom:8px">${esc(c.description || "No description")}</p>
               <small>${followerCount(c)} follower${followerCount(c) === 1 ? "" : "s"} · admin: ${esc(c.ownerName || "—")}</small>`,
        showCancelButton: true,
        cancelButtonText: "Close",
        confirmButtonText: admin ? "Delete channel" : "Unfollow",
        ...swalTheme,
        confirmButtonColor: "#ef4444"
    });
    if (!res.isConfirmed) return;
    if (!admin) return toggleFollow(cid);
    const sure = await Swal.fire({
        icon: "warning", title: "Delete this channel?", text: "All its posts will be removed for everyone.",
        showCancelButton: true, confirmButtonText: "Delete", ...swalTheme, confirmButtonColor: "#ef4444"
    });
    if (!sure.isConfirmed) return;
    try {
        await remove(ref(db, `messages/channel_${cid}`));
        await remove(ref(db, `channels/${cid}`));
        toast("Channel deleted", "success", 2000);
    } catch (err) {
        console.error(err);
        toast("Couldn't delete the channel. Check Firebase rules.", "error", 3500);
    }
}

$("channelsBtn").addEventListener("click", () => {
    if (!me) return;
    renderChannelList();
    channelModal.classList.remove("hidden");
});
$("closeChannelModalBtn").addEventListener("click", () => channelModal.classList.add("hidden"));
channelModal.addEventListener("click", (e) => { if (e.target === channelModal) channelModal.classList.add("hidden"); });
$("channelForm").addEventListener("submit", (e) => { e.preventDefault(); createChannel(); });
$("menuChannel").addEventListener("click", () => { closeMenus(); openChannelInfo(); });

/* =========================================================
   GAMES
========================================================= */
const GAME_NAMES = { ttt: "Tic-Tac-Toe", rps: "Rock · Paper · Scissors", memory: "Memory Match", snake: "Snake" };
const gamesModal = $("gamesModal");
const gameStage = $("gameStage");
let gameCleanup = null;

function endGameView() {
    if (!gameCleanup) return;
    const f = gameCleanup;
    gameCleanup = null;
    try { f(); } catch (_) { /* ignore */ }
}
function closeGames() {
    endGameView();
    gamesModal.classList.add("hidden");
}
function gameFrame(title, bodyHtml) {
    gameStage.innerHTML = `<div class="game-head"><button type="button" class="mini-btn" id="gameBack"><i class="fa-solid fa-arrow-left"></i> Games</button><h3>${esc(title)}</h3></div>${bodyHtml}`;
    $("gameBack").addEventListener("click", showHub);
}

function showHub() {
    endGameView();
    const cards = [
        ["ttt", "❌⭕", "2 players"],
        ["rps", "✊✋✌️", "2 players"],
        ["memory", "🧠", "Solo · fewest moves"],
        ["snake", "🐍", "Solo · high score"]
    ].map(([k, icon, sub]) =>
        `<button type="button" class="game-card" data-game="${k}"><span class="g-icon">${icon}</span><b>${esc(GAME_NAMES[k])}</b><small>${sub}</small></button>`
    ).join("");
    gameStage.innerHTML = `<h2>Games 🎮</h2><p class="login-sub">Challenge a friend, or beat the leaderboard.</p><div class="game-grid">${cards}</div>`;
    gameStage.querySelectorAll(".game-card").forEach((b) => b.addEventListener("click", () => startGame(b.dataset.game)));
}

function openGames() {
    if (!me) return;
    gamesModal.classList.remove("hidden");
    showHub();
}

function startGame(kind) {
    if (kind === "ttt" || kind === "rps") return inviteFriend(kind);
    if (kind === "memory") return openMemory();
    if (kind === "snake") return openSnake();
}

async function inviteFriend(kind) {
    const people = Object.entries(usersCache)
        .filter(([uid, u]) => uid !== me.uid && u?.name && !blockedEitherWay(uid))
        .sort((a, b) => (showActive(b[0], b[1]) - showActive(a[0], a[1])) || dispName(a[0], a[1].name).localeCompare(dispName(b[0], b[1].name)));
    if (!people.length) return toast("No one to play with yet", "info", 2500);

    const idx = await pickIndex(
        `Play ${GAME_NAMES[kind]} with…`,
        people.map(([uid, u]) => `<i class="fa-solid fa-user"></i> <span>${esc(dispName(uid, u.name))}</span>${showActive(uid, u) ? " <small>Active</small>" : ""}`)
    );
    if (idx < 0) return;
    const [uid2, u2] = people[idx];
    try {
        const gid = push(ref(db, "games")).key;
        const base = { kind, p1: me.uid, p2: uid2, p1Name: me.name, p2Name: u2.name, createdAt: Date.now() };
        const init = kind === "ttt"
            ? { ...base, board: "---------", turn: me.uid, starter: me.uid }
            : { ...base, round: 1, scores: { [me.uid]: 0, [uid2]: 0 }, over: false };
        await set(ref(db, `games/${gid}`), init);
        // the invite lands in their private chat with me, with a Play button
        await push(ref(db, roomPathFor(uid2)), { uid: me.uid, name: me.name, type: "game", content: gid, game: kind, timestamp: Date.now() });
        openMultiplayer(gid);
    } catch (err) {
        console.error(err);
        toast("Couldn't start the game. Check Firebase rules.", "error", 3500);
    }
}

function openMultiplayer(gid) {
    if (!me) return;
    gamesModal.classList.remove("hidden");
    endGameView();
    gameStage.innerHTML = '<p class="game-note">Loading game…</p>';
    const un = onValue(ref(db, `games/${gid}`), (snap) => {
        const g = snap.val();
        if (!g) return gameFrame("Game", '<p class="game-note">This game no longer exists.</p>');
        if (g.kind === "ttt") renderTTT(gid, g);
        else if (g.kind === "rps") renderRPS(gid, g);
    });
    gameCleanup = un;
}

/* ---------- Tic-Tac-Toe ---------- */
const TTT_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const tttLine = (b) => TTT_LINES.find(([x, y, z]) => b[x] !== "-" && b[x] === b[y] && b[x] === b[z]) || null;

function renderTTT(gid, g) {
    const board = String(g.board || "---------");
    const line = tttLine(board);
    const sym = me.uid === g.p1 ? "X" : me.uid === g.p2 ? "O" : null;
    const nameOf = (uid) => (uid === me.uid ? "You" : uid === g.p1 ? g.p1Name : g.p2Name);
    let status;
    if (g.winner === "draw") status = "🤝 It's a draw";
    else if (g.winner) status = g.winner === me.uid ? "🎉 You won!" : `${nameOf(g.winner)} won`;
    else status = g.turn === me.uid ? "Your turn" : `Waiting for ${nameOf(g.turn)}…`;

    const cells = [...board].map((c, i) => {
        const dis = c !== "-" || g.winner || g.turn !== me.uid || !sym;
        return `<button type="button" class="ttt-cell ${c === "X" ? "x" : c === "O" ? "o" : ""}${line && line.includes(i) ? " win" : ""}" data-i="${i}" ${dis ? "disabled" : ""}>${c === "-" ? "" : c}</button>`;
    }).join("");

    gameFrame("Tic-Tac-Toe", `
        <p class="game-players">❌ ${esc(g.p1Name)} <span>vs</span> ⭕ ${esc(g.p2Name)}</p>
        <p class="game-status">${esc(status)}</p>
        <div class="ttt-board">${cells}</div>
        ${g.winner && sym ? '<button type="button" class="btn-primary btn-sm" id="gameAgain"><i class="fa-solid fa-rotate"></i> Play again</button>' : ""}`);
    gameStage.querySelectorAll(".ttt-cell").forEach((b) => b.addEventListener("click", () => tttMove(gid, Number(b.dataset.i))));
    $("gameAgain")?.addEventListener("click", () => tttAgain(gid));
}

function tttMove(gid, i) {
    runTransaction(ref(db, `games/${gid}`), (g) => {
        if (!g || g.winner || g.turn !== me.uid || String(g.board)[i] !== "-") return;   // abort
        const b = [...g.board];
        b[i] = me.uid === g.p1 ? "X" : "O";
        g.board = b.join("");
        if (tttLine(b)) g.winner = me.uid;
        else if (!b.includes("-")) g.winner = "draw";
        else g.turn = me.uid === g.p1 ? g.p2 : g.p1;
        return g;
    }).catch((err) => { console.error(err); toast("Move failed", "error", 2500); });
}

function tttAgain(gid) {
    runTransaction(ref(db, `games/${gid}`), (g) => {
        if (!g || !g.winner) return;
        g.board = "---------";
        g.winner = null;
        g.starter = g.starter === g.p1 ? g.p2 : g.p1;     // the other player starts the next round
        g.turn = g.starter;
        return g;
    }).catch(() => {});
}

/* ---------- Rock · Paper · Scissors (first to 3) ---------- */
const RPS_ICON = { rock: "✊", paper: "✋", scissors: "✌️" };
const rpsWinner = (a, b) => (a === b ? 0 : (a === "rock" && b === "scissors") || (a === "paper" && b === "rock") || (a === "scissors" && b === "paper") ? 1 : 2);

function renderRPS(gid, g) {
    const player = me.uid === g.p1 || me.uid === g.p2;
    const nameOf = (uid) => (uid === me.uid ? "You" : uid === g.p1 ? g.p1Name : g.p2Name);
    const s1 = g.scores?.[g.p1] || 0;
    const s2 = g.scores?.[g.p2] || 0;
    const picked = g.picks?.[me.uid];

    let last = "";
    if (g.last) {
        const mine = me.uid === g.p2 ? g.last.b : g.last.a;
        const theirs = me.uid === g.p2 ? g.last.a : g.last.b;
        const res = g.last.w === "draw" ? "Draw" : g.last.w === me.uid ? "You win the round" : `${nameOf(g.last.w)} wins the round`;
        last = player
            ? `<p class="game-last">${RPS_ICON[mine] || ""} vs ${RPS_ICON[theirs] || ""} — ${esc(res)}</p>`
            : `<p class="game-last">${RPS_ICON[g.last.a] || ""} vs ${RPS_ICON[g.last.b] || ""} — ${esc(res)}</p>`;
    }
    let status;
    if (g.over) status = (s1 > s2 ? g.p1 : g.p2) === me.uid ? "🎉 You won the match!" : `${nameOf(s1 > s2 ? g.p1 : g.p2)} won the match`;
    else if (!player) status = "Spectating";
    else if (picked) status = "Waiting for your friend…";
    else status = `Round ${g.round || 1} — pick one`;

    const buttons = !g.over && player && !picked
        ? Object.entries(RPS_ICON).map(([k, ic]) => `<button type="button" class="rps-btn" data-pick="${k}" aria-label="${k}">${ic}</button>`).join("")
        : picked && !g.over ? `<span class="rps-picked">${RPS_ICON[picked]}</span>` : "";

    gameFrame("Rock · Paper · Scissors", `
        <p class="game-players">${esc(g.p1Name)} <b>${s1}</b> <span>—</span> <b>${s2}</b> ${esc(g.p2Name)}</p>
        <p class="game-status">${esc(status)}</p>
        ${last}
        <div class="rps-row">${buttons}</div>
        ${g.over && player ? '<button type="button" class="btn-primary btn-sm" id="gameAgain"><i class="fa-solid fa-rotate"></i> Play again</button>' : ""}`);
    gameStage.querySelectorAll(".rps-btn").forEach((b) => b.addEventListener("click", () => rpsPick(gid, b.dataset.pick)));
    $("gameAgain")?.addEventListener("click", () => rpsAgain(gid));
}

function rpsPick(gid, pick) {
    runTransaction(ref(db, `games/${gid}`), (g) => {
        if (!g || g.over || (me.uid !== g.p1 && me.uid !== g.p2)) return;
        g.picks = g.picks || {};
        if (g.picks[me.uid]) return;
        g.picks[me.uid] = pick;
        const a = g.picks[g.p1];
        const b = g.picks[g.p2];
        if (a && b) {
            const r = rpsWinner(a, b);
            g.scores = g.scores || {};
            if (r === 1) g.scores[g.p1] = (g.scores[g.p1] || 0) + 1;
            if (r === 2) g.scores[g.p2] = (g.scores[g.p2] || 0) + 1;
            g.last = { a, b, w: r === 0 ? "draw" : r === 1 ? g.p1 : g.p2 };
            g.picks = null;
            g.round = (g.round || 1) + 1;
            if ((g.scores[g.p1] || 0) >= 3 || (g.scores[g.p2] || 0) >= 3) g.over = true;
        }
        return g;
    }).catch((err) => { console.error(err); toast("Couldn't send your pick", "error", 2500); });
}

function rpsAgain(gid) {
    runTransaction(ref(db, `games/${gid}`), (g) => {
        if (!g || !g.over) return;
        g.scores = { [g.p1]: 0, [g.p2]: 0 };
        g.round = 1;
        g.over = false;
        g.last = null;
        g.picks = null;
        return g;
    }).catch(() => {});
}

/* ---------- scores + leaderboard (solo games) ---------- */
async function saveScore(game, score, lowerBetter = false) {
    try {
        const r = ref(db, `scores/${game}/${me.uid}`);
        const old = (await get(r)).val()?.score;
        if (old == null || (lowerBetter ? score < old : score > old)) {
            await set(r, { name: me.name, score, at: Date.now() });
            return true;
        }
    } catch (err) {
        console.warn("Couldn't save score:", err);
    }
    return false;
}

async function paintLeaderboard(game, lowerBetter, unit) {
    const box = document.getElementById("gameBoard");
    if (!box) return;
    try {
        const rows = [];
        (await get(ref(db, `scores/${game}`))).forEach((c) => {
            const v = c.val();
            if (v && typeof v.score === "number") rows.push({ uid: c.key, ...v });
        });
        rows.sort((a, b) => (lowerBetter ? a.score - b.score : b.score - a.score));
        const top = rows.slice(0, 5);
        const target = document.getElementById("gameBoard");
        if (!target) return;
        target.innerHTML = top.length
            ? `<ol class="leaderboard">${top.map((r) => `<li${r.uid === me.uid ? ' class="me"' : ""}><span>${esc(dispName(r.uid, r.name))}</span><b>${r.score} ${unit}</b></li>`).join("")}</ol>`
            : '<p class="game-note">No scores yet — be the first!</p>';
    } catch (_) {
        box.innerHTML = '<p class="game-note">Leaderboard unavailable.</p>';
    }
}

/* ---------- Memory Match ---------- */
function shuffled(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function openMemory() {
    endGameView();
    const faces = ["🌸", "🦋", "🍓", "🌙", "🎈", "🐝", "🍉", "🦄"];
    const deck = shuffled([...faces, ...faces]);
    let open = [];
    const done = new Set();
    let moves = 0;
    let busy = false;
    let timer = null;

    gameFrame("Memory Match", `
        <div class="mem-info"><span>Moves: <b id="memMoves">0</b></span><button type="button" class="mini-btn" id="memRestart">Restart</button></div>
        <div class="mem-grid" id="memGrid"></div>
        <h4 class="lb-title">🏆 Fewest moves</h4><div id="gameBoard"></div>`);
    const grid = $("memGrid");
    const paint = () => {
        grid.innerHTML = deck.map((f, i) => {
            const up = open.includes(i) || done.has(i);
            return `<button type="button" class="mem-card${up ? " up" : ""}${done.has(i) ? " matched" : ""}" data-i="${i}" aria-label="card">${up ? f : "❔"}</button>`;
        }).join("");
        grid.querySelectorAll(".mem-card").forEach((b) => b.addEventListener("click", () => flip(Number(b.dataset.i))));
    };
    const flip = async (i) => {
        if (busy || open.includes(i) || done.has(i)) return;
        open.push(i);
        paint();
        if (open.length < 2) return;
        moves++;
        $("memMoves").textContent = moves;
        const [a, b] = open;
        if (deck[a] === deck[b]) {
            done.add(a); done.add(b); open = [];
            paint();
            if (done.size === deck.length) {
                const best = await saveScore("memory", moves, true);
                toast(best ? `🎉 New best: ${moves} moves!` : `Done in ${moves} moves`, "success", 2600);
                paintLeaderboard("memory", true, "moves");
            }
        } else {
            busy = true;
            timer = setTimeout(() => { open = []; busy = false; paint(); }, 750);
        }
    };
    $("memRestart").addEventListener("click", openMemory);
    paint();
    paintLeaderboard("memory", true, "moves");
    gameCleanup = () => clearTimeout(timer);
}

/* ---------- Snake ---------- */
const SNAKE_N = 15;
function snakeFood(snake, rnd = Math.random) {
    const free = [];
    for (let x = 0; x < SNAKE_N; x++) for (let y = 0; y < SNAKE_N; y++) {
        if (!snake.some((c) => c.x === x && c.y === y)) free.push({ x, y });
    }
    return free.length ? free[Math.floor(rnd() * free.length)] : { x: -1, y: -1 };
}
function snakeInit(rnd = Math.random) {
    const snake = [{ x: 7, y: 7 }, { x: 6, y: 7 }, { x: 5, y: 7 }];
    return { snake, dir: { x: 1, y: 0 }, food: snakeFood(snake, rnd), score: 0, dead: false };
}
function snakeStep(s, want, rnd = Math.random) {
    const d = want && !(want.x === -s.dir.x && want.y === -s.dir.y) ? want : s.dir;
    const head = { x: s.snake[0].x + d.x, y: s.snake[0].y + d.y };
    const ate = head.x === s.food.x && head.y === s.food.y;
    const body = ate ? s.snake : s.snake.slice(0, -1);
    if (head.x < 0 || head.y < 0 || head.x >= SNAKE_N || head.y >= SNAKE_N || body.some((c) => c.x === head.x && c.y === head.y)) {
        return { ...s, dir: d, dead: true };
    }
    const snake = [head, ...s.snake];
    if (!ate) snake.pop();
    return { snake, dir: d, food: ate ? snakeFood(snake, rnd) : s.food, score: s.score + (ate ? 1 : 0), dead: false };
}

function openSnake() {
    endGameView();
    const CELL = 20;
    gameFrame("Snake", `
        <div class="mem-info"><span>Score: <b id="snakeScore">0</b></span><button type="button" class="btn-primary btn-sm snake-play" id="snakePlay">Play</button></div>
        <canvas id="snakeCanvas" class="snake-canvas" width="${SNAKE_N * CELL}" height="${SNAKE_N * CELL}"></canvas>
        <p class="game-last" id="snakeMsg">Arrow keys / WASD, swipe, or use the pad.</p>
        <div class="dpad">
            <button type="button" data-d="up" aria-label="Up">▲</button>
            <button type="button" data-d="left" aria-label="Left">◀</button>
            <button type="button" data-d="down" aria-label="Down">▼</button>
            <button type="button" data-d="right" aria-label="Right">▶</button>
        </div>
        <h4 class="lb-title">🏆 High scores</h4><div id="gameBoard"></div>`);
    const canvas = $("snakeCanvas");
    const g = canvas.getContext("2d");
    const css = getComputedStyle(document.documentElement);
    let st = snakeInit();
    let want = null;
    let timer = null;
    let running = false;
    const DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

    const draw = () => {
        g.fillStyle = css.getPropertyValue("--tint").trim() || "#f6e4dd";
        g.fillRect(0, 0, canvas.width, canvas.height);
        g.fillStyle = "#e0566a";
        g.beginPath();
        g.arc(st.food.x * CELL + CELL / 2, st.food.y * CELL + CELL / 2, CELL / 2 - 3, 0, Math.PI * 2);
        g.fill();
        st.snake.forEach((c, i) => {
            g.fillStyle = i === 0 ? "#8f4f5c" : "#b4707a";
            g.fillRect(c.x * CELL + 1, c.y * CELL + 1, CELL - 2, CELL - 2);
        });
    };
    const tick = async () => {
        st = snakeStep(st, want);
        want = null;
        draw();
        $("snakeScore").textContent = st.score;
        if (st.dead) {
            running = false;
            $("snakeMsg").textContent = `Game over — score ${st.score}`;
            if (st.score > 0) {
                const best = await saveScore("snake", st.score);
                if (best) toast(`🎉 New best: ${st.score}!`, "success", 2400);
            }
            paintLeaderboard("snake", false, "pts");
            return;
        }
        timer = setTimeout(tick, Math.max(70, 140 - st.score * 4));
    };
    const play = () => {
        clearTimeout(timer);
        st = snakeInit();
        want = null;
        running = true;
        $("snakeScore").textContent = "0";
        $("snakeMsg").textContent = "Go!";
        draw();
        timer = setTimeout(tick, 300);
    };
    const KEYS = { ArrowUp: "up", w: "up", ArrowDown: "down", s: "down", ArrowLeft: "left", a: "left", ArrowRight: "right", d: "right" };
    const onKey = (e) => {
        const k = KEYS[e.key];
        if (!k) return;
        e.preventDefault();
        if (running) want = DIRS[k];
    };
    document.addEventListener("keydown", onKey);
    gameStage.querySelectorAll(".dpad button").forEach((b) => b.addEventListener("click", () => { if (running) want = DIRS[b.dataset.d]; }));
    let tx = 0, ty = 0;
    canvas.addEventListener("touchstart", (e) => { tx = e.touches[0].clientX; ty = e.touches[0].clientY; }, { passive: true });
    canvas.addEventListener("touchend", (e) => {
        const dx = e.changedTouches[0].clientX - tx;
        const dy = e.changedTouches[0].clientY - ty;
        if (!running || Math.max(Math.abs(dx), Math.abs(dy)) < 20) return;
        want = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? DIRS.right : DIRS.left) : (dy > 0 ? DIRS.down : DIRS.up);
    }, { passive: true });
    $("snakePlay").addEventListener("click", play);
    draw();
    paintLeaderboard("snake", false, "pts");
    gameCleanup = () => { clearTimeout(timer); running = false; document.removeEventListener("keydown", onKey); };
}

$("gamesBtn").addEventListener("click", openGames);
$("closeGamesBtn").addEventListener("click", closeGames);
gamesModal.addEventListener("click", (e) => { if (e.target === gamesModal) closeGames(); });
document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!gamesModal.classList.contains("hidden")) closeGames();
    channelModal.classList.add("hidden");
});

/* =========================================================
   PRIVACY (who can see my personal info)
========================================================= */
const PRIVACY_FIELDS = [
    ["lastSeen", "Last seen and online"],
    ["avatar", "Profile picture"],
    ["about", "About"],
    ["status", "Status"]
];
const privacyModal = $("privacyModal");
let privacyView = { page: "main", field: null, picks: new Set() };

const myPrivacy = (field) => me?.privacy?.[field] || { mode: "everyone" };

/* can I see `field` of ownerUid? (their rule, evaluated against me) */
function canSee(ownerUid, field) {
    if (!me || ownerUid === me.uid) return true;
    const owner = usersCache[ownerUid];
    const p = owner?.privacy?.[field];
    if (!p || !p.mode || p.mode === "everyone") return true;
    if (p.mode === "nobody") return false;
    if (p.mode === "close") return !!owner.closeFriends?.[me.uid];
    if (p.mode === "except") return !p.except?.[me.uid];
    return true;
}
// like WhatsApp: if I hide my own last seen from everybody, I can't see anybody else's either
const canSeePresence = (uid) => canSee(uid, "lastSeen") && myPrivacy("lastSeen").mode !== "nobody";
const avatarFor = (uid, u) => (u && canSee(uid, "avatar") ? u.avatar || defaultAvatar(u.name) : defaultAvatar(u?.name));

function lastSeenText(uid, u) {
    if (!u?.lastSeenAt || blockedEitherWay(uid) || !canSeePresence(uid)) return "";
    const d = new Date(u.lastSeenAt);
    const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
    if (days <= 0) return `Last seen today at ${t}`;
    if (days === 1) return `Last seen yesterday at ${t}`;
    return `Last seen ${d.toLocaleDateString([], { day: "numeric", month: "short" })} at ${t}`;
}

function privacySummary(field) {
    const p = myPrivacy(field);
    if (p.mode === "nobody") return "Nobody";
    if (p.mode === "close") return "Close friends only";
    if (p.mode === "except") {
        const n = Object.keys(p.except || {}).length;
        return `${n} contact${n === 1 ? "" : "s"} excluded`;
    }
    return "Everyone";
}

function afterPrivacyChange() {
    renderSidebar();
    updateRoomHeader();
    renderStatusStrip();
    if (selectedMember && !viewUserModal.classList.contains("hidden")) fillViewUser(selectedMember.uid);
}

async function savePrivacy(field, value) {
    if (!me) return;
    me.privacy = { ...(me.privacy || {}) };
    if (!value || value.mode === "everyone") delete me.privacy[field]; else me.privacy[field] = value;
    afterPrivacyChange();
    try {
        const r = ref(db, `users/${me.uid}/privacy/${field}`);
        if (me.privacy[field]) await set(r, me.privacy[field]); else await remove(r);
    } catch (err) {
        console.error(err);
        toast("Couldn't save the setting. Check Firebase rules.", "error", 3500);
    }
}

function renderPrivacy() {
    const body = $("privacyBody");
    const { page, field } = privacyView;
    $("privacyBack").hidden = page === "main";
    body.innerHTML = "";

    if (page === "main") {
        $("privacyTitle").textContent = "Privacy";
        body.innerHTML = '<p class="privacy-label">Who can see my personal info</p>';
        PRIVACY_FIELDS.forEach(([f, label]) => {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "privacy-row";
            row.innerHTML = '<span><b></b><small></small></span><i class="fa-solid fa-chevron-right"></i>';
            row.querySelector("b").textContent = label;
            row.querySelector("small").textContent = privacySummary(f);
            row.addEventListener("click", () => { privacyView = { page: "field", field: f, picks: new Set() }; renderPrivacy(); });
            body.appendChild(row);
        });
        const note = document.createElement("p");
        note.className = "privacy-note";
        note.textContent = "Your choices are checked by the other person's AuraChat. Only close friends you've added can be allowed with “Close friends only”.";
        body.appendChild(note);
        return;
    }

    const label = PRIVACY_FIELDS.find((x) => x[0] === field)[1];

    if (page === "field") {
        $("privacyTitle").textContent = label;
        body.innerHTML = `<p class="privacy-label">Who can see my ${esc(label.toLowerCase())}</p>`;
        const cur = myPrivacy(field).mode;
        [
            ["everyone", "Everyone"],
            ["except", "Everyone except…"],
            ["close", "Close friends only"],
            ["nobody", "Nobody"]
        ].forEach(([mode, text]) => {
            const row = document.createElement("button");
            row.type = "button";
            row.className = `privacy-row option${cur === mode ? " on" : ""}`;
            row.innerHTML = '<span><b></b></span><i class="fa-solid fa-circle-check"></i>';
            row.querySelector("b").textContent = text;
            row.addEventListener("click", () => {
                if (mode === "except") {
                    privacyView = { page: "pick", field, picks: new Set(Object.keys(myPrivacy(field).except || {})) };
                } else {
                    savePrivacy(field, { mode });
                }
                renderPrivacy();
            });
            body.appendChild(row);
        });
        if (field === "lastSeen") {
            const n = document.createElement("p");
            n.className = "privacy-note";
            n.textContent = "If you don't share your last seen and online, you won't see other people's last seen and online either.";
            body.appendChild(n);
        }
        return;
    }

    // page === "pick": choose the contacts who must NOT see this
    $("privacyTitle").textContent = "Exclude contacts";
    body.innerHTML = `<p class="privacy-label">Hide my ${esc(label.toLowerCase())} from…</p>`;
    const people = Object.entries(usersCache)
        .filter(([uid, u]) => uid !== me.uid && u?.name)
        .sort((a, b) => dispName(a[0], a[1].name).localeCompare(dispName(b[0], b[1].name)));
    const list = document.createElement("ul");
    list.className = "privacy-pick";
    if (!people.length) list.innerHTML = '<li class="reminder-empty">No contacts yet</li>';
    people.forEach(([uid, u]) => {
        const li = document.createElement("li");
        li.className = privacyView.picks.has(uid) ? "selected" : "";
        const img = document.createElement("img");
        img.className = "member-list-img";
        img.alt = "";
        img.src = u.avatar || defaultAvatar(u.name);
        const nm = document.createElement("span");
        nm.textContent = dispName(uid, u.name);
        const tick = document.createElement("i");
        tick.className = "fa-solid fa-circle-check";
        li.append(img, nm, tick);
        li.addEventListener("click", () => {
            if (privacyView.picks.has(uid)) privacyView.picks.delete(uid); else privacyView.picks.add(uid);
            li.classList.toggle("selected", privacyView.picks.has(uid));
            $("privacyDone").textContent = `Done (${privacyView.picks.size} excluded)`;
        });
        list.appendChild(li);
    });
    body.appendChild(list);
    const done = document.createElement("button");
    done.type = "button";
    done.id = "privacyDone";
    done.className = "btn-primary";
    done.textContent = `Done (${privacyView.picks.size} excluded)`;
    done.addEventListener("click", () => {
        const except = {};
        privacyView.picks.forEach((uid) => { except[uid] = true; });
        savePrivacy(field, privacyView.picks.size ? { mode: "except", except } : { mode: "everyone" });
        privacyView = { page: "field", field, picks: new Set() };
        renderPrivacy();
    });
    body.appendChild(done);
}

function openPrivacy() {
    if (!me) return;
    profileModal.classList.add("hidden");
    privacyView = { page: "main", field: null, picks: new Set() };
    renderPrivacy();
    privacyModal.classList.remove("hidden");
}
function closePrivacy() {
    privacyModal.classList.add("hidden");
}

$("privacyBack").addEventListener("click", () => {
    privacyView = privacyView.page === "pick" ? { page: "field", field: privacyView.field, picks: new Set() } : { page: "main", field: null, picks: new Set() };
    renderPrivacy();
});
$("closePrivacyBtn").addEventListener("click", closePrivacy);
privacyModal.addEventListener("click", (e) => { if (e.target === privacyModal) closePrivacy(); });
$("openPrivacyBtn").addEventListener("click", openPrivacy);
$("privacyShortcutBtn").addEventListener("click", openPrivacy);

/* =========================================================
   LOCATION SHARING
========================================================= */
function parseLoc(content) {
    const m = /^(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/.exec(String(content ?? "").trim());
    if (!m) return null;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

function locationHtml(d) {
    const p = parseLoc(d.content);
    if (!p) return '<span class="msg-deleted">Invalid location</span>';
    return `<div class="loc-card" data-lat="${p.lat}" data-lng="${p.lng}">
        <div class="loc-title"><i class="fa-solid fa-location-dot"></i> Shared location</div>
        <small>${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</small>
        <div class="loc-map"></div>
        <div class="loc-actions">
            <button type="button" class="loc-show"><i class="fa-regular fa-map"></i> Show map</button>
            <a class="loc-open" href="https://www.google.com/maps?q=${p.lat},${p.lng}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open in Maps</a>
        </div>
    </div>`;
}

function showLocMap(btn) {
    const card = btn.closest(".loc-card");
    const box = card?.querySelector(".loc-map");
    if (!box) return;
    if (box.firstChild) { box.textContent = ""; btn.innerHTML = '<i class="fa-regular fa-map"></i> Show map'; return; }
    const lat = Number(card.dataset.lat);
    const lng = Number(card.dataset.lng);
    const f = document.createElement("iframe");
    f.loading = "lazy";
    f.title = "Map";
    f.referrerPolicy = "no-referrer";
    f.src = `https://www.openstreetmap.org/export/embed.html?bbox=${lng - 0.006},${lat - 0.004},${lng + 0.006},${lat + 0.004}&layer=mapnik&marker=${lat},${lng}`;
    box.appendChild(f);
    btn.innerHTML = '<i class="fa-solid fa-xmark"></i> Hide map';
}

async function shareLocation() {
    if (!me) return;
    if (!navigator.geolocation) return toast("This browser can't share location", "error", 3000);
    if (!window.isSecureContext) return alertError("Location needs https", "Browsers only share location on https:// pages (or localhost). Open AuraChat from a secure address.");

    Swal.fire({ title: "Getting your location…", allowOutsideClick: false, ...swalTheme, didOpen: () => Swal.showLoading() });
    let pos;
    try {
        pos = await new Promise((resolve, reject) =>
            navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 })
        );
    } catch (err) {
        Swal.close();
        const msg = err.code === 1 ? "Location permission was denied. Allow it in your browser's site settings and try again."
            : err.code === 3 ? "Finding your location took too long. Try again."
            : "Your location isn't available right now.";
        return alertError("Couldn't get location", msg);
    }
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const res = await Swal.fire({
        icon: "question",
        title: "Share your current location?",
        html: `${esc(lat.toFixed(5))}, ${esc(lng.toFixed(5))}<br><small>accurate to about ${Math.round(pos.coords.accuracy || 0)} m · everyone in “${esc(currentChatTitle.innerText)}” will see it</small>`,
        showCancelButton: true,
        confirmButtonText: "Share",
        ...swalTheme
    });
    if (res.isConfirmed) handleSendMessage(`${lat.toFixed(6)},${lng.toFixed(6)}`, "location");
}
$("attachLocationBtn").addEventListener("click", () => { closeMenus(); shareLocation(); });

/* =========================================================
   WEBRTC CALLS
========================================================= */
function cleanupCallUI() {
    stopCallRecording(true);
    callUnsubs.forEach((fn) => fn());
    callUnsubs = [];
    pendingCandidates = [];

    if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
        localStream = null;
    }
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    const remote = $("remoteVideo");
    const local = $("localVideo");
    if (remote) remote.srcObject = null;
    if (local) local.srcObject = null;
    $("videoCallOverlay").classList.add("hidden");

    // reset mic / cam buttons
    $("toggleMicBtn").innerHTML = `<i class="fa-solid fa-microphone"></i>`;
    $("toggleCamBtn").innerHTML = `<i class="fa-solid fa-video"></i>`;
}

function setupPeer() {
    peerConnection = new RTCPeerConnection(rtcServers);
    pendingCandidates = [];
    localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = (e) => {
        $("remoteVideo").srcObject = e.streams[0];
    };
    peerConnection.onicecandidate = (e) => {
        if (e.candidate && me) push(ref(db, "callSignal/candidates"), { candidate: e.candidate.toJSON(), sender: me.uid });
    };
}

async function addRemoteCandidate(candidate) {
    if (!peerConnection) return;
    if (!peerConnection.remoteDescription) {
        pendingCandidates.push(candidate);
        return;
    }
    try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
        console.warn("ICE candidate error:", err);
    }
}

async function flushCandidates() {
    const list = pendingCandidates;
    pendingCandidates = [];
    for (const c of list) await addRemoteCandidate(c);
}

function listenForCandidates() {
    callUnsubs.push(
        onChildAdded(ref(db, "callSignal/candidates"), (snap) => {
            const d = snap.val();
            if (d && me && d.sender !== me.uid) addRemoteCandidate(d.candidate);
        })
    );
}

async function getMedia(isVideo) {
    try {
        return await navigator.mediaDevices.getUserMedia({ video: isVideo, audio: true });
    } catch (err) {
        alertError("Can't access devices", "Please allow microphone" + (isVideo ? " and camera" : "") + " access.");
        return null;
    }
}

async function startCall(isVideo) {
    if (!me || peerConnection) return;

    localStream = await getMedia(isVideo);
    if (!localStream) return;

    $("videoCallOverlay").classList.remove("hidden");
    $("localVideo").srcObject = localStream;
    setupPeer();

    const offer = await peerConnection.createOffer();

    // write the signal first, then start ICE gathering so candidates are not wiped by set()
    await set(ref(db, "callSignal"), {
        offer: { type: offer.type, sdp: offer.sdp },
        sender: me.uid,
        senderName: me.name,
        type: isVideo ? "Video Call" : "Voice Call",
        createdAt: Date.now()
    });
    await peerConnection.setLocalDescription(offer);

    handleSendMessage(`📞 ${me.name} started a ${isVideo ? "Video" : "Voice"} Call`, "call-log");

    callUnsubs.push(
        onValue(ref(db, "callSignal/answer"), async (snap) => {
            const answer = snap.val();
            if (answer && peerConnection && !peerConnection.currentRemoteDescription) {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
                await flushCandidates();
            }
        })
    );
    listenForCandidates();
}

async function acceptCall(data) {
    localStream = await getMedia(data.type === "Video Call");
    if (!localStream) {
        remove(ref(db, "callSignal"));
        return;
    }

    $("videoCallOverlay").classList.remove("hidden");
    $("localVideo").srcObject = localStream;
    setupPeer();

    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    await update(ref(db, "callSignal"), { answer: { type: answer.type, sdp: answer.sdp } });

    handleSendMessage(`✅ ${me.name} answered the ${data.type || "Call"}`, "call-log");

    listenForCandidates();
    await flushCandidates();
}

function subscribeCalls() {
    const unsub = onValue(ref(db, "callSignal"), async (snapshot) => {
        if (!me) return;
        const data = snapshot.val();

        if (!data) {
            if (incomingPrompt) Swal.close();
            if (peerConnection) cleanupCallUI();
            return;
        }

        const isFresh = data.createdAt && Date.now() - data.createdAt < 60000;
        if (data.offer && data.sender !== me.uid && !me.blocked?.[data.sender] && isFresh && !peerConnection && !incomingPrompt) {
            incomingPrompt = true;
            const result = await Swal.fire({
                title: `Incoming ${data.type || "Call"}!`,
                text: `${data.senderName || "Someone"} is calling you...`,
                icon: "info",
                ...swalTheme,
                showCancelButton: true,
                confirmButtonColor: "#10b981",
                cancelButtonColor: "#ef4444",
                confirmButtonText: "Accept",
                cancelButtonText: "Decline"
            });
            incomingPrompt = false;

            if (result.isConfirmed) {
                acceptCall(data);
            } else if (result.dismiss !== Swal.DismissReason.close) {
                handleSendMessage(`❌ Missed Call from ${data.senderName || "someone"}`, "call-log");
                remove(ref(db, "callSignal"));
            }
        }
    });
    sessionUnsubs.push(unsub);
}

function endCall() {
    cleanupCallUI();
    remove(ref(db, "callSignal"));
    handleSendMessage("📴 Call Ended", "call-log");
}

$("startAudioCallBtn").addEventListener("click", () => startCall(false));
$("startVideoCallBtn").addEventListener("click", () => startCall(true));
$("endCallBtn").addEventListener("click", endCall);

$("toggleMicBtn").addEventListener("click", () => {
    if (!localStream) return;
    const tracks = localStream.getAudioTracks();
    const enable = !tracks.every((t) => t.enabled);
    tracks.forEach((t) => (t.enabled = enable));
    $("toggleMicBtn").innerHTML = `<i class="fa-solid ${enable ? "fa-microphone" : "fa-microphone-slash"}"></i>`;
});

$("toggleCamBtn").addEventListener("click", () => {
    if (!localStream) return;
    const tracks = localStream.getVideoTracks();
    if (!tracks.length) return;
    const enable = !tracks.every((t) => t.enabled);
    tracks.forEach((t) => (t.enabled = enable));
    $("toggleCamBtn").innerHTML = `<i class="fa-solid ${enable ? "fa-video" : "fa-video-slash"}"></i>`;
});