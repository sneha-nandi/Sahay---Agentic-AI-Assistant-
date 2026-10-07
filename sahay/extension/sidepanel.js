const $ = (s, root = document) => root.querySelector(s);

// The nine workflow steps, in order, with what the user sees while each runs.
const STEPS = [
  ['observe', 'Reading the page'], ['understand', 'Understanding your question'], ['retrieve', 'Checking trusted sources'],
  ['reason', 'Working out a full answer'], ['assess_risk', 'Checking how risky each step is'], ['decide', 'Deciding what to do'],
  ['act', 'Working on the page'], ['verify', 'Checking that it worked'], ['respond', 'Writing it up'],
];
const STEP_OF = { ask_human: 'act', clarify: 'act' };
const PROFILE_FIELDS = [['full_name', 'Full name'], ['email', 'Email'], ['phone', 'Mobile number'], ['address', 'Postal address'],
  ['city', 'City'], ['state', 'State'], ['pincode', 'PIN code']];
const STARTERS = ['Explain this page to me.', 'What documents do I need?', 'What are the important dates?',
  'Fill in the non-sensitive information.', 'Help me complete this application.'];
const FACTS = [['eligibility', 'Who can apply', 'ul'], ['required_documents', 'Documents you need', 'ul'],
  ['deadlines', 'Important dates', 'ul'], ['next_steps', 'Next steps', 'ol']];
const SLOW_ACTIONS = new Set(['navigate', 'click', 'submit']);
const MAX_SESSIONS = 20;     // per site
const MAX_TURNS = 40;        // per conversation
const HISTORY_TURNS = 6;     // earlier turns sent with a follow-up question

let settings = { backend: 'http://localhost:8000', profile: {} };
let site = null;    // { origin, host, tabId, url } for the active tab
let session = null; // { id, origin, title, created, updated, turns: [{ question, url, ts, response, error }] }
let busy = false;

// Build DOM with text only: model and page text are never parsed as HTML.
function h(tag, { dataset = {}, ...props } = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  Object.assign(node.dataset, dataset);
  node.append(...children.flat().filter((c) => c != null && c !== '' && c !== false));
  return node;
}

const ICONS = {
  plus: 'M12 5v14M5 12h14',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  send: 'M5 12h14M13 6l6 6-6 6',
  speaker: 'M11 5 6 9H3v6h3l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
};
// A small hand-drawn mark: a rounded shield (safety) with a marigold guiding path.
function brandMark() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');
  const shield = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shield.setAttribute('d', 'M16 2.5 4.5 7.2v9.1c0 6.6 4.7 11.4 11.5 13.2 6.8-1.8 11.5-6.6 11.5-13.2V7.2Z');
  shield.setAttribute('fill', 'currentColor');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M10.5 17.6 14.6 21.6 22 12.4');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'var(--marigold)');
  path.setAttribute('stroke-width', '3');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(shield, path);
  return svg;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
    svg.setAttribute(k, v);
  }
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

const setStatus = (text) => ($('#status').textContent = text);
const when = (ts) => new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const pathOf = (url) => { try { const u = new URL(url); return u.pathname + (u.search ? '?…' : ''); } catch { return ''; } };
const scrollDown = () => ($('#thread').scrollTop = $('#thread').scrollHeight);

// ------------------------------------------------------------ Markdown (safe subset)

