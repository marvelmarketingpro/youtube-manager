/* Marvel Marketing Pro YouTube Manager — runs entirely in the browser.
   Talks straight to the YouTube Data API v3 and YouTube Analytics API with a Google sign-in token.
   No server and no secret keys: only the public OAuth Client ID is stored (in this browser). */
'use strict';

const SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/yt-analytics.readonly'
].join(' ');
const YT = 'https://www.googleapis.com/youtube/v3/';
const YTA = 'https://youtubeanalytics.googleapis.com/v2/reports';
const CATEGORIES = { 22: 'People & Blogs', 27: 'Education', 28: 'Science & Technology', 26: 'Howto & Style', 24: 'Entertainment', 25: 'News & Politics', 1: 'Film & Animation', 10: 'Music', 17: 'Sports', 20: 'Gaming', 23: 'Comedy', 2: 'Autos & Vehicles', 19: 'Travel & Events', 15: 'Pets & Animals', 29: 'Nonprofits & Activism' };
const FILE_CATS = ['Scripts', 'Descriptions', 'Thumbnails', 'Video', 'Other'];

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
const cfg = store.get('mmp_yt_cfg', { clientId: '', defaults: { privacy: 'private', category: '22', tags: '', descFooter: '' } });
const state = { token: null, exp: 0, channel: null, videos: null, playlists: [], demo: false, range: 28, analytics: null, upload: {} };

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => Number(n || 0).toLocaleString('en-US');
const compact = n => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(n || 0));
const fmtDate = s => s ? new Date(s).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
const fmtSize = b => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
const fmtDur = s => { s = Math.round(s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const iso = d => d.toISOString().slice(0, 10);

function toast(msg, err) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' toast--err' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), err ? 8000 : 4000);
}

/* ---------- modal ---------- */
function openModal(html) { $('#modalBox').innerHTML = html; $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; $('#modalBox').innerHTML = ''; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.dataset.close !== undefined) closeModal(); });
function confirmModal(title, text, okLabel) {
  return new Promise(res => {
    openModal(`<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="modal__foot"><button class="btn" id="cNo">Cancel</button><button class="btn btn--danger" id="cYes">${esc(okLabel)}</button></div>`);
    $('#cNo').onclick = () => { closeModal(); res(false); };
    $('#cYes').onclick = () => { closeModal(); res(true); };
  });
}

/* ---------- auth ---------- */
function signedIn() { return !!state.token && Date.now() < state.exp; }
function signIn() {
  if (!cfg.clientId) { location.hash = '#settings'; toast('Add your Google OAuth Client ID first.'); return; }
  if (!(window.google && google.accounts && google.accounts.oauth2)) { toast('Google sign-in has not loaded yet. Check your connection or ad blocker and try again.', true); return; }
  const client = google.accounts.oauth2.initTokenClient({
    client_id: cfg.clientId, scope: SCOPES,
    callback: r => {
      if (r.error) { toast('Sign-in failed: ' + (r.error_description || r.error), true); return; }
      state.token = r.access_token; state.exp = Date.now() + (r.expires_in - 60) * 1000; state.demo = false;
      try { sessionStorage.setItem('mmp_yt_tok', JSON.stringify({ t: state.token, e: state.exp })); } catch (e) {}
      loadChannel();
    },
    error_callback: e => toast('Sign-in was closed or blocked (' + (e.type || 'error') + ').', true)
  });
  client.requestAccessToken();
}
function signOut() {
  if (state.token && window.google && google.accounts) { try { google.accounts.oauth2.revoke(state.token, () => {}); } catch (e) {} }
  Object.assign(state, { token: null, exp: 0, channel: null, videos: null, playlists: [], analytics: null });
  try { sessionStorage.removeItem('mmp_yt_tok'); } catch (e) {}
  render();
}

async function api(url, opts = {}) {
  if (!signedIn()) { state.token = null; render(); throw new Error('Your Google session expired. Sign in again.'); }
  const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + state.token, ...(opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const reason = j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason;
    let m = (j.error && j.error.message) || ('Request failed (' + r.status + ')');
    if (reason === 'quotaExceeded') m = 'Daily YouTube API quota is used up. It resets at midnight Pacific time.';
    if (r.status === 401) { state.token = null; m = 'Your Google session expired. Sign in again.'; }
    throw new Error(m);
  }
  return j;
}
const qs = o => new URLSearchParams(o).toString();

