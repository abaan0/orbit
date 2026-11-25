// Optional Firebase personal-chat sync. No existing chats are uploaded automatically.
// Large messages / code-heavy conversations cannot be synced by this UI.
// Code Vault and the AI backend are not connected to Firebase.
import { firebaseConfig } from './firebase-config.js';
const style = document.createElement('link');
style.rel = 'stylesheet'; style.href = './firebase-sync.css';
document.head.append(style);
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js';
import {
  getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, query,
  orderBy, limit
} from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js';

// Standalone adapter for Orbit's existing localStorage chat data.
// This mobile-friendly version does not modify Orbit's app.js.
const STORE = 'orbit-code-chats-v1';
let cache = null;
let cachedRaw = null;
let showReload = () => {};
function loadCurrent() {
  const raw = localStorage.getItem(STORE) || '';
  if (cache && raw === cachedRaw) return cache;
  try {
    const parsed = JSON.parse(raw || '{}');
    cache = {
      activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
      threads: Array.isArray(parsed.threads) ? parsed.threads : []
    };
  } catch { cache = {activeId:null, threads:[]}; }
  cachedRaw = raw;
  return cache;
}
function persistCurrent() {
  try {
    cachedRaw = JSON.stringify(loadCurrent());
    localStorage.setItem(STORE, cachedRaw);
  } catch (e) {
    console.warn('Could not save personal chat locally', e);
  }
}
const bridge = {
  getThreads: () => loadCurrent().threads,
  getActiveId: () => loadCurrent().activeId,
  isBusy: () => Boolean(document.getElementById('sendBtn')?.disabled),
  persist: persistCurrent,
  importRemote(remote) {
    if (!remote || !Array.isArray(remote.messages) || this.isBusy()) return;
    const state = loadCurrent();
    let t = state.threads.find(item => item.id === remote.id);
    if (t && (!t.cloudSynced || (t.cloudSyncedAt || 0) >= remote.updatedAt)) return;
    const messages = remote.messages.map(m=>({role:m.role,content:m.content,model:m.model}));
    const select = document.getElementById('modelSelect');
    const validModel = [...(select?.options || [])].some(o=>o.value===remote.model);
    const changes = {title:remote.title,messages,cloudSynced:true,
      cloudSyncedAt:remote.updatedAt,model:validModel?remote.model:'auto',
      interactionId:null,keySlot:'primary'};
    if (t) Object.assign(t, changes);
    else state.threads.unshift({id:remote.id,created:remote.created,...changes});
    persistCurrent();
    showReload();
  }
};

const configured = !Object.values(firebaseConfig).some(v => !v || v.startsWith('PASTE_'));
const nav = document.getElementById('sidebar');
const headerActions = document.querySelector('.top-right');

