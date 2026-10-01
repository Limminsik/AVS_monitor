'use strict';
/* AVS 모니터링 — 드라이브의 상태·요약 파일을 읽어 그린다. 자료는 메모리에만 둔다. */

const CFG = Object.assign({ clientId: '', rootFolderName: 'AVS_raw', refreshMinutes: 5 }, window.AVS_CONFIG || {});
const VERSION = 'monitor 0.1';
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

async function loadDrive() {
  const roots = await listAll(`name='${CFG.rootFolderName}' and mimeType='${FOLDER}' and trashed=false`);
  if (!roots.length) throw new Error('NO_ROOT');
  const statusFiles = await listAll(`name='status.json' and trashed=false`);
  const subjectFiles = await listAll(`name='subject.json' and trashed=false`);
  const phones = (await pool(statusFiles, 6, async (f) => JSON.parse(await fileText(f.id)))).filter(Boolean);
  const subjects = (await pool(subjectFiles, 6, async (f) => ({ info: JSON.parse(await fileText(f.id)), folderId: (f.parents || [])[0] }))).filter(Boolean);
  return { phones, subjects };
}

async function loadDates(subject) {
  if (DEMO) return demo.dates(subject);
  const folders = await listAll(`'${subject.folderId}' in parents and mimeType='${FOLDER}' and trashed=false`, 'id,name');
  return folders.filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
}

