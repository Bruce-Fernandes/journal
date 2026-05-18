// Trading Journal frontend
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const fmt = n => (n==null||isNaN(n)) ? '—' : '$' + Number(n).toLocaleString(undefined,{maximumFractionDigits:2});
const pct = n => (n==null||isNaN(n)) ? '—' : Number(n).toFixed(2) + '%';
const num = (n,d=2) => (n==null||isNaN(n)) ? '—' : Number(n).toFixed(d);
const escHtml = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

let state = { trades: [], analytics: null, settings: null, calMonth: new Date() };
let charts = {};

function toast(msg, type='success'){
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  setTimeout(()=>t.classList.add('hidden'), 2400);
  t.classList.remove('hidden');
}

// ---------- Navigation ----------
$$('.nav-item').forEach(a => a.addEventListener('click', () => {
  $$('.nav-item').forEach(n=>n.classList.remove('active'));
  a.classList.add('active');
  const v = a.dataset.view;
  $$('.view').forEach(x=>x.classList.add('hidden'));
  $('#view-'+v).classList.remove('hidden');
  const titles = {dashboard:['Dashboard','Overview of your trading performance'],trades:['Trades','All your logged trades'],analytics:['Analytics','Deep dive into your performance'],calendar:['Calendar','Daily P&L heatmap'],calculator:['Compound Calculator','Project your account growth'],settings:['Settings','Account configuration']};
  $('#viewTitle').textContent = titles[v][0];
  $('#viewSub').textContent = titles[v][1];
  if (v === 'calendar') renderCalendar();
  if (v === 'analytics') renderAnalytics();
  if (v === 'settings') loadSettingsForm();
}));

// ---------- API ----------
async function api(url, opts={}) {
  const r = await fetch(url, opts);
  if (r.status === 401 && !url.includes('/api/auth/')) { showAuthOverlay(); throw new Error('Unauthorized'); }
  if (!r.ok) {
    const body = await r.text();
    let msg = body;
    try { msg = JSON.parse(body).error || body; } catch(_) {}
    throw new Error(msg);
  }
  const ct = r.headers.get('content-type')||'';
  return ct.includes('json') ? r.json() : r.text();
}

async function loadAll() {
  state.settings = await api('/api/settings');
  state.trades = await api('/api/trades');
  state.analytics = await api('/api/analytics');
  $('#balancePill').textContent = `Balance: ${fmt(state.analytics.current_balance)}`;
  renderDashboard();
  renderTrades();
}

