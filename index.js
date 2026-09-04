const express = require('express');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');

const app = express();

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const XAI_API_KEY = process.env.XAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const NOTIFY_SECRET = process.env.NOTIFY_SECRET;
const HANBO_USER_ID = process.env.HANBO_USER_ID;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const sessions = {};
const pushUserIds = new Set(
  (process.env.PUSH_USER_IDS || '').split(',').filter(id => id.trim())
);

// 執行長本人專屬功能（每日工事／SOP／全店記帳）都透過這個函式判斷，
// 身份規則只在這裡改，避免散在各處漏改造成漏洞。
function isHanbo(userId) {
  return Boolean(HANBO_USER_ID) && userId === HANBO_USER_ID;
}

// ── 記憶系統 ──────────────────────────────────────────

async function dbFetch(path, options = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
}

// ── 記帳系統 ──────────────────────────────────────────

async function parseFinanceEntry(text) {
  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 120,
    system: `解析記帳訊息，只回傳 JSON，不要其他文字：
{"type":"expense|revenue","amount":數字,"category":"餐飲|交通|購物|孩子|醫療|娛樂|店務|其他","description":"簡短描述"}
若含「營業額」「業績」「收入」→ type 為 revenue
若無法辨識金額 → {"error":"無法辨識"}`,
    messages: [{ role: 'user', content: text }]
  });
  try { return JSON.parse(res.content[0].text.trim()); }
  catch { return { error: '解析失敗' }; }
}

