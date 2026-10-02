'use strict';
/* AVS 모니터링 — 드라이브의 상태·요약 파일을 읽어 그린다. 자료는 메모리에만 둔다. */

const CFG = Object.assign({ clientId: '', rootFolderName: 'AVS_raw', refreshMinutes: 5, fastSeconds: 15, ackPollSeconds: 20, ackWarnMinutes: 2 }, window.AVS_CONFIG || {});
/* 머리 막대에 작게 보이는 웹 판. 폰·워치 앱과 같은 번호로 맞춘다 — 나란히 놓고 같은 판인지 본다. */
const VERSION = 'v2.1.7';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const DRIVE = 'https://www.googleapis.com/drive/v3/';
const FOLDER = 'application/vnd.google-apps.folder';
const GOAL_HOURS = 100, GOAL_DAYS = 5, GOAL_SUBJECTS = 100;
const RATE = { PPG: 25, ACC: 25, HR: 1, EDA: 1, TEMP: 1 / 60 };
const DEMO = new URLSearchParams(location.search).has('demo');

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = (n) => Number(n || 0).toLocaleString('ko-KR');
const pad = (n) => String(n).padStart(2, '0');
const kstParts = (ms) => { const d = new Date(ms + 9 * 3600e3); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() }; };
const kstHM = (ms) => { if (!ms) return '—'; const p = kstParts(ms); return `${pad(p.h)}:${pad(p.mi)}`; };
const kstDate = (ms) => { const p = kstParts(ms); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; };
const ago = (ms, now) => {
  if (!ms) return '기록 없음';
  const m = Math.round((now - ms) / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}시간 ${m % 60}분 전` : `${Math.floor(h / 24)}일 전`;
};

const state = { token: null, tokenExp: 0, tokenClient: null, phones: [], subjects: [], sel: null, dates: [], days: [], fileIndex: new Map(), manifest: [], events: [], timer: null, loadedAt: 0 };

/* ---------------- 구글 로그인 · 드라이브 ---------------- */

function initAuth() {
  if (!window.google || !google.accounts || !google.accounts.oauth2) { setTimeout(initAuth, 200); return; }
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CFG.clientId,
    scope: SCOPE,
    callback: (resp) => {
      if (resp.error) { banner(`로그인 실패 — ${esc(resp.error)}`, 'bad'); return; }
      state.token = resp.access_token;
      state.tokenExp = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
      signedIn();
    },
  });
}

function requestToken(prompt) {
  return new Promise((resolve, reject) => {
    const prev = state.tokenClient.callback;
    state.tokenClient.callback = (resp) => {
      state.tokenClient.callback = prev;
      if (resp.error) { reject(new Error(resp.error)); return; }
      state.token = resp.access_token;
      state.tokenExp = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
      resolve();
    };
    state.tokenClient.requestAccessToken({ prompt });
  });
}

async function api(path, params = {}, asText = false, retried = false) {
  if (Date.now() > state.tokenExp) await requestToken('');
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(DRIVE + path + (qs ? '?' + qs : ''), { headers: { Authorization: 'Bearer ' + state.token } });
  if (res.status === 401 && !retried) { await requestToken(''); return api(path, params, asText, true); }
  if (!res.ok) throw new Error(`드라이브 ${res.status} — ${path}`);
  return asText ? res.text() : res.json();
}

async function listAll(q, fields = 'id,name,parents,modifiedTime,mimeType') {
  const out = [];
  let pageToken = '';
  do {
    const r = await api('files', { q, fields: `nextPageToken,files(${fields})`, pageSize: 1000, ...(pageToken ? { pageToken } : {}) });
    out.push(...(r.files || []));
    pageToken = r.nextPageToken || '';
  } while (pageToken);
  return out;
}

const fileText = (id) => api(`files/${id}`, { alt: 'media' }, true);
// 같은 파일이 바뀌지 않았으면(수정 시각 같음) 다시 받지 않는다 — 새로 읽기를 가볍게
const textCache = new Map();
async function cachedText(f) {
  const m = f.modifiedTime || '', c = textCache.get(f.id);
  if (m && c && c.m === m) return c.t;
  const t = await fileText(f.id); textCache.set(f.id, { m, t }); return t;
}
// 시간 파일의 첫 줄(헤더)만 — 앞 4KB만 받아 폰 번호·앱 버전·워치 번호를 읽는다
async function fileHead(id) {
  if (Date.now() > state.tokenExp) await requestToken('');
  const res = await fetch(DRIVE + `files/${id}?alt=media`, { headers: { Authorization: 'Bearer ' + state.token, Range: 'bytes=0-4095' } });
  if (!res.ok) return null;
  try { return JSON.parse((await res.text()).split('\n')[0]); } catch (e) { return null; }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = null; } }
  }));
  return out;
}

/* ---------------- CSV ---------------- */

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift() || [];
  return rows.map((r) => Object.fromEntries(head.map((h, j) => [h, r[j] ?? ''])));
}

/* ---------------- 읽기 ---------------- */

// 폰 폴더가 둘이면 같은 이름 파일 중 가장 최근 것
function keepNewest(d, f) { const o = d.files[f.name]; if (!o || String(f.modifiedTime || '') > String(o.modifiedTime || '')) d.files[f.name] = f; }
// 명령은 폰이 읽는 폴더에 써야 한다 — 처리 결과(ack)나 command.json이 있는 폴더, 없으면 status.json이 있는 폴더
function pickFolder(d) { const f = d.files['command_ack.json'] || d.files['command.json'] || d.files['status.json']; d.folderId = (f && (f.parents || [])[0]) || d.folderIds[0]; d.split = d.folderIds.length > 1; }
// v2 — 설정한 루트(AVS_raw_v2) 아래 것만 읽는다(지금 판 AVS_raw와 섞이지 않게)
const childFolders = (parentId, name) => listAll(`'${parentId}' in parents and mimeType='${FOLDER}' and trashed=false${name ? ` and name='${name}'` : ''}`, 'id,name,createdTime');
async function loadDrive() {
  const roots = await listAll(`name='${CFG.rootFolderName}' and mimeType='${FOLDER}' and trashed=false`, 'id,name');
  if (!roots.length) throw new Error('NO_ROOT');
  // 이름이 같은 루트가 여럿이면 subjects나 _system이 있는 것
  let root = roots[0];
  if (roots.length > 1) for (const r of roots) { if ((await childFolders(r.id)).some((c) => c.name === 'subjects' || c.name === '_system')) { root = r; break; } }
  state.rootId = root.id;
  const top = await childFolders(root.id);
  // 같은 이름 폴더가 둘 생겼을 수 있다(폰이 동시에 만듦) — 모두 모은다
  const subjDirs = top.filter((c) => c.name === 'subjects'), sysDirs = top.filter((c) => c.name === '_system');
  const subjFolders = (await Promise.all(subjDirs.map((d) => childFolders(d.id)))).flat();
  const phonesDirs = (await Promise.all(sysDirs.map((d) => childFolders(d.id, 'phones')))).flat();
  const phoneFolders = (await Promise.all(phonesDirs.map((d) => childFolders(d.id)))).flat();
  const subjIds = new Set(subjFolders.map((f) => f.id));
  const [subjectFiles, phoneFiles] = await Promise.all([
    listAll(`name='subject.json' and trashed=false`),
    phoneFolders.length ? listAll(`(name='status.json' or name='command.json' or name='command_ack.json') and trashed=false`) : [],
  ]);
  // 폰 폴더 이름(폰 id)마다 — 폴더가 여럿이면 다 묶고, 파일은 가장 최근 것을 쓴다
  state.phoneDirs = new Map();
  phoneFolders.forEach((f) => { const d = state.phoneDirs.get(f.name) || { folderIds: [], createdTime: f.createdTime, files: {} }; d.folderIds.push(f.id); if (f.createdTime < d.createdTime) d.createdTime = f.createdTime; state.phoneDirs.set(f.name, d); });
  const owner = new Map(phoneFolders.map((f) => [f.id, f.name]));
  phoneFiles.forEach((f) => { const pid = owner.get((f.parents || [])[0]); if (pid) keepNewest(state.phoneDirs.get(pid), f); });
  state.phoneDirs.forEach(pickFolder);
  const phones = (await pool([...state.phoneDirs.entries()].filter(([, d]) => d.files['status.json']), 6, async ([pid, d]) => ({ ...JSON.parse(await cachedText(d.files['status.json'])), _dir: pid }))).filter(Boolean);
  await pool([...state.phoneDirs.values()].filter((d) => d.files['command_ack.json']), 6, async (d) => { d.ack = JSON.parse(await cachedText(d.files['command_ack.json'])); });
  const subjects = (await pool(subjectFiles.filter((f) => subjIds.has((f.parents || [])[0])), 6, async (f) => ({ info: JSON.parse(await cachedText(f)), folderId: (f.parents || [])[0] }))).filter(Boolean);
  return { phones, subjects };
}

async function loadDates(subject) {
  if (DEMO) return demo.dates(subject);
  const folders = await listAll(`'${subject.folderId}' in parents and mimeType='${FOLDER}' and trashed=false`, 'id,name');
  return folders.filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
}

async function loadDay(dateFolder) {
  if (DEMO) return demo.day(dateFolder);
  const files = await listAll(`'${dateFolder.id}' in parents and trashed=false`, 'id,name,size,modifiedTime');
  const get = async (name) => { const f = files.find((x) => x.name === name); return f ? parseCsv(await cachedText(f)) : []; };
  const [manifest, events] = await Promise.all([get('manifest.csv'), get('events.csv')]);
  const mf = files.find((x) => x.name === 'manifest.csv');
  return { manifest, events, manifestAt: mf && mf.modifiedTime ? Date.parse(mf.modifiedTime) : 0, files: files.filter((f) => f.name.endsWith('.ndjson')) };
}

async function refresh() {
  try {
    $('btnRefresh').disabled = true;
    const data = DEMO ? demo.all() : await loadDrive();
    state.phones = data.phones;
    state.subjects = data.subjects.sort((a, b) => (b.info.started_at || 0) - (a.info.started_at || 0));
    state.loadedAt = Date.now();
    if (!state.phones.length && !state.subjects.length) {
      banner('로그인은 됐지만 보이는 파일이 없습니다. 앱이 만든 파일만 보는 권한(drive.file)이라, 이 웹 클라이언트가 폰 앱과 <b>같은 구글 클라우드 프로젝트</b>에 있어야 합니다.', 'bad');
    } else if (!DEMO) banner('', '');
    renderCohort();
    renderCtl();
    renderProgress();
    fillSubjectPicker();
    // 대상자는 고를 때만 읽는다(처음엔 아무것도 읽지 않아 가볍게)
    if (state.sel && state.subjects.find((s) => s.info.subject_id === state.sel)) await selectSubject(state.sel, true); else showPick();
    $('stamp').textContent = `읽음 ${kstHM(state.loadedAt)}`;
  } catch (e) {
    banner(e.message === 'NO_ROOT' ? `드라이브에서 <code>${esc(CFG.rootFolderName)}</code> 폴더를 찾지 못했습니다. 연구실 계정(gachondac)으로 로그인했는지 확인하세요.` : `읽기 실패 — ${esc(e.message)}`, 'bad');
  } finally {
    $('btnRefresh').disabled = false;
  }
}

/* ---------------- 그리기 ---------------- */

function banner(html, kind) {
  const b = $('banner');
  if (!html) { b.hidden = true; return; }
  b.className = 'banner ' + (kind || '');
  b.innerHTML = html;
  b.hidden = false;
}

function renderCohort() {
  const now = Date.now();
  const current = state.subjects.filter(isRunning).length;
  const done = state.subjects.length - current;
  const small = (t) => `<small style="font-size:14px;color:var(--ink3);font-weight:500"> ${t}</small>`;
  $('kpis').innerHTML = [
    ['코호트', `${state.subjects.length}${small('/ ' + GOAL_SUBJECTS + '명')}`],
    ['현재 수집', `${current}${small('명')}`],
    ['수집 완료', `${done}${small('명')}`],
  ].map(([l, v]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('');

  $('progNote').textContent = `${state.subjects.length}명`;
  renderConn();
}

// 연결 상태 — 고른 대상자 폴더의 manifest.csv · events.csv로 만든다 (폰 status.json은 있으면 폰 번호만 보탠다)
const kstMs = (s) => { const t = Date.parse(String(s || '').trim().replace(' ', 'T') + '+09:00'); return isNaN(t) ? 0 : t; };
function renderConn() {
  const now = Date.now(), id = state.sel;
  const sj = id && state.subjects.find((s) => s.info.subject_id === id);
  if (!id || !sj) { $('phonesNote').textContent = ''; $('phones').innerHTML = '<div class="empty">연구번호를 고르면 그 대상자의 워치·폰·드라이브 연결 상태가 나옵니다.</div>'; return; }
  if (state.connFor !== id) { $('phonesNote').textContent = id; $('phones').innerHTML = '<div class="empty">대상자 폴더를 읽는 중…</div>'; return; }
  const man = (state.manifest || []).filter((r) => r.file);
  if (!man.length) { $('phonesNote').textContent = id; $('phones').innerHTML = '<div class="empty">이 대상자 폴더에 manifest.csv가 아직 없습니다.</div>'; return; }
  const run = isRunning(sj);
  const lastRow = man.reduce((a, r) => (+r.last_ts > +a.last_ts ? r : a));
  const lastSample = +lastRow.last_ts || 0;
  const phoneAt = Math.max(0, ...man.map((r) => kstMs(r.updated_kst)));
  const driveAt = Math.max(0, ...(state.days || []).map((d) => d.manifestAt || 0)) || phoneAt;
  const unsynced = man.filter((r) => r.synced !== 'yes').length;
  const total = man.reduce((a, r) => a + Number(r.rows || 0), 0);
  const ph = state.phones.find((p) => p.subject_id === id);
  // 지난 24시간 — 10분 칸. 파일이 덮는 구간에서 워치 끊김(watch_lost~watch_back)을 뺀다. 수집이 끝났으면 마지막 샘플까지의 24시간
  const end = run ? now : (lastSample || now), slot0 = end - 144 * 600e3, from = sj.info.started_at || Math.min(...man.map((r) => +r.first_ts));
  const spans = man.map((r) => [+r.first_ts, +r.last_ts]).filter(([x, y]) => y >= x);
  const evs = (state.events || []).map((e) => ({ code: e.code, ms: kstMs(e.kst) })).filter((e) => e.ms).sort((a, b) => a.ms - b.ms);
  const lost = []; let o = null;
  evs.forEach((e) => { if (e.code === 'watch_lost' && o === null) o = e.ms; if (e.code === 'watch_back' && o !== null) { lost.push([o, e.ms]); o = null; } });
  if (o !== null) lost.push([o, end]);
  const hit = (list, a, b) => list.some(([x, y]) => x < b && y > a);
  const cov = Array.from({ length: 144 }, (_, i) => { const a = slot0 + i * 600e3, b = a + 600e3;
    if (b <= from) return 'pre';
    return hit(spans, a, b) && !lost.some(([x, y]) => x <= a && y >= b) ? 'on' : 'off'; });
  const holes = []; let h0 = null;
  cov.forEach((c, i) => { const t = slot0 + i * 600e3; if (c === 'off' && h0 === null) h0 = t; if (c !== 'off' && h0 !== null) { holes.push([h0, t]); h0 = null; } });
  if (h0 !== null) holes.push([h0, end]);
    const onN = cov.filter((c) => c === 'on').length, cntN = cov.filter((c) => c !== 'pre').length;
  const holeTxt = holes.map(([x, y]) => `${kstHM(x)}–${kstHM(y)}`).join(', ');
  $('phonesNote').textContent = `${id} · 대상자 폴더 기준 · 마지막 갱신 ${kstHM(phoneAt)} (${ago(phoneAt, now)})`;
  $('phones').innerHTML = `<table class="list">
    <thead><tr><th>상태</th><th>대상자</th><th>워치</th><th>스마트폰</th><th>드라이브</th><th class="r">전체 행</th><th style="min-width:240px">지난 24시간</th></tr></thead>
    <tbody><tr class="st-${run ? 'ok' : 'off'} sel">
      <td><span class="pill ${run ? 'ok' : 'off'}">${run ? '수집 중' : '완료'}</span></td>
      <td class="subj">${esc(id)}</td>
      <td data-tip="마지막 샘플 시각">${kstHM(lastSample)} <span class="muted">${ago(lastSample, now)}</span><div class="id">${esc(String(lastRow.watch || '').slice(0, 8) || '—')}</div></td>
      <td data-tip="폰이 manifest를 마지막으로 고친 시각">${kstHM(phoneAt)} <span class="muted">${ago(phoneAt, now)}</span><div class="id">${(() => { const h = state.connHead || ph; return h && h.phone_id ? esc(String(h.phone_id).slice(0, 8)) + (h.app_version ? ' · ' + esc(h.app_version) : '') : '—'; })()}</div></td>
      <td data-tip="드라이브에 manifest가 마지막으로 올라온 시각">${kstHM(driveAt)} <span class="muted">${ago(driveAt, now)}</span>${unsynced ? `<div class="id" style="color:var(--red)">대기 ${unsynced}파일</div>` : ''}</td>
      <td class="r">${fmtInt(total)}</td>
      <td><div class="strip" data-tip="지난 24시간 · 10분 칸 · 자료가 있는 칸 ${onN}/${cntN}${holes.length ? ' · 빈 곳 ' + holeTxt : ''}">${cov.map((c) => `<i${c === 'on' ? ' class="on"' : ''}></i>`).join('')}</div></td>
    </tr></tbody></table>`;
}

// 수집 중인가 — 폰이 지금 이 연구번호를 들고 있거나, 종료 시각이 없거나, 종료 뒤 다시 시작했으면 수집 중
// (같은 번호를 끝냈다 다시 시작하면 폰 앱이 subject.json에 옛 종료 시각을 남기는 경우가 있어 폰 상태로 함께 본다)
function isRunning(s) {
  const i = s.info;
  if (state.phones.some((p) => p.subject_id && p.subject_id === i.subject_id)) return true;
  return !i.ended_at || (i.started_at && i.ended_at < i.started_at);
}
const kstMDHM = (ms) => (ms ? `${kstDate(ms).slice(5)} ${kstHM(ms)}` : '—');

// 대상자 진행 — 표: 번호(등록 순) · 연구번호 · 상태 · 시작 · 종료 · 누적 수집 시간
function renderProgress() {
  if (!state.subjects.length) { $('progress').innerHTML = '<div class="empty">대상자 파일(subject.json)이 없습니다.</div>'; return; }
  const list = state.subjects.slice().sort((a, b) => (a.info.started_at || 0) - (b.info.started_at || 0));
  $('progress').innerHTML = `<table class="list ptab"><thead><tr><th class="r" style="width:44px">No.</th><th>연구번호</th><th>상태</th><th>시작</th><th>종료</th><th style="width:40%">누적 수집</th><th class="r">시간</th></tr></thead><tbody>` +
    list.map((s, k) => {
      const info = s.info, h = (info.total_collected_min || 0) / 60, pct = Math.min(100, (h / GOAL_HOURS) * 100), run = isRunning(s);
      return `<tr data-subject="${esc(info.subject_id)}" class="${state.sel === info.subject_id ? 'sel' : ''}">
        <td class="r num">${k + 1}</td><td class="subj">${esc(info.subject_id)}</td>
        <td><span class="pill ${run ? 'ok' : 'off'}">${run ? '수집 중' : '완료'}</span></td>
        <td>${kstMDHM(info.started_at)}</td><td>${run ? '—' : kstMDHM(info.ended_at)}</td>
        <td><div class="bar" data-tip="${h.toFixed(1)} / ${GOAL_HOURS}시간"><b style="width:${pct}%"></b></div></td>
        <td class="r"><b>${h.toFixed(1)}</b> / ${GOAL_HOURS}시간</td></tr>`;
    }).join('') + '</tbody></table>';
  document.querySelectorAll('#progress tr[data-subject]').forEach((el) => el.addEventListener('click', () => openSubject(el.dataset.subject)));
}

function fillSubjectPicker() {
  $('pickSubject').innerHTML = '<option value="">연구번호 고르기</option>' + state.subjects.map((s) => `<option value="${esc(s.info.subject_id)}">${esc(s.info.subject_id)}</option>`).join('');
  $('pickSubject').value = state.sel || '';
}
function showPick() {
  const m = '<div class="empty">위 «대상자 진행»이나 «연결 상태»에서 연구번호를 누르거나, 오른쪽 위에서 고르면 그 대상자 자료만 불러옵니다.</div>';
  $('fill').innerHTML = m; $('signal').innerHTML = ''; $('pickFile').innerHTML = ''; $('fillLegend').innerHTML = '';
  $('events').innerHTML = '<div class="empty">연구번호를 고르면 그 대상자의 수집 폰 로그가 나옵니다.</div>';
}
// 표에서 누르면 그 대상자를 불러오고 상세 현황으로 내려간다
function openSubject(id) { if (!id) return; selectSubject(id); $('pickSubject').closest('section').scrollIntoView({ behavior: 'smooth', block: 'start' }); }

// 연구번호 하나를 고르면 그 대상자의 날짜 폴더를 모두 읽어 한 번에 보여 준다
async function selectSubject(id, keep) {
  if (!id) { state.sel = null; showPick(); renderCohort(); return; }
  const changed = state.sel !== id;
  state.sel = id;
  if (changed) state.connFor = null;
  $('pickSubject').value = id;
  if (changed) renderCohort();
  document.querySelectorAll('#phones tr[data-subject], #progress tr[data-subject]').forEach((c) => c.classList.toggle('sel', c.dataset.subject === id));
  const subject = state.subjects.find((s) => s.info.subject_id === id);
  if (!subject) return;
  $('fill').innerHTML = '<div class="empty">날짜 폴더를 읽는 중…</div>';
  state.dates = await loadDates(subject);
  const days = await pool(state.dates, 4, async (d) => ({ date: d.name, ...(await loadDay(d)) }));
  state.days = days.filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
  state.manifest = state.days.flatMap((d) => d.manifest.map((r) => ({ ...r, date: d.date })));
  state.events = state.days.flatMap((d) => d.events);
  state.fileIndex = new Map(state.days.flatMap((d) => (d.files || []).map((f) => [f.name, f])));
  state.connFor = id;
  state.connHead = null;
  renderConn();
  // 연결 상태의 스마트폰 칸 — 가장 최근 시간 파일 헤더에 적힌 폰 번호·앱 버전
  const latest = state.manifest.filter((r) => r.file && state.fileIndex.has(r.file)).sort((a, b) => +b.last_ts - +a.last_ts)[0];
  if (latest && !DEMO) fileHead(state.fileIndex.get(latest.file).id).then((h) => { if (h && state.sel === id) { state.connHead = h; renderConn(); } }).catch(() => {});
  renderFill();
  renderEvents();
  initSignal(keep && !changed);
}

// 완전성(수신율, A44 확정) = 받은 행 ÷ (명세 주기 × 수집 기간)
//  수집 기간 = 대상자 시작 ~ 마지막 샘플(종료했으면 종료 시각)
//  시간 파일마다의 기대 구간 = 앞 파일의 마지막 샘플 ~ 이 파일의 마지막 샘플(첫 파일은 대상자 시작부터)
//  → 파일 사이·첫 샘플 전의 빈 시간도 빠짐없이 기대 값에 들어간다
function completeness(tracker) {
  const rate = RATE[tracker], subj = state.subjects.find((s) => s.info.subject_id === state.sel);
  const fs = state.manifest.filter((r) => r.tracker === tracker && r.file).map((r) => ({ r, t0: +r.first_ts, t1: +r.last_ts, n: +r.rows })).filter((f) => f.t1 >= f.t0).sort((a, b) => a.t0 - b.t0);
  if (!fs.length) return { files: fs, byFile: new Map(), pct: null };
  const start = Math.min(fs[0].t0, (subj && subj.info.started_at) || Infinity);
  let prev = start, got = 0;
  fs.forEach((f) => { const from = Math.min(prev, f.t0); f.exp = rate ? Math.max(1, ((f.t1 - from) / 1000) * rate) : 0; f.pct = rate ? Math.min(100, (f.n / f.exp) * 100) : null; got += f.n; prev = Math.max(prev, f.t1); });
  const end = Math.max(prev, (subj && subj.info.ended_at) || 0);
  const exp = rate ? ((end - start) / 1000) * rate : 0;
  return { files: fs, byFile: new Map(fs.map((f) => [f.r.file, f])), start, end, got, exp, rate, pct: rate ? Math.min(100, (got / exp) * 100) : null };
}

function renderFill() {
  const rows = state.manifest;
  if (!rows.length) { $('fill').innerHTML = '<div class="empty">manifest.csv가 없습니다.</div>'; return; }
  const trackers = [...new Set(rows.map((r) => r.tracker))].sort((a, b) => Object.keys(RATE).indexOf(a) - Object.keys(RATE).indexOf(b));
  const dates = state.days.map((d) => d.date);
  const comp = Object.fromEntries(trackers.map((t) => [t, completeness(t)]));
  const byKey = {};
  let totalRows = 0, unsynced = 0;
  rows.forEach((r) => {
    const key = `${r.tracker}|${r.date}|${Number(r.hour)}`, prev = byKey[key], f = comp[r.tracker].byFile.get(r.file) || { n: +r.rows, exp: 0 };
    byKey[key] = prev ? { ...prev, rows: prev.rows + f.n, exp: prev.exp + f.exp } : { r, rows: f.n, exp: f.exp };
    totalRows += Number(r.rows);
    if (r.synced !== 'yes') unsynced++;
  });
  Object.values(byKey).forEach((c) => { c.fill = c.exp ? Math.min(100, (c.rows / c.exp) * 100) : null; });
  const c0 = comp[trackers[0]];
  const bucket = (f) => (f >= 99 ? 's4' : f >= 97 ? 's3' : f >= 90 ? 's2' : f >= 50 ? 's1' : 's0');
  const hours = Array.from({ length: 24 }, (_, h) => h);
  let html = `<div class="summary"><span>기간 <b>${esc(dates[0])}${dates.length > 1 ? ' ~ ' + esc(dates[dates.length - 1]) : ''}</b> (${dates.length}일)</span>
    <span>파일 수 <b>${rows.length}</b></span><span>행 <b>${fmtInt(totalRows)}</b></span>
    <span>완전성 <b>${trackers.map((t) => (trackers.length > 1 ? t + ' ' : '') + (comp[t].pct === null ? '—' : comp[t].pct.toFixed(1) + '%')).join(' · ')}</b></span>
    <span>드라이브에 안 올라간 파일 <b style="color:${unsynced ? 'var(--red)' : 'inherit'}">${unsynced}</b></span></div>`;
  html += '<div class="heat"><table><tr><th class="tr">시간(24시)</th>' + hours.map((h) => `<th>${pad(h)}</th>`).join('') + '</tr>';
  trackers.forEach((t) => {
    if (trackers.length > 1) html += `<tr><th class="grp" colspan="25">${esc(t)}</th></tr>`;
    dates.forEach((d, di) => {
      html += `<tr><th class="tr">${esc(d.slice(5))} <span class="dn">${di + 1}일차</span></th>` + hours.map((h) => {
        const c = byKey[`${t}|${d}|${h}`];
        if (!c) return '<td class="none"></td>';
        const r = c.r;
        const tip = `${esc(t)} ${esc(d)} ${pad(h)}시 · ${fmtInt(c.rows)}행${c.fill !== null ? ' · 완전성 ' + c.fill.toFixed(1) + '%' : ''} · ${esc(String(r.first_kst).slice(11, 16))}–${esc(String(r.last_kst).slice(11, 16))} · ${r.status === 'open' ? '쓰는 중' : '닫힘'} · 드라이브 ${r.synced === 'yes' ? '올림' : '대기'}`;
        const cls = (c.fill === null ? 's2' : bucket(c.fill)) + (r.status === 'open' ? ' open' : '') + (r.synced !== 'yes' ? ' unsync' : '');
        return `<td class="${cls} pick" data-t="${esc(r.first_ts)}" data-tag="${esc(t)}" data-tip="${tip} · 눌러서 측정 값으로">${c.fill === null ? '●' : Math.floor(c.fill)}</td>`;
      }).join('') + '</tr>';
    });
  });
  html += '</table></div>';
  $('fillLegend').innerHTML = `<span><i class="sw" style="background:var(--seq4)"></i>99+</span><span><i class="sw" style="background:var(--seq3)"></i>97–99</span>
    <span><i class="sw" style="background:var(--seq2)"></i>90–97</span><span><i class="sw" style="background:var(--seq1)"></i>50–90</span>
    <span><i class="sw" style="background:var(--seq0)"></i>&lt;50</span><span><i class="sw" style="background:transparent;box-shadow:inset 0 0 0 2px #E0A33A"></i>쓰는 중</span>`;
  $('fill').innerHTML = html;
  document.querySelectorAll('#fill td[data-t]').forEach((td) => td.addEventListener('click', () => {
    if (sig.tag !== td.dataset.tag) { $('pickFile').value = td.dataset.tag; setTracker(td.dataset.tag, +td.dataset.t); }
    else seek(+td.dataset.t);
    $('sigBox') && $('sigBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

const EV = {
  bad: ['store_fail', 'drive_fail', 'drive_error', 'google_lost', 'unreadable', 'convert_fail', 'drive_rename_fail'],
  warn: ['relay_restart', 'relay_timeout', 'space_low', 'watch_switch', 'drive_name_conflict', 'many_roots', 'subject_conflict', 'watch_lost'],
  ok: ['subject_start', 'subject_end', 'google_ok', 'drive_ok', 'watch_back'],
};
const evClass = (code) => (EV.bad.includes(code) ? 'bad' : EV.warn.includes(code) ? 'warn' : EV.ok.includes(code) ? 'ok' : 'info');
const evMark = { bad: '!', warn: '!', ok: '✓', info: 'i' };

// 로그 — 폰이 남긴 events.csv를 그대로 (최근이 위)
function renderEvents() {
  const evs = (state.events || []).filter((e) => e.kst).slice().sort((a, b) => String(b.kst).localeCompare(String(a.kst)));
  if (!evs.length) { $('events').innerHTML = '<div class="empty">events.csv가 없습니다.</div>'; return; }
  const only = $('issuesOnly').checked;
  const list = only ? evs.filter((e) => ['bad', 'warn'].includes(evClass(e.code))) : evs;
  const nIssue = evs.filter((e) => ['bad', 'warn'].includes(evClass(e.code))).length;
  let html = `<div class="summary"><span>전체 <b>${fmtInt(evs.length)}</b>줄</span><span>이슈 <b>${fmtInt(nIssue)}</b>줄</span></div>`;
  html += list.length ? '<div class="logbox"><table class="log"><thead><tr><th>날짜</th><th>시각</th><th></th><th>내용</th><th>코드</th></tr></thead><tbody>' + list.map((e) => {
    const c = evClass(e.code);
    return `<tr class="lv-${c}"><td>${esc(String(e.kst).slice(5, 10))}</td><td>${esc(String(e.kst).slice(11, 19))}</td><td><span class="ic ${c}">${evMark[c]}</span></td><td class="tx">${esc(e.text)}</td><td class="cd">${esc(e.code)}</td></tr>`;
  }).join('') + '</tbody></table></div>' : '<div class="empty">이슈 줄이 없습니다.</div>';
  $('events').innerHTML = html;
}


/* ---------------- 대상자 관리 (v2) — 웹 → 드라이브 command.json → 폰(3분) → 워치 ---------------- */

const ID_RULE = /^[A-Za-z0-9_-]{1,32}$/;
const WSTATE = { collecting: ['ok', '수집 중'], charging: ['off', '충전 중 · 수집 안 함'], off_wrist: ['off', '미착용 · 수집 안 함'], stopped: ['warn', '멈춤(워치에서)'], standby: ['off', '대기'], needs_open: ['bad', '앱 열기 필요'], no_permission: ['bad', '권한 없음'] };
const ctl = { open: null, pending: new Map(), timer: null, poll: null };   // pending: 폰 → {seq, cmd, at}

function phoneDir(pid) { return (state.phoneDirs && state.phoneDirs.get(pid)) || null; }
function ackOf(pid) { const d = phoneDir(pid); return d && d.ack; }

// 명령 하나의 상태 — 보냄(대기) · 반영됨 · 거절 · 오래 대기
function cmdState(pid) {
  const p = ctl.pending.get(pid), a = ackOf(pid), now = Date.now();
  if (p && (!a || a.seq < p.seq)) {
    const min = Math.floor((now - p.at) / 60e3);
    return min >= CFG.ackWarnMinutes ? ['bad', `반영 안 됨 · ${min}분 — 폰·망 확인`] : ['wait', `보냄 · 폰 확인 대기${min ? ` ${min}분` : ''}`];
  }
  if (!a) return ['', '—'];
  const t = `${kstHM(a.applied_at)} ${({ start: '시작', end: '종료', rename: '번호 고침', sync_now: '지금 보내기' })[a.action] || ''}`;
  return a.result === 'ok' ? ['ok', `반영됨 ${t}`] : ['bad', `${a.result === 'rejected' ? '거절' : '실패'} ${t} — ${a.reason || ''}`];
}

// 폰 첫 화면 — 폰이 status.json 의 home 칸에 그대로 적어 보낸다(Z-3). 옛 앱이면 다른 칸으로 비슷하게
function homeOf(p, now) {
  if (p.home && p.home.lines) return p.home;
  const w = p.last_sample_at && now - p.last_sample_at <= 10e3 ? ['ok', `받는 중 · ${ago(p.last_sample_at, now)}`] : p.last_sample_at ? ['bad', `안 옵니다 · ${ago(p.last_sample_at, now)}`] : ['bad', '아직 받은 것이 없습니다'];
  return { subject: { title: p.subject_id || '연구번호 없음', missing: !p.subject_id, note: '', goal: '' },
    lines: [{ label: '워치', text: w[1] + (p.watch_device_id ? ' · ' + String(p.watch_device_id).slice(0, 8) : ''), tone: w[0] },
      { label: '드라이브', text: p.drive_last_ok_at ? `올림 · ${ago(p.drive_last_ok_at, now)} · 밀린 것 ${p.drive_pending_files || 0}` : '아직 올린 것이 없습니다', tone: p.google_connected === false ? 'wait' : 'ok' }], remote_note: '' };
}

// 오른쪽 메뉴 MONITOR 1 · 2 … — 누르면 그 폰의 화면이 열리고, 다시 누르면 닫힌다(여럿 열 수 있음)
function phoneList() {
  const dirs = state.phoneDirs ? [...state.phoneDirs.entries()] : [];
  return dirs.sort((x, y) => String(x[1].createdTime || x[0]).localeCompare(String(y[1].createdTime || y[0]))).map(([pid]) => pid);
}
function renderCtl() {
  const list = phoneList(), now = Date.now();
  if (!ctl.drawers) ctl.drawers = new Set();
  const rail = $('rail'); rail.hidden = false; document.body.classList.add('has-rail');
  rail.innerHTML = '<div class="rail-h">폰 화면</div>' + (list.length ? list.map((pid, i) => {
    const p = state.phones.find((x) => x._dir === pid) || {}, stale = !p.at || now - p.at > 3 * 60e3, tone = (homeOf(p, now).lines || []).some((l) => l.tone === 'bad') ? 'bad' : stale ? 'warn' : 'ok';
    return `<button class="rail-b${ctl.drawers.has(pid) ? ' on' : ''}" data-pid="${esc(pid)}" title="${esc(pid)}"><i class="dot ${tone}"></i><b>MONITOR ${i + 1}</b><span>${esc(pid.slice(0, 8))}</span><span>${esc(currentSubject(pid) || '연구번호 없음')}</span></button>`;
  }).join('') : '<div class="rail-e">v2 폰이 아직 없습니다</div>');
  rail.querySelectorAll('.rail-b').forEach((b) => (b.onclick = () => { const pid = b.dataset.pid; ctl.drawers.has(pid) ? ctl.drawers.delete(pid) : ctl.drawers.add(pid); renderCtl(); }));
  [...ctl.drawers].forEach((pid) => { if (!list.includes(pid)) ctl.drawers.delete(pid); });
  $('drawers').innerHTML = [...ctl.drawers].map((pid) => drawerHtml(pid, list.indexOf(pid) + 1, now)).join('');
  document.querySelectorAll('#drawers .drawer').forEach((dw) => {
    const pid = dw.dataset.pid;
    dw.querySelector('.dw-x').onclick = () => { ctl.drawers.delete(pid); renderCtl(); };
    dw.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => {
      if (b.dataset.act === 'sync') { if (isPending(pid)) { alertLine(pid, '앞 명령이 아직 반영되지 않았습니다 — 반영된 뒤 보내세요'); return; } b.disabled = true; sendCommand(pid, { action: 'sync_now' }).then(() => { renderCtl(); watchAcks(); }).catch((e) => { b.disabled = false; alertLine(pid, '보내기 실패 — ' + e.message); }); return; }
      openForm(pid, b.dataset.act);
    }));
  });
  document.querySelectorAll('#drawers details.diag').forEach((dt) => { const pid = dt.closest('.drawer').dataset.pid; if (ctl.diagOpen && ctl.diagOpen.has(pid)) { dt.open = true; diag(pid, dt.querySelector('.diag-b')); }
    dt.addEventListener('toggle', () => { ctl.diagOpen = ctl.diagOpen || new Set(); if (dt.open) { ctl.diagOpen.add(pid); diag(pid, dt.querySelector('.diag-b')); } else ctl.diagOpen.delete(pid); }); });
  if (ctl.open && ctl.drawers.has(ctl.open.pid)) openForm(ctl.open.pid, ctl.open.act, true);
}

// 워치마다 한 줄(A59) — 폰이 status.json 의 watches 로 올린 것을 그대로. 없으면(2.1.6 이하) 옛 한 줄
const WTONE = { ok: 'ok', wait: 'off', warn: 'warn', bad: 'bad' };
function watchRows(p, w, ws) {
  const list = Array.isArray(p.watches) ? p.watches.filter((x) => x && x.id) : [];
  if (!list.length) return `<div><span class="k">워치</span> ${w.state ? `<span class="pill ${ws[0]}">${ws[1]}</span>` : '<span class="muted">—</span>'} <span class="id">${esc(String(w.id || p.watch_device_id || '').slice(0, 8))}${w.at ? ' · ' + kstHM(w.at) : ''}</span></div>`;
  return list.map((x) => {
    const st = WSTATE[x.state] || ['', x.state ? esc(x.state) : '—'];
    const tone = WTONE[x.tone] || st[0];
    const text = x.line ? String(x.line).replace(/\s*·\s*[0-9a-f]{8}$/i, '') : st[1];
    return `<div><span class="k">워치</span> <span class="pill ${tone}" title="${esc(x.reason || '')}">${esc(text)}</span> <span class="id">${esc(String(x.id).slice(0, 8))}${x.connected === false ? ' · 끊김' : ''}${x.state_at ? ' · ' + kstHM(x.state_at) : ''}</span></div>`;
  }).join('');
}
function drawerHtml(pid, n, now) {
  const p = state.phones.find((x) => x._dir === pid) || {}, a = ackOf(pid) || {}, w = a.watch && (a.watch.at || 0) > ((p.watch_control || {}).at || 0) ? a.watch : (p.watch_control || {});
  const sub = currentSubject(pid), h = JSON.parse(JSON.stringify(homeOf(p, now))), ws = WSTATE[w.state] || ['', w.state ? esc(w.state) : '—'], cs = cmdState(pid), stale = p.at ? now - p.at : Infinity;
  // 폰이 명령을 처리한 결과(ack)가 폰 화면 파일(status.json)보다 새것이면 연구번호는 결과를 따른다 — 폰 화면 파일은 1분 뒤에 따라온다
  const ackNewer = a.applied_at && a.applied_at > (p.at || 0) && a.result === 'ok' && a.action !== 'sync_now';
  if (ackNewer && h.subject && (h.subject.title !== (sub || '연구번호 없음'))) h.subject = sub ? { title: sub, note: '폰 화면 갱신 대기 · 명령은 반영됨', goal: '', missing: false } : { title: '연구번호 없음', missing: true, note: '폰 화면 갱신 대기 · 명령은 반영됨' };
  const lines = (h.lines || []).map((l) => `<div class="pl"><i class="dot ${esc(l.tone)}"></i><b>${esc(l.label)}</b><span>${esc(l.text)}</span></div>`).join('');
  return `<section class="drawer" data-pid="${esc(pid)}">
    <div class="dw-h"><b>MONITOR ${n}</b><span class="muted">${esc(pid.slice(0, 8))} · ${esc(p.app_version || '')}</span><button class="dw-x" title="닫기">✕</button></div>
    <div class="phone">
      <div class="phead"><span class="ph-brand"><img src="assets/daclab-mark.png" alt="" width="14" height="15">AVS 모니터링</span><span class="ph-id">${esc(pid.slice(0, 8))}</span></div>
      <div class="pbar"><span>폰 화면</span><span class="${stale > 3 * 60e3 ? 'old' : ''}">${p.at ? kstHM(p.at) + ' · ' + ago(p.at, now) : '상태 없음'}</span></div>
      <div class="psub ${h.subject && h.subject.missing ? 'none' : ''}"><div class="pl1">연구번호</div><div class="pt">${esc(h.subject ? h.subject.title : '—')}</div>
        <div class="pn">${esc([h.subject && h.subject.note, h.subject && h.subject.goal].filter(Boolean).join(' · '))}</div>
        ${h.subject && h.subject.progress ? `<div class="pprog"><b style="width:${Math.min(100, h.subject.progress * 100)}%"></b></div>` : ''}</div>
      <div class="plines">${lines}</div>
      ${h.remote_note ? `<div class="premote">${esc(h.remote_note)}</div>` : ''}
      <div class="pbtns"><button class="btn sm" data-act="start">시작</button><button class="btn ghost sm" data-act="rename"${sub ? '' : ' disabled'}>번호 고치기</button><button class="btn danger sm" data-act="end"${sub ? '' : ' disabled'}>종료</button><button class="btn ghost sm" data-act="sync">지금 보내기</button></div>
      <div class="pfoot"><img class="pf-logo" src="assets/daclab-logo.png" alt="DAC LAB" width="53" height="16"><span class="pf-lic">© 2026 Minsik Lim. All rights reserved.${p.app_version ? ' · v' + esc(p.app_version) : ''}</span><span class="pf-pt"><img src="assets/gil-logo.png" alt="가천대 길병원" width="76" height="16"><img src="assets/gachon-logo.png" alt="가천대학교" width="66" height="16"></span></div>
    </div>
    <div class="dw-info">
      ${watchRows(p, w, ws)}
      <div><span class="k">명령</span> <span class="cmdst ${cs[0]}">${esc(cs[1])}</span></div>
      ${stale > 3 * 60e3 && p.at ? `<div class="warnline">폰 화면이 ${ago(p.at, now)} 것입니다 — 폰·망을 확인하세요</div>` : ''}
      ${!p.at ? '<div class="warnline">폰 상태 파일(status.json)을 아직 못 찾았습니다</div>' : ''}
      ${(phoneDir(pid) || {}).split ? `<div class="warnline">이 폰 폴더가 드라이브에 ${(phoneDir(pid) || {}).folderIds.length}개 있습니다 — 모두 읽습니다</div>` : ''}
      <div class="muted small">화면은 15초마다 새로 봄(폰은 1분마다 올림) · 명령은 폰이 15초마다 읽습니다</div>
    </div>
    <div class="dform"></div>
    <details class="diag"><summary>로그</summary><div class="diag-b" data-diag="${esc(pid)}">여는 중…</div></details>
  </section>`;
}
const formBox = (pid) => document.querySelector(`#drawers .drawer[data-pid="${CSS.escape(pid)}"] .dform`);
const alertLine = (pid, t) => { const f = formBox(pid); if (f) f.innerHTML = `<div class="ctl-form"><div class="msg">${esc(t)}</div></div>`; };

// 빠른 새로 읽기 — 15초마다 폰 폴더의 status.json · command_ack.json 목록(수정 시각)만 한 번에 묻고,
// 바뀐 파일만 받는다. 폰의 연구번호·워치가 바뀌면 대상자 목록도 곧바로 다시 읽는다(전체는 5분마다)
function pollPhones(delay) { if (delay !== undefined) fastPoll(delay); }
function fastPoll(delay = 0) {
  clearTimeout(ctl.fast);
  ctl.fast = setTimeout(async () => {
    try { if (!document.hidden && state.token && !DEMO && state.phoneDirs && state.phoneDirs.size) await fastOnce(); }
    catch (e) { /* 다음에 */ }
    finally { fastPoll(CFG.fastSeconds * 1000); }
  }, delay);
}
async function fastOnce() {
  const all = [...state.phoneDirs.entries()], ids = all.flatMap(([, d]) => d.folderIds || [d.folderId]);
  const owner = new Map(all.flatMap(([pid, d]) => (d.folderIds || [d.folderId]).map((id) => [id, pid])));
  const fs = await listAll(`(${ids.map((id) => `'${id}' in parents`).join(' or ')}) and (name='status.json' or name='command_ack.json' or name='command.json') and trashed=false`, 'id,name,modifiedTime,parents');
  const before = new Map(state.phones.map((p) => [p._dir, `${p.subject_id}|${p.watch_device_id}|${p.at}`]));
  all.forEach(([, d]) => { d.files = {}; });
  fs.forEach((f) => { const pid = owner.get((f.parents || [])[0]); if (pid) keepNewest(state.phoneDirs.get(pid), f); });
  let subjChanged = false;
  await pool(all, 4, async ([pid, d]) => {
    if (d.folderIds) pickFolder(d);
    if (d.files['status.json']) {
      const st = { ...JSON.parse(await cachedText(d.files['status.json'])), _dir: pid }, i = state.phones.findIndex((x) => x._dir === pid);
      const old = i >= 0 ? state.phones[i] : null;
      if (!old || old.subject_id !== st.subject_id) subjChanged = true;
      if (i >= 0) state.phones[i] = st; else state.phones.push(st);
    }
    if (d.files['command_ack.json']) d.ack = JSON.parse(await cachedText(d.files['command_ack.json']));
  });
  const changed = state.phones.some((p) => before.get(p._dir) !== `${p.subject_id}|${p.watch_device_id}|${p.at}`);
  if (subjChanged || state.phones.some((p) => p.subject_id && !state.subjects.some((x) => x.info.subject_id === p.subject_id))) quickRefresh();
  else if (changed) { renderCtl(); renderCohort(); }
}
// 연구번호가 바뀌었을 때 — 대상자 목록(subject.json)까지 다시 읽되 겹치지 않게(바뀐 파일만 받으므로 가벼움)
let quickT = null;
function quickRefresh() { clearTimeout(quickT); quickT = setTimeout(() => refresh(), 1500); }
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.token && !DEMO) fastPoll(0); });