// ---------- Dashboard ----------
function kpi(label, value, sub, cls=''){
  return `<div class="kpi ${cls}"><label>${label}</label><div class="v ${cls}">${value}</div>${sub?`<div class="sub">${sub}</div>`:''}</div>`;
}
function renderDashboard() {
  const a = state.analytics;
  const pnlCls = a.net_pnl >= 0 ? 'pos' : 'neg';
  $('#kpis').innerHTML = [
    kpi('Net P&L', fmt(a.net_pnl), pct(a.return_pct)+' return', pnlCls),
    kpi('Balance', fmt(a.current_balance), `Started ${fmt(a.starting_balance)}`),
    kpi('Win Rate', pct(a.win_rate), `${a.wins}W / ${a.losses}L`),
    kpi('Profit Factor', a.profit_factor==null?'∞':num(a.profit_factor), `Expectancy ${fmt(a.expectancy)}`),
    kpi('Avg R', num(a.avg_rr), `Trades: ${a.total_trades}`),
    kpi('Max Drawdown', fmt(a.max_drawdown), pct(a.max_drawdown_pct), 'neg'),
    kpi('Best Trade', fmt(a.best_trade), `Worst ${fmt(a.worst_trade)}`, 'pos'),
    kpi('Streaks', `${a.best_win_streak}W / ${a.best_loss_streak}L`, 'best win / loss')
  ].join('');

  // Equity
  drawLine('equityChart', a.equity.map(p=>new Date(p.t).toLocaleDateString()), a.equity.map(p=>p.v), 'Equity', '#5b8cff');

  // Daily P&L bar
  const days = Object.entries(a.by_day).sort();
  drawBar('dailyChart', days.map(([d])=>d), days.map(([_,v])=>v.pnl), 'P&L');

  // session/dow/hour
  drawBar('sessionChart', Object.keys(a.by_session), Object.values(a.by_session).map(v=>v.pnl));
  drawBar('dowChart', Object.keys(a.by_dow), Object.values(a.by_dow).map(v=>v.pnl));
  const hKeys = Object.keys(a.by_hour).sort();
  drawBar('hourChart', hKeys, hKeys.map(k=>a.by_hour[k].pnl));

  // top symbols / tags
  const renderList = (id, obj) => {
    const arr = Object.entries(obj).map(([k,v])=>({k,...v,wr:v.trades?v.wins/v.trades*100:0})).sort((a,b)=>b.pnl-a.pnl).slice(0,8);
    $(id).innerHTML = arr.length ? arr.map(r=>`
      <div class="list-row">
        <div><div class="name">${escHtml(r.k)}</div><div class="meta">${r.trades} trades · ${r.wr.toFixed(0)}% WR</div></div>
        <div class="${r.pnl>=0?'pos':'neg'}" style="font-weight:700">${fmt(r.pnl)}</div>
      </div>`).join('') : '<div class="muted">No data yet.</div>';
  };
  renderList('#symbolList', a.by_symbol);
  renderList('#tagList', Object.keys(a.by_tag).length ? a.by_tag : a.by_strategy);
}

function drawLine(id, labels, data, label='', color='#5b8cff') {
  if (charts[id]) charts[id].destroy();
  const ctx = $('#'+id).getContext('2d');
  const grad = ctx.createLinearGradient(0,0,0,260);
  grad.addColorStop(0, color+'66'); grad.addColorStop(1, color+'00');
  charts[id] = new Chart(ctx, {
    type:'line',
    data:{labels, datasets:[{label, data, borderColor:color, backgroundColor:grad, fill:true, tension:.3, pointRadius:0, pointHoverRadius:5, pointHoverBackgroundColor:color, borderWidth:2}]},
    options:chartOpts(true)
  });
  // double-click to reset zoom
  ctx.canvas.ondblclick = () => charts[id]?.resetZoom();
}
function drawBar(id, labels, data, label='') {
  if (charts[id]) charts[id].destroy();
  const colors = data.map(v => v>=0 ? '#22c55e' : '#ef4444');
  charts[id] = new Chart($('#'+id), {
    type:'bar',
    data:{labels, datasets:[{label, data, backgroundColor:colors, borderRadius:6, borderSkipped:false}]},
    options:chartOpts(false)
  });
}
function chartOpts(zoomable=false){ return {
  responsive:true, maintainAspectRatio:false,
  interaction:{ mode:'index', intersect:false },
  plugins:{
    legend:{display:false},
    tooltip:{
      backgroundColor:'#1a2238',
      borderColor:'#5b8cff',
      borderWidth:1,
      padding:12,
      titleColor:'#e6edf7',
      bodyColor:'#8a95ad',
      displayColors:false,
      callbacks:{
        label: ctx => {
          const v = ctx.parsed.y;
          if (v == null) return '';
          return typeof v === 'number' ? (Math.abs(v) >= 1000 ? '$'+v.toLocaleString(undefined,{maximumFractionDigits:2}) : v.toFixed(2)) : v;
        }
      }
    },
    zoom: zoomable ? {
      zoom:{ wheel:{ enabled:true }, pinch:{ enabled:true }, mode:'x' },
      pan:{ enabled:true, mode:'x' }
    } : {}
  },
  scales:{
    x:{grid:{color:'rgba(255,255,255,.04)'}, ticks:{color:'#8a95ad', maxTicksLimit:10}},
    y:{grid:{color:'rgba(255,255,255,.04)'}, ticks:{color:'#8a95ad'}}
  }
};}