async function parseReceiptImage(messageId) {
  const imgRes = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
  });
  const buffer = await imgRes.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const contentType = imgRes.headers.get('content-type') || 'image/jpeg';

  const prompt = `這是台灣發票或收據照片，請仔細辨識：
1. 找出「總計」「合計」「金額」「小計」或最大的數字作為金額
2. 從店名或品項判斷分類
3. 只回傳 JSON，不要其他文字：
{"type":"expense","amount":數字,"category":"餐飲|交通|購物|孩子|醫療|娛樂|店務|其他","description":"店名或主要品項"}
若真的完全無法辨識任何金額 → {"error":"無法辨識"}`;

  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${XAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'grok-4.5',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${contentType};base64,${base64}` } },
          { type: 'text', text: prompt }
        ]
      }]
    })
  });
  const data = await res.json();
  try {
    const raw = data.choices[0].message.content.trim().replace(/^```(?:json)?|```$/g, '').trim();
    return JSON.parse(raw);
  } catch { return { error: '解析失敗' }; }
}

async function recordDailyExpense(storeId, amount, category, description) {
  if (!SUPABASE_URL) return false;
  try {
    const r = await dbFetch('store_daily_expenses', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        store_id: storeId,
        amount,
        description: `【費用】${category}：${description}`,
        date: new Date().toISOString().split('T')[0]
      })
    });
    return r.ok;
  } catch { return false; }
}

async function recordDailyRevenue(storeId, amount) {
  if (!SUPABASE_URL) return false;
  try {
    const r = await dbFetch('store_daily_report?on_conflict=store_id,date', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        store_id: storeId,
        morning_revenue: amount,
        date: new Date().toISOString().split('T')[0]
      })
    });
    return r.ok;
  } catch { return false; }
}

// ── 語音轉文字 (Groq Whisper) ──────────────────────────────────────────

async function transcribeAudio(audioBuffer) {
  const formData = new FormData();
  const blob = new Blob([audioBuffer], { type: 'audio/m4a' });
  formData.append('file', blob, 'audio.m4a');
  formData.append('model', 'whisper-large-v3');
  formData.append('language', 'zh');
  formData.append('response_format', 'text');

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: formData
  });
  if (!res.ok) throw new Error(`Groq error: ${await res.text()}`);
  return (await res.text()).trim();
}

// ── 任務系統 ──────────────────────────────────────────

// 待辦一進 Inbox 就用「重要／緊急」四象限判斷，目的是幫執行長把重要的事留在自己手上、
// 該授權的授權出去，不用每件事都靠他自己一件件想過一遍。
async function classifyTaskPriority(content) {
  try {
    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: `你是漢柏分身，執行長剛把一件事丟進待辦 Inbox。這個 Inbox 同時裝公司事務跟個人生活事務（家人、健康、人際關係、雜事都會出現），用「重要／緊急」四象限幫他判斷這件事該怎麼處理，目的是幫他把人生跟公司裡真正重要的事留在自己手上、該授權或該放掉的就授權放掉，避免他被瑣事淹沒。只回傳 JSON，不要其他文字：
{"quadrant":"重要緊急|重要不緊急|緊急不重要|不重要不緊急","action":"親自處理|排時間做|授權出去|刪除或忽略","reason":"一句不超過30字的理由，語氣像教練，直接但溫暖"}

判斷原則（公司事務跟個人生活事務都適用同一套邏輯，不要因為不是公司的事就拒絕判斷）：
- 重要：跟公司方向、人才發展、關鍵決策、店務核心風險有關；或跟家人健康、重要關係、個人核心承諾有關——別人做不了、或做錯/不做代價高
- 不重要：瑣事、例行事務、跑腿雜務，員工、系統或家人朋友就能處理，對大局影響小
- 緊急：有明確時間壓力，拖延會造成損失或錯過時機
- 不緊急：沒有立即時間壓力，可以排時間或交給別人

四象限對應動作：
- 重要緊急 → 親自處理：現在就做，別人做不了
- 重要不緊急 → 排時間做：排進行程表親自處理，但不用現在
- 緊急不重要 → 授權出去：找人代辦，執行長不必親自做
- 不重要不緊急 → 刪除或忽略：可以直接不做，或之後有空再說

只有在內容破碎到完全看不懂在講什麼事（例如語音辨識錯誤導致文字不成句）時才回傳 {"error":"無法辨識"}；只要看得懂是在做什麼事，即使很瑣碎、即使是私事，都要給出四象限判斷，不要用「不是公司的事」當理由拒絕分類。`,
      messages: [{ role: 'user', content }]
    });
    const text = res.content[0].text.trim();
    const match = text.match(/\{[\s\S]*\}/);
    return JSON.parse(match ? match[0] : text);
  } catch (err) { console.error('classifyTaskPriority failed:', err); return { error: '解析失敗' }; }
}

async function saveTask(content, source = 'line_voice') {
  if (!SUPABASE_URL) return { ok: false, classified: null };
  const classified = await classifyTaskPriority(content);
  const body = { content, source, status: 'pending' };
  if (!classified.error) {
    body.quadrant = classified.quadrant || null;
    body.action = classified.action || null;
    body.ai_note = classified.reason || null;
  }
  try {
    const r = await dbFetch('tasks', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(body)
    });
    return { ok: r.ok, classified: classified.error ? null : classified };
  } catch { return { ok: false, classified: null }; }
}

function quadrantTag(classified) {
  if (!classified || !classified.quadrant) return '';
  return `\n\n📌 ${classified.quadrant}｜建議：${classified.action}\n${classified.reason || ''}`;
}

async function listPendingTasks() {
  if (!SUPABASE_URL) return [];
  try {
    const res = await dbFetch('tasks?status=eq.pending&order=created_at.desc&limit=10');
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

// ── 四象限分析彙整（累積式，跟每日工事月結/季結同一套節奏）──────────

async function fetchTasksInRange(sinceISO, untilISO) {
  if (!SUPABASE_URL) return [];
  try {
    const res = await dbFetch(`tasks?created_at=gte.${sinceISO}&created_at=lt.${untilISO}&select=id,content,quadrant,action,created_at&order=created_at.asc`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

// 回傳 { text, counts, total, unclassified, delegateRate }——text 給 LINE 推播用，
// 其餘結構化欄位存進 task_quadrant_snapshots，網頁的累積趨勢頁靠這些欄位畫圖，不用重新解析文字。
function buildQuadrantAnalysis(tasks, title, prevDelegateRate) {
  const counts = { 重要緊急: 0, 重要不緊急: 0, 緊急不重要: 0, 不重要不緊急: 0 };
  let classifiedTotal = 0;
  tasks.forEach(t => {
    if (counts[t.quadrant] === undefined) return;
    counts[t.quadrant]++;
    classifiedTotal++;
  });
  const unclassified = tasks.length - classifiedTotal;

  if (!classifiedTotal) {
    return {
      text: `${title}\n\n${tasks.length ? '這段期間的任務語音太破碎，AI 判斷不出結果' : '這段期間沒有任務紀錄，是漏記了，還是真的都授權出去了？'}`,
      counts, total: 0, unclassified, delegateRate: null
    };
  }

  const pct = n => Math.round((n / classifiedTotal) * 100);
  const delegateCount = counts.緊急不重要 + counts.不重要不緊急;
  const delegateRate = Math.round((delegateCount / classifiedTotal) * 100);

  let msg = `${title}（共 ${classifiedTotal} 筆已分類${unclassified ? `，另有 ${unclassified} 筆語音太破碎沒判斷出來` : ''}）\n\n`;
  msg += `🔴 重要緊急：${counts.重要緊急} 筆（${pct(counts.重要緊急)}%）親自處理\n`;
  msg += `🔵 重要不緊急：${counts.重要不緊急} 筆（${pct(counts.重要不緊急)}%）排時間做\n`;
  msg += `🟠 緊急不重要：${counts.緊急不重要} 筆（${pct(counts.緊急不重要)}%）授權出去\n`;
  msg += `⚪ 不重要不緊急：${counts.不重要不緊急} 筆（${pct(counts.不重要不緊急)}%）刪除或忽略\n`;
  msg += `\n📊 該授權或該放掉的比例：${delegateRate}%`;

  if (typeof prevDelegateRate === 'number') {
    const diff = delegateRate - prevDelegateRate;
    const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
    msg += `（上一期 ${prevDelegateRate}% ${arrow}）`;
  }

  return { text: msg.trim(), counts, total: classifiedTotal, unclassified, delegateRate };
}

async function saveQuadrantSnapshot({ periodLabel, periodStart, periodEnd, isQuarter = false, analysis }) {
  if (!SUPABASE_URL) return false;
  try {
    const r = await dbFetch('task_quadrant_snapshots', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        period_label: periodLabel,
        period_start: periodStart,
        period_end: periodEnd,
        is_quarter: isQuarter,
        total: analysis.total,
        unclassified: analysis.unclassified,
        count_do: analysis.counts.重要緊急,
        count_schedule: analysis.counts.重要不緊急,
        count_delegate: analysis.counts.緊急不重要,
        count_drop: analysis.counts.不重要不緊急,
        delegate_rate: analysis.delegateRate,
        summary_text: analysis.text
      })
    });
    return r.ok;
  } catch { return false; }
}

async function fetchLatestQuadrantSnapshot(isQuarter = false) {
  if (!SUPABASE_URL) return null;
  try {
    const res = await dbFetch(`task_quadrant_snapshots?is_quarter=eq.${isQuarter}&order=period_start.desc&limit=1`);
    const data = await res.json();
    return Array.isArray(data) && data[0] ? data[0] : null;
  } catch { return null; }
}

// ── 每日摘要 ──────────────────────────────────────────

async function getOperatingStores() {
  if (!SUPABASE_URL) return [];
  try {
    const res = await dbFetch('stores?status=eq.營運中&select=id,name');
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

async function getAllowedStores(userId) {
  if (isHanbo(userId)) return getOperatingStores();
  if (!SUPABASE_URL) return [];
  try {
    const res = await dbFetch(`store_staff?line_user_id=eq.${userId}&select=stores(id,name)`);
    const data = await res.json();
    return Array.isArray(data) ? data.map(r => r.stores).filter(Boolean) : [];
  } catch { return []; }
}

async function buildDailySummary() {
  // 只看「昨天有沒有回報」在門店都是隔幾天一次補登記的情況下幾乎天天都亮紅字，沒有意義。
  // 改成看「每間店實際填到哪一天、落後幾天」＋「這半個月資料本身有沒有明顯異常」，
  // 兩者都是稽核左大店資料時發現真的會出錯、值得盯的東西（漏填、重複記帳）。
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const lookbackDate = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];
  const stores = await getOperatingStores();
  const tasks = await listPendingTasks();

  let progressMsg = '目前沒有營運中門店資料';
  let anomalyLines = [];

  if (stores.length) {
    try {
      // 「填到哪天」只看到昨天為止——不然店家萬一提早填了今天（甚至填錯未來日期），
      // 會被誤判成「進度超前」，反而把選錯日期這種真的出過的錯蓋掉。
      const res = await dbFetch(`store_daily_report?date=gte.${lookbackDate}&date=lte.${yesterday}&select=store_id,date,is_rest_day,cash_counted,morning_revenue,evening_revenue,line_pay,uber_amount,foodpanda_amount&order=date.asc`);
      const rows = await res.json();
      const byStore = {};
      (Array.isArray(rows) ? rows : []).forEach(r => {
        (byStore[r.store_id] = byStore[r.store_id] || []).push(r);
      });

      const onTrack = [];
      const behind = [];
      const never = [];
      stores.forEach(s => {
        const list = byStore[s.id] || [];
        if (!list.length) { never.push(s.name); return; }
        const latest = list[list.length - 1].date;
        const gap = Math.round((new Date(yesterday) - new Date(latest)) / 86400000);
        if (gap <= 0) onTrack.push(s.name);
        else behind.push(`${s.name}（填到${latest.slice(5)}，落後${gap}天）`);
      });

      // 「大家的進度」要列出每一間店，不能只給準時的數字——落後/沒填的名單再清楚，
      // 準時的店只給一個數字還是等於沒回報到「誰做得好」。
      const progressParts = [];
      if (onTrack.length) progressParts.push(`✅ 跟上進度（${onTrack.length}/${stores.length}）：${onTrack.join('、')}`);
      if (behind.length) progressParts.push(`⚠️ 落後：${behind.join('、')}`);
      if (never.length) progressParts.push(`🚫 近14天沒填：${never.join('、')}`);
      progressMsg = progressParts.join('\n');

      // 漏填檢查只看昨天（当天没填完整才需要提醒），店休的天數本來就該是空的，跳過不算漏填
      Object.entries(byStore).forEach(([storeId, list]) => {
        const row = list.find(r => r.date === yesterday);
        if (!row || row.is_rest_day) return;
        const store = stores.find(s => s.id === storeId);
        if (!store) return;
        // cash_counted 只有網頁完整日報表才會填，LINE 只回報營業額的話這欄一定是空的
        if (row.cash_counted === null) {
          anomalyLines.push(`${store.name}：只回報營業額，資料不全`);
        } else if (!row.morning_revenue && !row.evening_revenue && !row.line_pay && !row.uber_amount && !row.foodpanda_amount) {
          anomalyLines.push(`${store.name}：有送出日報但營收欄位全空，疑似漏填`);
        }
      });

      // 重複記帳檢查看「這半個月」（1-15或16-月底，過15號就算下半月，跟毛利結算頁同一套切法），
      // 只看昨天的話，稽核左大店/三民建工店查到的舊重複記帳過一天就再也不會被提醒。
      const today = new Date();
      const day = today.getDate();
      const y = today.getFullYear(), m = today.getMonth();
      const periodStart = day <= 15 ? new Date(y, m, 1) : new Date(y, m, 16);
      const periodStartStr = periodStart.toISOString().split('T')[0];
      const expRes = await dbFetch(`store_daily_expenses?date=gte.${periodStartStr}&date=lte.${yesterday}&select=store_id,vendor_name,description,amount,date`);
      const expRows = await expRes.json();
      const expByStore = {};
      (Array.isArray(expRows) ? expRows : []).forEach(e => {
        (expByStore[e.store_id] = expByStore[e.store_id] || []).push(e);
      });
      Object.entries(expByStore).forEach(([storeId, list]) => {
        const store = stores.find(s => s.id === storeId);
        if (!store) return;
        const seen = {};
        list.forEach(e => {
          const key = `${e.date}_${e.vendor_name || e.description}_${e.amount}`;
          (seen[key] = seen[key] || []).push(e);
        });
        Object.entries(seen).filter(([, l]) => l.length > 1).forEach(([key, l]) => {
          const [date, name] = key.split('_');
          anomalyLines.push(`${store.name}：${date.slice(5)} ${name} $${l[0].amount} 出現${l.length}次，疑似重複記帳`);
        });
      });
    } catch (err) {
      console.error('每日摘要計算失敗:', err);
      progressMsg = '進度計算失敗，稍後查看日報表確認';
    }
  }

  let msg = `☀️ 早安，今天的營運摘要\n\n📅 各店回報進度：\n${progressMsg}`;
  if (anomalyLines.length) msg += `\n\n🔍 資料異常：\n${anomalyLines.join('\n')}`;
  msg += `\n\n📋 待辦 Inbox：${tasks.length} 件待處理`;
  msg += `\n\n🔗 詳細日報：https://ijs7594.github.io/daily-report.html`;
  return msg;
}

