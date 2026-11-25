// Standalone cross-device vault, unrelated to Orbit's Gemini chat or local history.
// Access is scoped to the signed-in Firebase user by Firestore Security Rules.
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js';
import { getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, query, orderBy, limit } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js';

const $ = name => document.getElementById(name);
const fbApp = initializeApp(firebaseConfig, 'orbit-standalone-vault');
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
const MAX_BYTES = 650000;
const bytes = value => new TextEncoder().encode(value).length;
let user = null;
let currentId = null;
let records = [];
let unsubscribe = null;
let dirty = false;
let saving = false;

function message(value, error=false, target='status') {
  $(target).textContent = value;
  $(target).classList.toggle('error',error);
}
function updateStats() {
  const value = $('content').value;
  $('count').textContent = `${value ? value.split('\n').length : 0} lines · ${(bytes(value)/1000).toFixed(1)} KB`;
}
function setSaving(value) {
  saving = value;
  $('save').disabled = value;
  $('delete').disabled = value || !currentId;
}
function fresh() {
  currentId = null;
  $('title').value = '';
  $('content').value = '';
  dirty = false;
  setSaving(false);
  updateStats();
  message('New draft. Paste text and save.');
  renderList();
}
function openDraft(item) {
  if (dirty && !confirm('Discard unsaved edits?')) return;
  currentId = item.id;
  $('title').value = item.title;
  $('content').value = item.content;
  dirty = false;
  setSaving(false);
  updateStats();
  message('Loaded from cloud.');
  renderList();
}
function renderList() {
  const list = $('draftList');
  list.replaceChildren();
  if (!records.length) {
    const p=document.createElement('div');
    p.textContent='No saved drafts yet.';
    list.append(p);
    return;
  }
  for (const item of records) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'entry' + (item.id===currentId ? ' active' : '');
    button.textContent = item.title;
    button.onclick = () => openDraft(item);
    list.append(button);
  }
}

$('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  message('Signing in…',false,'loginStatus');
  try {
    await signInWithEmailAndPassword(auth,$('email').value.trim(),$('pass').value);
    $('pass').value='';
    message('',false,'loginStatus');
  } catch (err) { message(`Sign in failed: ${err.code || err.message}`,true,'loginStatus'); }
});
$('signup').onclick = async () => {
  if (!confirm('Create a Firebase account with the entered email and password?')) return;
  message('Creating account…',false,'loginStatus');
  try {
    await createUserWithEmailAndPassword(auth,$('email').value.trim(),$('pass').value);
    $('pass').value='';
    message('',false,'loginStatus');
  } catch (err) { message(`Could not create account: ${err.code || err.message}`,true,'loginStatus'); }
};
$('logout').onclick = () => signOut(auth);
$('new').onclick = () => { if (dirty && !confirm('Discard unsaved edits?')) return; fresh(); };
$('content').addEventListener('input',() => { dirty=true; updateStats(); message('Unsaved edits'); });
$('title').addEventListener('input',() => { dirty=true; message('Unsaved edits'); });
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('content').value); message('Copied to clipboard.'); }
  catch { $('content').focus(); $('content').select(); message('Select and copy the highlighted text manually.',true); }
};
$('save').onclick = async () => {
  if (!user) return message('Sign in first.',true);
  const title=$('title').value.trim(), content=$('content').value;
  if (!title) return message('Enter a draft name.',true);
  if (!content.trim()) return message('Paste some text first.',true);
  if (bytes(content)>MAX_BYTES) return message('Over 650 KB. Split into separate drafts.',true);
  setSaving(true);
  message('Saving to cloud…');
  const now=Date.now();
  const existing=records.find(r => r.id===currentId);
  const draftId=currentId || crypto.randomUUID();
  try {
    await setDoc(doc(db,'users',user.uid,'vaultSnippets',draftId),{
      title,content,createdAt:existing?.createdAt || now,updatedAt:now
    });
    currentId=draftId;
    dirty=false;
    message('Saved to cloud. Open this vault on your other device.');
    renderList();
  } catch (err) { message(`Save failed: ${err.code || err.message}`,true); }
  finally { setSaving(false); }
};
$('delete').onclick = async () => {
  if (!user || !currentId || saving) return;
  if (!confirm('Delete this draft on all devices?')) return;
  setSaving(true);
  try {
    await deleteDoc(doc(db,'users',user.uid,'vaultSnippets',currentId));
    fresh();
    message('Deleted from cloud.');
  } catch(err) { message(`Delete failed: ${err.code || err.message}`,true); }
  finally { setSaving(false); }
};
onAuthStateChanged(auth, nextUser => {
  if (unsubscribe) { unsubscribe(); unsubscribe=null; }
  user=nextUser;
  currentId=null;records=[];dirty=false;
  $('login').classList.toggle('hidden',!!user);
  $('workspace').classList.toggle('hidden',!user);
  $('logout').classList.toggle('hidden',!user);
  if (!user) { $('title').value='';$('content').value='';return; }
  fresh();
  unsubscribe=onSnapshot(query(collection(db,'users',user.uid,'vaultSnippets'),orderBy('updatedAt','desc'),limit(50)),snapshot => {
    records=snapshot.docs.map(item => ({id:item.id,...item.data()}));
    if (currentId && !dirty && !records.some(item=>item.id===currentId)) fresh();
    else renderList();
  }, err => message(`Cloud loading failed: ${err.code || err.message}. Check Firestore setup and rules.`,true));
});
updateStats();