async function loadDay(dateFolder) {
  if (DEMO) return demo.day(dateFolder);
  const files = await listAll(`'${dateFolder.id}' in parents and trashed=false`, 'id,name,size');
  const get = async (name) => { const f = files.find((x) => x.name === name); return f ? parseCsv(await fileText(f.id)) : []; };
  const [manifest, events] = await Promise.all([get('manifest.csv'), get('events.csv')]);
  return { manifest, events, files: files.filter((f) => f.name.endsWith('.ndjson')) };
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
  const verdicts = state.phones.map((p) => (p.subject_id ? { cls: 'ok', text: '수집 중' } : { cls: 'off', text: '완료' }));
  const current = state.subjects.filter(isRunning).length;
  const done = state.subjects.length - current;
  const small = (t) => `<small style="font-size:14px;color:var(--ink3);font-weight:500"> ${t}</small>`;
  $('kpis').innerHTML = [
    ['코호트', `${state.subjects.length}${small('/ ' + GOAL_SUBJECTS + '명')}`],
    ['현재 수집', `${current}${small('명')}`],
    ['수집 완료', `${done}${small('명')}`],
  ].map(([l, v]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`).join('');

  const lastAt = Math.max(0, ...state.phones.map((p) => p.at || 0));
  $('phonesNote').textContent = state.phones.length ? `${state.sel ? state.sel + ' · ' : ''}폰 상태 파일 ${state.phones.length}개 · 가장 최근 보고 ${kstHM(lastAt)} (${ago(lastAt, now)})` : '';
  $('progNote').textContent = `${state.subjects.length}명`;
  const subjOf = (id) => state.subjects.find((s) => s.info.subject_id === id);
  // 연결 상태는 고른 대상자 한 명 것만
  const shown = state.phones.map((p, i) => ({ p, v: verdicts[i] })).filter(({ p }) => state.sel && p.subject_id === state.sel);
  const emptyMsg = !state.phones.length ? '<div class="empty">폰 상태 파일(<code>status.json</code>)을 찾지 못했습니다 — 폰 앱이 드라이브에 상태를 올리고 있는지 확인하세요.</div>'
    : !state.sel ? '<div class="empty">연구번호를 고르면 그 대상자를 수집하는 폰·워치의 연결 상태가 나옵니다.</div>'
    : `<div class="empty">지금 <b>${esc(state.sel)}</b>를 수집하는 폰이 없습니다 — 수집이 끝났거나 폰에서 연구번호가 바뀌었습니다.</div>`;
  $('phones').innerHTML = shown.length ? `<table class="list">
    <thead><tr><th>상태</th><th>대상자</th><th>워치</th><th>스마트폰</th><th>드라이브</th><th class="r">전체 행</th><th style="min-width:200px">지난 24시간</th><th>빈 곳</th></tr></thead>
    <tbody>` + shown
    .map(({ p, v }) => {
      const sj = subjOf(p.subject_id);
      const today = Object.values(p.today || {}).reduce((a, n) => a + Number(n || 0), 0);
      const total = sj ? (sj.info.days || []).reduce((a, d) => a + Number(d.rows || 0), 0) : 0;
      const cov = String(p.coverage_24h || '').padStart(144, '0').slice(-144);
      // 10분 칸 — 대상자 시작 뒤 칸만 셈
      const slot0 = (p.at || now) - 144 * 600e3, from = sj && sj.info.started_at ? sj.info.started_at : (p.subject_id ? slot0 : Infinity);
      const holes = []; let open = null;
      [...cov].forEach((c, i) => { const t = slot0 + i * 600e3; const counted = t + 600e3 > from; const miss = counted && c !== '1';
        if (miss && open === null) open = t; if (!miss && open !== null) { holes.push([open, t]); open = null; } });
      if (open !== null) holes.push([open, slot0 + 144 * 600e3]);
      const missN = holes.reduce((a, [x, y]) => a + Math.round((y - x) / 600e3), 0);
      const holeTxt = holes.map(([x, y]) => `${kstHM(x)}–${kstHM(y)}`).join(', ');
      const drive = p.drive_last_ok_at ? `${kstHM(p.drive_last_ok_at)} <span class="muted">${ago(p.drive_last_ok_at, now)}</span>${p.drive_pending_files ? ` · 밀림 ${p.drive_pending_files}` : ''}` : '—';
      return `<tr class="st-${v.cls}${state.sel && state.sel === p.subject_id ? ' sel' : ''}" data-subject="${esc(p.subject_id)}">
        <td><span class="pill ${v.cls}">${esc(v.text)}</span></td>
        <td class="subj">${esc(p.subject_id || '—')}</td>
        <td>${kstHM(p.last_sample_at)} <span class="muted">${ago(p.last_sample_at, now)}</span><div class="id">${esc(String(p.watch_device_id || '').slice(0, 8) || '—')}</div></td>
        <td>${kstHM(p.at)} <span class="muted">${ago(p.at, now)}</span><div class="id">${esc(String(p.phone_id || '').slice(0, 8))} · ${esc(p.app_version || '')}</div></td>
        <td>${drive}</td>
        <td class="r" data-tip="오늘 ${fmtInt(today)}행">${sj ? fmtInt(total) : '—'}</td>
        <td><div class="strip" data-tip="지난 24시간 · 10분 칸 · 워치 자료가 들어온 칸 ${[...cov].filter((c) => c === '1').length}/144">${[...cov].map((c) => `<i${c === '1' ? ' class="on"' : ''}></i>`).join('')}</div></td>
        <td>${!p.subject_id ? '<span class="muted">—</span>' : missN ? `<span class="miss" data-tip="${esc(holeTxt)}">${missN * 10}분 · ${holes.length}곳</span>` : '<span class="nomiss">없음</span>'}</td>
      </tr>`;
    }).join('') + '</tbody></table>' : emptyMsg;
  document.querySelectorAll('#phones tr[data-subject]').forEach((el) => el.addEventListener('click', () => openSubject(el.dataset.subject)));
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
    <span><i class="sw" style="background:var(--seq0)"></i>50 아래</span><span><i class="sw" style="background:transparent;box-shadow:inset 0 0 0 2px #E0A33A"></i>쓰는 중</span>`;
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
  state.timer = setInterval(refresh, CFG.refreshMinutes * 60e3);
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
  cols: null, chans: [], header: null, rate: 0, alarms: [], issues: [], hoverT: null, seg: [], raf: 0, ovSpan: 864e5 };


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
  sig.files.forEach((f) => { if (old.get(f.name) !== f.rows) { sig.cache.delete(f.name); sig.failed.delete(f.name); } });
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
  if (!sameTag) { sig.cols = null; sig.chans = []; sig.header = null; sig.view.len = sig.rate >= 10 ? 30 : sig.rate >= 1 ? 1800 : 1800; }
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
  if (sig.cache.has(f.name)) { const v = sig.cache.get(f.name); sig.cache.delete(f.name); sig.cache.set(f.name, v); adoptCols(v); return v; }
  if (sig.failed.has(f.name)) return null;
  if (sig.loading.has(f.name)) return sig.loading.get(f.name);
  const p = (async () => {
    try {
      let text;
      if (DEMO) text = demo.raw(f.name);
      else { const d = state.fileIndex && state.fileIndex.get(f.name); if (!d) throw new Error('드라이브에서 찾지 못함'); text = await fileText(d.id); }
      const o = await parser(text); o.text = text;
      sig.cache.set(f.name, o);
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
  sig.preT = setTimeout(() => [sig.files[i0 - 1], i1 >= 0 ? sig.files[i1] : null].filter(Boolean).forEach((f) => loadFile(f)), 600);   // 앞뒤 파일은 멈춘 뒤에
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
      <div class="legend"><span><i class="sw" style="background:${chanColor('green')}"></i>측정 값</span><span><i class="sw" style="background:var(--mon-bad)"></i>센서 상태 −1</span><span><i class="sw" style="background:rgba(255,71,71,.35)"></i>1초 넘는 빈틈</span><span><i class="sw" style="background:var(--mon-alarm)"></i>워치 끊김(폰 로그)</span><span><i class="sw" style="background:transparent;border-color:var(--mon-win)"></i>지금 보는 창</span></div>
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
    for (let k = i; k < j; k++) { const t = o.ts[k]; if (prev !== null && t - prev > 1000) { gaps++; gapS += (t - prev) / 1000; } prev = t; if (any.some((bb) => bb[k])) badN++; if ((k - i) % 25 === 0) lag.push((o.sent[k] - t) / 1000); } });
  lag.sort((p, q) => p - q);
  const exp = sig.rate ? v.len * sig.rate : 0;
  $('sigStat').innerHTML = `<span>이 창 <b>${fmtInt(n)}</b>샘플${exp ? ` / 기대 ${fmtInt(exp)}` : ''}</span><span>1초 넘는 빈틈 <b>${gaps}</b>${gaps ? ` (합 ${gapS.toFixed(1)}초)` : ''}</span><span>센서 −1 <b>${fmtInt(badN)}</b></span><span>도착 지연 중앙 <b>${lag.length ? lag[lag.length >> 1].toFixed(1) + '초' : '—'}</b></span>`;
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
  if (al) parts.push(`워치 끊김(폰 로그) ${kstFull(al[0]).slice(0, 8)}–${kstFull(al[1]).slice(0, 8)} · ${Math.round((al[1] - al[0]) / 1000)}초 — 누르면 그 시작으로`);
  iss.forEach((e) => parts.push(`${String(e.kst).slice(11, 19)} ${e.text} (${e.code})`));
  return parts.join(' · ');
}

function drawOverview() {
  const ov = $('sigOv'), O = canvasSetup(ov), x = O.x, w = O.w, h = O.h;
  if (w < 20) return;
  const [T0, T1] = ovRange(), X = (t) => ((t - T0) / (T1 - T0)) * w, SP = T1 - T0;
  const BAR_T = 16, BAR_H = h - 16 - 62, AL_Y = h - 44, IS_Y = h - 12;
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
  // 워치 끊김(폰 로그) — 넓으면 길이를 적음
  x.fillStyle = cssv('--mon-dim'); x.fillText('워치 끊김(폰 로그)', 2, AL_Y - 4);
  x.fillStyle = cssv('--mon-grid2'); x.fillRect(0, AL_Y, w, 14);
  sig.alarms.forEach(([sA, eA]) => { if (!(eA > T0 && sA < T1)) return; const a = X(Math.max(sA, T0)), b = X(Math.min(eA, T1));
    x.fillStyle = cssv('--mon-alarm'); x.fillRect(a, AL_Y, Math.max(2, b - a), 14);
    const lb = (eA - sA) >= 60e3 ? `${Math.round((eA - sA) / 60e3)}분` : `${Math.round((eA - sA) / 1000)}초`;
    if (b - a > x.measureText(lb).width + 8) { x.fillStyle = '#fff'; x.fillText(lb, a + 4, AL_Y + 11); } });
  // 다른 이슈(폰 로그) — 점
  x.fillStyle = cssv('--mon-dim'); x.fillText('다른 이슈(폰 로그)', 2, IS_Y - 4);
  x.fillStyle = cssv('--mon-grid2'); x.fillRect(0, IS_Y, w, 8);
  sig.issues.forEach((e) => { if (e.ms < T0 || e.ms > T1) return; x.fillStyle = evClass(e.code) === 'bad' ? '#FF4747' : '#FFB300'; x.fillRect(X(e.ms) - 1.5, IS_Y, 3, 8); });
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
    // 워치 끊김(폰 로그) 띠
    x.fillStyle = cssv('--mon-alarm'); sig.alarms.forEach(([sA, eA]) => { if (eA > tA && sA < tB) x.fillRect(XX(Math.max(sA, tA)), 0, Math.max(2, XX(Math.min(eA, tB)) - XX(Math.max(sA, tA))), 4); });
    if (!cnt) { const rg = $('rg_' + col); if (rg) rg.textContent = ''; drawCursorOn(c); return; }
    // −1 음영 · 빈틈
    let prevT = null;
    sig.seg.forEach(({ o, i, j }) => {
      const bad = o.bad[col]; x.fillStyle = cssv('--mon-bad');
      for (let k = i; k < j; k++) if (bad && bad[k]) { let e = k; while (e < j && bad[e]) e++; x.fillRect(XX(o.ts[k]), T, Math.max(2, XX(o.ts[e - 1]) - XX(o.ts[k])), PH); k = e; }
      for (let k = i; k < j; k++) { const t = o.ts[k]; if (prevT !== null && t - prevT > 1000) { const x0 = XX(prevT), x1 = XX(t);
        x.fillStyle = 'rgba(255,71,71,.18)'; x.fillRect(x0, T, Math.max(2, x1 - x0), PH);
        if (x1 - x0 > 60) { x.fillStyle = '#FF8A8A'; x.fillText(`빈틈 ${((t - prevT) / 1000).toFixed(1)}초`, x0 + 6, T + PH - 8); } } prevT = t; }
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
  $('sigRead').innerHTML = `<b>${kstDate(o.ts[k])} ${kstFull(o.ts[k])}</b> · ` + sig.chans.map((c) => `<span style="color:${chanColor(c)}">${esc(c)}</span> ${esc(o.data[c] ? o.data[c][k] : '')}`).join(' · ') + ` · 보냄 ${((o.sent[k] - o.ts[k]) / 1000).toFixed(1)}초 뒤` + (Object.values(o.bad).some((b) => b[k]) ? ' · <span style="color:#FFB300">상태 −1</span>' : '') + (inAlarm ? ' · <span style="color:#FF2D55">워치 끊김 로그 구간</span>' : '') + ' <span id="sigStatus"></span>';
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
    all: () => ({ phones, subjects }),
    dates: (s) => s.info.days.map((d) => ({ name: d.date, id: s.info.subject_id + '|' + d.date, s })),
    day: (d) => { if (!cacheDay.has(d.id)) { const man = mkManifest(d.s, d.name); cacheDay.set(d.id, { manifest: man, events: mkEvents(d.s, d.name, man) }); } return cacheDay.get(d.id); },
  };
})();

/* ---------------- 시작 ---------------- */

function start() {
if (DEMO) {
  banner('<b>데모</b> — 화면을 보여 주려고 만든 <b>가짜 자료</b>입니다. 실제 자료는 로그인해야 보입니다. <a href="./">데모 끄기</a>', 'demo');
  $('btnLogin').hidden = true;
  signedIn();
} else if (CFG.clientId) {
  initAuth();
}
}
start();