function inline(text, cite) {
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(/\*\*(.+?)\*\*|`([^`]+)`|\[([\w.-]+#\d+)\]|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])/g)) {
    out.push(String(text).slice(last, m.index));
    if (m[1]) out.push(h('strong', {}, m[1]));
    else if (m[2]) out.push(h('code', {}, m[2]));
    else if (m[3]) out.push(cite.has(m[3]) ? h('span', { className: 'cite', title: cite.get(m[3]).title }, String(cite.get(m[3]).n)) : '');
    else out.push(h('em', {}, m[4]));
    last = m.index + m[0].length;
  }
  out.push(String(text).slice(last));
  return out;
}

function markdown(text, cite) {
  const root = h('div', { className: 'answer' });
  let list = null;
  let para = [];
  const flush = () => { if (para.length) root.append(h('p', {}, inline(para.join(' '), cite))); para = []; };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    let m;
    if (!line) { flush(); list = null; continue; }
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) { flush(); list = null; root.append(h('h3', {}, inline(m[1].replace(/\*\*/g, ''), cite))); continue; }
    if ((m = line.match(/^(?:[-*•]|(\d+)[.)])\s+(.*)$/))) {
      flush();
      const tag = m[1] ? 'OL' : 'UL';
      if (!list || list.tagName !== tag) root.append((list = h(tag.toLowerCase())));
      list.append(h('li', {}, inline(m[2], cite)));
      continue;
    }
    list = null;
    para.push(line);
  }
  flush();
  return root;
}

// ------------------------------------------------------------ settings

async function loadSettings() {
  try { Object.assign(settings, await chrome.storage.local.get(['backend', 'profile'])); } catch {}
  $('#backend').value = settings.backend;
  $('#profileFields').replaceChildren(...PROFILE_FIELDS.map(([key, label]) =>
    h('label', { className: 'field' }, label, h('input', { name: key, value: settings.profile?.[key] || '' }))));
}

function toggleSheet(id) {
  for (const sheet of ['history', 'settings']) {
    const open = sheet === id && $(`#${sheet}`).hidden;
    $(`#${sheet}`).hidden = !open;
    $(`#${sheet}Toggle`).setAttribute('aria-expanded', String(open));
  }
}

$('#settingsToggle').onclick = () => toggleSheet('settings');
$('#historyToggle').onclick = () => toggleSheet('history');

$('#saveSettings').onclick = async () => {
  settings.backend = $('#backend').value.replace(/\/$/, '') || 'http://localhost:8000';
  settings.profile = Object.fromEntries([...$('#profileFields').querySelectorAll('input')].map((i) => [i.name, i.value.trim()]));
  await chrome.storage.local.set({ backend: settings.backend, profile: settings.profile });
  toggleSheet(null);
};

$('#clearHistory').onclick = async (e) => {
  if (busy) return;
  const button = e.currentTarget;
  if (!button.dataset.armed) {
    button.dataset.armed = '1';
    button.textContent = 'Click again to delete every saved conversation';
    setTimeout(() => { delete button.dataset.armed; button.textContent = 'Delete all saved conversations'; }, 4000);
    return;
  }
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('history:')));
  session = null;
  delete button.dataset.armed;
  button.textContent = 'All saved conversations deleted';
  renderThread();
  renderSessions([]);
};

// ------------------------------------------------------------ saved conversations, per website

const storageKey = (origin) => `history:${origin}`;

async function loadSessions(origin) {
  try { return (await chrome.storage.local.get(storageKey(origin)))[storageKey(origin)] || []; } catch { return []; }
}

async function saveSession(s) {
  const others = (await loadSessions(s.origin)).filter((x) => x.id !== s.id);
  let sessions = [s, ...others].slice(0, MAX_SESSIONS);
  // Browser storage is limited. If it's full, drop the oldest conversations for this site
  // rather than losing the answer the person just got.
  for (;;) {
    try {
      await chrome.storage.local.set({ [storageKey(s.origin)]: sessions });
      return sessions;
    } catch (err) {
      if (sessions.length <= 1) {
        console.warn('Sahay could not save this conversation:', err);
        return sessions;
      }
      sessions = sessions.slice(0, Math.max(1, sessions.length - 3));
    }
  }
}

async function deleteSession(s) {
  const sessions = (await loadSessions(s.origin)).filter((x) => x.id !== s.id);
  await chrome.storage.local.set({ [storageKey(s.origin)]: sessions });
  if (session?.id === s.id) { session = null; renderThread(); }
  renderSessions(sessions);
}