function currentSubject(pid) {
  const p = state.phones.find((x) => x._dir === pid) || {}, a = ackOf(pid) || {};
  return a.subject_id_now !== undefined && (a.applied_at || 0) > (p.at || 0) ? a.subject_id_now : p.subject_id;
}

// 로그 — 명령 기록. 맨 위는 지금 명령·결과(드라이브의 command.json · command_ack.json, 바로 보임),
// 그 아래는 폰 기록(_system/phones/<폰>/logs/<날짜>.ndjson — 올리기 회차에 올라오므로 몇 분 늦을 수 있음)
const LOG_CODES = /원격|대상자 시작|대상자 종료|연구번호|지금 보내기|가져/;
const ACT = { start: '시작', end: '종료', rename: '번호 고침', sync_now: '지금 보내기' };
async function diag(pid, box) {
  const d = phoneDir(pid); if (!d) { box.textContent = '폰 폴더 없음'; return; }
  const rows = [];
  const pe = ctl.pending.get(pid), a = d.ack;
  if (pe && (!a || a.seq < pe.seq)) rows.push([pe.at, '보냄', `${ACT[pe.cmd.action] || pe.cmd.action} ${pe.cmd.subject_id || ''}${pe.cmd.rename_to ? ' → ' + pe.cmd.rename_to : ''} · 폰 확인 대기`]);
  if (a && a.applied_at) rows.push([a.applied_at, a.result === 'ok' ? '반영됨' : a.result === 'rejected' ? '거절' : '실패', `${ACT[a.action] || a.action} ${a.subject_id_now || ''}${a.reason ? ' · ' + a.reason : ''}`]);
  if (!DEMO) {
    try {
      for (const id of (d.folderIds || [d.folderId])) {
        const logDir = (await listAll(`'${id}' in parents and name='logs' and mimeType='${FOLDER}' and trashed=false`, 'id'))[0];
        if (!logDir) continue;
        const fs = (await listAll(`'${logDir.id}' in parents and trashed=false`, 'id,name')).sort((x, y) => y.name.localeCompare(x.name)).slice(0, 2);
        for (const f of fs) (await fileText(f.id)).split('\n').forEach((ln) => { try { const e = JSON.parse(ln); if (LOG_CODES.test(e.code || '')) rows.push([e.at, e.code, String(e.detail || '')]); } catch (err) { /* 빈 줄 */ } });
      }
    } catch (e) { rows.push([Date.now(), '로그 읽기 실패', e.message]); }
  }
  const seen = new Set();
  const list = rows.filter((r) => { const k = r[0] + r[1] + r[2]; if (seen.has(k)) return false; seen.add(k); return true; }).sort((x, y) => y[0] - x[0]).slice(0, 60);
  box.innerHTML = list.length ? '<table class="loglist">' + list.map(([t, c, x]) => `<tr><td>${kstDate(t).slice(5)} ${kstFull(t).slice(0, 5)}</td><td><b>${esc(c)}</b></td><td>${esc(x)}</td></tr>`).join('') + '</table><div class="muted small">폰 기록은 올리기 회차(15분 · 지금 보내기)에 맞춰 늦게 보일 수 있습니다</div>' : '<span class="muted">아직 명령 기록이 없습니다</span>';
}
function isPending(pid) { const p = ctl.pending.get(pid), a = ackOf(pid); return !!p && (!a || a.seq < p.seq); }
function openForm(pid, act, keep) {
  if (isPending(pid)) { alertLine(pid, '앞 명령이 아직 반영되지 않았습니다 — 반영된 뒤 보내세요(명령은 하나씩 갑니다)'); return; }
  ctl.open = { pid, act };
  const cur = currentSubject(pid), box = formBox(pid); if (!box) return;
  const what = act === 'start' ? `폰 <b>${esc(pid.slice(0, 8))}</b>에서 새 연구번호로 수집을 시작합니다${cur ? ` — 지금 <b>${esc(cur)}</b>는 종료됩니다` : ''}. 폰이 명령을 읽는 대로(15초 안팎) 그때부터 받는 자료가 이 번호로 갑니다. 워치는 착용 중이면 계속 수집합니다.`
    : act === 'end' ? `폰 <b>${esc(pid.slice(0, 8))}</b>의 <b>${esc(cur)}</b> 수집을 종료합니다. 그 뒤 받는 자료는 연구번호 없이(<code>_unassigned</code>) 쌓입니다. 확인으로 연구번호를 한 번 더 넣으세요.`
    : `<b>${esc(cur)}</b>의 연구번호를 고칩니다. 드라이브 폴더와 파일 머리의 번호가 바뀌고, 자료는 지우지 않습니다.`;
  if (keep && box.dataset.k === pid + act) return;
  box.dataset.k = pid + act;
  box.innerHTML = `<div class="ctl-form"><div class="what">${what}</div>
    <label>${act === 'end' ? '연구번호 확인' : act === 'rename' ? '새 연구번호' : '연구번호'}<input id="cf1" autocomplete="off" spellcheck="false"></label>
    ${act === 'end' ? '' : '<label>한 번 더<input id="cf2" autocomplete="off" spellcheck="false"></label>'}
    <button class="btn" id="cfGo">${act === 'start' ? '시작 보내기' : act === 'end' ? '종료 보내기' : '고치기 보내기'}</button>
    <button class="btn ghost" id="cfNo">닫기</button><div class="msg" id="cfMsg"></div></div>`;
  const q = (id) => box.querySelector('#' + id);
  q('cfNo').onclick = () => { ctl.open = null; box.innerHTML = ''; box.dataset.k = ''; };
  q('cfGo').onclick = () => submitForm(pid, act);
  q('cf1').focus();
}