// ── 展店紀錄系統 ──────────────────────────────────────────

async function getStoreNames() {
  if (!SUPABASE_URL) return [];
  try {
    const res = await dbFetch('stores?select=id,name');
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

async function parseStoreLog(text, existingStores) {
  const namesStr = existingStores.map(s => s.name).join('、') || '（尚無店家）';
  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    system: `解析展店心得訊息，只回傳 JSON，不要其他文字：
{"store_name":"店名","category":"選址|裝潢|人事|物流|行銷|口味|客訴|其他","content":"心得內容","exp":15或30或60}
現有店家：${namesStr}
若訊息裡的店名與現有店家接近，請用現有店家的完整名稱；否則視為新店家，用訊息裡的名稱。
exp 判斷：小發現/小提醒=15，一般心得/收穫=30，重大突破/重要教訓=60，無法判斷則用30。
若完全無法辨識店名 → {"error":"無法辨識店名"}`,
    messages: [{ role: 'user', content: text }]
  });
  try { return JSON.parse(res.content[0].text.trim()); }
  catch { return { error: '解析失敗' }; }
}

async function recordStoreLog(storeName, category, content, exp, imageUrl) {
  if (!SUPABASE_URL) return false;
  try {
    const found = await dbFetch(`stores?name=eq.${encodeURIComponent(storeName)}&select=id`);
    const list = await found.json();
    let storeId = Array.isArray(list) && list.length > 0 ? list[0].id : null;

    if (!storeId) {
      const created = await dbFetch('stores', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ name: storeName, status: '籌備中' })
      });
      const createdData = await created.json();
      storeId = createdData[0]?.id;
    }
    if (!storeId) return false;

    const body = { store_id: storeId, category, content, exp };
    if (imageUrl) body.image_url = imageUrl;

    const r = await dbFetch('store_logs', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(body)
    });
    return r.ok;
  } catch { return false; }
}

async function uploadStorePhoto(messageId) {
  const imgRes = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
  });
  const buffer = await imgRes.arrayBuffer();
  const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.includes('png') ? 'png' : 'jpg';
  const filename = `${Date.now()}-${messageId}.${ext}`;

  const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/store-photos/${filename}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': contentType
    },
    body: Buffer.from(buffer)
  });
  if (!uploadRes.ok) return null;
  return `${SUPABASE_URL}/storage/v1/object/public/store-photos/${filename}`;
}

// ── 每日工事紀錄系統 ──────────────────────────────────────────

async function parseWorkLog(text) {
  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system: `你是漢柏分身，正在幫執行長本人分析他剛完成的一件工作。他的教練教過他，看一件事要「由內而外」：先看人，再看事，時地物是最後才看的背景資訊，不要一開始就陷入瑣事細節。只回傳 JSON，不要其他文字：
{"who":"這件事核心牽涉到的人，例如某員工、某廠商、某夥伴；沒有明確對象就填 null","label":"教得會|不該做|親力親為","value":1到5的整數,"place":"地點或店名，沒有就填 null","thing":"牽涉到的物件或資源，例如合約、設備、發票；沒有就填 null","reply":"一句不超過35字的回應，講清楚為什麼歸這一類，語氣像教練，直接但溫暖"}

分析順序（由內而外，決定你怎麼想，不是輸出順序）：
1. 人：這件事的核心跟誰有關？是員工、廠商、還是只有漢柏自己？
2. 事：實際做了什麼判斷或動作？（這決定 label 跟 value）
3. 地／物：發生在哪個店、涉及什麼物件或資源？能辨識就填，不確定寧可留 null，不要亂猜

分類原則：
- 教得會：有明確流程或判斷邏輯，員工學過就能做，執行長不必每次都親自處理。這類事情現在多半是靠執行長「想到就做」、沒有寫下來，歸這類代表它該被整理成工作說明書／SOP，之後才能真的交出去，不是只在腦子裡會而已
- 不該做：對公司或店務價值低、屬於瑣事，應該授權出去或乾脆停止，不值得執行長投入時間
- 親力親為：需要執行長的角色、信任關係、或關鍵決策權，現階段別人做不了

value 判斷：1-2=低（瑣事或可完全放手）、3=中（有價值但可訓練他人接手）、4-5=高（核心決策/戰略性，親自做才有意義）
若歸類為「教得會」，reply 裡要點出「這個該寫成SOP」這個動作，不是只說可以教
若完全看不出這是在做什麼事 → {"error":"無法辨識"}`,
    messages: [{ role: 'user', content: text }]
  });
  try {
    const raw = res.content[0].text.trim().replace(/^```(?:json)?|```$/g, '').trim();
    return JSON.parse(raw);
  } catch { return { error: '解析失敗' }; }
}

