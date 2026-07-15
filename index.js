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

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const sessions = {};
const pushUserIds = new Set(
  (process.env.PUSH_USER_IDS || '').split(',').filter(id => id.trim())
);

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

async function loadProfile(userId) {
  if (!SUPABASE_URL) return '';
  try {
    const res = await dbFetch(`user_memory?user_id=eq.${userId}&select=profile`);
    const data = await res.json();
    return data[0]?.profile || '';
  } catch { return ''; }
}

async function saveProfile(userId, profile) {
  if (!SUPABASE_URL) return;
  try {
    await dbFetch('user_memory', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ user_id: userId, profile, updated_at: new Date().toISOString() })
    });
  } catch {}
}

async function updateProfile(userId, history, existingProfile) {
  const userMessages = history.filter(m => m.role === 'user').map(m => m.content).join('\n');
  try {
    const newProfile = await callClaude(
      `你是記憶整理助手。根據對話用不超過80字整理使用者的小檔案。
格式：姓名：\n角色：\n常聊主題：\n上次重點：\n狀態：
現有記憶：\n${existingProfile || '（新使用者）'}`,
      [], `這次對話：\n${userMessages}`
    );
    await saveProfile(userId, newProfile);
    return newProfile;
  } catch { return existingProfile; }
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

async function recordExpense(userId, amount, category, description) {
  if (!SUPABASE_URL) return false;
  try {
    const r = await dbFetch('expenses', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: userId, amount, category, description, date: new Date().toISOString().split('T')[0] })
    });
    return r.ok;
  } catch { return false; }
}

async function recordRevenue(userId, amount, note) {
  if (!SUPABASE_URL) return false;
  try {
    const r = await dbFetch('revenue', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: userId, amount, note, date: new Date().toISOString().split('T')[0] })
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

async function saveTask(content, source = 'line_voice') {
  if (!SUPABASE_URL) return false;
  try {
    const r = await dbFetch('tasks', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ content, source, status: 'pending' })
    });
    return r.ok;
  } catch { return false; }
}