function renderSessions(sessions) {
  $('#historySite').textContent = site?.host || 'this site';
  $('#sessions').replaceChildren(...(sessions.length ? sessions.map((s) => h('li', {},
    h('button', {
      type: 'button', className: `open${s.id === session?.id ? ' current' : ''}`,
      onclick: () => { if (busy) return; session = s; renderThread(`You're back in a conversation from ${when(s.updated)}.`); toggleSheet(null); },
    }, h('strong', {}, s.title), h('small', {}, `${s.turns.length} question${s.turns.length === 1 ? '' : 's'}, last on ${when(s.updated)}`)),
    h('button', { type: 'button', className: 'icon', title: 'Delete this conversation', ariaLabel: `Delete ${s.title}`, onclick: () => !busy && deleteSession(s) }, icon('trash'))))
    : [h('li', { className: 'hint' }, 'No saved conversations on this site yet.')]));
}

function newConversation() {
  if (busy) return;
  session = null;
  renderThread();
  toggleSheet(null);
  $('#request').focus();
}

// Follow the active tab: each website has its own conversations, and the latest one resumes automatically.
async function refreshSite() {
  if (busy) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let url = null;
  try { url = new URL(tab?.url); } catch {}
  const readable = url && ['http:', 'https:'].includes(url.protocol);
  const origin = readable ? url.origin : null;
  if (site && site.origin === origin && site.tabId === tab?.id) { site.url = tab.url; return; }
  site = { origin, host: readable ? url.host : null, tabId: tab?.id, url: tab?.url };
  $('#site').textContent = readable ? url.host : 'Open a website to start';
  const sessions = origin ? await loadSessions(origin) : [];
  session = sessions[0] || null;
  renderThread(session ? `Picking up your conversation from ${when(session.updated)}.` : '');
  renderSessions(sessions);
}
chrome.tabs.onActivated.addListener(refreshSite);
chrome.tabs.onUpdated.addListener((tabId, info) => { if (tabId === site?.tabId && (info.url || info.status === 'complete')) refreshSite(); });

// ------------------------------------------------------------ thread rendering

function renderThread(banner = '') {
  const thread = $('#thread');
  thread.replaceChildren();
  if (!session?.turns.length) {
    thread.append(h('section', { className: 'welcome' },
      h('h2', {}, site?.origin ? 'What would you like to know about this page?' : 'Open a website, then ask Sahay about it.'),
      h('p', {}, 'Sahay explains official websites in plain words, tells you who can apply and what you need, and can fill in forms when you ask.'),
      site?.origin ? h('ul', { className: 'starters' }, STARTERS.map((q) => h('li', {}, h('button', { type: 'button', onclick: () => ask(q) }, q)))) : ''));
    return;
  }
  if (banner) thread.append(h('p', { className: 'resume' }, banner, h('button', { type: 'button', className: 'link', onclick: newConversation }, 'Start a new one')));
  session.turns.forEach((t, i) => {
    thread.append(youTurn(t));
    const view = sahayTurn();
    thread.append(view.el);
    if (t.response) view.render(t.response, i === session.turns.length - 1);
    else view.fail(t.error || 'This question did not finish.');
  });
  scrollDown();
}

function youTurn(t) {
  return h('div', { className: 'turn you' }, h('p', { className: 'bubble' }, t.question),
    t.url ? h('p', { className: 'where', title: t.url }, `Asked on ${pathOf(t.url)}`) : '');
}