async function recordWorkLog({ content, label, value, who, place, thing, reply }) {
  if (!SUPABASE_URL) return false;
  try {
    const r = await dbFetch('hanbo_work_logs', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ content, label, value, who, place, thing, reply })
    });
    return r.ok;
  } catch { return false; }
}

// ── 候選SOP追蹤（教得會事項重複達3次 → 觸發七何）──────────

async function matchOrCreateSopCandidate(content, who, place) {
  if (!SUPABASE_URL) return null;
  try {
    const res = await dbFetch('hanbo_sop_candidates?status=eq.pending&select=id,topic,count');
    const candidates = await res.json();
    const list = Array.isArray(candidates) ? candidates : [];

    let matchedId = null;
    let topic = content.slice(0, 20);
    if (list.length) {
      const namesStr = list.map(c => `${c.id}:${c.topic}`).join('\n');
      const result = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system: `判斷這件新記錄的事，跟下面現有的「候選SOP主題」是不是同一件重複性工作（做法/情境相同即可，文字不用一樣）。只回傳 JSON，不要其他文字：
{"matched_id":"符合的id，沒有符合則null","topic":"這件事的精簡主題名稱，10字內"}
現有候選：\n${namesStr}`,
        messages: [{ role: 'user', content: `新記錄：${content}${who ? `（人：${who}）` : ''}${place ? `（地：${place}）` : ''}` }]
      });
      try {
        const parsed = JSON.parse(result.content[0].text.trim());
        matchedId = parsed.matched_id || null;
        if (parsed.topic) topic = parsed.topic;
      } catch {}
    }

    if (matchedId) {
      const existing = list.find(c => c.id === matchedId);
      const newCount = (existing?.count || 1) + 1;
      await dbFetch(`hanbo_sop_candidates?id=eq.${matchedId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ count: newCount, updated_at: new Date().toISOString() })
      });
      return { id: matchedId, topic: existing?.topic || topic, count: newCount };
    }

    const created = await dbFetch('hanbo_sop_candidates', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ topic, count: 1 })
    });
    const data = await created.json();
    return data[0] ? { id: data[0].id, topic: data[0].topic, count: 1 } : null;
  } catch { return null; }
}

async function markSopCandidateStatus(id, status) {
  if (!SUPABASE_URL || !id) return false;
  try {
    const r = await dbFetch(`hanbo_sop_candidates?id=eq.${id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status, updated_at: new Date().toISOString() })
    });
    return r.ok;
  } catch { return false; }
}

async function listTriggeredSopCandidates() {
  if (!SUPABASE_URL) return [];
  try {
    const res = await dbFetch('hanbo_sop_candidates?status=eq.triggered&select=id,topic,count&order=updated_at.desc');
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

const SEVEN_HE_QUESTIONS = [
  { key: 'what',  label: '何事', ask: topic => `這件事「${topic}」，具體來說在做什麼？` },
  { key: 'why',   label: '何因', ask: () => '為什麼要做這件事？不做的話會怎樣？' },
  { key: 'who',   label: '何人', ask: () => '誰負責、誰需要配合？' },
  { key: 'when',  label: '何時', ask: () => '什麼時機做、多久一次？' },
  { key: 'where', label: '何地', ask: () => '在哪裡做、哪些店適用？' },
  { key: 'how',   label: '何法', ask: () => '具體步驟是什麼？可以條列講。' },
  { key: 'cost',  label: '何價', ask: () => '大概要花多少時間或成本？' }
];

function buildSopDraft(topic, answers) {
  return `📋 SOP 草稿：${topic}

【何事】${answers.what || '-'}
【何因】${answers.why || '-'}
【何人】${answers.who || '-'}
【何時】${answers.when || '-'}
【何地】${answers.where || '-'}
【何法】
${answers.how || '-'}
【何價】${answers.cost || '-'}

這份先幫你存起來了，確認沒問題的話複製貼到 sop.html，或傳「選單」結束。`;
}

async function fetchWorkLogs(sinceISO) {
  if (!SUPABASE_URL) return [];
  try {
    const res = await dbFetch(`hanbo_work_logs?created_at=gte.${sinceISO}&order=created_at.asc`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

function topCounts(items, field, n = 3) {
  const counts = {};
  for (const it of items) {
    const v = it[field];
    if (!v) continue;
    counts[v] = (counts[v] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function buildWorklogSummary(logs, title) {
  if (!logs.length) return `${title}\n\n這段期間沒有工事紀錄，是漏記了，還是真的都授權出去了？`;
  const byLabel = { 教得會: [], 不該做: [], 親力親為: [] };
  for (const l of logs) (byLabel[l.label] || byLabel.親力親為).push(l);
  const pct = (n) => Math.round((n / logs.length) * 100);
  const highValue = logs.filter(l => l.value >= 4).sort((a, b) => b.value - a.value).slice(0, 5);
  const shouldStop = byLabel['不該做'].slice(0, 5);
  const sopCandidates = byLabel.教得會.slice(0, 8);
  const personalWho = topCounts(byLabel.親力親為, 'who');
  const personalPlace = topCounts(byLabel.親力親為, 'place');

  let msg = `${title}（共 ${logs.length} 筆）\n\n`;
  msg += `📚 教得會：${byLabel.教得會.length} 筆（${pct(byLabel.教得會.length)}%）\n`;
  msg += `🚫 不該做：${byLabel['不該做'].length} 筆（${pct(byLabel['不該做'].length)}%）\n`;
  msg += `🔑 親力親為：${byLabel.親力親為.length} 筆（${pct(byLabel.親力親為.length)}%）\n`;

  if (sopCandidates.length) {
    msg += `\n📚 該寫成SOP／工作說明書（目前靠想到就做）：\n` + sopCandidates.map(l => `・${l.content}`).join('\n') + '\n';
  }
  if (highValue.length) {
    msg += `\n⭐ 高價值事項：\n` + highValue.map(l => `・${l.content}`).join('\n') + '\n';
  }
  if (shouldStop.length) {
    msg += `\n🚫 該考慮授權/停止：\n` + shouldStop.map(l => `・${l.content}`).join('\n') + '\n';
  }
  if (personalWho.length || personalPlace.length) {
    msg += `\n🔎 由內而外看「親力親為」最常黏著誰／哪個地方：\n`;
    if (personalWho.length) msg += `　人：` + personalWho.map(([w, c]) => `${w}(${c})`).join('、') + '\n';
    if (personalPlace.length) msg += `　地：` + personalPlace.map(([p, c]) => `${p}(${c})`).join('、') + '\n';
  }
  return msg.trim();
}

function getMenu(userId) {
  const hanbo = isHanbo(userId);
  return `👋 你好！我是漢柏分身

請選擇你需要的服務：

1️⃣ 記帳 / 回報營業額
傳一句話就能記錄，直接同步到門店日報表

2️⃣ 展店紀錄
記一筆心得，累積這間店的經驗值

3️⃣ 待辦任務清單
查看目前未完成的任務
${hanbo ? `
4️⃣ 每日工事
做完一件事就丟給我，我幫你判斷該教會員工、不該做、還是只能你自己來
` : ''}
🎙️ 說語音 → 直接記錄任務
✍️ 傳「任務 xxx」→ 文字新增任務${hanbo ? '\n📋 傳「SOP」→ 整理累積到3次的教得會事項' : ''}

輸入數字開始，或直接說語音`;
}

// ── 工具函式 ──────────────────────────────────────────

function verifySignature(body, signature) {
  const hash = crypto.createHmac('SHA256', LINE_CHANNEL_SECRET).update(body).digest('base64');
  return hash === signature;
}

async function replyToLine(replyToken, message) {
  try {
    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: message }] })
    });
  } catch (err) {
    console.error('回覆 LINE 失敗:', err);
  }
}

async function pushToUser(userId, message) {
  try {
    await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      body: JSON.stringify({ to: userId, messages: [{ type: 'text', text: message }] })
    });
  } catch (err) {
    console.error('推播 LINE 失敗:', err);
  }
}