async function listPendingTasks() {
  if (!SUPABASE_URL) return [];
  try {
    const res = await dbFetch('tasks?status=eq.pending&order=created_at.desc&limit=10');
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
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
{"store_name":"店名","category":"選址|裝潢|人事|物流|行銷|口味|客訴|其他","content":"心得內容","exp":5或10或20}
現有店家：${namesStr}
若訊息裡的店名與現有店家接近，請用現有店家的完整名稱；否則視為新店家，用訊息裡的名稱。
exp 判斷：小發現/小提醒=5，一般心得/收穫=10，重大突破/重要教訓=20，無法判斷則用10。
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

// ── 技能提示 ──────────────────────────────────────────

const SKILLS = {
  career: {
    name: '職涯對話',
    prompt: `你是漢柏分身，一位教練型引導者，代表「貴焿古早味麵線羹」與員工對話。

現在進入「職涯對話」模式。

規則：
- 不直接給答案，用問題帶對方挖掘自己的答案
- 每次只問一個問題，等對方回答再繼續
- 語氣溫暖、簡潔、有深度
- 先確認對方現在的狀態，再慢慢深入

開場請說：「你今天想聊的，是關於工作的什麼部分？」

根據對方回答選擇方向：
- 不知道未來方向 → 挖掘熱情與強項
- 覺得卡住了 → 問他卡在哪裡
- 想轉換角色 → 先了解現在再問想去哪
- 想被肯定 → 先看見他再問他怎麼看自己

對話結束前問：「今天這段對話，有什麼讓你比較清楚了嗎？」
最後給一句不超過兩行的鼓勵。`
  },
  checkin: {
    name: '每日學習打卡',
    prompt: `你是漢柏分身的學習助手，代表「貴焿古早味麵線羹」陪員工打卡。

現在進入「每日學習打卡」模式。

依序問以下四題，每次問一題，等對方回答再繼續：
1. 「今天你做了什麼？（不用完整，說重點就好）」
2. 「今天有沒有遇到什麼卡關或不確定的地方？」
3. 「今天你覺得自己做得不錯的一件事是什麼？」
4. 「明天你最想完成的一件事是？」

四題都答完後，整理輸出：

📅 打卡日期：（今天日期）
✅ 今天完成：（第一題重點）
🤔 遇到的卡關：（第二題，沒有就寫「無」）
💪 今天的亮點：（第三題）
🎯 明天目標：（第四題）

最後給一句溫暖的話，不超過一行。`
  },
  onboard: {
    name: '新人引導',
    prompt: `你是漢柏分身，代表「貴焿古早味麵線羹」歡迎新人加入。

現在進入「新人引導」模式。

開場說：「歡迎加入貴焿！我是漢柏分身，接下來會陪你走過第一週。請問你的名字是？」

取得名字後依序介紹（每段介紹完問有沒有問題）：

1. 我們是誰：
「貴焿古早味麵線羹，是一個重視人勝過重視業績的品牌。我們的核心是：幫人發展與提升人生方向，比賺大錢更重要。」

2. 第一週任務清單：
- 認識所有同事的名字
- 了解自己負責的工作範圍
- 第一次獨立完成一件小任務
- 跟直屬主管進行一次一對一對話

3. 遇到問題怎麼辦：
「有問題先試著自己找，找不到再問同事，還是不確定就傳給我（回傳選單）。」

最後問：「你現在有什麼想問的，或是有什麼擔心的事嗎？」
根據回答回應，最後說：「第一天最重要的事，就是讓自己安心。加油，我們很高興你在這裡。」`
  }
};

function buildSystemPrompt(skillPrompt, profile) {
  if (!profile) return skillPrompt;
  return `${skillPrompt}\n\n---\n【這位使用者的過去記憶】\n${profile}`;
}

function getMenu() {
  return `👋 你好！我是漢柏分身

請選擇你需要的服務：

1️⃣ 職涯對話
想聊未來方向、卡關、或只是想被聽見

2️⃣ 每日學習打卡
記錄今天的成長與明天的目標

3️⃣ 新人引導
剛加入貴焿的夥伴從這裡開始

4️⃣ 記帳 / 回報營業額
傳一句話就能記錄

5️⃣ 展店紀錄
記一筆心得，累積這間店的經驗值

6️⃣ 待辦任務清單
查看目前未完成的任務

🎙️ 說語音 → 直接記錄任務
✍️ 傳「任務 xxx」→ 文字新增任務

輸入數字開始，或直接說語音`;
}

// ── 工具函式 ──────────────────────────────────────────

function verifySignature(body, signature) {
  const hash = crypto.createHmac('SHA256', LINE_CHANNEL_SECRET).update(body).digest('base64');
  return hash === signature;
}

async function replyToLine(replyToken, message) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: message }] })
  });
}

async function pushToUser(userId, message) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ to: userId, messages: [{ type: 'text', text: message }] })
  });
}

async function callClaude(systemPrompt, history, userMessage) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: systemPrompt,
    messages: [...history, { role: 'user', content: userMessage }]
  });
  return response.content[0].text;
}