function sahayTurn() {
  const now = h('p', { className: 'now' }, STEPS[0][1]);
  const track = h('ol', { className: 'track', ariaHidden: 'true' }, STEPS.map(() => h('li')));
  const progress = h('div', { className: 'progress' }, now, track);
  const warnings = h('div');
  const interaction = h('div');
  const body = h('div');
  const auditList = h('ol');
  const audit = h('details', { className: 'audit', hidden: true }, h('summary', {}, 'How Sahay got this answer'), auditList);
  const el = h('article', { className: 'turn sahay' },
    h('p', { className: 'speaker' }, h('span', { className: 'mark' }, brandMark()), 'Sahay'),
    progress, warnings, interaction, body);
  let reached = -1;

  const showWarnings = (flags) => warnings.replaceChildren(h('div', { className: 'warn' },
    h('strong', {}, 'This page contains text that tries to instruct AI assistants.'),
    'Sahay ignored it and did not act on it:', h('ul', {}, flags.map((f) => h('li', {}, f)))));

  return {
    el,
    step(node, entries) {
      const index = STEPS.findIndex(([key]) => key === (STEP_OF[node] || node));
      if (index >= 0) {
        reached = Math.max(reached, index);
        now.textContent = STEPS[index][1];
        setStatus(STEPS[index][1]);
        [...track.children].forEach((li, i) => { li.className = i === index ? 'current' : i <= reached ? 'done' : ''; });
      }
      audit.hidden = false;
      for (const { ts, step, ...detail } of entries) {
        auditList.append(h('li', {}, h('strong', {}, step), ` at ${new Date(ts).toLocaleTimeString()}`, h('pre', {}, JSON.stringify(detail, null, 1))));
        if (step === 'observe' && detail.injection_flags?.length) showWarnings(detail.injection_flags);
      }
    },
    waiting(text) { now.textContent = text; setStatus('Waiting for you'); },
    ask(card) { interaction.replaceChildren(card); scrollDown(); },
    doneAsking() { interaction.replaceChildren(); },
    fail(message) {
      progress.remove();
      interaction.replaceChildren();
      body.replaceChildren(h('p', { className: 'error', role: 'alert' }, message));
      setStatus('Error');
    },
    render(r, latest) {
      progress.remove();
      interaction.replaceChildren();
      if (r.injection_warnings?.length) showWarnings(r.injection_warnings);
      const cite = new Map((r.sources || []).map((s, i) => [s.id, { n: i + 1, title: `${s.title}: ${s.section}` }]));
      const answer = markdown(r.answer, cite);
      const facts = h('div', { className: 'facts' },
        r.summary ? h('details', {}, h('summary', {}, 'This page in short'), h('p', {}, r.summary)) : '',
        FACTS.map(([key, title, tag]) => (r[key]?.length
          ? h('details', { open: key === 'eligibility' }, h('summary', {}, title, h('span', { className: 'count' }, String(r[key].length))),
            h(tag, {}, r[key].map((item) => h('li', {}, inline(item, cite)))))
          : '')),
        r.results?.length
          ? h('details', { open: true }, h('summary', {}, 'What Sahay did', h('span', { className: 'count' }, String(r.results.length))),
            h('ul', { className: 'results' }, r.results.map((x) => h('li', {},
              h('span', { className: `risk ${x.risk || 'low'}` }, `${x.risk || 'low'} risk`),
              h('span', {}, `${x.type} “${x.target || ''}”: `, h('span', { className: `outcome ${x.status}` }, x.status)),
              h('span', { className: 'note' }, x.note)))))
          : '');
      const sources = r.sources?.length
        ? h('ol', { className: 'sources', ariaLabel: 'Sources' }, r.sources.map((s) => h('li', {}, h('span', {}, h('strong', {}, s.title), `, ${s.section}. ${s.source}`))))
        : '';
      const speak = h('button', { type: 'button', className: 'quiet' }, icon('speaker'), 'Read aloud');
      speak.onclick = () => {
        speechSynthesis.cancel();
        speechSynthesis.speak(new SpeechSynthesisUtterance([r.stopped, answer.innerText].filter(Boolean).join('. ')));
      };
      body.replaceChildren(
        r.stopped ? h('p', { className: 'stopped', role: 'alert' }, r.stopped) : '',
        answer, facts, sources,
        h('div', { className: 'turn-tools' }, speak, audit),
        latest && r.follow_up_questions?.length
          ? h('div', { className: 'next' }, h('p', {}, 'You could ask next'),
            r.follow_up_questions.map((q) => h('button', { type: 'button', onclick: () => ask(q) }, q)))
          : '');
      setStatus(r.stopped ? 'Stopped' : 'Done');
      scrollDown();
    },
  };
}