// ---------- Trades ----------
function renderTrades() {
  const q = $('#searchInput').value.toLowerCase();
  const fd = $('#filterDir').value;
  const fr = $('#filterResult').value;
  const rows = state.trades.filter(t => {
    if (fd && t.direction !== fd) return false;
    if (fr === 'win' && !(t.pnl > 0)) return false;
    if (fr === 'loss' && !(t.pnl < 0)) return false;
    if (q) {
      const blob = (t.symbol+' '+(t.tags||'')+' '+(t.notes||'')+' '+(t.strategy||'')+' '+(t.setup||'')).toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });
  $('#tradesBody').innerHTML = rows.length ? rows.map(t => {
    const session = sessionOf(t.entry_time);
    const tags = (t.tags||'').split(',').map(s=>s.trim()).filter(Boolean).map(x=>`<span class="tag">${escHtml(x)}</span>`).join('');
    const pnlCls = t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : '';
    return `<tr data-id="${t.id}">
      <td>${new Date(t.entry_time).toLocaleString()}</td>
      <td><b>${escHtml(t.symbol)}</b></td>
      <td><span class="badge ${t.direction}">${t.direction}</span></td>
      <td>${t.entry_price ?? '—'}</td>
      <td>${t.exit_price ?? '—'}</td>
      <td>${t.quantity}</td>
      <td class="${pnlCls}"><b>${fmt(t.pnl)}</b></td>
      <td>${num(t.rr)}</td>
      <td>${session}</td>
      <td>${tags||'<span class="muted">—</span>'}</td>
      <td>
        <button class="icon-btn edit-btn">✎</button>
        <button class="icon-btn del-btn">🗑</button>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="11" style="text-align:center;padding:30px;color:var(--muted)">No trades found. Click "+ Add Trade" to start.</td></tr>`;

  $$('#tradesBody .edit-btn').forEach(b => b.addEventListener('click', e => {
    const id = +e.target.closest('tr').dataset.id;
    openModal(state.trades.find(t=>t.id===id));
  }));
  $$('#tradesBody .del-btn').forEach(b => b.addEventListener('click', async e => {
    const id = +e.target.closest('tr').dataset.id;
    if (!confirm('Delete this trade?')) return;
    await api('/api/trades/'+id, {method:'DELETE'});
    toast('Trade deleted');
    await loadAll();
  }));
}
function sessionOf(iso){
  const h = new Date(iso).getUTCHours();
  if (h>=0 && h<7) return 'Asia';
  if (h>=7 && h<13) return 'London';
  if (h>=13 && h<21) return 'New York';
  return 'Off-Hours';
}
['searchInput','filterDir','filterResult'].forEach(id=>$('#'+id).addEventListener('input', renderTrades));

// CSV import
$('#importCsv').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const text = await f.text();
    const r = await api('/api/import', {method:'POST', headers:{'Content-Type':'text/plain'}, body:text});
    toast(`Imported ${r.inserted} trades`);
    await loadAll();
  } catch(err) { toast('Import failed: ' + err.message, 'error'); }
  e.target.value = '';
});