// ── Webhook ──────────────────────────────────────────

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.get('/', (req, res) => res.send('貴焿 LINE Bot 運行中 🍜'));

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

    // ── 語音訊息 → 直接存任務 ──
    if (isAudio) {
      try {
        const audioRes = await fetch(`https://api-data.line.me/v2/bot/message/${event.message.id}/content`, {
          headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
        });
        const audioBuffer = await audioRes.arrayBuffer();
        const text = await transcribeAudio(audioBuffer);
        await saveTask(text, 'line_voice');
        await replyToLine(replyToken, `✅ 任務記錄\n\n「${text}」\n\n網頁已同步 → ijs7594.github.io/inbox.html\n\n傳「選單」繼續`);
      } catch (err) {
        console.error('語音辨識失敗:', err);
        await replyToLine(replyToken, '語音辨識失敗，請改用文字：\n「任務 你的任務內容」');
      }
      continue;
    }

    const userId = event.source.userId;
    const userText = isText
      ? event.message.text.trim().replace(/[！-～]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
      : '[圖片]';
    console.log(`[${userId}] "${userText}"`);
    const replyToken = event.replyToken;

    if (!sessions[userId]) sessions[userId] = { skill: null, history: [], profile: null, pendingImageUrl: null };
    const session = sessions[userId];

    // 圖片在非記帳／展店模式下提示
    if (isImage && session.skill !== 'finance' && session.skill !== 'storelog') {
      await replyToLine(replyToken, '圖片記帳請先傳 4 進入記帳模式，或傳 5 進入展店紀錄模式，再拍照傳送。');
      continue;
    }

    // ── 文字新增任務 ──
    if (userText.startsWith('任務 ') || userText.startsWith('todo ')) {
      const content = userText.replace(/^(任務|todo)\s+/i, '').trim();
      if (content) {
        await saveTask(content, 'line_text');
        await replyToLine(replyToken, `✅ 任務記錄\n\n「${content}」\n\n繼續傳下一個，或傳「選單」`);
      } else {
        await replyToLine(replyToken, '請在「任務」後面加上內容，例如：\n「任務 追蹤小明的排班問題」');
      }
      continue;
    }

    // ── 查看待辦 ──
    if (userText === '6' || userText === '待辦' || userText === '任務清單') {
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

    // 回選單
    if (userText === '選單' || userText === 'menu' || userText === '0') {
      if (session.skill && session.skill !== 'finance' && session.history.length > 2) {
        updateProfile(userId, session.history, session.profile).catch(console.error);
      }
      sessions[userId] = { skill: null, history: [], profile: null, pendingImageUrl: null };
      await replyToLine(replyToken, getMenu());
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
          await recordRevenue(userId, parsed.amount, parsed.description);
          await replyToLine(replyToken, `💰 已記錄營業額 $${Number(parsed.amount).toLocaleString()}\n${parsed.description ? `（${parsed.description}）` : ''}\n\n繼續傳下一筆，或傳「選單」結束`);
        } else {
          await recordExpense(userId, parsed.amount, parsed.category, parsed.description);
          await replyToLine(replyToken, `✅ ${parsed.description} $${parsed.amount}\n分類：${parsed.category}\n\n繼續傳下一筆，或傳「選單」結束`);
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

    // 選擇技能
    if (!session.skill) {
      if (userText === '1' || userText.includes('職涯')) {
        session.skill = 'career';
      } else if (userText === '2' || userText.includes('打卡')) {
        session.skill = 'checkin';
      } else if (userText === '3' || userText.includes('新人')) {
        session.skill = 'onboard';
      } else if (userText === '4' || userText.includes('記帳') || userText.includes('營業額')) {
        session.skill = 'finance';
        await replyToLine(replyToken, `📒 記帳模式開啟\n\n直接傳就好，例如：\n「午餐 金園排骨 260」\n「今日營業額 18500」\n「停車費 80」\n\n傳「選單」結束記帳`);
        continue;
      } else if (userText === '5' || userText.includes('展店')) {
        session.skill = 'storelog';
        await replyToLine(replyToken, `🏪 展店紀錄模式開啟\n\n直接傳心得就好，例如：\n「三民店 選址 巷口那間租金太高，以後要抓預算上限」\n「新開的左營店 人事 找到超讚的店長」\n\n傳「選單」結束`);
        continue;
      } else {
        await replyToLine(replyToken, getMenu());
        continue;
      }

      session.profile = await loadProfile(userId);
      const skill = SKILLS[session.skill];
      try {
        const opening = await callClaude(buildSystemPrompt(skill.prompt, session.profile), [], '請開始');
        session.history = [
          { role: 'user', content: '請開始' },
          { role: 'assistant', content: opening }
        ];
        await replyToLine(replyToken, opening);
      } catch (err) {
        console.error('技能開場失敗:', err);
        session.skill = null;
        await replyToLine(replyToken, '抱歉，啟動失敗，請再試一次。');
      }
      continue;
    }

    // 繼續對話
    const skill = SKILLS[session.skill];
    try {
      const reply = await callClaude(buildSystemPrompt(skill.prompt, session.profile), session.history, userText);
      session.history.push({ role: 'user', content: userText });
      session.history.push({ role: 'assistant', content: reply });
      if (session.history.length > 20) session.history = session.history.slice(-20);
      if (session.history.length % 8 === 0) {
        updateProfile(userId, session.history, session.profile)
          .then(p => { session.profile = p; })
          .catch(console.error);
      }
      await replyToLine(replyToken, reply);
    } catch (err) {
      console.error(err);
      await replyToLine(replyToken, '抱歉，我剛才沒跟上，可以再說一次嗎？');
    }
  }
});

// ── 定時推播 ──────────────────────────────────────────


cron.schedule('30 21 * * *', async () => {
  const msg = `🌙 今天結束前，記得打個卡。\n\n傳 2 給我，花 2 分鐘記錄今天的收穫。`;
  for (const uid of pushUserIds) await pushToUser(uid, msg);
}, { timezone: 'Asia/Taipei' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Supabase：${SUPABASE_URL ? '已連接' : '未設定'}`);
});