/* ---------- data ---------- */
async function loadChannel() {
  try {
    const j = await api(YT + 'channels?' + qs({ part: 'snippet,statistics,contentDetails', mine: true }));
    if (!j.items || !j.items.length) throw new Error('This Google account has no YouTube channel. Sign in with the account that owns the Marvel Marketing Pro channel.');
    state.channel = j.items[0];
    state.videos = null; state.analytics = null;
    api(YT + 'playlists?' + qs({ part: 'snippet', mine: true, maxResults: 50 })).then(p => { state.playlists = p.items || []; }).catch(() => {});
    toast('Connected to ' + state.channel.snippet.title);
  } catch (e) { toast(e.message, true); }
  render();
}
async function loadVideos(force) {
  if (state.demo) { state.videos = DEMO.videos; return; }
  if (state.videos && !force) return;
  const pl = state.channel.contentDetails.relatedPlaylists.uploads;
  let ids = [], page = '';
  do {
    const j = await api(YT + 'playlistItems?' + qs({ part: 'contentDetails', playlistId: pl, maxResults: 50, ...(page ? { pageToken: page } : {}) }));
    ids = ids.concat((j.items || []).map(i => i.contentDetails.videoId));
    page = j.nextPageToken || '';
  } while (page && ids.length < 500);
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const j = await api(YT + 'videos?' + qs({ part: 'snippet,statistics,status', id: ids.slice(i, i + 50).join(',') }));
    out.push(...(j.items || []));
  }
  out.sort((a, b) => new Date(b.snippet.publishedAt) - new Date(a.snippet.publishedAt));
  state.videos = out;
}
async function loadAnalytics() {
  if (state.demo) { state.analytics = demoAnalytics(state.range); return; }
  const end = new Date(), start = new Date(Date.now() - state.range * 864e5);
  const base = { ids: 'channel==MINE', startDate: iso(start), endDate: iso(end) };
  const [daily, top] = await Promise.all([
    api(YTA + '?' + qs({ ...base, metrics: 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,comments', dimensions: 'day', sort: 'day' })),
    api(YTA + '?' + qs({ ...base, metrics: 'views,estimatedMinutesWatched', dimensions: 'video', sort: '-views', maxResults: 8 }))
  ]);
  const rows = daily.rows || [];
  const sum = i => rows.reduce((a, r) => a + r[i], 0);
  const views = sum(1);
  state.analytics = {
    range: state.range,
    days: rows.map(r => ({ d: r[0], v: r[1] })),
    views, minutes: sum(2),
    avgDur: views ? rows.reduce((a, r) => a + r[3] * r[1], 0) / views : 0,
    subs: sum(4) - sum(5), likes: sum(6), comments: sum(7),
    top: (top.rows || []).map(r => ({ id: r[0], views: r[1], minutes: r[2] }))
  };
}

/* ---------- views ---------- */
const VIEWS = { dashboard: 'Dashboard', videos: 'Videos', upload: 'Upload', files: 'Content Files', settings: 'Settings' };
function currentView() { const v = location.hash.replace('#', ''); return VIEWS[v] ? v : 'dashboard'; }
window.addEventListener('hashchange', render);

function render() {
  const v = currentView();
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.view === v));
  $('#viewTitle').textContent = VIEWS[v];
  $('#topActions').innerHTML = '';
  $('#demoBar').hidden = !state.demo;
  renderAccount();
  const needsAuth = v === 'dashboard' || v === 'videos' || v === 'upload';
  if (needsAuth && !state.demo && !(signedIn() && state.channel)) return renderConnect();
  ({ dashboard: viewDashboard, videos: viewVideos, upload: viewUpload, files: viewFiles, settings: viewSettings })[v]();
}
function renderAccount() {
  const el = $('#account'), c = state.demo ? DEMO.channel : state.channel;
  if (c && (state.demo || signedIn())) {
    el.innerHTML = `<div class="acct">${c.snippet.thumbnails ? `<img src="${esc(c.snippet.thumbnails.default.url)}" alt="">` : ''}<div><b>${esc(c.snippet.title)}</b><span>${state.demo ? 'Sample data' : 'Connected'}</span></div></div>
      <button class="btn btn--ghost btn--sm" id="acctBtn">${state.demo ? 'Exit preview' : 'Sign out'}</button>`;
    $('#acctBtn').onclick = state.demo ? exitDemo : signOut;
  } else {
    el.innerHTML = `<button class="btn btn--ghost btn--sm" id="acctBtn">Connect YouTube</button>`;
    $('#acctBtn').onclick = signIn;
  }
}
function renderConnect() {
  $('#view').innerHTML = `<div class="card empty"><h2>Connect the Marvel Marketing Pro channel</h2>
    <p>${cfg.clientId ? 'Sign in with the Google account that owns the channel to load videos and stats.' : 'One-time setup: add a Google OAuth Client ID in Settings, then sign in with the Google account that owns the channel.'}</p>
    <button class="btn btn--pri" id="cGo">${cfg.clientId ? 'Sign in with Google' : 'Open Settings'}</button>
    <p style="margin-top:14px"><button class="link" id="cDemo">Preview the dashboard with sample data</button></p></div>`;
  $('#cGo').onclick = () => cfg.clientId ? signIn() : (location.hash = '#settings');
  $('#cDemo').onclick = () => { state.demo = true; state.videos = null; state.analytics = null; render(); };
}
function exitDemo() { state.demo = false; state.videos = null; state.analytics = null; render(); }
$('#exitDemo').onclick = exitDemo;
function loading(msg) { $('#view').innerHTML = `<div class="card empty">${esc(msg)}</div>`; }
function fail(e) { $('#view').innerHTML = `<div class="card empty"><h2>Could not load</h2><p>${esc(e.message)}</p><button class="btn" id="retry">Try again</button></div>`; $('#retry').onclick = render; }

async function viewDashboard() {
  const ch = state.demo ? DEMO.channel : state.channel;
  $('#topActions').innerHTML = `<div class="seg" id="range">${[7, 28, 90].map(d => `<button data-d="${d}" class="${state.range === d ? 'on' : ''}">${d} days</button>`).join('')}</div><a class="btn btn--pri" href="#upload">Upload video</a>`;
  $('#range').onclick = e => { const d = +e.target.dataset.d; if (d) { state.range = d; state.analytics = null; render(); } };
  if (!state.analytics || state.analytics.range !== state.range || !state.videos) {
    loading('Loading channel stats…');
    try { await Promise.all([loadAnalytics(), loadVideos()]); } catch (e) { return fail(e); }
    if (currentView() !== 'dashboard') return;
  }
  const a = state.analytics, s = ch.statistics, titles = Object.fromEntries(state.videos.map(v => [v.id, v.snippet.title]));
  const kpi = (l, v, sub) => `<div class="card kpi"><span>${l}</span><b>${v}</b><small>${sub}</small></div>`;
  $('#view').innerHTML = `
    <div class="grid kpis">
      ${kpi('Subscribers', s.hiddenSubscriberCount ? 'Hidden' : compact(s.subscriberCount), (a.subs >= 0 ? '+' : '') + num(a.subs) + ' in ' + a.range + ' days')}
      ${kpi('Views', compact(a.views), 'last ' + a.range + ' days · ' + compact(s.viewCount) + ' all time')}
      ${kpi('Watch time', (a.minutes / 60).toFixed(1) + ' h', 'last ' + a.range + ' days')}
      ${kpi('Avg view duration', fmtDur(a.avgDur), 'minutes:seconds')}
      ${kpi('Likes · Comments', compact(a.likes) + ' · ' + compact(a.comments), 'last ' + a.range + ' days')}
      ${kpi('Videos', num(s.videoCount), 'on the channel')}
    </div>
    <div class="grid cols">
      <div class="card"><h2>Daily views</h2>${chart(a.days)}<p class="note">YouTube Analytics data runs about two days behind.</p></div>
      <div class="card"><h2>Top videos, last ${a.range} days</h2>${a.top.length ? `<ol class="toplist">${a.top.map(t => `<li><span title="${esc(titles[t.id] || t.id)}">${esc(titles[t.id] || t.id)}</span><b>${num(t.views)}</b></li>`).join('')}</ol>` : '<p class="note">No views recorded in this period yet.</p>'}</div>
    </div>
    <div class="card" style="margin-top:14px"><h2>Latest uploads</h2>${state.videos.length ? videoTable(state.videos.slice(0, 5), false) : '<p class="note">No videos yet. Upload the first one.</p>'}</div>`;
}

function chart(days) {
  if (!days.length) return '<p class="note">No daily data for this period yet.</p>';
  const W = 720, H = 240, L = 40, R = 10, T = 12, B = 26, max = Math.max(1, ...days.map(d => d.v));
  const top = Math.ceil(max / Math.pow(10, Math.floor(Math.log10(max)))) * Math.pow(10, Math.floor(Math.log10(max)));
  const x = i => L + (days.length === 1 ? (W - L - R) / 2 : i * (W - L - R) / (days.length - 1));
  const y = v => T + (H - T - B) * (1 - v / top);
  const pts = days.map((d, i) => x(i).toFixed(1) + ',' + y(d.v).toFixed(1));
  const step = Math.max(1, Math.ceil(days.length / 7)), bw = (W - L - R) / days.length;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily views line chart">
    <defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b82f6" stop-opacity=".28"/><stop offset="1" stop-color="#3b82f6" stop-opacity="0"/></linearGradient></defs>
    ${[0, .5, 1].map(f => `<line x1="${L}" x2="${W - R}" y1="${y(top * f)}" y2="${y(top * f)}" stroke="#dbe5f5"/><text x="${L - 6}" y="${y(top * f) + 3}" text-anchor="end">${compact(top * f)}</text>`).join('')}
    <polygon points="${L},${H - B} ${pts.join(' ')} ${x(days.length - 1)},${H - B}" fill="url(#ga)"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="#3370b5" stroke-width="2.2" stroke-linejoin="round"/>
    ${days.map((d, i) => (i % step === 0 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(d.d.slice(5))}</text>` : '') + `<rect class="hit" x="${x(i) - bw / 2}" y="${T}" width="${bw}" height="${H - T - B}"><title>${esc(d.d)}: ${num(d.v)} views</title></rect>`).join('')}
  </svg>`;
}

function statusOf(v) {
  if (v.status.privacyStatus === 'private' && v.status.publishAt) return ['scheduled', 'Scheduled ' + fmtDate(v.status.publishAt)];
  return [v.status.privacyStatus, v.status.privacyStatus[0].toUpperCase() + v.status.privacyStatus.slice(1)];
}
function videoTable(list, actions) {
  return `<div class="tablewrap"><table><thead><tr><th>Video</th><th>Status</th><th class="num">Views</th><th class="num">Likes</th><th class="num">Comments</th>${actions ? '<th></th>' : ''}</tr></thead><tbody>
  ${list.map(v => { const [k, label] = statusOf(v), th = v.snippet.thumbnails && (v.snippet.thumbnails.medium || v.snippet.thumbnails.default); return `<tr>
    <td><div class="vid">${th ? `<img src="${esc(th.url)}" alt="" loading="lazy">` : '<img alt="">'}<div><b>${esc(v.snippet.title)}</b><small>${fmtDate(v.snippet.publishedAt)}</small></div></div></td>
    <td><span class="badge badge--${k}">${esc(label)}</span></td>
    <td class="num">${num(v.statistics.viewCount)}</td><td class="num">${num(v.statistics.likeCount)}</td><td class="num">${num(v.statistics.commentCount)}</td>
    ${actions ? `<td><div class="row-actions"><button class="btn btn--sm" data-edit="${esc(v.id)}">Edit</button><a class="btn btn--sm" target="_blank" rel="noopener" href="https://youtu.be/${esc(v.id)}">Open</a><a class="btn btn--sm" target="_blank" rel="noopener" href="https://studio.youtube.com/video/${esc(v.id)}/analytics">Stats</a><button class="btn btn--sm btn--danger" data-del="${esc(v.id)}">Delete</button></div></td>` : ''}
  </tr>`; }).join('')}</tbody></table></div>`;
}

async function viewVideos() {
  $('#topActions').innerHTML = `<input type="search" id="vq" placeholder="Search titles" style="width:220px"><button class="btn" id="vRefresh">Refresh</button><a class="btn btn--pri" href="#upload">Upload video</a>`;
  if (!state.videos) { loading('Loading videos…'); try { await loadVideos(); } catch (e) { return fail(e); } if (currentView() !== 'videos') return; }
  const draw = () => {
    const q = $('#vq').value.trim().toLowerCase();
    const list = state.videos.filter(v => !q || v.snippet.title.toLowerCase().includes(q));
    $('#view').innerHTML = `<div class="card">${list.length ? videoTable(list, true) : `<div class="empty">${state.videos.length ? 'No videos match that search.' : 'No videos on the channel yet.'}</div>`}</div>`;
  };
  $('#vq').oninput = draw;
  $('#vRefresh').onclick = async () => { loading('Refreshing…'); try { await loadVideos(true); } catch (e) { return fail(e); } draw(); };
  $('#view').onclick = e => {
    const ed = e.target.dataset.edit, del = e.target.dataset.del;
    if (ed) editVideo(state.videos.find(v => v.id === ed));
    if (del) deleteVideo(state.videos.find(v => v.id === del));
  };
  draw();
}

function editVideo(v) {
  openModal(`<h2>Edit video</h2><div class="form">
    <label>Title<input type="text" id="eTitle" maxlength="100" value="${esc(v.snippet.title)}"></label>
    <label>Description<textarea id="eDesc" maxlength="5000">${esc(v.snippet.description)}</textarea></label>
    <label>Tags <small>comma separated</small><input type="text" id="eTags" value="${esc((v.snippet.tags || []).join(', '))}"></label>
    <label>Visibility<select id="ePriv">${['public', 'unlisted', 'private'].map(p => `<option ${v.status.privacyStatus === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
    </div><div class="modal__foot"><button class="btn" data-close>Cancel</button><button class="btn btn--pri" id="eSave">Save changes</button></div>`);
  $('#eSave').onclick = async () => {
    if (state.demo) { closeModal(); return toast('Preview mode: nothing was changed.'); }
    const title = $('#eTitle').value.trim();
    if (!title) return toast('Title is required.', true);
    $('#eSave').disabled = true;
    try {
      const body = { id: v.id, snippet: { title, description: $('#eDesc').value, tags: splitTags($('#eTags').value), categoryId: v.snippet.categoryId }, status: { privacyStatus: $('#ePriv').value, selfDeclaredMadeForKids: !!v.status.selfDeclaredMadeForKids } };
      const j = await api(YT + 'videos?part=snippet,status', { method: 'PUT', body: JSON.stringify(body) });
      Object.assign(v.snippet, j.snippet); Object.assign(v.status, j.status);
      closeModal(); toast('Video updated.'); render();
    } catch (e) { $('#eSave').disabled = false; toast(e.message, true); }
  };
}
async function deleteVideo(v) {
  if (!(await confirmModal('Delete this video?', '"' + v.snippet.title + '" will be permanently removed from YouTube. This cannot be undone.', 'Delete permanently'))) return;
  if (state.demo) return toast('Preview mode: nothing was deleted.');
  try { await api(YT + 'videos?' + qs({ id: v.id }), { method: 'DELETE' }); state.videos = state.videos.filter(x => x.id !== v.id); toast('Video deleted.'); render(); }
  catch (e) { toast(e.message, true); }
}
const splitTags = s => s.split(',').map(t => t.trim()).filter(Boolean);

/* ---------- upload ---------- */
async function viewUpload() {
  const d = cfg.defaults, u = state.upload;
  const files = await db.all().catch(() => []);
  const texts = files.filter(f => isText(f)), imgs = files.filter(f => (f.type || '').startsWith('image/'));
  $('#view').innerHTML = `<div class="card"><div class="form" id="upForm">
    <div class="drop" id="drop"><b id="dropName">${u.file ? esc(u.file.name) + ' · ' + fmtSize(u.file.size) : 'Drop a video file here or click to choose'}</b><span>MP4, MOV, WebM and other formats YouTube accepts</span><input type="file" id="upFile" accept="video/*" hidden></div>
    <label>Title <small>up to 100 characters</small><input type="text" id="upTitle" maxlength="100"></label>
    <label>Description ${texts.length ? `<select id="upFromFile" style="max-width:320px"><option value="">Insert from a content file…</option>${texts.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select>` : ''}
      <textarea id="upDesc" maxlength="5000">${esc(d.descFooter ? '\n\n' + d.descFooter : '')}</textarea></label>
    <label>Tags <small>comma separated</small><input type="text" id="upTags" value="${esc(d.tags)}"></label>
    <div class="two">
      <label>Visibility<select id="upPriv">${['private', 'unlisted', 'public', 'schedule'].map(p => `<option value="${p}" ${d.privacy === p ? 'selected' : ''}>${p === 'schedule' ? 'Schedule (private until date)' : p}</option>`).join('')}</select></label>
      <label>Publish date and time <small>only for scheduled</small><input type="datetime-local" id="upWhen" disabled></label>
    </div>
    <div class="two">
      <label>Category<select id="upCat">${Object.entries(CATEGORIES).map(([k, n]) => `<option value="${k}" ${String(d.category) === k ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
      <label>Add to playlist<select id="upPl"><option value="">None</option>${state.playlists.map(p => `<option value="${esc(p.id)}">${esc(p.snippet.title)}</option>`).join('')}</select></label>
    </div>
    <div class="two">
      <label>Thumbnail <small>JPG or PNG, under 2 MB</small><input type="file" id="upThumb" accept="image/jpeg,image/png"></label>
      <label>Or pick from Content Files<select id="upThumbLib"><option value="">None</option>${imgs.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select></label>
    </div>
    <label class="check"><input type="checkbox" id="upKids"> This video is made for kids</label>
    <label class="check"><input type="checkbox" id="upNotify" checked> Notify subscribers</label>
    <div id="upProg" hidden><div class="progress"><i id="upBar"></i></div><p class="note" id="upMsg" style="margin-top:6px"></p></div>
    <div><button class="btn btn--pri" id="upGo">Upload to YouTube</button></div>
    <p class="note">Keep this tab open until the upload finishes. If your Google Cloud project has not passed YouTube's API audit, YouTube forces API uploads to private; switch visibility in YouTube Studio after uploading.</p>
  </div></div>`;
  const drop = $('#drop'), inp = $('#upFile');
  const setFile = f => { if (!f) return; u.file = f; $('#dropName').textContent = f.name + ' · ' + fmtSize(f.size); if (!$('#upTitle').value) $('#upTitle').value = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 100); };
  drop.onclick = () => inp.click();
  inp.onchange = () => setFile(inp.files[0]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); setFile(e.dataTransfer.files[0]); };
  $('#upPriv').onchange = e => { $('#upWhen').disabled = e.target.value !== 'schedule'; };
  $('#upPriv').onchange({ target: $('#upPriv') });
  const from = $('#upFromFile');
  if (from) from.onchange = async () => { const f = files.find(x => String(x.id) === from.value); if (f) { $('#upDesc').value = await f.blob.text(); from.value = ''; } };
  $('#upGo').onclick = () => doUpload(files);
}

async function doUpload(libFiles) {
  const u = state.upload, title = $('#upTitle').value.trim(), priv = $('#upPriv').value, when = $('#upWhen').value;
  if (state.demo) return toast('Preview mode: connect your channel to upload.');
  if (!u.file) return toast('Choose a video file first.', true);
  if (!title) return toast('Title is required.', true);
  if (priv === 'schedule' && (!when || new Date(when) <= new Date())) return toast('Pick a publish time in the future.', true);
  const status = { privacyStatus: priv === 'schedule' ? 'private' : priv, selfDeclaredMadeForKids: $('#upKids').checked };
  if (priv === 'schedule') status.publishAt = new Date(when).toISOString();
  const meta = { snippet: { title, description: $('#upDesc').value, tags: splitTags($('#upTags').value), categoryId: $('#upCat').value }, status };
  const thumbFile = $('#upThumb').files[0], libId = $('#upThumbLib').value, playlist = $('#upPl').value;
  const thumb = thumbFile || (libId ? (libFiles.find(f => String(f.id) === libId) || {}).blob : null);
  const btn = $('#upGo'), msg = t => { const m = $('#upMsg'); if (m) m.textContent = t; };
  btn.disabled = true; $('#upProg').hidden = false; msg('Starting upload…');
  try {
    if (!signedIn()) throw new Error('Your Google session expired. Sign in again.');
    const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?' + qs({ uploadType: 'resumable', part: 'snippet,status', notifySubscribers: $('#upNotify').checked }), {
      method: 'POST', body: JSON.stringify(meta),
      headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(u.file.size), 'X-Upload-Content-Type': u.file.type || 'application/octet-stream' }
    });
    if (!init.ok) { const j = await init.json().catch(() => ({})); throw new Error((j.error && j.error.message) || 'YouTube rejected the upload (' + init.status + ').'); }
    const loc = init.headers.get('Location');
    if (!loc) throw new Error('YouTube did not return an upload address.');
    const video = await new Promise((res, rej) => {
      const x = new XMLHttpRequest();
      x.open('PUT', loc);
      x.setRequestHeader('Content-Type', u.file.type || 'application/octet-stream');
      x.upload.onprogress = e => { if (e.lengthComputable) { const p = e.loaded / e.total * 100; const b = $('#upBar'); if (b) b.style.width = p.toFixed(1) + '%'; msg(p.toFixed(0) + '% · ' + fmtSize(e.loaded) + ' of ' + fmtSize(e.total)); } };
      x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch (e) {} x.status < 300 ? res(j) : rej(new Error((j.error && j.error.message) || 'Upload failed (' + x.status + ').')); };
      x.onerror = () => rej(new Error('Network error during upload.'));
      x.send(u.file);
    });
    const warn = [];
    if (thumb) { msg('Setting thumbnail…'); try { await api('https://www.googleapis.com/upload/youtube/v3/thumbnails/set?' + qs({ videoId: video.id, uploadType: 'media' }), { method: 'POST', body: thumb, headers: { 'Content-Type': thumb.type || 'image/jpeg' } }); } catch (e) { warn.push('Thumbnail not set: ' + e.message); } }
    if (playlist) { try { await api(YT + 'playlistItems?part=snippet', { method: 'POST', body: JSON.stringify({ snippet: { playlistId: playlist, resourceId: { kind: 'youtube#video', videoId: video.id } } }) }); } catch (e) { warn.push('Not added to playlist: ' + e.message); } }
    state.upload = {}; state.videos = null; state.analytics = null;
    const actual = video.status && video.status.privacyStatus;
    if (actual && actual !== status.privacyStatus) warn.push('YouTube set this video to ' + actual + ' instead of ' + status.privacyStatus + '.');
    $('#view').innerHTML = `<div class="card empty"><h2>Upload complete</h2><p>"${esc(title)}" is on YouTube and still processing. ${warn.map(esc).join(' ')}</p>
      <a class="btn btn--pri" target="_blank" rel="noopener" href="https://studio.youtube.com/video/${esc(video.id)}/edit">Open in YouTube Studio</a> <a class="btn" href="#videos">Go to Videos</a> <button class="btn" id="again">Upload another</button></div>`;
    $('#again').onclick = render;
  } catch (e) { btn.disabled = false; msg('Upload failed.'); toast(e.message, true); }
}

/* ---------- content files (stored in this browser's IndexedDB) ---------- */
const db = {
  open() { return this._p || (this._p = new Promise((res, rej) => { const r = indexedDB.open('mmp_yt_files', 1); r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'id', autoIncrement: true }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); })); },
  async tx(mode, fn) { const d = await this.open(); return new Promise((res, rej) => { const t = d.transaction('files', mode), q = fn(t.objectStore('files')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); },
  all() { return this.tx('readonly', s => s.getAll()); },
  put(f) { return this.tx('readwrite', s => s.put(f)); },
  del(id) { return this.tx('readwrite', s => s.delete(id)); }
};
const isText = f => (f.type || '').startsWith('text/') || /\.(txt|md|srt|vtt|csv|json)$/i.test(f.name);
const guessCat = f => (f.type || '').startsWith('image/') ? 'Thumbnails' : (f.type || '').startsWith('video/') ? 'Video' : isText(f) ? 'Scripts' : 'Other';

async function viewFiles() {
  $('#topActions').innerHTML = `<select id="fCat" style="width:160px"><option value="">All categories</option>${FILE_CATS.map(c => `<option>${c}</option>`).join('')}</select><button class="btn" id="fNew">New text doc</button><button class="btn btn--pri" id="fAdd">Add files</button><input type="file" id="fInp" multiple hidden>`;
  let files;
  try { files = await db.all(); } catch (e) { return fail(new Error('This browser is blocking local file storage.')); }
  const urls = [];
  const draw = () => {
    urls.splice(0).forEach(URL.revokeObjectURL);
    const cat = $('#fCat').value, list = files.filter(f => !cat || f.category === cat).sort((a, b) => b.added - a.added);
    $('#view').innerHTML = (list.length ? `<div class="grid files">${list.map(f => {
      let prev = esc((f.name.split('.').pop() || 'file').slice(0, 4).toUpperCase());
      if ((f.type || '').startsWith('image/')) { const u = URL.createObjectURL(f.blob); urls.push(u); prev = `<img src="${u}" alt="">`; }
      return `<div class="card file"><div class="file__prev">${prev}</div><b title="${esc(f.name)}">${esc(f.name)}</b><small>${esc(f.category)} · ${fmtSize(f.size)} · ${fmtDate(f.added)}</small>
        <div class="row-actions">${isText(f) ? `<button class="btn btn--sm" data-open="${f.id}">Edit</button>` : ''}<button class="btn btn--sm" data-dl="${f.id}">Download</button><button class="btn btn--sm" data-move="${f.id}">Move</button><button class="btn btn--sm btn--danger" data-rm="${f.id}">Delete</button></div></div>`;
    }).join('')}</div>` : `<div class="card empty"><h2>No content files${cat ? ' in ' + esc(cat) : ''} yet</h2><p>Keep scripts, description templates, thumbnails and other working files here. Text docs can be dropped into the description on the Upload page, and images can be used as thumbnails.</p></div>`)
      + `<p class="note" style="margin-top:14px">Files are stored in this browser on this computer only. They are not uploaded anywhere and will not appear on other devices; download anything you need to keep.</p>`;
  };
  const reload = async () => { files = await db.all(); draw(); };
  $('#fCat').onchange = draw;
  $('#fAdd').onclick = () => $('#fInp').click();
  $('#fInp').onchange = async e => {
    for (const f of e.target.files) await db.put({ name: f.name, type: f.type, size: f.size, category: guessCat(f), added: Date.now(), blob: f });
    toast(e.target.files.length + ' file(s) added.'); reload();
  };
  $('#fNew').onclick = () => textDoc(null, reload);
  $('#view').onclick = async e => {
    const t = e.target.dataset, get = id => files.find(f => f.id === +id);
    if (t.open) textDoc(get(t.open), reload);
    if (t.dl) { const f = get(t.dl), a = document.createElement('a'), u = URL.createObjectURL(f.blob); a.href = u; a.download = f.name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 2000); }
    if (t.move) { const f = get(t.move);
      openModal(`<h2>Move "${esc(f.name)}"</h2><div class="form"><label>Category<select id="mCat">${FILE_CATS.map(c => `<option ${c === f.category ? 'selected' : ''}>${c}</option>`).join('')}</select></label></div><div class="modal__foot"><button class="btn" data-close>Cancel</button><button class="btn btn--pri" id="mOk">Move</button></div>`);
      $('#mOk').onclick = async () => { f.category = $('#mCat').value; await db.put(f); closeModal(); reload(); }; }
    if (t.rm) { const f = get(t.rm); if (await confirmModal('Delete this file?', '"' + f.name + '" will be removed from this browser. This cannot be undone.', 'Delete')) { await db.del(f.id); reload(); } }
  };
  draw();
}
async function textDoc(f, done) {
  const text = f ? await f.blob.text() : '';
  openModal(`<h2>${f ? 'Edit' : 'New'} text doc</h2><div class="form">
    <label>File name<input type="text" id="tName" value="${esc(f ? f.name : 'untitled.txt')}"></label>
    <label>Category<select id="tCat">${FILE_CATS.map(c => `<option ${c === (f ? f.category : 'Scripts') ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
    <label>Content<textarea id="tBody" style="min-height:260px">${esc(text)}</textarea></label>
    </div><div class="modal__foot"><button class="btn" data-close>Cancel</button><button class="btn btn--pri" id="tSave">Save</button></div>`);
  $('#tSave').onclick = async () => {
    let name = $('#tName').value.trim() || 'untitled.txt';
    if (!/\.[a-z0-9]+$/i.test(name)) name += '.txt';
    const blob = new Blob([$('#tBody').value], { type: 'text/plain' });
    await db.put({ ...(f ? { id: f.id } : {}), name, type: 'text/plain', size: blob.size, category: $('#tCat').value, added: f ? f.added : Date.now(), blob });
    closeModal(); toast('Saved.'); done();
  };
}

/* ---------- settings ---------- */
function viewSettings() {
  const d = cfg.defaults, origin = location.origin;
  $('#view').innerHTML = `<div class="grid" style="max-width:860px">
    <div class="card"><h2>Google connection</h2><div class="form">
      <label>OAuth Client ID <small>ends in .apps.googleusercontent.com — this is a public identifier, not a password</small><input type="text" id="sClient" value="${esc(cfg.clientId)}" placeholder="1234567890-abc123.apps.googleusercontent.com" autocomplete="off" spellcheck="false"></label>
      <div><button class="btn btn--pri" id="sSave">Save</button> ${signedIn() ? '<button class="btn" id="sOut">Sign out</button>' : '<button class="btn" id="sIn">Sign in with Google</button>'}</div>
    </div></div>
    <div class="card"><h2>One-time Google setup</h2><ol class="steps">
      <li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud Console</a> and create a project (for example "MMP YouTube Manager").</li>
      <li>In <b>APIs &amp; Services → Library</b>, enable <b>YouTube Data API v3</b> and <b>YouTube Analytics API</b>.</li>
      <li>In <b>OAuth consent screen</b>, choose External, fill in the app name and your email, and add the Google account that owns the channel as a <b>Test user</b>.</li>
      <li>In <b>Credentials → Create credentials → OAuth client ID</b>, pick <b>Web application</b> and add this under Authorized JavaScript origins: <code>${esc(origin)}</code></li>
      <li>Copy the Client ID, paste it above, save, then sign in.</li>
    </ol></div>
    <div class="card"><h2>Upload defaults</h2><div class="form">
      <div class="two">
        <label>Default visibility<select id="sPriv">${['private', 'unlisted', 'public'].map(p => `<option ${d.privacy === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
        <label>Default category<select id="sCat">${Object.entries(CATEGORIES).map(([k, n]) => `<option value="${k}" ${String(d.category) === k ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
      </div>
      <label>Default tags <small>comma separated</small><input type="text" id="sTags" value="${esc(d.tags)}"></label>
      <label>Description footer <small>added to the end of every new description</small><textarea id="sFoot">${esc(d.descFooter)}</textarea></label>
      <div><button class="btn btn--pri" id="sSave2">Save defaults</button></div>
    </div></div></div>`;
  $('#sSave').onclick = () => {
    const id = $('#sClient').value.trim();
    if (id && !/\.apps\.googleusercontent\.com$/.test(id)) return toast('That does not look like an OAuth Client ID.', true);
    cfg.clientId = id; store.set('mmp_yt_cfg', cfg); toast('Saved.'); render();
  };
  $('#sSave2').onclick = () => { cfg.defaults = { privacy: $('#sPriv').value, category: $('#sCat').value, tags: $('#sTags').value.trim(), descFooter: $('#sFoot').value.trim() }; store.set('mmp_yt_cfg', cfg); toast('Defaults saved.'); };
  const i = $('#sIn'), o = $('#sOut'); if (i) i.onclick = signIn; if (o) o.onclick = signOut;
}

/* ---------- sample data for the preview ---------- */
const DEMO = {
  channel: { snippet: { title: 'Sample Channel' }, statistics: { subscriberCount: 1240, viewCount: 86400, videoCount: 6 } },
  videos: ['Sample video one', 'Sample video two', 'Sample video three', 'Sample video four', 'Sample video five', 'Sample video six'].map((t, i) => ({
    id: 'demo' + i, snippet: { title: t, description: 'Sample description.', tags: ['sample'], categoryId: '22', publishedAt: new Date(Date.now() - (i * 6 + 2) * 864e5).toISOString() },
    statistics: { viewCount: [4210, 3180, 2650, 1920, 1140, 760][i], likeCount: [212, 160, 131, 88, 54, 31][i], commentCount: [34, 21, 18, 9, 6, 2][i] },
    status: { privacyStatus: i === 0 ? 'private' : i === 3 ? 'unlisted' : 'public', publishAt: i === 0 ? new Date(Date.now() + 3 * 864e5).toISOString() : undefined }
  }))
};
function demoAnalytics(range) {
  const days = [];
  for (let i = range - 1; i >= 0; i--) { const d = new Date(Date.now() - i * 864e5); days.push({ d: iso(d), v: Math.round(260 + 140 * Math.sin(i / 3.1) + 90 * Math.cos(i / 1.7) + (range - i) * 3) }); }
  const views = days.reduce((a, d) => a + d.v, 0);
  return { range, days, views, minutes: views * 2.4, avgDur: 144, subs: Math.round(range * 2.3), likes: Math.round(views * .045), comments: Math.round(views * .006), top: DEMO.videos.slice(1).map(v => ({ id: v.id, views: Math.round(v.statistics.viewCount * range / 90) })) };
}

/* ---------- boot ---------- */
(function boot() {
  try { const s = JSON.parse(sessionStorage.getItem('mmp_yt_tok') || 'null'); if (s && s.e > Date.now()) { state.token = s.t; state.exp = s.e; loadChannel(); } } catch (e) {}
  render();
})();
