const express = require('express');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');

const app = express();

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

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

  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: contentType, data: base64 } },
        { type: 'text', text: `這是台灣發票或收據照片，請仔細辨識：
1. 找出「總計」「合計」「金額」「小計」或最大的數字作為金額
2. 從店名或品項判斷分類
3. 只回傳 JSON，不要其他文字：
{"type":"expense","amount":數字,"category":"餐飲|交通|購物|孩子|醫療|娛樂|店務|其他","description":"店名或主要品項"}
若真的完全無法辨識任何金額 → {"error":"無法辨識"}` }
      ]
    }]
  });
  try { return JSON.parse(res.content[0].text.trim()); }
  catch { return { error: '解析失敗' }; }
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

輸入數字 1、2、3 或 4 開始`;
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
    const isText = event.message.type === 'text';
    if (!isText && !isImage) continue;

    const userId = event.source.userId;
    const userText = isText
      ? event.message.text.trim().replace(/[！-～]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
      : '[圖片]';
    console.log(`[${userId}] "${userText}"`);
    const replyToken = event.replyToken;

    if (!sessions[userId]) sessions[userId] = { skill: null, history: [], profile: null };
    const session = sessions[userId];

    // 圖片在非記帳模式下提示
    if (isImage && session.skill !== 'finance') {
      await replyToLine(replyToken, '圖片記帳請先傳 4 進入記帳模式，再拍照傳送。');
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
      sessions[userId] = { skill: null, history: [], profile: null };
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

cron.schedule('0 9 * * *', async () => {
  const msg = `☀️ 早安！今天也是美好的一天。\n\n準備好了嗎？傳 2 給我，開始今天的學習打卡。`;
  for (const uid of pushUserIds) await pushToUser(uid, msg);
}, { timezone: 'Asia/Taipei' });

cron.schedule('30 21 * * *', async () => {
  const msg = `🌙 今天結束前，記得打個卡。\n\n傳 2 給我，花 2 分鐘記錄今天的收穫。`;
  for (const uid of pushUserIds) await pushToUser(uid, msg);
}, { timezone: 'Asia/Taipei' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Supabase：${SUPABASE_URL ? '已連接' : '未設定'}`);
});
