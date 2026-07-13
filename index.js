const express = require('express');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');

const app = express();

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// 每個使用者的對話記憶（簡單版，重啟會清空）
const sessions = {};

// 推播名單（從環境變數載入，格式：PUSH_USER_IDS=U123,U456）
const pushUserIds = new Set(
  (process.env.PUSH_USER_IDS || '').split(',').filter(id => id.trim())
);

// 技能系統提示
const SKILLS = {
  'career': {
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
  'checkin': {
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
  'onboard': {
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

// 主選單文字
function getMenu() {
  return `👋 你好！我是漢柏分身

請選擇你需要的服務：

1️⃣ 職涯對話
想聊未來方向、卡關、或只是想被聽見

2️⃣ 每日學習打卡
記錄今天的成長與明天的目標

3️⃣ 新人引導
剛加入貴焿的夥伴從這裡開始

輸入數字 1、2 或 3 開始`;
}

// 驗證 LINE 簽名
function verifySignature(body, signature) {
  const hash = crypto
    .createHmac('SHA256', LINE_CHANNEL_SECRET)
    .update(body)
    .digest('base64');
  return hash === signature;
}

// 回傳訊息給 LINE
async function replyToLine(replyToken, message) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text: message }]
    })
  });
  return res;
}

// 主動推播訊息給指定使用者
async function pushToUser(userId, message) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: 'text', text: message }]
    })
  });
}

// 呼叫 Claude
async function callClaude(systemPrompt, history, userMessage) {
  const messages = [
    ...history,
    { role: 'user', content: userMessage }
  ];

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: systemPrompt,
    messages
  });

  return response.content[0].text;
}

app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

app.get('/', (req, res) => res.send('貴焿 LINE Bot 運行中 🍜'));

app.post('/webhook', async (req, res) => {
  const signature = req.headers['x-line-signature'];
  if (!verifySignature(req.rawBody, signature)) {
    return res.status(403).send('Invalid signature');
  }

  res.status(200).send('OK');

  const events = req.body.events || [];

  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const userId = event.source.userId;
    // 全形轉半形數字，再 trim
    const userText = event.message.text.trim().replace(/[１２３４５６７８９０]/g, s =>
      String.fromCharCode(s.charCodeAt(0) - 0xFEE0)
    );
    console.log(`[userId=${userId}] 收到訊息: "${userText}"`);
    const replyToken = event.replyToken;

    // 初始化 session
    if (!sessions[userId]) {
      sessions[userId] = { skill: null, history: [] };
    }

    const session = sessions[userId];

    // 指令：查詢自己的 LINE ID
    if (userText === '我的ID' || userText === 'myid') {
      await replyToLine(replyToken, `你的 LINE ID 是：\n${userId}`);
      continue;
    }

    // 指令：重新開始
    if (userText === '選單' || userText === 'menu' || userText === '0') {
      sessions[userId] = { skill: null, history: [] };
      await replyToLine(replyToken, getMenu());
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
      } else {
        await replyToLine(replyToken, getMenu());
        continue;
      }

      // 技能開場
      const skill = SKILLS[session.skill];
      try {
        const opening = await callClaude(skill.prompt, [], '請開始');
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
      const reply = await callClaude(skill.prompt, session.history, userText);
      session.history.push({ role: 'user', content: userText });
      session.history.push({ role: 'assistant', content: reply });

      // 只保留最近 10 輪對話避免太長
      if (session.history.length > 20) {
        session.history = session.history.slice(-20);
      }

      await replyToLine(replyToken, reply);
    } catch (err) {
      console.error(err);
      await replyToLine(replyToken, '抱歉，我剛才沒跟上，可以再說一次嗎？');
    }
  }
});

// 定時推播（時區 UTC+8 台灣時間）
// 早上 9:00 → UTC 01:00
cron.schedule('0 1 * * *', async () => {
  const msg = `☀️ 早安！今天也是美好的一天。

準備好了嗎？傳 2 給我，開始今天的學習打卡。`;
  for (const uid of pushUserIds) {
    await pushToUser(uid, msg);
  }
}, { timezone: 'Asia/Taipei' });

// 晚上 9:30 → 提醒打卡
cron.schedule('30 21 * * *', async () => {
  const msg = `🌙 今天結束前，記得打個卡。

傳 2 給我，花 2 分鐘記錄今天的收穫。`;
  for (const uid of pushUserIds) {
    await pushToUser(uid, msg);
  }
}, { timezone: 'Asia/Taipei' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`推播名單：${[...pushUserIds].join(', ') || '（空）'}`);
});