// ── Webhook ──────────────────────────────────────────

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.get('/', (req, res) => res.send('貴焿 LINE Bot 運行中 🍜'));

app.use('/api', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.post('/api/classify-log', async (req, res) => {
  if (!NOTIFY_SECRET || req.body.secret !== NOTIFY_SECRET) return res.status(403).send('forbidden');
  const content = (req.body.content || '').trim();
  const category = req.body.category || '其他';
  if (!content) return res.status(400).send('缺少 content');
  try {
    const result = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: `你是漢柏分身，幫展店心得評分並給一句回應。只回傳 JSON，不要其他文字：
{"exp":15或30或60,"reply":"一句不超過30字的回應，溫暖有教練感，像是看見他寫的東西"}
exp 判斷：小發現/小提醒=15，一般心得/收穫=30，重大突破/重要教訓=60，無法判斷則用30。
這筆心得的分類：${category}`,
      messages: [{ role: 'user', content }]
    });
    const raw = result.content[0].text.trim().replace(/^```(?:json)?|```$/g, '').trim();
    const parsed = JSON.parse(raw);
    res.json({ exp: parsed.exp || 30, reply: parsed.reply || '' });
  } catch (err) {
    console.error(err);
    res.json({ exp: 30, reply: '' });
  }
});

app.post('/api/parse-daily-report-photo', async (req, res) => {
  const { image_base64, media_type, year, month } = req.body;
  if (!image_base64 || !year || !month) return res.status(400).json({ error: '缺少必要參數' });
  try {
    const result = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: media_type || 'image/jpeg', data: image_base64 }
          },
          {
            type: 'text',
            text: `這是一張手寫日報表照片，${year}年${month}月的資料。

欄位說明（由左到右）：
日（幾號）、客數、現金（現金營收）、Line Pay、貸放支出（不是營收，跳過）、理費支出（跳過）、總營收（可忽略，用其他欄算）、鍋數、熊貓（foodpanda）、UBER、現金實存（實際盤點現金）、零錢

請將每一行解析成 JSON，只回傳以下格式，不要其他文字：
{
  "rows": [
    {
      "day": 1,
      "customers": 38,
      "cash": 23077,
      "line_pay": 1980,
      "uber": 1551,
      "foodpanda": 1831,
      "cash_counted": 2300,
      "change": 77,
      "pots": 13
    }
  ]
}

注意：
- day 是號數（1~31）
- 看不清楚的格子填 null
- 只解析有資料的行，空白行跳過
- 數字不要有逗號`
          }
        ]
      }]
    });
    const raw = result.content[0].text.trim().replace(/^```(?:json)?|```$/gm, '').trim();
    const parsed = JSON.parse(raw);
    res.json(parsed);
  } catch (err) {
    console.error('parse-daily-report-photo error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notify', async (req, res) => {
  if (!NOTIFY_SECRET || req.body.secret !== NOTIFY_SECRET) return res.status(403).send('forbidden');
  const message = (req.body.message || '').trim();
  if (!message) return res.status(400).send('缺少 message');
  try {
    for (const uid of pushUserIds) await pushToUser(uid, message);
    res.send('ok');
  } catch (err) {
    console.error(err);
    res.status(500).send('通知失敗');
  }
});

// 待辦在網頁上被標記完成時，inbox.html 會打這支 API，
// 讓「待辦」跟「每日工事」共用同一套 AI 判斷跟同一張紀錄表，不用漢柏自己再輸入一次。
app.post('/api/task-completed', async (req, res) => {
  if (!NOTIFY_SECRET || req.body.secret !== NOTIFY_SECRET) return res.status(403).send('forbidden');
  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).send('缺少 content');
  res.send('ok');

  if (!HANBO_USER_ID) return;
  try {
    const parsed = await parseWorkLog(content);
    if (parsed.error) return;

    const ok = await recordWorkLog({
      content,
      label: parsed.label,
      value: parsed.value,
      who: parsed.who || null,
      place: parsed.place || null,
      thing: parsed.thing || null,
      reply: parsed.reply
    });
    if (!ok) return;

    const tags = [parsed.who, parsed.place, parsed.thing].filter(Boolean);
    const tagLine = tags.length ? `\n👤${parsed.who || '-'} 📍${parsed.place || '-'} 📦${parsed.thing || '-'}` : '';
    let nudge = '';
    if (parsed.label === '教得會') {
      const candidate = await matchOrCreateSopCandidate(content, parsed.who, parsed.place);
      if (candidate && candidate.count >= 3) {
        await markSopCandidateStatus(candidate.id, 'triggered');
        nudge = `\n\n🔔 「${candidate.topic}」這件事已經出現第 ${candidate.count} 次了，要不要花幾分鐘走一輪七何，把它寫成SOP？\n傳「SOP」開始，或晚點再說`;
      }
    }
    await pushToUser(HANBO_USER_ID, `✅ 待辦完成，順便幫你歸類了：\n「${content}」\n\n${parsed.label}｜價值 ${parsed.value}/5${tagLine}\n${parsed.reply}${nudge}`);
  } catch (err) {
    console.error('任務完成自動歸類失敗:', err);
  }
});

