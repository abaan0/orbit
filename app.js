const $ = id => document.getElementById(id);
const $list = $('threadList');
const $messages = $('messages');
const $empty = $('emptyState');
const $input = $('promptInput');
const $send = $('sendBtn');
const $toast = $('toast');
const $overlay = $('authOverlay');
const $error = $('errorBox');
const STORE = 'orbit-code-chats-v1';
const PASSWORD_STORE = 'orbit-code-password-v1';
let password = sessionStorage.getItem(PASSWORD_STORE) || '';
let threads = [];
let activeId = null;
let busy = false;
let toastTimer;

try {
  const state = JSON.parse(localStorage.getItem(STORE) || '{}');
  if (Array.isArray(state.threads)) {
    threads = state.threads.filter(t => t && typeof t.id === 'string' && Array.isArray(t.messages)).slice(0, 25);
    activeId = state.activeId || null;
  }
} catch { /* ignore invalid saved data */ }

const active = () => threads.find(t => t.id === activeId) || null;
const id = () => (globalThis.crypto?.randomUUID?.() || `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      activeId,
      threads: threads.slice(0, 25).map(t => ({
        ...t,
        messages: t.messages.slice(-50)
      }))
    }));
  } catch { toast('Browser storage is full. Older messages might not be saved.'); }
}

function toast(msg) {
  clearTimeout(toastTimer);
  $toast.textContent = msg;
  $toast.hidden = false;
  toastTimer = setTimeout(() => { $toast.hidden = true; }, 2800);
}

function setError(msg) {
  $error.hidden = !msg;
  $error.textContent = msg || '';
}

function createThread() {
  if (busy) return;
  const t = { id: id(), title: 'New conversation', messages: [], model: $('modelSelect').value, interactionId: null, keySlot: 'primary', created: Date.now() };
  threads.unshift(t);
  activeId = t.id;
  $input.value = '';
  setError('');
  save();
  render();
  $('sidebar').classList.remove('open');
  $input.focus();
}

function removeThread(tid) {
  if (busy || !confirm('Delete this conversation from this browser?')) return;
  threads = threads.filter(t => t.id !== tid);
  if (activeId === tid) activeId = threads[0]?.id || null;
  save();
  render();
}

function groupForThread(time) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const created = typeof time === 'number' ? time : 0;
  if (created >= today) return 'Today';
  if (created >= today - 86400000) return 'Yesterday';
  if (created >= today - 604800000) return 'Previous 7 days';
  return 'Earlier';
}
function renderThreads() {
  $list.replaceChildren();
  const filter = ($('searchChats')?.value || '').trim().toLowerCase();
  let lastGroup = '';
  for (const t of threads.filter(item => !filter || item.title.toLowerCase().includes(filter))) {
    const group = groupForThread(t.created);
    if (group !== lastGroup) {
      const heading = document.createElement('span');
      heading.className = 'thread-group-title';
      heading.textContent = group;
      $list.append(heading);
      lastGroup = group;
    }
    const btn = document.createElement('button');
    btn.className = 'thread-item' + (t.id === activeId ? ' active' : '');
    const icon = document.createElement('span'); icon.className = 'thread-icon'; icon.textContent = '▤';
    const title = document.createElement('span'); title.className = 'thread-title'; title.textContent = t.title;
    const del = document.createElement('button');
    // Separate button is not nested within another button.
    btn.append(icon, title);
    btn.onclick = () => { if (busy) return; activeId = t.id; save(); render(); $('sidebar').classList.remove('open'); };
    del.className = 'thread-delete'; del.title = 'Delete conversation'; del.textContent = '×';
    del.onclick = event => { event.stopPropagation(); removeThread(t.id); };
    const row = document.createElement('div'); row.className = 'thread-row';
    row.style.display = 'flex'; row.style.alignItems = 'center';
    btn.style.flex = '1'; btn.style.minWidth = '0';
    row.append(btn, del);
    $list.append(row);
  }
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function inline(text) {
  const e = escapeHTML(text);
  return e.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
}
function plainMarkdown(text) {
  const paragraphs = [];
  let bullets = [];
  function closeList() { if (bullets.length) { paragraphs.push(`<ul>${bullets.join('')}</ul>`); bullets = []; } }
  let current = [];
  function closeParagraph() { if (current.length) { paragraphs.push(`<p>${current.map(inline).join('<br>')}</p>`); current = []; } }
  for (const line of text.split('\n')) {
    if (!line.trim()) { closeParagraph(); closeList(); continue; }
    if (/^#{1,4}\s+/.test(line)) { closeParagraph(); closeList(); paragraphs.push(`<h3>${inline(line.replace(/^#{1,4}\s+/, ''))}</h3>`); }
    else if (/^[-*]\s+/.test(line)) { closeParagraph(); bullets.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`); }
    else { closeList(); current.push(line); }
  }
  closeParagraph(); closeList();
  return paragraphs.join('');
}
function renderMarkdown(container, text) {
  const parts = String(text).split(/(```[\s\S]*?```)/g);
  parts.forEach(part => {
    if (!part) return;
    if (part.startsWith('```') && part.endsWith('```')) {
      const match = part.match(/^```([^\n]*)\n?([\s\S]*?)```$/);
      if (!match) { const p = document.createElement('p'); p.textContent = part; container.append(p); return; }
      const language = match[1].trim().slice(0, 30) || 'code';
      const source = match[2].replace(/\n$/, '');
      const outer = document.createElement('div'); outer.className = 'code-block';
      const header = document.createElement('div'); header.className = 'code-header';
      const lang = document.createElement('span'); lang.textContent = language;
      const copy = document.createElement('button'); copy.className = 'copy-btn'; copy.textContent = 'Copy code';
      copy.onclick = () => copyText(source, copy);
      const pre = document.createElement('pre'); const code = document.createElement('code');
      code.textContent = source; pre.append(code); header.append(lang, copy); outer.append(header, pre); container.append(outer);
    } else {
      const body = document.createElement('div');
      body.innerHTML = plainMarkdown(part);
      container.append(body);
    }
  });
}
async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) { const old = button.textContent; button.textContent = 'Copied!'; setTimeout(() => { button.textContent = old; }, 1500); }
    else toast('Copied to clipboard');
  } catch { toast('Clipboard unavailable. Select and copy the text manually.'); }
}
function appendMessage(msg) {
  const outer = document.createElement('article'); outer.className = `message ${msg.role}`;
  const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = msg.role === 'user' ? 'U' : '✳';
  const body = document.createElement('div'); body.className = 'message-body';
  const name = document.createElement('div'); name.className = 'message-name'; name.textContent = msg.role === 'user' ? 'You' : `Copilot · ${msg.model || 'Gemini'}${msg.fallbackUsed ? ' (automatic fallback)' : ''}`;
  const content = document.createElement('div'); content.className = 'message-text';
  if (msg.role === 'user') { const p = document.createElement('p'); p.textContent = msg.content; content.append(p); }
  else renderMarkdown(content, msg.content);
  const tools = document.createElement('div'); tools.className = 'message-tools';
  const copy = document.createElement('button'); copy.textContent = '⧉ Copy message'; copy.onclick = () => copyText(msg.content);
  tools.append(copy); body.append(name, content, tools); outer.append(avatar, body); $messages.append(outer);
}
function render() {
  renderThreads();
  $messages.replaceChildren();
  const t = active();
  $empty.hidden = Boolean(t?.messages.length);
  if (t) $('modelSelect').value = t.model || 'gemini-3.8-flash';
  if (t?.messages) t.messages.forEach(appendMessage);
  $('chatScroll').scrollTop = $('chatScroll').scrollHeight;
}
function setBusy(next) {
  busy = next;
  $send.disabled = next;
  $('modelSelect').disabled = next;
  $('clearBtn').disabled = next;
}
function getRecentHistory(messages) {
  // Bound the entire network payload when working with multi-thousand-line ABAP.
  let budget = 600000;
  const out = [];
  for (const item of messages.slice(-30).reverse()) {
    if (!item || typeof item.content !== 'string') continue;
    if (item.content.length > budget) break;
    out.unshift({ role: item.role, content: item.content });
    budget -= item.content.length;
  }
  return out;
}
async function sendMessage(message = $input.value) {
  if (busy || !password || !String(message).trim()) { if (!password) showAuth(); return; }
  const prompt = String(message).trim();
  if (prompt.length > 500000) { setError('Message is too long (maximum 500,000 characters).'); return; }
  if (!active()) createThread();
  const t = active();
  t.messages.push({ role: 'user', content: prompt });
  if (t.title === 'New conversation') t.title = prompt.replace(/\s+/g, ' ').slice(0, 43);
  $input.value = ''; resize(); setError(''); save(); render(); setBusy(true);
  const typing = document.createElement('div'); typing.className = 'typing'; typing.textContent = 'Thinking • • •';
  $messages.append(typing);
  $('chatScroll').scrollTop = $('chatScroll').scrollHeight;
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-app-password': password },
      body: JSON.stringify({ prompt, model: t.model, previousInteractionId: t.interactionId, previousKeySlot: t.keySlot || 'primary', history: getRecentHistory(t.messages.slice(0, -1)) })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error([data.error, data.detail].filter(Boolean).join(' ' ) || `HTTP ${r.status}`), { status: r.status });
    t.interactionId = data.interactionId || null;
    t.keySlot = data.keySlot || 'primary';
    t.messages.push({ role: 'assistant', content: data.reply, model: data.model, fallbackUsed: Boolean(data.fallbackUsed) });
    if (data.fallbackUsed) toast(`Automatic fallback: ${data.model}`);
    if (data.incomplete) setError('This answer may be incomplete. Ask the model to continue before using the code.');
    if (data.contextDropped) setError('Some older chat context could not be sent after switching credentials. Reattach important source files if needed.');
    save();
  } catch (err) {
    if (err.status === 401) { password = ''; sessionStorage.removeItem(PASSWORD_STORE); showAuth('Website password rejected.'); }
    t.messages.pop();
    $input.value = prompt;
    resize();
    setError(err.message || 'Request failed. Check your internet connection.');
    save();
  } finally {
    typing.remove(); setBusy(false); render();
    $('chatScroll').scrollTop = $('chatScroll').scrollHeight;
  }
}
function resize() { $input.style.height = 'auto'; $input.style.height = Math.min($input.scrollHeight, 180) + 'px'; }
function showAuth(error = '') { $overlay.hidden = false; $('authError').hidden = !error; $('authError').textContent = error; $('passwordInput').focus(); }
async function checkHealth() {
  const el = $('statusBadge');
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    const data = await r.json();
    el.textContent = data.server === 'ready' ? '' : 'Setup required';
    el.className = 'status ' + (data.server === 'ready' ? 'ok' : 'bad');
    const dot = document.createElement('i'); el.prepend(dot);
  } catch { el.textContent = 'Server unavailable'; el.className = 'status bad'; const dot = document.createElement('i'); el.prepend(dot); }
}
$('authForm').addEventListener('submit', async event => {
  event.preventDefault();
  const val = $('passwordInput').value;
  const btn = $('authForm').querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = 'Checking…';
  try {
    const r = await fetch('/api/auth', { headers: { 'x-app-password': val }, cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    password = val;
    sessionStorage.setItem(PASSWORD_STORE, password);
    $('passwordInput').value = '';
    $overlay.hidden = true;
    setError('');
    $input.focus();
  } catch (err) { $('authError').hidden = false; $('authError').textContent = err.message; }
  finally { btn.disabled = false; btn.textContent = 'Open workspace →'; }
});
$('sendBtn').addEventListener('click', () => sendMessage());
$input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); } });
$input.addEventListener('input', resize);
$('searchChats').addEventListener('input', renderThreads);
$('attachBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 400000) { setError('This text file is too large for one prompt.'); return; }
  try {
    const source = await file.text();
    const kind = /\.abap$/i.test(file.name) ? 'abap' : 'text';
    const addition = `File: ${file.name}\n\n\`\`\`${kind}\n${source}\n\`\`\``;
    const full = [$input.value.trim(), addition].filter(Boolean).join('\n\n');
    if (full.length > 500000) { setError('Message is too long (maximum 500,000 characters).'); return; }
    $input.value = full;
    setError('');
    resize();
    $input.focus();
  } catch { setError('Could not read this text file.'); }
});
$('newChatBtn').addEventListener('click', createThread);
$('clearBtn').addEventListener('click', () => {
  if (busy) return;
  const t = active();
  if (!t) return;
  if (!confirm('Clear all messages in this conversation?')) return;
  t.messages = []; t.interactionId = null; t.keySlot = 'primary'; t.title = 'New conversation'; save(); render();
});
$('modelSelect').addEventListener('change', event => {
  const t = active();
  if (t && t.model !== event.target.value) {
    t.model = event.target.value;
    // Gemini Interactions API can continue a text conversation across Gemini models.
    save();
    if (t.messages.length) toast('Model changed. Previous conversation is retained where supported.');
  }
});
$('menuBtn').addEventListener('click', () => $('sidebar').classList.toggle('open'));
for (const btn of document.querySelectorAll('[data-prompt]')) btn.addEventListener('click', () => sendMessage(btn.dataset.prompt));
render(); resize(); checkHealth();
if (!password) showAuth();