// ---------- Modal ----------
const modal = $('#tradeModal');
function openModal(trade=null) {
  $('#modalTitle').textContent = trade ? 'Edit Trade' : 'Add Trade';
  const f = $('#tradeForm');
  f.reset();
  $('#f_id').value = trade?.id || '';
  if (trade) {
    const set = (id,v)=>{ const el=$(id); if(el && v!=null) el.value = v; };
    set('#f_symbol', trade.symbol);
    set('#f_direction', trade.direction);
    set('#f_entry_time', toLocal(trade.entry_time));
    set('#f_exit_time', toLocal(trade.exit_time));
    set('#f_entry_price', trade.entry_price);
    set('#f_exit_price', trade.exit_price);
    set('#f_quantity', trade.quantity);
    set('#f_stop_loss', trade.stop_loss);
    set('#f_take_profit', trade.take_profit);
    set('#f_fees', trade.fees);
    set('#f_risk_amount', trade.risk_amount);
    set('#f_pnl', trade.pnl);
    set('#f_strategy', trade.strategy);
    set('#f_setup', trade.setup);
    set('#f_emotion', trade.emotion);
    set('#f_tags', trade.tags);
    set('#f_mistakes', trade.mistakes);
    set('#f_notes', trade.notes);
  } else {
    $('#f_entry_time').value = toLocal(new Date().toISOString());
  }
  modal.classList.remove('hidden');
}
function toLocal(iso){
  if (!iso) return '';
  const d = new Date(iso);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime()-off*60000).toISOString().slice(0,16);
}
$('#addTradeBtn').addEventListener('click', () => openModal());
$('#modalClose').addEventListener('click', ()=>modal.classList.add('hidden'));
$('#cancelBtn').addEventListener('click', ()=>modal.classList.add('hidden'));
modal.addEventListener('click', e => { if (e.target===modal) modal.classList.add('hidden'); });

$('#tradeForm').addEventListener('submit', async e => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const id = $('#f_id').value;
  // convert datetime-local to ISO
  for (const k of ['entry_time','exit_time']) {
    const v = fd.get(k);
    if (v) fd.set(k, new Date(v).toISOString());
  }
  try {
    const r = id
      ? await fetch('/api/trades/'+id, {method:'PUT', body:fd})
      : await fetch('/api/trades', {method:'POST', body:fd});
    if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.error || 'Save failed'); }
    modal.classList.add('hidden');
    toast(id ? 'Trade updated' : 'Trade added');
    await loadAll();
  } catch (err) { toast('Error: ' + err.message, 'error'); }
});

// ---------- Analytics ----------
function renderAnalytics() {
  const a = state.analytics;
  // drawdown
  let peak = a.starting_balance, dd = [];
  a.equity.forEach(p => { if (p.v>peak) peak=p.v; dd.push(((p.v-peak)/peak)*100); });
  drawLine('ddChart', a.equity.map(p=>new Date(p.t).toLocaleDateString()), dd, 'DD %', '#ef4444');

  // R distribution
  const buckets = {'<-2':0,'-2 to -1':0,'-1 to 0':0,'0 to 1':0,'1 to 2':0,'2 to 3':0,'>3':0};
  state.trades.filter(t=>t.rr!=null).forEach(t=>{
    const r = Number(t.rr);
    if (r<-2) buckets['<-2']++;
    else if (r<-1) buckets['-2 to -1']++;
    else if (r<0) buckets['-1 to 0']++;
    else if (r<1) buckets['0 to 1']++;
    else if (r<2) buckets['1 to 2']++;
    else if (r<3) buckets['2 to 3']++;
    else buckets['>3']++;
  });
  drawBar('rChart', Object.keys(buckets), Object.values(buckets));

  // strategy
  const strat = Object.entries(a.by_strategy).map(([k,v])=>({k,...v,wr:v.trades?v.wins/v.trades*100:0})).sort((a,b)=>b.pnl-a.pnl);
  $('#stratList').innerHTML = strat.length ? strat.map(r=>`
    <div class="list-row">
      <div><div class="name">${escHtml(r.k)}</div><div class="meta">${r.trades} trades · ${r.wr.toFixed(0)}% WR</div></div>
      <div class="${r.pnl>=0?'pos':'neg'}" style="font-weight:700">${fmt(r.pnl)}</div>
    </div>`).join('') : '<div class="muted">Tag your trades with a strategy to see breakdown.</div>';

  // session mix
  const sLabels = Object.keys(a.by_session);
  const winRates = sLabels.map(k => a.by_session[k].trades ? (a.by_session[k].wins/a.by_session[k].trades*100) : 0);
  const pnls = sLabels.map(k => a.by_session[k].pnl);
  if (charts.sessionMixChart) charts.sessionMixChart.destroy();
  charts.sessionMixChart = new Chart($('#sessionMixChart'), {
    type:'bar',
    data:{labels:sLabels, datasets:[
      {label:'Win Rate %', data:winRates, backgroundColor:'#5b8cff', borderRadius:6, yAxisID:'y'},
      {label:'P&L $', data:pnls, backgroundColor:'#22c55e', borderRadius:6, yAxisID:'y1', type:'line', borderColor:'#22c55e', tension:.3}
    ]},
    options:{...chartOpts(), plugins:{legend:{labels:{color:'#cdd6e6'}}}, scales:{
      x:{grid:{color:'rgba(255,255,255,.04)'},ticks:{color:'#8a95ad'}},
      y:{position:'left',grid:{color:'rgba(255,255,255,.04)'},ticks:{color:'#8a95ad'}},
      y1:{position:'right',grid:{display:false},ticks:{color:'#8a95ad'}}
    }}
  });
}