// inbox.html 網頁快速新增的任務不會經過 saveTask，補這支 API 讓它也能拿到同一套
// 重要／緊急四象限判斷，寫回 tasks 資料表，網頁下次刷新就會看到分類結果。
app.post('/api/classify-task', async (req, res) => {
  if (!NOTIFY_SECRET || req.body.secret !== NOTIFY_SECRET) return res.status(403).send('forbidden');
  const id = req.body.id;
  const content = (req.body.content || '').trim();
  if (!id || !content) return res.status(400).send('缺少 id 或 content');
  res.send('ok');

  try {
    const classified = await classifyTaskPriority(content);
    if (classified.error) { console.error(`任務分類無結果 id=${id}:`, classified.error, '|', content); return; }
    const patchRes = await dbFetch(`tasks?id=eq.${id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        quadrant: classified.quadrant || null,
        action: classified.action || null,
        ai_note: classified.reason || null
      })
    });
    if (!patchRes.ok) console.error(`任務分類寫入失敗 id=${id}:`, patchRes.status, await patchRes.text());
  } catch (err) {
    console.error('任務分類失敗:', err);
  }
});

app.post('/webhook', async (req, res) => {
  const signature = req.headers['x-line-signature'];
  if (!verifySignature(req.rawBody, signature)) return res.status(403).send('Invalid signature');
  res.status(200).send('OK');

  for (const event of req.body.events || []) {
    if (event.type !== 'message') continue;
    const isImage = event.message.type === 'image';
    const isText  = event.message.type === 'text';
    const isAudio = event.message.type === 'audio';
    if (!isText && !isImage && !isAudio) continue;

    const userId = event.source.userId;
    const replyToken = event.replyToken;

    // ── 語音訊息 → 直接存任務 ──
    if (isAudio) {
      try {
        const audioRes = await fetch(`https://api-data.line.me/v2/bot/message/${event.message.id}/content`, {
          headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
        });
        const audioBuffer = await audioRes.arrayBuffer();
        const text = await transcribeAudio(audioBuffer);
        const { classified } = await saveTask(text, 'line_voice');
        await replyToLine(replyToken, `✅ 任務記錄\n\n「${text}」${quadrantTag(classified)}\n\n網頁已同步 → ijs7594.github.io/inbox.html\n\n傳「選單」繼續`);
      } catch (err) {
        console.error('語音辨識失敗:', err);
        await replyToLine(replyToken, '語音辨識失敗，請改用文字：\n「任務 你的任務內容」');
      }
      continue;
    }

    const userText = isText
      ? event.message.text.trim().replace(/[！-～]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
      : '[圖片]';
    console.log(`[${userId}] "${userText}"`);

    if (!sessions[userId]) sessions[userId] = { skill: null, pendingImageUrl: null, storeId: null, storeName: null, awaitingStore: false, storeChoices: null, sopStep: null, sopAnswers: null, sopTopic: null, sopCandidateId: null, awaitingSopChoice: false, sopChoices: null };
    const session = sessions[userId];

    // 圖片在非記帳／展店模式下提示
    if (isImage && session.skill !== 'finance' && session.skill !== 'storelog') {
      await replyToLine(replyToken, '圖片記帳請先傳 1 進入記帳模式，或傳 2 進入展店紀錄模式，再拍照傳送。');
      continue;
    }

    // ── 文字新增任務 ──
    if (userText.startsWith('任務 ') || userText.startsWith('todo ')) {
      const content = userText.replace(/^(任務|todo)\s+/i, '').trim();
      if (content) {
        const { classified } = await saveTask(content, 'line_text');
        await replyToLine(replyToken, `✅ 任務記錄\n\n「${content}」${quadrantTag(classified)}\n\n繼續傳下一個，或傳「選單」`);
      } else {
        await replyToLine(replyToken, '請在「任務」後面加上內容，例如：\n「任務 追蹤小明的排班問題」');
      }
      continue;
    }

    // ── 查看待辦 ──
    if (userText === '3' || userText === '待辦' || userText === '任務清單') {
      const tasks = await listPendingTasks();
      if (!tasks.length) {
        await replyToLine(replyToken, '目前沒有待辦任務 🎉\n\n說語音或傳「任務 xxx」新增');
      } else {
        const list = tasks.map((t, i) => `${i + 1}. ${t.content}`).join('\n');
        await replyToLine(replyToken, `📋 待辦（${tasks.length} 件）\n\n${list}\n\n到網頁標記完成 →\nijs7594.github.io/inbox.html`);
      }
      continue;
    }

    // 查詢 ID
    if (userText.toLowerCase().includes('我的id') || userText.toLowerCase() === 'myid') {
      await replyToLine(replyToken, `你的 LINE ID：\n${userId}`);
      continue;
    }

    // ── 觸發七何寫SOP（只開放給執行長，資料來源是他自己的每日工事紀錄）──
    if ((userText === 'SOP' || userText.toLowerCase() === 'sop' || userText === '七何') && !session.awaitingSopChoice && session.skill !== 'sopwrite') {
      if (!isHanbo(userId)) {
        await replyToLine(replyToken, getMenu(userId));
        continue;
      }
      const triggered = await listTriggeredSopCandidates();
      if (!triggered.length) {
        await replyToLine(replyToken, '目前沒有累積到3次、等你寫SOP的事項。');
      } else if (triggered.length === 1) {
        session.skill = 'sopwrite';
        session.sopCandidateId = triggered[0].id;
        session.sopTopic = triggered[0].topic;
        session.sopStep = 0;
        session.sopAnswers = {};
        await replyToLine(replyToken, `📋 開始整理「${session.sopTopic}」的SOP，用七何一題一題來。\n\n${SEVEN_HE_QUESTIONS[0].ask(session.sopTopic)}`);
      } else {
        session.awaitingSopChoice = true;
        session.sopChoices = triggered;
        const list = triggered.map((c, i) => `${i + 1}. ${c.topic}（出現${c.count}次）`).join('\n');
        await replyToLine(replyToken, `有幾件事都到了該寫SOP的時候，先選一個：\n\n${list}`);
      }
      continue;
    }

    // 回選單
    if (userText === '選單' || userText === 'menu' || userText === '0') {
      sessions[userId] = { skill: null, pendingImageUrl: null, storeId: null, storeName: null, awaitingStore: false, storeChoices: null, sopStep: null, sopAnswers: null, sopTopic: null, sopCandidateId: null, awaitingSopChoice: false, sopChoices: null };
      await replyToLine(replyToken, getMenu(userId));
      continue;
    }

    // ── 卡在某個模式（含選店中／寫SOP中）時，輸入其他模式的關鍵字直接切換，不用先傳「選單」──
    // （2026-08-11晚上漢柏真的卡住3小時的原因：待在worklog模式時打「記帳」，
    // 因為選擇技能的關鍵字判斷只在 session.skill 是 null 時才會跑到，結果被當成工事內容送去分類。
    // 這裡要涵蓋所有「忙碌中」狀態，包含選店中／寫SOP中，不然同一種卡法會在別的模式重演）
    const busy = session.skill === 'finance' || session.skill === 'storelog' || session.skill === 'worklog'
      || session.skill === 'sopwrite' || session.awaitingSopChoice;
    if (busy) {
      const switchingAway =
        (session.skill !== 'finance'  && (userText === '1' || userText.includes('記帳') || userText.includes('營業額'))) ||
        (session.skill !== 'storelog' && (userText === '2' || userText.includes('展店'))) ||
        (session.skill !== 'worklog'  && (userText === '4' || userText.includes('工事')));
      if (switchingAway) {
        session.skill = null;
        session.awaitingStore = false;
        session.awaitingSopChoice = false;
        session.sopChoices = null;
        session.sopStep = null;
        session.sopAnswers = null;
        session.sopTopic = null;
        session.sopCandidateId = null;
      }
    }

    // 換店（記帳模式用）
    if (userText === '換店') {
      session.storeId = null;
      session.storeName = null;
      if (session.skill === 'finance') {
        const stores = await getAllowedStores(userId);
        if (!stores.length) {
          await replyToLine(replyToken, '你的 LINE 帳號還沒被設定可以記哪一家店的帳，請聯絡漢柏幫你綁定。');
          session.skill = null;
          continue;
        }
        session.storeChoices = stores;
        session.awaitingStore = true;
        const list = stores.map((s, i) => `${i + 1}. ${s.name}`).join('\n');
        await replyToLine(replyToken, `要換記哪一家店的日報？\n\n${list}`);
      } else {
        await replyToLine(replyToken, '已重設店家，下次進記帳模式會重新讓你選。');
      }
      continue;
    }

    // ── 記帳模式：選店 ──
    if (session.skill === 'finance' && session.awaitingStore) {
      const idx = parseInt(userText, 10) - 1;
      const choice = (session.storeChoices || [])[idx];
      if (!choice) {
        const list = session.storeChoices.map((s, i) => `${i + 1}. ${s.name}`).join('\n');
        await replyToLine(replyToken, `請輸入店家編號：\n\n${list}`);
        continue;
      }
      session.storeId = choice.id;
      session.storeName = choice.name;
      session.awaitingStore = false;
      await replyToLine(replyToken, `✅ 之後記帳都記到「${choice.name}」\n\n直接傳就好，例如：\n「午餐 金園排骨 260」\n「今日營業額 18500」\n「停車費 80」\n\n要換店傳「換店」，傳「選單」結束`);
      continue;
    }

    // ── 記帳模式（不需要對話歷史）──
    if (session.skill === 'finance') {
      try {
        const parsed = isImage
          ? await parseReceiptImage(event.message.id)
          : await parseFinanceEntry(userText);
        if (parsed.error) {
          await replyToLine(replyToken, `無法辨識，請試試：\n「午餐 260」\n「今日營業額 15000」\n\n或傳「選單」結束`);
        } else if (parsed.type === 'revenue') {
          await recordDailyRevenue(session.storeId, parsed.amount);
          await replyToLine(replyToken, `💰 已記錄「${session.storeName}」今日營業額 $${Number(parsed.amount).toLocaleString()}\n已同步到日報表\n\n繼續傳下一筆，或傳「選單」結束`);
        } else {
          await recordDailyExpense(session.storeId, parsed.amount, parsed.category, parsed.description);
          await replyToLine(replyToken, `✅ 「${session.storeName}」支出 ${parsed.description} $${parsed.amount}\n分類：${parsed.category}\n已同步到日報表\n\n繼續傳下一筆，或傳「選單」結束`);
        }
      } catch (err) {
        console.error(err);
        await replyToLine(replyToken, '記帳失敗，請再試一次。');
      }
      continue;
    }

    // ── 展店紀錄模式（不需要對話歷史）──
    if (session.skill === 'storelog') {
      if (isImage) {
        try {
          const url = await uploadStorePhoto(event.message.id);
          if (!url) throw new Error('upload failed');
          session.pendingImageUrl = url;
          await replyToLine(replyToken, '📷 照片收到了，再傳一句話說明是哪間店、什麼心得（例如：三民店 裝潢 天花板完工了），我會把照片一起存進去。');
        } catch (err) {
          console.error(err);
          await replyToLine(replyToken, '照片上傳失敗，請再試一次。');
        }
        continue;
      }
      try {
        const existing = await getStoreNames();
        const parsed = await parseStoreLog(userText, existing);
        if (parsed.error) {
          await replyToLine(replyToken, `無法辨識，請試試：\n「店名 分類 心得內容」\n例如「三民店 選址 巷口那間租金太高」\n\n或傳「選單」結束`);
        } else {
          const exp = parsed.exp || 10;
          const imageUrl = session.pendingImageUrl;
          const ok = await recordStoreLog(parsed.store_name, parsed.category, parsed.content, exp, imageUrl);
          if (ok) {
            session.pendingImageUrl = null;
            await replyToLine(replyToken, `✅ 已記錄到「${parsed.store_name}」${imageUrl ? '（含照片）' : ''}\n分類：${parsed.category}\n+${exp} EXP\n\n繼續傳下一筆，或傳「選單」結束`);
          } else {
            await replyToLine(replyToken, '記錄失敗，請再試一次。');
          }
        }
      } catch (err) {
        console.error(err);
        await replyToLine(replyToken, '記錄失敗，請再試一次。');
      }
      continue;
    }

    // ── 每日工事模式（不需要對話歷史）──
    if (session.skill === 'worklog') {
      try {
        const parsed = await parseWorkLog(userText);
        if (parsed.error) {
          await replyToLine(replyToken, `無法辨識，請直接說做了什麼，例如：\n「跟廠商確認三民店的工期」\n\n或傳「選單」結束`);
        } else {
          const ok = await recordWorkLog({
            content: userText,
            label: parsed.label,
            value: parsed.value,
            who: parsed.who || null,
            place: parsed.place || null,
            thing: parsed.thing || null,
            reply: parsed.reply
          });
          if (ok) {
            const tags = [parsed.who, parsed.place, parsed.thing].filter(Boolean);
            const tagLine = tags.length ? `\n👤${parsed.who || '-'} 📍${parsed.place || '-'} 📦${parsed.thing || '-'}` : '';
            let nudge = '';
            if (parsed.label === '教得會') {
              const candidate = await matchOrCreateSopCandidate(userText, parsed.who, parsed.place);
              if (candidate && candidate.count >= 3) {
                await markSopCandidateStatus(candidate.id, 'triggered');
                nudge = `\n\n🔔 「${candidate.topic}」這件事已經出現第 ${candidate.count} 次了，要不要現在花幾分鐘走一輪七何，把它寫成SOP？\n傳「SOP」開始，或晚點再說`;
              }
            }
            await replyToLine(replyToken, `${parsed.label}｜價值 ${parsed.value}/5${tagLine}\n${parsed.reply}\n\n繼續傳下一件，或傳「選單」結束${nudge}`);
          } else {
            await replyToLine(replyToken, '記錄失敗，請再試一次。');
          }
        }
      } catch (err) {
        console.error(err);
        await replyToLine(replyToken, '記錄失敗，請再試一次。');
      }
      continue;
    }

    // ── 選擇要寫哪個SOP ──
    if (session.awaitingSopChoice) {
      const idx = parseInt(userText, 10) - 1;
      const choice = (session.sopChoices || [])[idx];
      if (!choice) {
        const list = session.sopChoices.map((c, i) => `${i + 1}. ${c.topic}（出現${c.count}次）`).join('\n');
        await replyToLine(replyToken, `請輸入編號：\n\n${list}`);
        continue;
      }
      session.awaitingSopChoice = false;
      session.sopChoices = null;
      session.skill = 'sopwrite';
      session.sopCandidateId = choice.id;
      session.sopTopic = choice.topic;
      session.sopStep = 0;
      session.sopAnswers = {};
      await replyToLine(replyToken, `📋 開始整理「${session.sopTopic}」的SOP，用七何一題一題來。\n\n${SEVEN_HE_QUESTIONS[0].ask(session.sopTopic)}`);
      continue;
    }

    // ── 七何寫SOP進行中 ──
    if (session.skill === 'sopwrite') {
      const q = SEVEN_HE_QUESTIONS[session.sopStep];
      session.sopAnswers[q.key] = userText;
      session.sopStep += 1;
      if (session.sopStep < SEVEN_HE_QUESTIONS.length) {
        await replyToLine(replyToken, SEVEN_HE_QUESTIONS[session.sopStep].ask(session.sopTopic));
      } else {
        const draft = buildSopDraft(session.sopTopic, session.sopAnswers);
        await markSopCandidateStatus(session.sopCandidateId, 'done');
        session.skill = null;
        session.sopCandidateId = null;
        session.sopAnswers = null;
        session.sopStep = null;
        await replyToLine(replyToken, draft);
      }
      continue;
    }

    // 選擇技能
    if (!session.skill) {
      if (userText === '1' || userText.includes('記帳') || userText.includes('營業額')) {
        session.skill = 'finance';
        const stores = await getAllowedStores(userId);
        if (!stores.length) {
          await replyToLine(replyToken, '你的 LINE 帳號還沒被設定可以記哪一家店的帳，請聯絡漢柏幫你綁定。');
          session.skill = null;
          continue;
        }
        session.storeChoices = stores;
        session.awaitingStore = true;
        const list = stores.map((s, i) => `${i + 1}. ${s.name}`).join('\n');
        await replyToLine(replyToken, `📒 記帳模式開啟\n\n先選要記哪一家店的日報：\n\n${list}`);
        continue;
      } else if (userText === '2' || userText.includes('展店')) {
        session.skill = 'storelog';
        await replyToLine(replyToken, `🏪 展店紀錄模式開啟\n\n直接傳心得就好，例如：\n「三民店 選址 巷口那間租金太高，以後要抓預算上限」\n「新開的左營店 人事 找到超讚的店長」\n\n傳「選單」結束`);
        continue;
      } else if (userText === '4' || userText.includes('工事')) {
        if (!isHanbo(userId)) {
          await replyToLine(replyToken, getMenu(userId));
          continue;
        }
        session.skill = 'worklog';
        await replyToLine(replyToken, `🗂️ 每日工事模式開啟\n\n做完一件事就傳給我，我幫你判斷「教得會 / 不該做 / 親力親為」跟價值分，月底季底會彙整成報告給你。\n\n例如：「跟廠商確認三民店的工期」\n\n傳「選單」結束`);
        continue;
      } else {
        await replyToLine(replyToken, getMenu(userId));
        continue;
      }
    }
  }
});