async function submitForm(pid, act) {
  const box = formBox(pid), q = (id) => box.querySelector('#' + id);
  const v1 = q('cf1').value.trim(), v2 = q('cf2') ? q('cf2').value.trim() : v1, cur = currentSubject(pid), msg = q('cfMsg');
  const exists = (id) => state.subjects.some((s) => s.info.subject_id === id);
  let cmd;
  if (act === 'end') {
    if (v1 !== cur) { msg.textContent = `지금 연구번호(${cur})와 다릅니다`; return; }
    cmd = { action: 'end', subject_id: cur };
  } else {
    if (!v1) { msg.textContent = '연구번호를 넣으세요'; return; }
    if (v1 !== v2) { msg.textContent = '두 번 넣은 값이 다릅니다'; return; }
    if (!ID_RULE.test(v1) || v1 === '_unassigned') { msg.textContent = '영문·숫자·- _ 만, 32자까지'; return; }
    if (exists(v1) || v1 === cur) { msg.textContent = '이미 있는 연구번호입니다'; return; }
    cmd = act === 'start' ? { action: 'start', subject_id: v1 } : { action: 'rename', subject_id: cur, rename_to: v1 };
  }
  q('cfGo').disabled = true; msg.textContent = '보내는 중…';
  try {
    await sendCommand(pid, cmd);
    ctl.open = null; box.innerHTML = ''; box.dataset.k = '';
    renderCtl(); watchAcks();
  } catch (e) { msg.textContent = '보내기 실패 — ' + e.message; q('cfGo').disabled = false; }
}