// ------------------------------------------------------------ browser tab

async function inTab(tabId, func, args = []) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result;
}
const snapshot = (tabId) => inTab(tabId, () => window.__sahay.snapshot());
const execute = (tabId, action) => inTab(tabId, (a) => window.__sahay.execute(a), [action]);

async function waitForLoad(tabId) {
  await new Promise((r) => setTimeout(r, 800));
  for (let i = 0; i < 30 && (await chrome.tabs.get(tabId)).status !== 'complete'; i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ------------------------------------------------------------ asking

// What an earlier turn looked like, for follow-up questions.
function historyText(r) {
  const actions = (r.results || []).map((x) => `${x.type} “${x.target}”: ${x.status}`).join('; ');
  return [r.answer, r.stopped && `Stopped: ${r.stopped}`, actions && `Actions: ${actions}`].filter(Boolean).join('\n').slice(0, 7000);
}

async function ask(question) {
  if (busy) return;
  await refreshSite();
  if (!site?.origin) return renderThread();
  busy = true;
  $('#go').disabled = true;
  setStatus(STEPS[0][1]);
  toggleSheet(null);
  document.querySelectorAll('.next, .resume, .welcome').forEach((n) => n.remove());
  if (!session) session = { id: crypto.randomUUID(), origin: site.origin, title: question.slice(0, 80), created: Date.now(), updated: Date.now(), turns: [] };

  const turn = { question, url: site.url, ts: Date.now(), response: null };
  const view = sahayTurn();
  $('#thread').append(youTurn(turn), view.el);
  scrollDown();
  const run = { thread: crypto.randomUUID(), tabId: site.tabId, view }; // passed along explicitly so a callback can never act on another run
  const history = session.turns.filter((t) => t.response).slice(-HISTORY_TURNS)
    .map((t) => ({ question: t.question, url: t.url || '', answer: historyText(t.response) }));
  try {
    const page = await snapshot(run.tabId);
    turn.url = page.url;
    turn.response = await call(run, '/run', { thread_id: run.thread, request: question, history, page, profile: settings.profile || {} });
    if (!turn.response) {
      turn.error = run.error || 'Sahay did not finish this answer. Ask again.';
      view.fail(turn.error);
    }
  } catch (err) {
    turn.error = err.message.includes('Cannot access') ? 'Sahay cannot read this kind of page (browser or store pages).' : err.message;
    view.fail(turn.error);
  } finally {
    session.turns = [...session.turns, turn].slice(-MAX_TURNS);
    session.updated = Date.now();
    try { renderSessions(await saveSession(session)); } catch (err) { console.warn('Sahay could not save this conversation:', err); }
    busy = false;
    $('#go').disabled = false;
    refreshSite();
  }
}

async function call(run, path, body) {
  const res = await fetch(settings.backend + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .catch(() => { throw new Error(`Sahay can't reach its backend at ${settings.backend}. Start it, then ask again.`); });
  if (!res.ok) throw new Error(`The backend refused the request (${res.status}): ${(await res.json().catch(() => ({}))).detail || ''}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return null;
    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const event of lines.filter(Boolean).map((l) => JSON.parse(l))) {
      if (event.event === 'step') run.view.step(event.node, event.audit);
      else if (event.event === 'error') { run.error = event.message; run.view.fail(event.message); }
      else if (event.event === 'done') { run.view.render(event.response, true); return event.response; }
      else if (event.event === 'interrupt') return onInterrupt(run, event.data);
    }
  }
}

function resume(run, value) {
  run.view.doneAsking();
  setStatus('Working');
  return call(run, '/resume', { thread_id: run.thread, value });
}

async function onInterrupt(run, data) {
  const { view } = run;
  if (data.type === 'execute') {
    const a = data.action;
    view.step('act', []);
    let outcome;
    try {
      outcome = await execute(run.tabId, a);
      if (SLOW_ACTIONS.has(a.type)) await waitForLoad(run.tabId);
    } catch (err) {
      outcome = { ok: false, error: err.message };
    }
    try { outcome.page = await snapshot(run.tabId); } catch {}
    return resume(run, outcome);
  }

  if (data.type === 'clarify') {
    view.waiting('Sahay has a question for you');
    const input = h('input', { type: 'text', placeholder: 'Type your answer' });
    const skip = h('button', { type: 'button', className: 'quiet' }, 'Skip');
    const form = h('form', { className: 'ask-card' }, h('h3', {}, 'Sahay needs a little more information'), h('p', {}, data.question), input,
      h('div', { className: 'choices' }, skip, h('button', { type: 'submit' }, 'Send answer')));
    view.ask(form);
    input.focus();
    const answer = await new Promise((r) => {
      form.onsubmit = (e) => { e.preventDefault(); r(input.value); };
      skip.onclick = () => r('');
    });
    return resume(run, answer);
  }

  if (data.type === 'approval') {
    const a = data.action;
    const critical = a.risk === 'critical';
    view.waiting('Waiting for your approval');
    const approve = h('button', { type: 'button', disabled: true }, 'Approve');
    const deny = h('button', { type: 'button', className: 'quiet danger' }, 'Deny');
    const understood = h('input', { type: 'checkbox' });
    const row = (label, value) => (value ? [h('dt', {}, label), h('dd', {}, value)] : []);
    view.ask(h('div', { className: `ask-card ${critical ? 'critical' : a.risk === 'high' ? 'risky' : ''}`, role: 'group', ariaLabel: 'Approval needed' },
      h('div', { className: 'head' }, h('h3', {}, 'Approve this step?'), h('span', { className: `risk ${a.risk}` }, `${a.risk} risk`)),
      h('dl', {},
        row('Action', a.type),
        row('On', a.target_label ? `“${a.target_label}” (label from the website)` : a.url),
        row('Element', a.target_kind),
        row('Data', a.value ? `“${a.value}” (${a.value_source})` : 'None'),
        row('Website', a.site),
        row('Sends data to', a.sends_to),
        row('Assistant’s reason', a.reason),
        row('What will happen', a.consequences),
        row('Why flagged', a.risk_reasons?.join('; '))),
      critical ? h('label', { className: 'confirm' }, understood, 'I understand this may move money or cannot be undone.') : '',
      h('div', { className: 'choices' }, deny, approve)));
    deny.focus();
    // Short delay so a click already in progress can't land on Approve; critical actions also need the tick.
    let ready = false;
    const sync = () => (approve.disabled = !ready || (critical && !understood.checked));
    understood.onchange = sync;
    setTimeout(() => { ready = true; sync(); }, 1200);
    const approved = await new Promise((r) => { approve.onclick = () => r(true); deny.onclick = () => r(false); });
    return resume(run, { approved });
  }
}

// ------------------------------------------------------------ start

const composer = $('#request');
composer.addEventListener('input', () => { composer.style.height = 'auto'; composer.style.height = `${composer.scrollHeight}px`; });
composer.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#ask').requestSubmit(); } });
$('#ask').onsubmit = (e) => {
  e.preventDefault();
  const question = composer.value.trim();
  if (!question) return;
  composer.value = '';
  composer.style.height = 'auto';
  ask(question);
};
$('#newChat').onclick = newConversation;
$('#newChat').append(icon('plus'));
$('#historyToggle').append(icon('clock'));
$('#settingsToggle').append(icon('gear'));
$('#go').prepend(icon('send'));
$('.top .mark').append(brandMark());
loadSettings();
refreshSite();