// ---------- Calendar ----------
function renderCalendar() {
  const m = state.calMonth;
  $('#calLabel').textContent = m.toLocaleDateString(undefined,{month:'long',year:'numeric'});
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const days = new Date(m.getFullYear(), m.getMonth()+1, 0).getDate();
  const offset = first.getDay();
  const byDay = state.analytics.by_day;
  const dows = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let html = dows.map(d=>`<div class="cal-cell dow">${d}</div>`).join('');
  for (let i=0;i<offset;i++) html += '<div class="cal-cell empty"></div>';
  for (let d=1; d<=days; d++) {
    const key = `${m.getFullYear()}-${String(m.getMonth()+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const data = byDay[key];
    const cls = data ? (data.pnl>=0?'win':'loss') : '';
    html += `<div class="cal-cell ${cls}">
      <div class="d">${d}</div>
      ${data?`<div class="pnl ${data.pnl>=0?'pos':'neg'}">${fmt(data.pnl)}</div><div class="ct">${data.trades} trades</div>`:''}
    </div>`;
  }
  $('#calendar').innerHTML = html;
}
$('#calPrev').addEventListener('click', ()=>{ state.calMonth.setMonth(state.calMonth.getMonth()-1); renderCalendar(); });
$('#calNext').addEventListener('click', ()=>{ state.calMonth.setMonth(state.calMonth.getMonth()+1); renderCalendar(); });

// ---------- Calculator ----------
function runCalc() {
  const start = +$('#ccStart').value;
  const wr = +$('#ccWinRate').value / 100;
  const aw = +$('#ccAvgWin').value;
  const al = +$('#ccAvgLoss').value;
  const risk = +$('#ccRisk').value / 100;
  const tpd = +$('#ccTradesDay').value;
  const dpm = +$('#ccDaysMonth').value;
  const months = +$('#ccMonths').value;
  const expR = wr*aw - (1-wr)*al;
  const perTrade = expR * risk;
  const totalTrades = months * dpm * tpd;
  let bal = start;
  const labels = ['Start'], data = [start];
  for (let m=1; m<=months; m++) {
    const trades = dpm*tpd;
    bal *= Math.pow(1+perTrade, trades);
    labels.push('M'+m); data.push(bal);
  }
  const finalBal = bal;
  const totalReturn = (finalBal/start-1)*100;
  $('#ccResult').innerHTML = `
    <div>Expected R/trade: <b>${expR.toFixed(3)}</b></div>
    <div>Expected Return / trade: <b>${(perTrade*100).toFixed(3)}%</b></div>
    <div>Total trades: <b>${totalTrades}</b></div>
    <div>Final balance: <b>${fmt(finalBal)}</b></div>
    <div>Total return: <b class="${totalReturn>=0?'pos':'neg'}">${pct(totalReturn)}</b></div>
    <div>Monthly avg: <b>${pct((Math.pow(finalBal/start,1/months)-1)*100)}</b></div>
  `;
  drawLine('ccChart', labels, data, 'Equity', '#a06bff');
}
$('#ccRun').addEventListener('click', runCalc);
$('#ccUseMine').addEventListener('click', () => {
  const a = state.analytics;
  if (!a || !a.total_trades) return toast('No data yet','error');
  $('#ccStart').value = Math.round(a.current_balance);
  $('#ccWinRate').value = a.win_rate.toFixed(1);
  const wins = state.trades.filter(t=>t.pnl>0 && t.rr!=null).map(t=>+t.rr);
  const losses = state.trades.filter(t=>t.pnl<0 && t.rr!=null).map(t=>Math.abs(+t.rr));
  if (wins.length) $('#ccAvgWin').value = (wins.reduce((a,b)=>a+b,0)/wins.length).toFixed(2);
  if (losses.length) $('#ccAvgLoss').value = (losses.reduce((a,b)=>a+b,0)/losses.length).toFixed(2);
  runCalc();
});

// ---------- Settings ----------
function loadSettingsForm() {
  const s = state.settings;
  $('#setStart').value = s.starting_balance;
  $('#setCcy').value = s.account_currency;
  $('#setDaily').value = s.daily_loss_limit_pct;
  $('#setMax').value = s.max_loss_limit_pct;
  $('#setTarget').value = s.profit_target_pct;
}
$('#saveSettings').addEventListener('click', async () => {
  await api('/api/settings', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      starting_balance: +$('#setStart').value,
      account_currency: $('#setCcy').value,
      daily_loss_limit_pct: +$('#setDaily').value,
      max_loss_limit_pct: +$('#setMax').value,
      profit_target_pct: +$('#setTarget').value,
    })
  });
  toast('Settings saved');
  await loadAll();
});

// ---------- Auth ----------
function showAuthOverlay() {
  $('#authOverlay').classList.remove('hidden');
  document.querySelector('.sidebar').classList.add('hidden');
  document.querySelector('.main').classList.add('hidden');
}
function hideAuthOverlay() {
  $('#authOverlay').classList.add('hidden');
  document.querySelector('.sidebar').classList.remove('hidden');
  document.querySelector('.main').classList.remove('hidden');
}

// tab switching
$$('.auth-tab').forEach(tab => tab.addEventListener('click', () => {
  $$('.auth-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  $$('.auth-form').forEach(f => f.classList.add('hidden'));
  $('#' + tab.dataset.tab + 'Form').classList.remove('hidden');
}));

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = $('#loginError');
  errEl.classList.add('hidden');
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ username: $('#loginUsername').value, password: $('#loginPassword').value })
    });
    setUser(data);
    hideAuthOverlay();
    await loadAll();
    runCalc();
  } catch(err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

$('#registerForm').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = $('#registerError');
  errEl.classList.add('hidden');
  try {
    const data = await api('/api/auth/register', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ username: $('#regUsername').value, email: $('#regEmail').value, password: $('#regPassword').value })
    });
    setUser(data);
    hideAuthOverlay();
    await loadAll();
    runCalc();
  } catch(err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

function setUser(u) {
  const initial = (u.username || '?')[0].toUpperCase();
  $('#userAvatar').textContent = initial;
  $('#userLabel').textContent = u.username;
}

$('#logoutBtn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  showAuthOverlay();
  // reset state
  state.trades = []; state.analytics = null; state.settings = null;
  $('#loginForm').reset(); $('#registerForm').reset();
});

// ---------- Boot ----------
(async () => {
  try {
    const me = await fetch('/api/auth/me');
    if (me.status === 401) { showAuthOverlay(); return; }
    const user = await me.json();
    setUser(user);
    await loadAll();
    runCalc();
  } catch(e) { console.error(e); showAuthOverlay(); }
})();