// command.json을 같은 파일 id에 덮어쓴다(없으면 만든다). seq는 앞 명령·처리 결과보다 1 크게
async function sendCommand(pid, body) {
  const d = phoneDir(pid); if (!d) throw new Error('폰 폴더 없음');
  let prev = 0;
  if (d.files['command.json'] && !DEMO) { try { prev = JSON.parse(await fileText(d.files['command.json'].id)).seq || 0; } catch (e) { prev = 0; } }
  prev = Math.max(prev, (d.ack && d.ack.seq) || 0, (ctl.pending.get(pid) || {}).seq || 0, d.lastSeq || 0);
  const now = Date.now();
  const cmd = { format: 'avs-cmd/1', cmd_id: (crypto.randomUUID ? crypto.randomUUID() : String(now) + Math.random().toString(16).slice(2)), seq: prev + 1, issued_at: now, issued_kst: `${kstDate(now)} ${kstFull(now).slice(0, 8)}`, phone_id: pid, ...body };
  if (DEMO) { demo.command(pid, cmd); }
  else {
    const text = JSON.stringify(cmd, null, 1);
    if (Date.now() > state.tokenExp) await requestToken('');
    let res;
    if (d.files['command.json']) {
      res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${d.files['command.json'].id}?uploadType=media`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json' }, body: text });
    } else {
      const b = 'avs' + now, meta = JSON.stringify({ name: 'command.json', parents: [d.folderId], mimeType: 'application/json' });
      res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,parents', { method: 'POST', headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': `multipart/related; boundary=${b}` },
        body: `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${b}--` });
      if (res.ok) { const f = await res.clone().json(); d.files['command.json'] = f; }
    }
    if (!res.ok) throw new Error(`드라이브 ${res.status}`);
  }
  d.lastSeq = cmd.seq;
  ctl.pending.set(pid, { seq: cmd.seq, cmd, at: now });
}

// 보낸 명령이 있으면 처리 결과 파일만 짧게 다시 읽는다(전체 새로고침은 5분 그대로)
function watchAcks() {
  clearTimeout(ctl.timer);
  // 반영된 뒤에도 워치 답(수집 중·대기)이 올 때까지 몇 번 더 읽는다 — 폰은 워치 답을 받으면 결과 파일을 다시 쓴다
  const waiting = (pid, p) => { const a = ackOf(pid); if (!a || a.seq < p.seq) return true; const w = a.watch || {};
    if ((w.at || 0) >= (a.applied_at || 0) - 5000 && w.state) return false; p.extra = (p.extra || 0) + 1; return p.extra <= 6; };
  if (![...ctl.pending.entries()].some(([pid, p]) => waiting(pid, p))) return;
  ctl.timer = setTimeout(async () => {
    for (const [pid, p] of ctl.pending) {
      const d = phoneDir(pid); if (!d) continue;
      if (d.ack && d.ack.seq >= p.seq && (p.extra || 0) > 6) continue;
      try {
        if (DEMO) d.ack = demo.ack(pid) || d.ack;
        else {
          if (!d.files['command_ack.json']) { const f = await listAll(`'${d.folderId}' in parents and name='command_ack.json' and trashed=false`); if (f.length) d.files['command_ack.json'] = f[0]; }
          if (d.files['command_ack.json']) d.ack = JSON.parse(await fileText(d.files['command_ack.json'].id));
        }
      } catch (e) { /* 다음에 */ }
    }
    if (!DEMO && [...ctl.pending.entries()].some(([pid, p]) => ackOf(pid) && ackOf(pid).seq >= p.seq && !p.refreshed && (p.refreshed = true))) { fastPoll(3000); }
    renderCtl(); watchAcks();
  }, (DEMO ? 3 : ([...ctl.pending.values()].some((p) => Date.now() - p.at < 120e3) ? 5 : CFG.ackPollSeconds)) * 1000);   // 보낸 뒤 2분은 5초마다
}

/* ---------------- 말풍선 ---------------- */

document.addEventListener('mousemove', (ev) => {
  const t = ev.target.closest('[data-tip]');
  const tip = $('tip');
  if (!t) { tip.hidden = true; return; }
  tip.textContent = t.dataset.tip;
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(window.innerWidth - w - 8, ev.clientX + 12) + 'px';
  tip.style.top = (ev.clientY - h - 12 < 0 ? ev.clientY + 16 : ev.clientY - h - 12) + 'px';
});

/* ---------------- 시작 ---------------- */

function signedIn() {
  $('welcome').hidden = true;
  $('app').hidden = false;
  $('btnLogin').hidden = true;
  $('btnLogout').hidden = DEMO;
  $('btnRefresh').hidden = false;
  refresh();
  clearInterval(state.timer);
  state.timer = setInterval(() => { if (!document.hidden) refresh(); }, CFG.refreshMinutes * 60e3);
  fastPoll(CFG.fastSeconds * 1000);
}

function signOut() {
  if (state.token && window.google) google.accounts.oauth2.revoke(state.token, () => {});
  state.token = null;
  location.reload();
}

$('btnRefresh').addEventListener('click', refresh);
$('btnLogout').addEventListener('click', signOut);
$('pickSubject').addEventListener('change', (e) => selectSubject(e.target.value));
$('issuesOnly').addEventListener('change', renderEvents);
$('pickFile').addEventListener('change', (e) => setTracker(e.target.value));
$('btnLogin').addEventListener('click', () => {
  if (!CFG.clientId) { banner('<code>config.js</code>에 웹 클라이언트 ID(<code>clientId</code>)를 먼저 넣어야 합니다. README의 «처음 한 번»을 보세요.', 'bad'); return; }
  if (!state.tokenClient) { banner('구글 로그인 모듈을 불러오는 중입니다. 잠시 뒤 다시 눌러 주세요.', ''); return; }
  state.tokenClient.requestAccessToken({ prompt: 'consent' });
});

/* ---------------- 측정 값 — 대상자 전 기간을 한 시간축으로 ---------------- */
// 원자료는 한 시간 파일로 나뉘어 있지만, 화면에서는 시간축 하나로 잇는다.
// 보는 창이 걸친 시간 파일만 드라이브에서 읽고(앞뒤 파일은 미리 읽음), 최근 몇 개만 메모리에 둔다.

function alarmSpans() {
  const evs = (state.events || []).map((e) => ({ code: e.code, ms: Date.parse(String(e.kst).replace(' ', 'T') + '+09:00') })).filter((e) => !isNaN(e.ms)).sort((p, q) => p.ms - q.ms);
  const out = []; let open = null;
  evs.forEach((e) => { if (e.code === 'watch_lost' && open === null) open = e.ms; if (e.code === 'watch_back' && open !== null) { out.push([open, e.ms]); open = null; } });
  if (open !== null) out.push([open, open + 60e3]);
  return out;
}

const CACHE_MAX = 8;
const OV_SPANS = [[864e5, '24시간'], [6 * 3600e3, '6시간'], [3600e3, '1시간'], [600e3, '10분']];
const LENS = [10, 30, 60, 300, 1800];
const sig = { tag: null, files: [], T0: 0, T1: 0, cache: new Map(), loading: new Map(), failed: new Set(), view: { t: 0, len: 30 },
  cols: null, chans: [], header: null, rate: 0, alarms: [], issues: [], hoverT: null, seg: [], raf: 0, ovSpan: 864e5,
  sum: new Map(), scanId: 0, scanning: false };
// 빈틈 기준 — 명세 주기의 2.5배(최소 1초). 25 Hz는 1초, 심박(1 Hz)은 2.5초
const gapMs = () => (sig.rate ? Math.max(1000, 2500 / sig.rate) : Infinity);
// 파일 하나의 실제 빈틈·센서 −1 구간(읽은 뒤 요약만 남겨 둔다 — 파일은 메모리에서 지워져도)
function summarize(o) {
  const g = gapMs(), gaps = [], bad = [];
  for (let k = 1; k < o.n; k++) if (o.ts[k] - o.ts[k - 1] > g) gaps.push([o.ts[k - 1], o.ts[k]]);
  const any = Object.values(o.bad);
  let s0 = null;
  for (let k = 0; k <= o.n; k++) { const b = k < o.n && any.some((a) => a[k]); if (b && s0 === null) s0 = o.ts[k]; if (!b && s0 !== null) { bad.push([s0, o.ts[k - 1]]); s0 = null; } }
  return { gaps, bad };
}
// 파일 사이·첫 샘플 전의 빈 시간 — manifest만으로
function fileGaps() {
  const g = gapMs(), out = []; let prev = sig.comp.start;
  sig.files.forEach((f) => { if (f.t0 - prev > g) out.push([prev, f.t0]); prev = Math.max(prev, f.t1); });
  return out;
}
// 위 막대에 보이는 구간의 파일을 하나씩 읽어 요약을 채운다(뒤에서 천천히)
async function scanRange() {
  if (sig.scanning) return;
  const id = sig.scanId; sig.scanning = true;
  try {
    for (;;) {
      if (id !== sig.scanId) return;
      const [a, b] = ovRange();
      const f = sig.files.find((q) => q.t1 >= a && q.t0 <= b && !sig.sum.has(q.name) && !sig.failed.has(q.name));
      if (!f) return;
      await loadFile(f);
      if (id !== sig.scanId) return;
      drawOverview();
    }
  } finally { sig.scanning = false; }
}


// 원자료 한 파일을 읽어 그리기용 배열로 — 화면이 멈추지 않게 가능하면 웹 워커에서.
// 원본 값 표는 파일 글자를 그대로 두고, 보이는 줄만 그때그때 꺼낸다(줄 위치만 기억).
function parseText(text) {
  const statusOf = (col, cols) => { const cand = [col.replace(/^ppg_/, '') + '_status', col + '_status', 'status']; return cand.find((c) => cols.includes(c) && c !== col) || null; };
  let header = null, cols = null, sessions = 0, oldShape = false;
  const rows = [], starts = [], ends = [], rawRows = [];
  let pos = 0;
  while (pos < text.length) {
    let nl = text.indexOf('\n', pos); if (nl < 0) nl = text.length;
    let end = nl; if (end > pos && text.charCodeAt(end - 1) === 13) end--;
    if (end > pos) {
      const c0 = text.charCodeAt(pos);
      if (c0 === 123) {                                   // {
        const r = JSON.parse(text.slice(pos, end));
        if (r.record === 'header') header = r;
        else if (r.record === 'session') sessions++;
        else if (r.record === 'batch') {                  // 1.7까지의 옛 모양
          oldShape = true;
          if (!cols) cols = ['ts', 'sent_at', ...r.columns.slice(1)];
          for (const row of r.rows) { const v = [row[0], r.sent_at, ...row.slice(1)]; rows.push(v); rawRows.push(v); starts.push(0); ends.push(0); }
          if (!header) header = { tracker: r.tracker_type, device_id: r.device_id, watch: String(r.device_id || '').slice(0, 8), format: '옛 모양(묶음)', session_id: r.session_id };
        }
      } else if (c0 === 91 && text.charCodeAt(pos + 1) === 34) cols = JSON.parse(text.slice(pos, end));   // ["
      else if (c0 === 91) { rows.push(JSON.parse(text.slice(pos, end))); starts.push(pos); ends.push(end); }
    }
    pos = nl + 1;
  }
  if (!cols || !rows.length) throw new Error('값 줄이 없음');
  let order = null;
  for (let i = 1; i < rows.length; i++) if (rows[i][0] < rows[i - 1][0]) { order = rows.map((_, k) => k).sort((x, y) => rows[x][0] - rows[y][0]); break; }
  const at = (i) => (order ? order[i] : i), n = rows.length;
  const chans = cols.filter((c, j) => j >= 2 && !/status/.test(c) && typeof rows.find((r) => r[j] !== null)?.[j] === 'number');
  const ts = new Float64Array(n), sent = new Float64Array(n), st = new Uint32Array(n), en = new Uint32Array(n), data = {}, bad = {};
  for (let i = 0; i < n; i++) { const r = rows[at(i)]; ts[i] = r[0]; sent[i] = r[1]; st[i] = starts[at(i)]; en[i] = ends[at(i)]; }
  chans.forEach((c) => {
    const j = cols.indexOf(c), sc = statusOf(c, cols), k = sc ? cols.indexOf(sc) : -1, d = new Float64Array(n), b = new Uint8Array(n);
    for (let i = 0; i < n; i++) { const r = rows[at(i)]; d[i] = r[j] === null ? NaN : r[j]; b[i] = k >= 0 && r[k] !== 0 && r[k] !== null ? 1 : 0; }
    data[c] = d; bad[c] = b;
  });
  return { header: header || {}, cols, chans, n, ts, sent, data, bad, starts: st, ends: en, sessions, oldShape, rawRows: oldShape ? (order ? order.map((k) => rawRows[k]) : rawRows) : null };
}

const parser = (() => {
  let w = null, seq = 0; const wait = new Map();
  try {
    const src = 'const parseText = ' + parseText.toString() + ';\nself.onmessage = (e) => { try { const r = parseText(e.data.text); const tr = [r.ts.buffer, r.sent.buffer, r.starts.buffer, r.ends.buffer, ...Object.values(r.data).map((a) => a.buffer), ...Object.values(r.bad).map((a) => a.buffer)]; self.postMessage({ id: e.data.id, r }, tr); } catch (err) { self.postMessage({ id: e.data.id, error: String(err && err.message || err) }); } };';
    w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = (e) => { const f = wait.get(e.data.id); if (!f) return; wait.delete(e.data.id); e.data.error ? f[1](new Error(e.data.error)) : f[0](e.data.r); };
    w.onerror = () => { w = null; wait.forEach(([, rej]) => rej(new Error('worker'))); wait.clear(); };
  } catch (e) { w = null; }
  return async (text) => {
    if (w) { try { return await new Promise((res, rej) => { const id = ++seq; wait.set(id, [res, rej]); w.postMessage({ id, text }); }); } catch (e) { if (e.message !== 'worker') throw e; } }
    return parseText(text);                               // 워커가 안 되는 곳에서는 바로
  };
})();

// 파일의 k번째 샘플 한 줄(원본 그대로)
const rowAt = (o, k) => (o.rawRows ? o.rawRows[k] : JSON.parse(o.text.slice(o.starts[k], o.ends[k])));

const lowerIn = (arr, n, t) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < t) lo = m + 1; else hi = m; } return lo; };
const kstFull = (ms) => { const d = new Date(ms + 9 * 3600e3); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`; };
const kstMD = (ms) => kstDate(ms).slice(5);
const cssv = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
// 침상 모니터처럼 채널마다 정해진 선 색
const chanColor = (c) => { c = String(c).toLowerCase();
  if (/green|hr|ibi|ecg/.test(c)) return '#00E05A'; if (/_ir|^ir/.test(c)) return '#E879F9'; if (/red/.test(c)) return '#FF6B6B';
  if (/acc|^x$|^y$|^z$/.test(c)) return '#4FC3F7'; if (/eda|skin|temp/.test(c)) return '#FFB74D'; if (/spo2/.test(c)) return '#00E5FF'; return '#00E05A'; };
function canvasSetup(c) {
  const r = window.devicePixelRatio || 1, w = c.clientWidth, h = c._h || (c._h = c.height);
  c.width = w * r; c.height = h * r; c.style.height = h + 'px';
  const x = c.getContext('2d'); x.setTransform(r, 0, 0, r, 0, 0); return { x, w, h };
}

const fmtMB = (b) => (b >= 1e6 ? (b / 1e6).toFixed(2) + ' MB' : (b / 1e3).toFixed(1) + ' KB');

function initSignal(keep) {
  const tags = [...new Set((state.manifest || []).filter((r) => r.file).map((r) => r.tracker))];
  if (!tags.length) { $('pickFile').innerHTML = ''; $('signal').innerHTML = '<div class="empty">원자료 파일이 없습니다.</div>'; return; }
  // 고르는 칸 — 트래커와 manifest에 적힌 파일 크기 합(기간·행·파일 수는 아래 요약에)
  $('pickFile').innerHTML = tags.map((t) => {
    const rs = state.manifest.filter((r) => r.tracker === t && r.file), sz = rs.reduce((a, r) => a + Number(r.bytes || 0), 0);
    return `<option value="${esc(t)}">${esc(t)} · ${fmtMB(sz)}</option>`;
  }).join('');
  const tag = keep && sig.tag && tags.includes(sig.tag) ? sig.tag : tags[0];
  if (keep && sig.tag === tag && $('sigBox')) { softRefresh(); return; }   // 5분 새로 읽기 — 화면은 그대로, 숫자·막대만
  if (!keep) sig.tag = null;          // 대상자가 바뀌면 처음부터
  setTracker(tag, keep && sig.tag === tag ? sig.view.t : null);
}

// 새로 읽은 manifest로 파일 목록만 바꾼다. 행 수가 늘어난(쓰는 중) 파일은 메모리에서 지워 다시 읽게 한다
function softRefresh() {
  const old = new Map(sig.files.map((f) => [f.name, f.rows]));
  sig.comp = completeness(sig.tag);
  sig.files = sig.comp.files.map((f) => ({ name: f.r.file, t0: f.t0, t1: f.t1, rows: f.n, fill: f.pct, status: f.r.status }));
  sig.T0 = sig.files[0].t0; sig.T1 = Math.max(...sig.files.map((f) => f.t1));
  sig.files.forEach((f) => { if (old.get(f.name) !== f.rows) { sig.cache.delete(f.name); sig.failed.delete(f.name); sig.sum.delete(f.name); } });
  sig.alarms = alarmSpans();
  renderSigKpi();
  seek(sig.view.t);
}

function setTracker(tag, t) {
  const sameTag = sig.tag === tag;
  sig.tag = tag; $('pickFile').value = tag;
  sig.comp = completeness(tag);
  sig.files = sig.comp.files.map((f) => ({ name: f.r.file, t0: f.t0, t1: f.t1, rows: f.n, fill: f.pct, status: f.r.status }));
  sig.T0 = sig.files[0].t0; sig.T1 = Math.max(...sig.files.map((f) => f.t1));
  sig.rate = RATE[tag] || 0;
  sig.scanId++;
  if (!sameTag) { sig.sum.clear(); sig.cols = null; sig.chans = []; sig.header = null; sig.view.len = sig.rate >= 10 ? 30 : sig.rate >= 1 ? 1800 : 1800; }
  sig.failed.clear();
  sig.alarms = alarmSpans();
  sig.issues = (state.events || []).filter((e) => ['bad', 'warn'].includes(evClass(e.code)) && e.code !== 'watch_lost').map((e) => ({ ...e, ms: Date.parse(String(e.kst).replace(' ', 'T') + '+09:00') })).filter((e) => !isNaN(e.ms));
  renderSignalShell();
  seek(t ?? sig.T1 - sig.view.len * 1000);
}

// 위 막대는 하루(00–24시)씩 — 보는 창이 걸친 날을 따라가고, ◀ ▶로 날을 바꾼다
const dayOf = (t) => Math.floor((t + 9 * 3600e3) / 864e5) * 864e5 - 9 * 3600e3;
function seek(t) {
  const len = sig.view.len * 1000;
  sig.view.t = Math.max(sig.T0, Math.min(Math.max(sig.T0, sig.T1 - len), t));
  setDay(dayOf(sig.view.t + len / 2));
  const rg = $('sigRange'); if (rg && document.activeElement !== rg) rg.value = sig.view.t;
  cancelAnimationFrame(sig.raf);
  sig.raf = requestAnimationFrame(() => { drawAll(); ensureLoaded(); });
}

function setDay(d) {
  sig.day = d;
  const rg = $('sigRange'); if (!rg) return;
  rg.min = Math.max(sig.T0, d); rg.max = Math.max(+rg.min, Math.min(sig.T1, d + 864e5) - sig.view.len * 1000);
  const days = [...new Set(sig.files.map((f) => dayOf(f.t0)).concat(sig.files.map((f) => dayOf(f.t1))))].sort((a, b) => a - b);
  const i = days.indexOf(d);
  $('dayLbl').textContent = ` ${kstDate(d)} · ${i + 1}일차 `;
  $('dayPrev').disabled = i <= 0; $('dayNext').disabled = i < 0 || i >= days.length - 1;
  sig.dayList = days;
}
function goDay(k) {
  const days = sig.dayList || [], i = days.indexOf(sig.day), d = days[i + k];
  if (d === undefined) return;
  const first = sig.files.find((f) => f.t1 >= d);
  seek(Math.max(d, first ? first.t0 : d));
}

const filesIn = (a, b) => sig.files.filter((f) => f.t1 >= a && f.t0 <= b);

// 열 이름·채널은 처음 읽은(또는 이미 메모리에 있는) 파일에서 가져온다
function adoptCols(o) { if (!sig.cols && o) { sig.cols = o.cols; sig.chans = o.chans; sig.header = o.header; renderChannels(); } }

async function loadFile(f) {
  if (sig.cache.has(f.name)) { const v = sig.cache.get(f.name); sig.cache.delete(f.name); sig.cache.set(f.name, v); if (!sig.sum.has(f.name)) sig.sum.set(f.name, summarize(v)); adoptCols(v); return v; }
  if (sig.failed.has(f.name)) return null;
  if (sig.loading.has(f.name)) return sig.loading.get(f.name);
  const p = (async () => {
    try {
      let text;
      if (DEMO) text = demo.raw(f.name);
      else { const d = state.fileIndex && state.fileIndex.get(f.name); if (!d) throw new Error('드라이브에서 찾지 못함'); text = await fileText(d.id); }
      const o = await parser(text); o.text = text;
      sig.cache.set(f.name, o);
      sig.sum.set(f.name, summarize(o));
      while (sig.cache.size > CACHE_MAX) {
        const [a, b] = [sig.view.t, sig.view.t + sig.view.len * 1000];
        const old = [...sig.cache.keys()].find((k) => !filesIn(a, b).some((x) => x.name === k));
        if (!old) break; sig.cache.delete(old);
      }
      adoptCols(o);
      return o;
    } catch (e) { sig.failed.add(f.name); f.err = e.message; return null; }
    finally { sig.loading.delete(f.name); }
  })();
  sig.loading.set(f.name, p);
  return p;
}

async function ensureLoaded() {
  const a = sig.view.t, b = a + sig.view.len * 1000;
  if (!sig.cols) { const hit = filesIn(a, b).map((f) => sig.cache.get(f.name)).find(Boolean); if (hit) { adoptCols(hit); drawAll(); } }
  const need = filesIn(a, b).filter((f) => !sig.cache.has(f.name) && !sig.failed.has(f.name));
  if (need.length) { setStatus(`읽는 중… ${need.map((f) => f.name).join(', ')}`); await Promise.all(need.map(loadFile)); setStatus(''); drawAll(); }
  // 앞뒤 파일을 미리 읽어 이어 볼 때 끊기지 않게
  const i0 = sig.files.findIndex((f) => f.t1 >= a), i1 = sig.files.findIndex((f) => f.t0 > b);
  clearTimeout(sig.preT);
  sig.preT = setTimeout(() => { [sig.files[i0 - 1], i1 >= 0 ? sig.files[i1] : null].filter(Boolean).forEach((f) => loadFile(f)); scanRange(); }, 600);   // 앞뒤 파일·위 막대 빈틈은 멈춘 뒤에
}

const setStatus = (t) => { const s = $('sigStatus'); if (s) s.textContent = t; };

function renderSigKpi() {
  const fs = sig.files, total = fs.reduce((a, f) => a + f.rows, 0), c = sig.comp;
  $('sigKpi').innerHTML = `
    <div class="kpis small">
      <div class="kpi"><div class="l">기간</div><div class="v sm">${kstMD(c.start)} ${kstHM(c.start)} – ${kstMD(c.end)} ${kstHM(c.end)}</div></div>
      <div class="kpi"><div class="l">전체 행</div><div class="v">${fmtInt(total)}</div></div>
      <div class="kpi"><div class="l">완전성</div><div class="v">${c.pct === null ? '—' : c.pct.toFixed(1) + '%'}</div></div>
      <div class="kpi"><div class="l">파일 수</div><div class="v">${fs.length}</div></div>
    </div>`;
}

function renderSignalShell() {
  const fs = sig.files, total = fs.reduce((a, f) => a + f.rows, 0), c = sig.comp;
  $('signal').innerHTML = `
    <div id="sigKpi"></div>
    <div class="mon" id="sigBox">
      <div class="mon-top"><span class="row"><button class="btn ghost sm" id="dayPrev" title="앞 날">◀</button><b id="dayLbl"></b><button class="btn ghost sm" id="dayNext" title="다음 날">▶</button><span class="row ovspan">${OV_SPANS.map(([ms, l]) => `<button class="btn ghost sm" data-ov="${ms}">${l}</button>`).join('')}</span><span class="dim">막대 = 시간 파일 완전성 · 눌러서 이동 · 휠로 넓히기·좁히기</span></span><span id="sigInfo"></span></div>
      <canvas id="sigOv" height="128"></canvas>
      <input type="range" id="sigRange" class="mon-range" step="1000" aria-label="시간 이동">
      <div class="row sig-ctl">
        <div class="row"><button class="btn ghost sm" id="sigPrev" title="반 창 앞으로">◀</button><b id="sigWin"></b><button class="btn ghost sm" id="sigNext" title="반 창 뒤로">▶</button></div>
        <div class="row">${LENS.map((s) => `<button class="btn ghost sm" data-len="${s}">${s < 60 ? s + '초' : s / 60 + '분'}</button>`).join('')}</div>
      </div>
      <div class="win-stat" id="sigStat"></div>
      <div id="sigChans"><div class="empty mon-empty">파일을 읽는 중…</div></div>
      <div class="readout" id="sigRead">그래프를 끌면 시간이 이어서 움직입니다 · 올리면 그 샘플 값과 아래 원본 줄이 표시됩니다 <span id="sigStatus"></span></div>
      <div class="legend"><span><i class="sw" style="background:${chanColor('green')}"></i>측정 값</span><span><i class="sw" style="background:var(--mon-bad)"></i>센서 상태 −1</span><span><i class="sw" style="background:#FF4747"></i>누락 구간(25 Hz 1초 · 1 Hz 2.5초 넘게)</span><span><i class="sw" style="background:#E6EDF3;border-radius:50%"></i>다른 이슈(폰 로그)</span><span><i class="sw" style="background:var(--mon-alarm)"></i>끊긴 구간(워치-폰)</span><span><i class="sw" style="background:transparent;border-color:var(--mon-win)"></i>지금 보는 창</span></div>
    </div>
    <h3 class="sub-h raw-h">원본 값</h3>
    <div class="tw rawtw" id="rawBox"><table class="raw"><thead id="rawHead"></thead><tbody id="sigRows"></tbody></table></div>`;
  renderSigKpi();
  if (sig.cols) renderChannels();
  const ov = $('sigOv');
  let dragOv = false;
  const ovT = (e) => { const r = ov.getBoundingClientRect(), [a, b] = ovRange(); return a + ((e.clientX - r.left) / r.width) * (b - a); };
  const ovSeek = (e) => { const t = ovT(e), hit = sig.alarms.find(([sA, eA]) => t >= sA && t <= eA && e.offsetY > ov.clientHeight - 46);
    seek((hit ? hit[0] - 5000 : t) - (hit ? 0 : sig.view.len * 500)); };
  ov.addEventListener('mousemove', (e) => { ov.dataset.tip = ovTip(ovT(e), e.offsetY); });
  ov.addEventListener('wheel', (e) => { e.preventDefault(); const i = OV_SPANS.findIndex(([ms]) => ms === sig.ovSpan); const j = Math.max(0, Math.min(OV_SPANS.length - 1, i + (e.deltaY > 0 ? -1 : 1))); if (j !== i) { sig.ovSpan = OV_SPANS[j][0]; drawAll(); } }, { passive: false });
  document.querySelectorAll('#signal [data-ov]').forEach((b) => (b.onclick = () => { sig.ovSpan = +b.dataset.ov; drawAll(); }));
  $('dayPrev').onclick = () => goDay(-1);
  $('dayNext').onclick = () => goDay(1);
  ov.addEventListener('pointerdown', (e) => { sig.ovFreeze = ovRange(); dragOv = true; ov.setPointerCapture(e.pointerId); ovSeek(e); });
  ov.addEventListener('pointermove', (e) => { if (dragOv) ovSeek(e); });
  ov.addEventListener('pointerup', () => { dragOv = false; sig.ovFreeze = null; drawAll(); });
  $('sigRange').addEventListener('input', (e) => seek(+e.target.value));
  $('sigPrev').onclick = () => seek(sig.view.t - sig.view.len * 500);
  $('sigNext').onclick = () => seek(sig.view.t + sig.view.len * 500);
  document.querySelectorAll('#signal [data-len]').forEach((b) => (b.onclick = () => {
    const mid = sig.view.t + sig.view.len * 500; sig.view.len = +b.dataset.len; seek(mid - sig.view.len * 500);
  }));
}

// 파일 머리의 단위 글자에서 «(단위 없음)»은 빼고, ADC는 «ADC count»로
const unitTxt = (u) => String(u || '').replace(/\s*\(단위 없음\)/, '').replace(/^ADC$/, 'ADC count');

function renderChannels() {
  const box = $('sigChans'); if (!box) return;
  const h = sig.chans.length > 3 ? 130 : 190, u = (sig.header && sig.header.units) || {};
  box.innerHTML = sig.chans.map((c) => `<div class="lbl"><span><b style="color:${chanColor(c)}">${esc(c)}</b> <span class="muted">${esc(unitTxt(u[c]))}</span></span><span class="muted" id="rg_${esc(c)}"></span></div><canvas class="sigc" data-col="${esc(c)}" height="${h}"></canvas>`).join('');
  $('rawHead').innerHTML = `<tr><th>날짜·시각 (KST)</th>${sig.cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>`;
  const H = sig.header;
  $('sigInfo').textContent = `${H.tracker || sig.tag} · 워치 ${H.watch || '—'} · ${sig.rate ? sig.rate + ' Hz' : '온디맨드'} · 앱 ${H.app_version || '—'} · ${H.format || ''}`;
  document.querySelectorAll('#signal canvas.sigc').forEach((c) => {
    let drag = null;
    c.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, t: sig.view.t }; c.setPointerCapture(e.pointerId); c.classList.add('grab'); });
    c.addEventListener('pointerup', () => { drag = null; c.classList.remove('grab'); });
    c.addEventListener('pointerleave', () => { if (!drag) { sig.hoverT = null; drawCursor(); } });
    c.addEventListener('pointermove', (e) => {
      const m = c._map; if (!m) return;
      if (drag) { seek(drag.t - ((e.clientX - drag.x) / (m.w - m.L - m.R)) * sig.view.len * 1000); return; }
      const r = c.getBoundingClientRect();
      sig.hoverT = m.t0 + ((e.clientX - r.left - m.L) / (m.w - m.L - m.R)) * (m.t1 - m.t0);
      drawCursor(true);
    });
    c.addEventListener('wheel', (e) => { const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0; if (!d) return; e.preventDefault(); seek(sig.view.t + (d / c.clientWidth) * sig.view.len * 1000); }, { passive: false });
  });
}