// ── 定時推播 ──────────────────────────────────────────

// 每月 1 號早上彙整上個月的每日工事紀錄，季底月份（1/4/7/10月）額外彙整上一季
cron.schedule('30 8 1 * *', async () => {
  if (!HANBO_USER_ID) return;
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthLogs = (await fetchWorkLogs(monthStart.toISOString()))
      .filter(l => new Date(l.created_at) < monthEnd);
    const monthLabel = `${monthStart.getFullYear()}/${monthStart.getMonth() + 1} 月`;
    await pushToUser(HANBO_USER_ID, buildWorklogSummary(monthLogs, `📊 ${monthLabel}工事彙整`));

    // 四象限分析：累積存進 task_quadrant_snapshots，跟上個月比才看得出授權比例有沒有變好
    const prevSnapshot = await fetchLatestQuadrantSnapshot(false);
    const monthTasks = await fetchTasksInRange(monthStart.toISOString(), monthEnd.toISOString());
    const monthQuad = buildQuadrantAnalysis(monthTasks, `🧭 ${monthLabel} 四象限分析`, prevSnapshot ? prevSnapshot.delegate_rate : null);
    await saveQuadrantSnapshot({ periodLabel: monthLabel, periodStart: monthStart.toISOString(), periodEnd: monthEnd.toISOString(), isQuarter: false, analysis: monthQuad });
    await pushToUser(HANBO_USER_ID, monthQuad.text);

    if ([0, 3, 6, 9].includes(now.getMonth())) {
      const qStart = new Date(now.getFullYear(), now.getMonth() - 3, 1);
      const qLogs = (await fetchWorkLogs(qStart.toISOString()))
        .filter(l => new Date(l.created_at) < monthEnd);
      const qLabel = `${qStart.getFullYear()} Q${Math.floor(qStart.getMonth() / 3) + 1}`;
      await pushToUser(HANBO_USER_ID, buildWorklogSummary(qLogs, `📈 ${qLabel} 工事彙整`));

      const prevQSnapshot = await fetchLatestQuadrantSnapshot(true);
      const qTasks = await fetchTasksInRange(qStart.toISOString(), monthEnd.toISOString());
      const qQuad = buildQuadrantAnalysis(qTasks, `🧭 ${qLabel} 四象限分析`, prevQSnapshot ? prevQSnapshot.delegate_rate : null);
      await saveQuadrantSnapshot({ periodLabel: qLabel, periodStart: qStart.toISOString(), periodEnd: monthEnd.toISOString(), isQuarter: true, analysis: qQuad });
      await pushToUser(HANBO_USER_ID, qQuad.text);
    }
  } catch (err) {
    console.error('工事彙整推播失敗:', err);
  }
}, { timezone: 'Asia/Taipei' });