if (!nav || !headerActions || !bridge) {
  console.warn('Personal sync unavailable: Orbit UI bridge not found');
} else {
  const shell = document.createElement('section');
  shell.className = 'cloud-control';
  shell.innerHTML = `<button id="cloudAccount" type="button">Personal sync · Sign in</button><div class="cloud-state" id="cloudState">Off. Local conversations stay on this browser.</div>`;
  nav.insertBefore(shell, document.querySelector('.section-label'));
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'cloud-current';
  toggle.textContent = 'Sync personal chat';
  headerActions.prepend(toggle);

  // New sync chats are stored locally; Orbit can display them after reload.
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'cloud-current';
  reload.textContent = 'Load synced chats';
  reload.hidden = true;
  reload.onclick = () => location.reload();
  shell.append(reload);
  showReload = () => {reload.hidden = false;};
  const state = shell.querySelector('#cloudState');
  const accountButton = shell.querySelector('#cloudAccount');
  let auth, db, currentUser = null, unsubscribe = null;
  let localDebounce = null;
  let lastRemote = new Map();

  const allThreads = () => bridge.getThreads();
  const active = () => allThreads().find(t => t.id === bridge.getActiveId());
  const tell = text => { state.textContent = text; };
  const isPersonal = t => {
    if (!t || !Array.isArray(t.messages) || t.messages.length > 30) return false;
    let total = 0;
    for (const m of t.messages) {
      if (!m || !['user','assistant'].includes(m.role) || typeof m.content !== 'string') return false;
      total += m.content.length;
      // These are size/content guardrails, not an automatic data classifier.
      if (m.content.length > 1400 || m.content.split('\n').length > 12 ||
          /```|\b(?:REPORT|FORM|ENDFORM|CLASS|ENDCLASS|SELECT|DATA|TYPES)\s+[A-Za-z_]/i.test(m.content)) return false;
    }
    return total <= 12000;
  };

  function repaint() {
    const t = active();
    accountButton.textContent = currentUser ? 'Personal sync · Signed in' : 'Personal sync · Sign in';
    toggle.disabled = !currentUser || !t || bridge.isBusy();
    toggle.textContent = t?.cloudSynced ? 'Cloud sync: On' : 'Sync personal chat';
    if (!configured) tell('Firebase setup required. See README-FIREBASE.md.');
    else if (!currentUser) tell('Off. No chats are uploaded until you sign in and opt in.');
    else tell('Personal chats only. Large/code-heavy chats and Code Vault stay local.');
  }

  function modal() {
    const layer = document.createElement('div');
    layer.className = 'cloud-modal-backdrop';
    const pane = document.createElement('div');
    pane.className = 'cloud-modal';
    const heading = document.createElement('h2'); heading.textContent = 'Personal chat sync';
    const help = document.createElement('p');
    help.textContent = 'Sign in on both devices using the same Firebase account. Only chats you explicitly enable will sync. Do not sync workplace or confidential material.';
    const email = document.createElement('input'); email.type = 'email'; email.placeholder = 'Email'; email.autocomplete = 'email';
    const pass = document.createElement('input'); pass.type = 'password'; pass.placeholder = 'Firebase account password'; pass.autocomplete = 'current-password';
    const errors = document.createElement('div'); errors.className = 'cloud-error';
    const actions = document.createElement('div'); actions.className = 'cloud-actions';
    function action(label, callback) { const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=callback;actions.append(b); }
    const close = () => layer.remove();
    const withAuth = async create => {
      if (!configured) { errors.textContent='Configure Firebase first.'; return; }
      try {
        errors.textContent = '';
        if (create) await createUserWithEmailAndPassword(auth,email.value.trim(),pass.value);
        else await signInWithEmailAndPassword(auth,email.value.trim(),pass.value);
        close();
      } catch (err) { errors.textContent = String(err.code || err.message || err); }
    };
    action('Sign in', () => withAuth(false));
    action('Create account', () => withAuth(true));
    if (currentUser) action('Sign out', async ()=> {await signOut(auth);close();});
    action('Close', close);
    pane.append(heading,help,email,pass,errors,actions);layer.append(pane);
    document.body.append(layer);
  }

  accountButton.onclick = modal;
  toggle.onclick = async () => {
    const t = active();
    if (!currentUser || !t || bridge.isBusy()) return;
    if (t.cloudSynced) {
      if (!confirm('Stop syncing this chat and remove its cloud copy?')) return;
      try {
        await deleteDoc(doc(db,'users',currentUser.uid,'personalChats',t.id));
        t.cloudSynced = false; t.cloudSyncedAt = 0;
        bridge.persist(); repaint();
      } catch (err) { tell('Could not remove cloud copy: '+err.code); }
      return;
    }
    if (!isPersonal(t)) {
      alert('Not eligible for personal sync. This conversation is too long or code-heavy; it will remain local.');return;
    }
    if (!confirm('Sync this conversation to your PERSONAL Firebase project? Only proceed for non-confidential personal messages.')) return;
    try {
      t.cloudSynced = true;
      await push(t);
      bridge.persist();repaint();
    } catch (err) { t.cloudSynced=false; tell('Sync failed: '+(err.code || err.message)); }
  };

  async function push(t) {
    if (!currentUser || !t.cloudSynced) return;
    if (!isPersonal(t)) {
      t.cloudSynced = false;
      bridge.persist();
      tell('Cloud sync stopped: chat became too long or code-heavy. Earlier synced content remains until removed from Firestore.');
      return;
    }
    const updatedAt = Date.now();
    const payload = {
      id:t.id, title:String(t.title || 'Conversation').slice(0,80),
      model:String(t.model || 'auto').slice(0,80),
      created: Number(t.created) || updatedAt,
      updatedAt,
      messages: t.messages.map(({role,content,model}) => ({role,content, ...(model ? {model:String(model).slice(0,80)} : {})}))
    };
    t.cloudSyncedAt = updatedAt;
    await setDoc(doc(db,'users',currentUser.uid,'personalChats',t.id),payload);
  }

  document.addEventListener('orbit:local-change', () => {
    repaint();
    clearTimeout(localDebounce);
    if (!currentUser) return;
    const t = active();
    if (!t?.cloudSynced) return;
    localDebounce = setTimeout(() => push(t).catch(err=>tell('Sync failed: '+(err.code || err.message))), 1000);
  });

  if (configured) {
    const app = initializeApp(firebaseConfig, 'orbit-personal-chat-sync');
    auth = getAuth(app);
    db = getFirestore(app);
    onAuthStateChanged(auth, user => {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      currentUser=user;lastRemote.clear();repaint();
      if (!user) return;
      const q=query(collection(db,'users',user.uid,'personalChats'),orderBy('updatedAt','desc'),limit(50));
      unsubscribe=onSnapshot(q, snap => {
        for (const item of snap.docs) {
          const remote=item.data();
          if (!remote || !remote.id || !isPersonal(remote)) continue;
          if ((lastRemote.get(remote.id)||0)>=remote.updatedAt) continue;
          lastRemote.set(remote.id,remote.updatedAt);
          bridge.importRemote(remote);
        }
        repaint();
      }, error=>tell('Sync unavailable: '+error.code));
    });
  }
  repaint();
}

// Poll only the local in-browser data. Never uploads without per-chat opt-in.
let lastObserved = cachedRaw;
setInterval(() => {
  const raw = localStorage.getItem(STORE) || '';
  if (raw === lastObserved) return;
  lastObserved = raw;
  loadCurrent();
  document.dispatchEvent(new Event('orbit:local-change'));
}, 1300);