// 창 안의 샘플: 걸친 파일마다 [파일, 시작, 끝] 조각
function windowSegments(a, b) {
  const seg = [];
  filesIn(a, b).forEach((f) => { const o = sig.cache.get(f.name); if (!o) return; const i = lowerIn(o.ts, o.n, a), j = lowerIn(o.ts, o.n, b); if (j > i) seg.push({ o, i, j }); });
  return seg;
}

function drawAll() {
  if (!sig.files.length || !$('sigOv')) return;
  const v = sig.view, a = v.t, b = a + v.len * 1000;
  sig.seg = windowSegments(a, b);
  const n = sig.seg.reduce((s, g) => s + g.j - g.i, 0);
  $('sigWin').textContent = ` ${kstDate(a)} ${kstFull(a).slice(0, 8)} – ${kstFull(b).slice(0, 8)} `;
  document.querySelectorAll('#signal [data-len]').forEach((x) => x.classList.toggle('on', +x.dataset.len === v.len));
  // 창 통계
  let gaps = 0, gapS = 0, badN = 0; const lag = []; let prev = null;
  sig.seg.forEach(({ o, i, j }) => { const any = Object.values(o.bad);
    const G = gapMs(); for (let k = i; k < j; k++) { const t = o.ts[k]; if (prev !== null && t - prev > G) { gaps++; gapS += (t - prev) / 1000; } prev = t; if (any.some((bb) => bb[k])) badN++; if ((k - i) % 25 === 0) lag.push((o.sent[k] - t) / 1000); } });
  lag.sort((p, q) => p - q);
  const exp = sig.rate ? v.len * sig.rate : 0;
  $('sigStat').innerHTML = `<span>이 창 <b>${fmtInt(n)}</b>샘플${exp ? ` / 기대 ${fmtInt(exp)}` : ''}</span><span>누락 구간 <b>${gaps}</b>${gaps ? ` (합 ${gapS.toFixed(1)}초)` : ''}</span><span>센서 −1 <b>${fmtInt(badN)}</b></span><span>도착 지연 중앙 <b>${lag.length ? lag[lag.length >> 1].toFixed(1) + '초' : '—'}</b></span>`;
  drawOverview();
  drawChannels();
  clearTimeout(sig.rawT); sig.rawT = setTimeout(renderRaw, 180);   // 원본 표는 움직임이 멈춘 뒤에 한 번
}