// 每天早上彙整昨日各店日報回報進度 + 待辦數量
cron.schedule('0 8 * * *', async () => {
  if (!HANBO_USER_ID) return;
  try {
    await pushToUser(HANBO_USER_ID, await buildDailySummary());
  } catch (err) {
    console.error('每日摘要推播失敗:', err);
  }
}, { timezone: 'Asia/Taipei' });

// 每月 27 號提醒填月底自我盤點，時間點卡在月底前，讓店長反思的是「這個月」，
// 剛好接上 8/1 那份評論月報回顧的也是同一個月份。
// 目前還沒有店長版的 LINE ID 名冊，所以先推給漢柏，由他轉發到店長群組；
// 之後有 supervisor_users 擴充成完整名冊，可以改成直接推給每位店長。
// 填寫頁面在夥伴入口裡（checkin.html），不是 Google 表單——用網頁是因為
// 店家可以直接綁定不用打字選，題目也能做成點選量表，比表單快也不會比對錯店。
const SELF_CHECKIN_URL = 'https://ijs7594.github.io/checkin.html';
cron.schedule('0 10 27 * *', async () => {
  if (!HANBO_USER_ID) return;
  try {
    await pushToUser(HANBO_USER_ID,
      `📝 該提醒店長們填「月底自我盤點」了\n\n這個月快結束了，麻煩轉發給店長群組，請大家花幾分鐘回顧這個月（也可以從夥伴入口點進去）：\n${SELF_CHECKIN_URL}`
    );
  } catch (err) {
    console.error('自我盤點提醒推播失敗:', err);
  }
}, { timezone: 'Asia/Taipei' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Supabase：${SUPABASE_URL ? '已連接' : '未設定'}`);
});