// 위 막대가 보여 주는 구간 — 24시간이면 그날 00–24시, 짧으면 보는 창을 가운데에
function ovRange() {
  if (sig.ovFreeze) return sig.ovFreeze;      // 막대를 끄는 동안은 구간을 고정
  const sp = sig.ovSpan;
  if (sp >= 864e5) return [sig.day, sig.day + 864e5];
  const step = sp / 6, c = sig.view.t + sig.view.len * 500;
  const a = Math.floor((c - sp / 2) / step) * step;
  return [a, a + sp];
}
function ovTip(t, y) {
  const al = sig.alarms.find(([sA, eA]) => t >= sA - 2000 && t <= eA + 2000);
  const iss = sig.issues.filter((e) => Math.abs(e.ms - t) < (ovRange()[1] - ovRange()[0]) / 200);
  const f = sig.files.find((q) => t >= q.t0 && t <= q.t1);
  const parts = [`${kstDate(t).slice(5)} ${kstFull(t).slice(0, 8)}`];
  if (f) parts.push(`${f.name.replace(/\.ndjson$/, '')} · 완전성 ${f.fill === null ? '—' : f.fill.toFixed(1) + '%'}`);
  if (al) parts.push(`끊긴 구간(워치-폰) ${kstFull(al[0]).slice(0, 8)}–${kstFull(al[1]).slice(0, 8)} · ${Math.round((al[1] - al[0]) / 1000)}초 — 누르면 그 시작으로`);
  const tol = (ovRange()[1] - ovRange()[0]) / 300, L = gapLanes(t - tol, t + tol);
  L.gaps.forEach(([a, b]) => parts.push(`누락 ${kstFull(a).slice(0, 8)}–${kstFull(b).slice(0, 8)} · ${((b - a) / 1000).toFixed(1)}초`));
  L.bad.forEach(([a, b]) => parts.push(`센서 −1 ${kstFull(a).slice(0, 8)}–${kstFull(b).slice(0, 8)} · ${Math.round((b - a) / 1000)}초`));
  if (L.unread.length) parts.push('누락 확인 전(파일을 읽는 중)');
  iss.forEach((e) => parts.push(`${String(e.kst).slice(11, 19)} ${e.text} (${e.code})`));
  return parts.join(' · ');
}

function gapLanes(T0, T1) {
  const gaps = fileGaps(), bad = [], unread = []; let done = 0, todo = 0;
  sig.files.forEach((f) => { if (f.t1 < T0 || f.t0 > T1) return; const sm = sig.sum.get(f.name);
    if (sm) { done++; gaps.push(...sm.gaps); bad.push(...sm.bad); } else if (!sig.failed.has(f.name)) { todo++; unread.push([f.t0, f.t1]); } });
  return { gaps: gaps.filter(([a, b]) => b > T0 && a < T1), bad: bad.filter(([a, b]) => b > T0 && a < T1), unread, done, todo };
}

function drawOverview() {
  const ov = $('sigOv'), O = canvasSetup(ov), x = O.x, w = O.w, h = O.h;
  if (w < 20) return;
  const [T0, T1] = ovRange(), X = (t) => ((t - T0) / (T1 - T0)) * w, SP = T1 - T0;
  const BAR_T = 16, BAR_H = h - 16 - 64, AL_Y = h - 46, IS_Y = h - 12;
  document.querySelectorAll('#signal [data-ov]').forEach((b) => b.classList.toggle('on', +b.dataset.ov === sig.ovSpan));
  x.fillStyle = cssv('--mon-bg'); x.fillRect(0, 0, w, h);
  x.fillStyle = cssv('--mon-grid2'); x.fillRect(0, BAR_T, w, BAR_H);
  // 날짜 경계 · 시각 눈금
  x.font = '11px ' + cssv('--sans'); x.lineWidth = 1;
  const [minor, major] = SP >= 864e5 ? [3600e3, 3 * 3600e3] : SP >= 6 * 3600e3 ? [900e3, 3600e3] : SP >= 3600e3 ? [300e3, 600e3] : [60e3, 120e3];
  for (let m = Math.ceil((T0 + 9 * 3600e3) / minor) * minor - 9 * 3600e3; m <= T1; m += minor) {
    const px = Math.min(w - 0.5, Math.round(X(m)) + 0.5), big = (m + 9 * 3600e3) % major === 0;
    x.strokeStyle = big ? '#2C4A38' : cssv('--mon-grid'); x.beginPath(); x.moveTo(px, BAR_T); x.lineTo(px, IS_Y + 8); x.stroke();
    if (big && px < w - 30) { x.fillStyle = kstHM(m) === '00:00' ? cssv('--mon-text') : cssv('--mon-dim'); x.fillText(kstHM(m) === '00:00' ? kstMD(m) : SP >= 864e5 ? kstHM(m).slice(0, 2) : kstHM(m), px + 3, 11); }
  }
  // 수집 기간 밖은 어둡게
  x.fillStyle = 'rgba(0,0,0,.55)';
  const pS = X(Math.max(T0, sig.comp.start)), pE = X(Math.min(T1, sig.comp.end));
  if (pS > 0) x.fillRect(0, BAR_T, Math.min(w, pS), BAR_H);
  if (pE < w) x.fillRect(Math.max(0, pE), BAR_T, w - Math.max(0, pE), BAR_H);
  // 시간 파일 막대(높이 = 채움)
  sig.files.forEach((f) => {
    const x0 = X(f.t0), x1 = Math.max(x0 + 1.5, X(f.t1)), fill = f.fill === null ? 100 : f.fill, hh = BAR_H * Math.max(0.08, fill / 100);
    if (f.t1 < T0 || f.t0 > T1) return;
    x.fillStyle = sig.failed.has(f.name) ? '#3A434C' : fill >= 97 ? '#1E9E50' : fill >= 90 ? '#B59A12' : '#C24A2A';
    x.fillRect(x0 + 0.5, BAR_T + BAR_H - hh, x1 - x0 - 1, hh);
  });
  // 끊긴 구간(워치-폰) — 넓으면 길이를 적음
  x.fillStyle = cssv('--mon-dim'); x.fillText('끊긴 구간(워치-폰)', 2, AL_Y - 4);
  x.fillStyle = cssv('--mon-grid2'); x.fillRect(0, AL_Y, w, 14);
  sig.alarms.forEach(([sA, eA]) => { if (!(eA > T0 && sA < T1)) return; const a = X(Math.max(sA, T0)), b = X(Math.min(eA, T1));
    x.fillStyle = cssv('--mon-alarm'); x.fillRect(a, AL_Y, Math.max(2, b - a), 14);
    const lb = (eA - sA) >= 60e3 ? `${Math.round((eA - sA) / 60e3)}분` : `${Math.round((eA - sA) / 1000)}초`;
    if (b - a > x.measureText(lb).width + 8) { x.fillStyle = '#fff'; x.fillText(lb, a + 4, AL_Y + 11); } });
  // 누락 구간(데이터) — 빨강 = 샘플 빈틈 · 노랑 = 센서 −1. 안 읽은 파일은 빗금. 다른 이슈(폰 로그)는 점
  const lanes = gapLanes(T0, T1), lbl = `누락 구간(데이터)${lanes.todo ? ` · 확인 중 ${lanes.done}/${lanes.done + lanes.todo}` : ''}`;
  x.fillStyle = cssv('--mon-dim'); x.fillText(lbl, 2, IS_Y - 4);
  x.fillStyle = cssv('--mon-grid2'); x.fillRect(0, IS_Y, w, 10);
  lanes.unread.forEach(([a, b]) => { x.fillStyle = 'rgba(255,255,255,.06)'; x.fillRect(X(a), IS_Y, Math.max(1, X(b) - X(a)), 10); });
  lanes.bad.forEach(([a, b]) => { x.fillStyle = '#FFB300'; x.fillRect(X(a), IS_Y, Math.max(2, X(b) - X(a)), 10); });
  lanes.gaps.forEach(([a, b]) => { x.fillStyle = '#FF4747'; x.fillRect(X(a), IS_Y, Math.max(2, X(b) - X(a)), 10); });
  sig.issues.forEach((e) => { if (e.ms < T0 || e.ms > T1) return; x.fillStyle = '#E6EDF3'; x.strokeStyle = '#000'; x.lineWidth = 1;
    x.beginPath(); x.arc(X(e.ms), IS_Y + 5, 3, 0, 7); x.fill(); x.stroke(); });
  // 지금 보는 창
  const ws = X(sig.view.t), we = X(sig.view.t + sig.view.len * 1000);
  x.fillStyle = 'rgba(90,200,250,.18)'; x.fillRect(ws, BAR_T, Math.max(3, we - ws), h - BAR_T);
  x.strokeStyle = cssv('--mon-win'); x.lineWidth = 1.5; x.strokeRect(ws, BAR_T + 0.5, Math.max(3, we - ws), h - BAR_T - 1);
  if (SP < 864e5) { x.fillStyle = cssv('--mon-dim'); const lb = `${kstHM(T0)} – ${kstHM(T1)}`; x.fillText(lb, w - x.measureText(lb).width - 4, 11); }
}

function niceStep(len) { return len <= 10 ? 1 : len <= 30 ? 5 : len <= 60 ? 10 : len <= 300 ? 60 : len <= 1800 ? 300 : 600; }
const fmtV = (q) => (Math.abs(q) >= 1e4 ? Math.round(q).toLocaleString('ko-KR') : String(+q.toFixed(3)));

function drawChannels() {
  const v = sig.view, tA = v.t, tB = v.t + v.len * 1000;
  document.querySelectorAll('#signal canvas.sigc').forEach((c) => {
    const col = c.dataset.col, C = canvasSetup(c), x = C.x, w = C.w, h = C.h;
    const L = 64, R = 10, T = 8, B = 22, PW = w - L - R, PH = h - T - B, XX = (t) => L + ((t - tA) / (tB - tA)) * PW;
    if (PW < 20) return;
    c._map = { t0: tA, t1: tB, L, R, w, T, B, h };
    x.fillStyle = cssv('--mon-bg'); x.fillRect(0, 0, w, h);
    // 값 범위
    let mn = Infinity, mx = -Infinity, cnt = 0;
    sig.seg.forEach(({ o, i, j }) => { const arr = o.data[col]; if (!arr) return; for (let k = i; k < j; k++) { const q = arr[k]; if (q === q) { if (q < mn) mn = q; if (q > mx) mx = q; cnt++; } } });
    const p = isFinite(mn) ? (mx - mn) * 0.08 || 1 : 1, lo = mn - p, hi = mx + p, YY = (q) => T + PH * (1 - (q - lo) / (hi - lo));
    // 격자 · 눈금
    x.strokeStyle = cssv('--mon-grid'); x.lineWidth = 1; x.beginPath();
    for (let k = 0; k <= 4; k++) { const y = Math.round(T + (PH * k) / 4) + 0.5; x.moveTo(L, y); x.lineTo(L + PW, y); }
    const st = niceStep(v.len) * 1000, ticks = [];
    for (let m = Math.ceil((tA + 9 * 3600e3) / st) * st - 9 * 3600e3; m <= tB; m += st) { const px = Math.round(XX(m)) + 0.5; x.moveTo(px, T); x.lineTo(px, T + PH); ticks.push([px, m]); }
    x.stroke();
    x.fillStyle = cssv('--mon-dim'); x.font = '11px ' + cssv('--sans');
    ticks.forEach(([px, m]) => { const lb = v.len <= 300 ? kstFull(m).slice(0, 8) : kstHM(m); const tw = x.measureText(lb).width; x.fillText(lb, Math.max(L, Math.min(L + PW - tw, px - tw / 2)), h - 6); });
    if (isFinite(mn)) { x.textAlign = 'right'; [hi - p, (lo + hi) / 2, lo + p].forEach((q) => x.fillText(fmtV(q), L - 6, YY(q) + 4)); x.textAlign = 'left'; }
    // 아직 못 읽은·없는 파일 구간
    filesIn(tA, tB).forEach((f) => { if (sig.cache.has(f.name)) return; const x0 = Math.max(L, XX(f.t0)), x1 = Math.min(L + PW, XX(f.t1));
      x.fillStyle = sig.failed.has(f.name) ? 'rgba(255,255,255,.07)' : 'rgba(255,255,255,.04)'; x.fillRect(x0, T, x1 - x0, PH);
      x.fillStyle = cssv('--mon-dim'); x.fillText(sig.failed.has(f.name) ? `${f.name} 읽지 못함${f.err ? ' — ' + f.err : ''}` : `${f.name} 읽는 중…`, x0 + 8, T + 18); });
    // 끊긴 구간(워치-폰) 띠
    x.fillStyle = cssv('--mon-alarm'); sig.alarms.forEach(([sA, eA]) => { if (eA > tA && sA < tB) x.fillRect(XX(Math.max(sA, tA)), 0, Math.max(2, XX(Math.min(eA, tB)) - XX(Math.max(sA, tA))), 4); });
    if (!cnt) { const rg = $('rg_' + col); if (rg) rg.textContent = ''; drawCursorOn(c); return; }
    // −1 음영 · 빈틈
    let prevT = null;
    sig.seg.forEach(({ o, i, j }) => {
      const bad = o.bad[col]; x.fillStyle = cssv('--mon-bad');
      for (let k = i; k < j; k++) if (bad && bad[k]) { let e = k; while (e < j && bad[e]) e++; x.fillRect(XX(o.ts[k]), T, Math.max(2, XX(o.ts[e - 1]) - XX(o.ts[k])), PH); k = e; }
      const G = gapMs(); for (let k = i; k < j; k++) { const t = o.ts[k]; if (prevT !== null && t - prevT > G) { const x0 = XX(prevT), x1 = XX(t);
        x.fillStyle = 'rgba(255,71,71,.18)'; x.fillRect(x0, T, Math.max(2, x1 - x0), PH);
        if (x1 - x0 > 60) { x.fillStyle = '#FF8A8A'; x.fillText(`누락 ${((t - prevT) / 1000).toFixed(1)}초`, x0 + 6, T + PH - 8); } } prevT = t; }
    });
    // 선 — 점이 많으면 픽셀마다 최소·최대
    x.strokeStyle = chanColor(col); x.lineWidth = 1.5;
    const dense = cnt > PW * 2;
    if (dense) {
      const mnA = new Float64Array(Math.ceil(PW) + 1).fill(Infinity), mxA = new Float64Array(Math.ceil(PW) + 1).fill(-Infinity);
      sig.seg.forEach(({ o, i, j }) => { const arr = o.data[col]; for (let k = i; k < j; k++) { const q = arr[k]; if (q !== q) continue; const px = Math.floor(XX(o.ts[k]) - L); if (q < mnA[px]) mnA[px] = q; if (q > mxA[px]) mxA[px] = q; } });
      x.beginPath(); for (let px = 0; px < mnA.length; px++) if (mnA[px] !== Infinity) { x.moveTo(L + px + 0.5, YY(mxA[px])); x.lineTo(L + px + 0.5, YY(mnA[px]) + 0.5); } x.stroke();
    } else {
      x.beginPath(); let pen = false, pt = null;
      sig.seg.forEach(({ o, i, j }) => { const arr = o.data[col]; for (let k = i; k < j; k++) { const q = arr[k], t = o.ts[k]; if (q !== q || (pt !== null && t - pt > 1000)) pen = false; pt = t; if (q !== q) continue; pen ? x.lineTo(XX(t), YY(q)) : x.moveTo(XX(t), YY(q)); pen = true; } });
      x.stroke();
      // 샘플 점은 그리지 않는다 — 선만. 그래프에 올리면 그 샘플에 흰 점과 값이 뜬다
    }
    const rg = $('rg_' + col); if (rg) rg.textContent = `이 창 ${fmtV(mn)} ~ ${fmtV(mx)}`;
    const snap = c._snap || (c._snap = document.createElement('canvas')); snap.width = c.width; snap.height = c.height; snap.getContext('2d').drawImage(c, 0, 0);
    c._yy = { lo, hi, T, PH };
    drawCursorOn(c);
  });
}

function nearest(t) {
  let best = null;
  sig.seg.forEach(({ o, i, j }, si) => { let k = lowerIn(o.ts, o.n, t); [k - 1, k].forEach((q) => { if (q >= i && q < j && (!best || Math.abs(o.ts[q] - t) < Math.abs(best.o.ts[best.k] - t))) best = { o, k, si }; }); });
  return best;
}

function drawCursorOn(c) {
  if (sig.hoverT === null || !c._map) return;
  const m = c._map, x = c.getContext('2d'), XX = (t) => m.L + ((t - m.t0) / (m.t1 - m.t0)) * (m.w - m.L - m.R);
  const nb = nearest(sig.hoverT); if (!nb) return;
  const px = XX(nb.o.ts[nb.k]);
  x.strokeStyle = 'rgba(255,255,255,.55)'; x.lineWidth = 1; x.beginPath(); x.moveTo(px, m.T); x.lineTo(px, m.h - m.B); x.stroke();
  const arr = nb.o.data[c.dataset.col], yy = c._yy;
  if (arr && yy && arr[nb.k] === arr[nb.k]) { x.fillStyle = '#fff'; x.beginPath(); x.arc(px, yy.T + yy.PH * (1 - (arr[nb.k] - yy.lo) / (yy.hi - yy.lo)), 3.5, 0, 7); x.fill(); }
}

function drawCursor(fromChart) {
  document.querySelectorAll('#signal canvas.sigc').forEach((c) => { const x = c.getContext('2d'); if (c._snap) { x.setTransform(1, 0, 0, 1, 0, 0); x.drawImage(c._snap, 0, 0); } x.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0); drawCursorOn(c); });
  if (sig.hoverT === null) { if (sig.rawHl !== undefined) { sig.rawHl = -1; renderRawRows(); } return; }
  const nb = nearest(sig.hoverT); if (!nb) return;
  const o = nb.o, k = nb.k, inAlarm = sig.alarms.some(([sA, eA]) => o.ts[k] >= sA && o.ts[k] < eA);
  $('sigRead').innerHTML = `<b>${kstDate(o.ts[k])} ${kstFull(o.ts[k])}</b> · ` + sig.chans.map((c) => `<span style="color:${chanColor(c)}">${esc(c)}</span> ${esc(o.data[c] ? o.data[c][k] : '')}`).join(' · ') + ` · 보냄 ${((o.sent[k] - o.ts[k]) / 1000).toFixed(1)}초 뒤` + (Object.values(o.bad).some((b) => b[k]) ? ' · <span style="color:#FFB300">상태 −1</span>' : '') + (inAlarm ? ' · <span style="color:#FF2D55">끊긴 구간(워치-폰)</span>' : '') + ' <span id="sigStatus"></span>';
  const R = sig.raw;
  if (R && R.n) {
    let i = lowerIn(R.t, R.n, o.ts[k]); if (i >= R.n) i = R.n - 1;
    sig.rawHl = i;
    if (fromChart) { const box = $('rawBox'); box.scrollTop = Math.max(0, i * ROW_H - box.clientHeight / 2 + ROW_H); }
    renderRawRows();
  }
}

// 원본 값 표 — 보는 창의 줄을 모두. 화면에 보이는 줄만 그때그때 만든다(수만 줄도 가볍게)
const ROW_H = 22;
function renderRaw() {
  if (!$('sigRows') || !sig.cols) return;
  let n = 0; sig.seg.forEach(({ i, j }) => (n += j - i));
  const ro = new Array(n), rk = new Int32Array(n), rt = new Float64Array(n); let m = 0;
  sig.seg.forEach(({ o, i, j }) => { for (let k = i; k < j; k++, m++) { ro[m] = o; rk[m] = k; rt[m] = o.ts[k]; } });
  sig.raw = { o: ro, k: rk, t: rt, n };
  const box = $('rawBox'); if (sig.hoverT === null) box.scrollTop = 0;
  box.onscroll = () => { cancelAnimationFrame(sig.rawRaf); sig.rawRaf = requestAnimationFrame(renderRawRows); };
  $('sigRows').onmouseover = (e) => { const tr = e.target.closest('tr[data-i]'); if (!tr) return; sig.hoverT = sig.raw.t[+tr.dataset.i]; drawCursor(false); };
  renderRawRows();
}
function renderRawRows() {
  const R = sig.raw, box = $('rawBox'); if (!R || !box) return;
  if (!R.n) { $('sigRows').innerHTML = `<tr><td colspan="${sig.cols.length + 1}">이 창에 샘플이 없습니다</td></tr>`; return; }
  const head = ($('rawHead') && $('rawHead').offsetHeight) || ROW_H;
  const a = Math.max(0, Math.floor((box.scrollTop - head) / ROW_H) - 10), b = Math.min(R.n, a + Math.ceil(box.clientHeight / ROW_H) + 20);
  const out = [`<tr class="sp" style="height:${a * ROW_H}px"></tr>`];
  for (let i = a; i < b; i++) {
    const o = R.o[i], k = R.k[i], r = rowAt(o, k);
    out.push(`<tr data-i="${i}"${i === sig.rawHl ? ' class="hl"' : ''}><td>${kstMD(o.ts[k])} ${kstFull(o.ts[k])}</td>${r.map((q, jj) => `<td class="${/status/.test(sig.cols[jj]) && q !== 0 && q !== null ? 'bad' : ''}">${esc(Array.isArray(q) ? JSON.stringify(q) : q)}</td>`).join('')}</tr>`);
  }
  out.push(`<tr class="sp" style="height:${(R.n - b) * ROW_H}px"></tr>`);
  $('sigRows').innerHTML = out.join('');
}

addEventListener('resize', () => { if (sig.files.length) drawAll(); });
// 처음에 숨어 있다 보이게 된 경우(미리보기 창 등)에도 다시 그린다
let lastW = 0;
if (window.ResizeObserver) new ResizeObserver((en) => { const w = Math.round(en[0].contentRect.width); if (w && w !== lastW) { lastW = w; if (sig.files.length && $('sigOv')) drawAll(); } }).observe($('signal'));

/* ---------------- 데모 자료 (가짜) ---------------- */

const demoCmd = new Map();
const demo = (() => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const now = Date.now();
  const day = 864e5;
  const cov = (onUntil, holes = []) => Array.from({ length: 144 }, (_, i) => (i >= 144 - onUntil && !holes.includes(i) ? '1' : '0')).join('');
  const phones = [
    { phone_id: 'demo0001aaaa', app_version: '1.8.1', at: now - 2 * 60e3, subject_id: 'DEMO-001', last_sample_at: now - 2 * 60e3 - 14e3, watch_device_id: 'd3m0a1b2', google_connected: true,
      today: { PPG_CONTINUOUS: 812400 }, coverage_24h: cov(144, [40, 41, 88]), drive_last_ok_at: now - 6 * 60e3, drive_pending_files: 0 },
    { phone_id: 'demo0002bbbb', app_version: '1.8.1', at: now - 3 * 60e3, subject_id: 'DEMO-002', last_sample_at: now - 27 * 60e3, watch_device_id: 'd3m0c3d4', google_connected: true,
      today: { PPG_CONTINUOUS: 402000 }, coverage_24h: cov(144, [141, 142, 143]), drive_last_ok_at: now - 12 * 60e3, drive_pending_files: 1 },
    { phone_id: 'demo0003cccc', app_version: '1.8.1', at: now - 4 * 60e3, subject_id: '', last_sample_at: now - 3 * 3600e3, watch_device_id: '', google_connected: true,
      today: {}, coverage_24h: cov(60).replace(/1/g, (m, i) => (i > 120 ? '0' : m)), drive_last_ok_at: now - 9 * 60e3, drive_pending_files: 0 },
  ];
  const mkDays = (startMs, n, perDay) => Array.from({ length: n }, (_, i) => ({ date: kstDate(startMs + i * day), collected_min: perDay[i], gaps: Math.round(rnd() * 6), watches: ['d3m0a1b2'], closed_files: 24, rows: perDay[i] * 60 * 25 }));
  const s1 = now - 2.6 * day, s2 = now - 1.2 * day, s3 = now - 7 * day;
  const subjects = [
    { info: { subject_id: 'DEMO-001', started_at: s1, started_at_kst: kstDate(s1) + ' ' + kstHM(s1), total_collected_min: 3660, days: mkDays(s1, 3, [820, 1410, 1430]) }, folderId: 'd1' },
    { info: { subject_id: 'DEMO-002', started_at: s2, started_at_kst: kstDate(s2) + ' ' + kstHM(s2), total_collected_min: 1510, days: mkDays(s2, 2, [480, 1030]) }, folderId: 'd2' },
    { info: { subject_id: 'DEMO-000', started_at: s3, started_at_kst: kstDate(s3) + ' ' + kstHM(s3), ended_at: s3 + 5.2 * day, ended_at_kst: kstDate(s3 + 5.2 * day) + ' 14:00', total_collected_min: 6240, days: mkDays(s3, 6, [700, 1400, 1380, 1420, 1390, 950]) }, folderId: 'd0' },
  ];
  const fileName = (date, h, watch) => `${date.replace(/-/g, '')}_${pad(h)}_PPG_${watch}.ndjson`;
  // 날짜 하나의 manifest — 대상자 시작 시각부터, 오늘이면 지금까지
  const mkManifest = (s, date) => {
    const out = [], info = s.info, bad = info.subject_id === 'DEMO-002';
    const end = Math.min(info.ended_at || now, now);
    for (let h = 0; h < 24; h++) {
      const hs = Date.parse(`${date}T${pad(h)}:00:00+09:00`), he = hs + 3600e3;
      const first = Math.max(hs, info.started_at), last = Math.min(he - 1000, end - 30e3);
      if (last <= first) continue;
      let fill = 0.985 + rnd() * 0.014;
      if (bad && he > now) fill = 0.55;
      if (h === 3) fill = 0.93;
      const rows = Math.round(((last - first) / 1000) * 25 * fill);
      out.push({ file: fileName(date, h, 'd3m0a1b2'), tracker: 'PPG', watch: 'd3m0a1b2', hour: String(h), rows: String(rows), bytes: String(rows * 58), first_ts: String(first), last_ts: String(last),
        first_kst: `${date} ${kstFull(first).slice(0, 8)}`, last_kst: `${date} ${kstFull(last).slice(0, 8)}`, status: he > now && !info.ended_at ? 'open' : 'closed', synced: he > now && bad ? 'no' : 'yes' });
    }
    return out;
  };
  const mkEvents = (s, date, man) => {
    const ev = [];
    if (date === kstDate(s.info.started_at)) ev.push({ kst: `${date} ${kstFull(s.info.started_at).slice(0, 8)}`, code: 'subject_start', text: `대상자 시작 ${s.info.subject_id}` });
    man.forEach((r) => {
      const h = +r.hour;
      if (h % 6 === 0) ev.push({ kst: `${date} ${pad(h)}:00:05`, code: 'drive_ok', text: '드라이브 상태 정상' });
      if (rnd() < 0.35) { const m = Math.floor(rnd() * 50);
        ev.push({ kst: `${date} ${pad(h)}:${pad(m)}:38`, code: 'watch_lost', text: '워치 상태 안 옵니다' });
        ev.push({ kst: `${date} ${pad(h)}:${pad(m + 1 + Math.floor(rnd() * 3))}:38`, code: 'watch_back', text: '워치 상태 받는 중' }); }
      if (h === 3) ev.push({ kst: `${date} 03:12:10`, code: 'relay_restart', text: '중계 다시 켬 · 메모리 정리로 꺼짐' });
    });
    return ev.sort((a, b) => a.kst.localeCompare(b.kst));
  };
  const raw = (name) => {
    const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})_PPG/.exec(name);
    const date = `${m[1]}-${m[2]}-${m[3]}`, h = +m[4];
    const hs = Date.parse(`${date}T${pad(h)}:00:00+09:00`), start = hs, end = Math.min(hs + 3600e3, now);
    const lines = [JSON.stringify({ record: 'header', format: 'avs-raw/2', tracker: 'PPG_CONTINUOUS', watch: 'd3m0a1b2', device_id: 'd3m0a1b2-demo', subject_id: 'DEMO', rate_hz: 25, app_version: '1.8.1',
      units: { ppg_green: 'ADC (단위 없음)', ppg_ir: 'ADC (단위 없음)', ppg_red: 'ADC (단위 없음)' }, session_id: 'demo-session' }),
      JSON.stringify(['ts', 'sent_at', 'ppg_green', 'ppg_ir', 'ppg_red', 'green_status', 'ir_status', 'red_status'])];
    let hr = 72, ph = 0, drift = 0;
    for (let t = start; t < end; t += 40) {
      if (t > start + 1200e3 && t < start + 1210e3) continue;           // 가짜 빈틈 10초
      hr += (rnd() - 0.5) * 0.02; ph += (2 * Math.PI * hr / 60) * 0.04; drift += (rnd() - 0.5) * 30;
      const beat = Math.sin(ph) + 0.35 * Math.sin(2 * ph + 1);
      const neg = t > start + 1800e3 && t < start + 1890e3;             // 가짜 −1 구간
      const sent = Math.ceil((t - start) / 16000) * 16000 + start + 1200;
      lines.push(JSON.stringify([t, sent, Math.round(-150000 + drift + 9000 * beat), neg ? 0 : Math.round(1560000 + drift * 0.3 + 4000 * beat), neg ? 0 : Math.round(1120000 + drift * 0.2 + 2500 * beat), 0, neg ? -1 : 0, neg ? -1 : 0]));
    }
    return lines.join('\n');
  };
  const cacheDay = new Map();
  return {
    raw,
    all: () => {
      phones.forEach((p) => { p._dir = p.phone_id.slice(0, 8); p.watch_control = p.subject_id ? { id: p.watch_device_id, state: 'collecting', at: p.at } : { id: 'd3m0e5f6', state: 'standby', at: p.at }; });
      if (!state.phoneDirs) state.phoneDirs = new Map(phones.map((p) => [p._dir, { folderId: 'pf_' + p._dir, files: {} }]));
      phones[2].watch_control = { id: 'd3m0e5f6', state: 'charging', at: phones[2].at };
      phones[0].watches = [{ id: 'd3m0a1b2', state: 'collecting', state_at: phones[0].at, last_sample_at: phones[0].at, connected: true, line: '받는 중 · 14초 전 · d3m0a1b2', tone: 'ok' }, { id: 'd3m0e5f6', state: 'charging', state_at: phones[0].at - 30 * 60e3, connected: true, line: '충전 중 · 수집 안 함 · d3m0e5f6', tone: 'wait' }];
      phones[0].home = { subject: { title: 'DEMO-001', note: '입원 3일째', goal: '수집 61 / 100시간', progress: 0.61, missing: false },
        lines: [{ label: '워치', text: '받는 중 · 14초 전 · d3m0a1b2', tone: 'ok' }, { label: '워치', text: '충전 중 · 수집 안 함 · d3m0e5f6', tone: 'wait' }, { label: '폰 저장', text: '오늘 812,400행 · 남은 공간 약 40일', tone: 'ok' }, { label: '드라이브', text: '올림 · 6분 전 · 밀린 것 0 (gachondac…)', tone: 'ok' }],
        remote_note: '원격 · 마지막 명령 09:12 시작 DEMO-001' };
      phones[2].home = { subject: { title: '연구번호 없음', missing: true }, lines: [{ label: '워치', text: '충전 중 · 수집 안 함 · d3m0e5f6', tone: 'wait' }, { label: '폰 저장', text: '오늘 0행 · 남은 공간 약 41일', tone: 'ok' }, { label: '드라이브', text: '올림 · 9분 전 · 밀린 것 0 (gachondac…)', tone: 'ok' }], remote_note: '' };
      return { phones, subjects };
    },
    // 예시 — 보낸 명령을 몇 초 뒤 «폰이 반영한» 것처럼
    command: (pid, cmd) => { demoCmd.set(pid, { cmd, at: Date.now() }); },
    ack: (pid) => { const c = demoCmd.get(pid); if (!c || Date.now() - c.at < 5000) return null; const k = c.cmd;
      const p = phones.find((x) => x._dir === pid), sub = k.action === 'sync_now' ? (p ? p.subject_id : '') : k.action === 'end' ? '' : k.action === 'rename' ? k.rename_to : k.subject_id;
      if (p) { p.subject_id = sub; p.at = Date.now(); if (p.home) p.home.subject = sub ? { title: sub, note: '입원 0일째', goal: '수집 0 / 100시간', progress: 0, missing: false } : { title: '연구번호 없음', missing: true }; }
      return { format: 'avs-ack/1', cmd_id: k.cmd_id, seq: k.seq, action: k.action, applied_at: Date.now(), result: 'ok', reason: '', subject_id_now: sub, watch: { id: p ? p.watch_device_id || 'd3m0e5f6' : '', state: (p && p.watch_control && p.watch_control.state) || 'collecting', at: Date.now() } }; },
    dates: (s) => s.info.days.map((d) => ({ name: d.date, id: s.info.subject_id + '|' + d.date, s })),
    day: (d) => { if (!cacheDay.has(d.id)) { const man = mkManifest(d.s, d.name); cacheDay.set(d.id, { manifest: man, events: mkEvents(d.s, d.name, man) }); } return cacheDay.get(d.id); },
  };
})();

/* ---------------- 시작 ---------------- */

function start() {
// 머리 막대의 웹 판 — 손으로 적지 않고 VERSION 하나에서 읽는다(폰 꼬리의 버전과 같은 방식).
if ($('webver')) $('webver').textContent = VERSION;
if (DEMO) {
  banner('<b>데모</b> — 화면을 보여 주려고 만든 <b>가짜 자료</b>입니다. 실제 자료는 로그인해야 보입니다. <a href="./">데모 끄기</a>', 'demo');
  $('btnLogin').hidden = true;
  signedIn();
} else if (CFG.clientId) {
  initAuth();
}
}
start();
