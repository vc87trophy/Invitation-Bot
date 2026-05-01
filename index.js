require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || 'YOUR_CHANNEL_ACCESS_TOKEN',
  channelSecret: process.env.LINE_CHANNEL_SECRET || 'YOUR_CHANNEL_SECRET',
};

const LIFF_ADMIN_URL = process.env.LIFF_ADMIN_URL || 'https://liff.line.me/YOUR_ADMIN_LIFF_ID';
const LIFF_SIGNUP_URL = process.env.LIFF_SIGNUP_URL || 'https://liff.line.me/YOUR_SIGNUP_LIFF_ID';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').filter(Boolean);
// ตัวอย่าง ADMIN_IDS=Uxxxxxxxx,Uyyyyyyyy

// ==========================================
// State: session การจองปัจจุบัน
// ==========================================
let session = null;
// session = {
//   title: string,
//   date: string,
//   location: string,
//   maxPlayers: number,
//   players: [{ userId, displayName, addedBy, timestamp }],
//   isOpen: boolean,
//   createdBy: string,
//   groupId: string,
//   messageId: string, // สำหรับ update flex message
// }

const client = new Client(config);
app.use(express.json());
app.use('/liff', express.static('liff'));

// ==========================================
// API for LIFF
// ==========================================

// GET session info
app.get('/api/session', (req, res) => {
  if (!session) return res.json({ active: false });
  res.json({ active: true, ...session });
});

// POST สร้าง session (Admin)
app.post('/api/session/create', async (req, res) => {
  const { title, date, location, maxPlayers, createdBy, groupId } = req.body;
  if (!title || !maxPlayers) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });

  session = {
    title,
    date: date || '',
    location: location || '',
    maxPlayers: parseInt(maxPlayers),
    players: [],
    isOpen: true,
    createdBy,
    groupId,
  };

  // ส่ง Flex Message เข้ากลุ่ม
  try {
    if (groupId) {
      await client.pushMessage(groupId, buildFlexMessage());
    }
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'ส่งข้อความเข้ากลุ่มไม่ได้: ' + e.message });
  }
});

// POST ลงชื่อ
app.post('/api/signup', (req, res) => {
  if (!session || !session.isOpen) return res.status(400).json({ error: 'ไม่มีการจองที่เปิดอยู่' });

  const { displayName, userId, addedBy } = req.body;
  if (!displayName || displayName.trim() === '') return res.status(400).json({ error: 'กรุณาใส่ชื่อ' });

  const name = displayName.trim();
  const uid = userId || `guest_${Date.now()}`;

  const already = session.players.find(p => p.displayName === name || p.userId === uid);
  if (already) return res.status(409).json({ error: `"${name}" ลงชื่อไว้แล้ว` });

  if (session.players.length >= session.maxPlayers) {
    return res.status(400).json({ error: `เต็มแล้ว! รับได้แค่ ${session.maxPlayers} คน` });
  }

  session.players.push({ userId: uid, displayName: name, addedBy: addedBy || name, timestamp: new Date() });

  const full = session.players.length >= session.maxPlayers;
  if (full) notifyGroupFull();

  res.json({ success: true, position: session.players.length, total: session.maxPlayers, full });
});

// POST ยกเลิก
app.post('/api/cancel', (req, res) => {
  if (!session) return res.status(400).json({ error: 'ไม่มีการจองที่เปิดอยู่' });

  const { displayName, userId } = req.body;
  const index = session.players.findIndex(p =>
    (userId && p.userId === userId) || p.displayName === displayName
  );
  if (index === -1) return res.status(404).json({ error: `ไม่พบ "${displayName}" ในรายชื่อ` });

  const removed = session.players.splice(index, 1)[0];
  res.json({ success: true, removed: removed.displayName });
});

// POST ปิดจอง (Admin)
app.post('/api/session/close', (req, res) => {
  if (!session) return res.status(400).json({ error: 'ไม่มี session' });
  session.isOpen = false;
  if (session.groupId) {
    client.pushMessage(session.groupId, {
      type: 'text',
      text: `🔒 ปิดการจอง "${session.title}" แล้วครับ\nผู้เล่นทั้งหมด ${session.players.length} คน\n` +
        session.players.map((p, i) => `  ${i + 1}. ${p.displayName}`).join('\n')
    }).catch(() => {});
  }
  res.json({ success: true });
});

// POST รีเซ็ต (Admin)
app.post('/api/session/reset', (req, res) => {
  session = null;
  res.json({ success: true });
});

// ==========================================
// LINE Webhook
// ==========================================
app.post('/webhook', middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.status(200).send('OK'))
    .catch(err => { console.error(err); res.status(500).end(); });
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId = event.source.userId;
  const groupId = event.source.groupId || null;
  const text = event.message.text.trim();
  const replyToken = event.replyToken;

  const isAdmin = ADMIN_IDS.length === 0 || ADMIN_IDS.includes(userId);

  if (text === 'เปิดจอง') {
    if (!isAdmin) {
      return client.replyMessage(replyToken, { type: 'text', text: '⛔ เฉพาะ Admin เท่านั้นที่เปิดจองได้ครับ' });
    }
    // ส่งลิงก์ LIFF Admin พร้อม groupId
    const url = `${LIFF_ADMIN_URL}?groupId=${groupId || ''}`;
    return client.replyMessage(replyToken, {
      type: 'flex',
      altText: '🏸 เปิดหน้าตั้งค่าการจอง',
      contents: {
        type: 'bubble',
        body: {
          type: 'box', layout: 'vertical', contents: [
            { type: 'text', text: '🏸 เปิดการจองแบดมินตัน', weight: 'bold', size: 'lg' },
            { type: 'text', text: 'กดปุ่มด้านล่างเพื่อตั้งค่ารายละเอียดและเปิดรับสมัคร', size: 'sm', color: '#888', wrap: true, margin: 'sm' },
          ]
        },
        footer: {
          type: 'box', layout: 'vertical', contents: [
            {
              type: 'button', style: 'primary', color: '#27ae60',
              action: { type: 'uri', label: '⚙️ ตั้งค่าและเปิดจอง', uri: url }
            }
          ]
        }
      }
    });
  }

  if (text === 'รายชื่อ' || text === 'list') {
    return client.replyMessage(replyToken, { type: 'text', text: buildListText() });
  }

  if (text === 'ลงชื่อ') {
    if (!session || !session.isOpen) {
      return client.replyMessage(replyToken, { type: 'text', text: '❌ ยังไม่มีการจองที่เปิดอยู่ครับ' });
    }
    // ดึงชื่อจาก Line Profile
    let displayName = 'ไม่ทราบชื่อ';
    try {
      const profile = groupId
        ? await client.getGroupMemberProfile(groupId, userId)
        : await client.getProfile(userId);
      displayName = profile.displayName;
    } catch (e) {}

    const already = session.players.find(p => p.userId === userId);
    if (already) return client.replyMessage(replyToken, { type: 'text', text: `❌ ${displayName} ลงชื่อไว้แล้วครับ` });
    if (session.players.length >= session.maxPlayers) return client.replyMessage(replyToken, { type: 'text', text: `⛔ เต็มแล้วครับ!` });

    session.players.push({ userId, displayName, addedBy: displayName, timestamp: new Date() });
    const pos = session.players.length;
    let msg = `✅ ${displayName} ลงชื่อสำเร็จ! (${pos}/${session.maxPlayers})`;
    if (pos >= session.maxPlayers) { msg += `\n🎉 ครบแล้ว!`; notifyGroupFull(); }
    return client.replyMessage(replyToken, { type: 'text', text: msg });
  }

  if (text === 'ยกเลิก') {
    if (!session) return client.replyMessage(replyToken, { type: 'text', text: '❌ ไม่มีการจองที่เปิดอยู่ครับ' });
    let displayName = '';
    try {
      const profile = groupId
        ? await client.getGroupMemberProfile(groupId, userId)
        : await client.getProfile(userId);
      displayName = profile.displayName;
    } catch (e) {}
    const index = session.players.findIndex(p => p.userId === userId);
    if (index === -1) return client.replyMessage(replyToken, { type: 'text', text: `❌ ไม่พบชื่อของคุณในรายชื่อครับ` });
    session.players.splice(index, 1);
    return client.replyMessage(replyToken, { type: 'text', text: `🚫 ${displayName} ยกเลิกแล้วครับ (${session.players.length}/${session.maxPlayers})` });
  }
}

// ==========================================
// Flex Message
// ==========================================
function buildFlexMessage() {
  if (!session) return { type: 'text', text: 'ยังไม่มีการจอง' };
  const { title, date, location, maxPlayers, players, isOpen } = session;
  const count = players.length;
  const isFull = count >= maxPlayers;
  const statusColor = !isOpen ? '#888888' : isFull ? '#e74c3c' : '#27ae60';
  const statusText = !isOpen ? '🔒 ปิดแล้ว' : isFull ? '⛔ เต็มแล้ว' : `🟢 เปิดรับ`;

  const previewPlayers = players.slice(0, 6).map((p, i) => ({
    type: 'text',
    text: `${i + 1}. ${p.displayName}`,
    size: 'sm', color: '#444444',
  }));

  if (players.length > 6) {
    previewPlayers.push({ type: 'text', text: `... และอีก ${players.length - 6} คน`, size: 'sm', color: '#888' });
  }

  return {
    type: 'flex',
    altText: `🏸 ${title} (${count}/${maxPlayers})`,
    contents: {
      type: 'bubble', size: 'mega',
      header: {
        type: 'box', layout: 'vertical',
        backgroundColor: statusColor,
        paddingAll: '20px',
        contents: [
          { type: 'text', text: '🏸 ' + title, weight: 'bold', size: 'xl', color: '#ffffff' },
          ...(date ? [{ type: 'text', text: '📅 ' + date, size: 'sm', color: '#ffffff99', margin: 'xs' }] : []),
          ...(location ? [{ type: 'text', text: '📍 ' + location, size: 'sm', color: '#ffffff99', margin: 'xs' }] : []),
          { type: 'text', text: statusText, size: 'sm', color: '#ffffffcc', margin: 'sm' },
        ]
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '20px',
        contents: [
          {
            type: 'box', layout: 'horizontal', marginBottom: '16px',
            contents: [
              { type: 'text', text: 'ผู้เล่น', size: 'sm', color: '#888', flex: 1 },
              { type: 'text', text: `${count} / ${maxPlayers}`, size: 'xxl', weight: 'bold', color: statusColor, align: 'end', flex: 1 },
            ]
          },
          { type: 'separator' },
          ...(players.length === 0
            ? [{ type: 'text', text: 'ยังไม่มีใครลงชื่อ', size: 'sm', color: '#888', margin: 'md' }]
            : previewPlayers.map(p => ({ ...p, margin: 'sm' }))),
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px',
        contents: isOpen ? [
          {
            type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [
              { type: 'button', style: 'primary', color: '#27ae60', flex: 1, action: { type: 'message', label: '✅ ลงชื่อ', text: 'ลงชื่อ' } },
              { type: 'button', style: 'secondary', flex: 1, action: { type: 'message', label: '❌ ยกเลิก', text: 'ยกเลิก' } },
            ]
          },
          { type: 'button', style: 'secondary', action: { type: 'message', label: '📋 ดูรายชื่อ', text: 'รายชื่อ' } },
          { type: 'button', style: 'link', action: { type: 'uri', label: '➕ เพิ่มชื่อ / คนนอกกลุ่ม', uri: LIFF_SIGNUP_URL } },
        ] : [
          { type: 'text', text: '🔒 ปิดการจองแล้ว', align: 'center', color: '#888', size: 'sm' }
        ]
      }
    }
  };
}

function buildListText() {
  if (!session) return '❌ ยังไม่มีการจองที่เปิดอยู่ครับ';
  const { title, players, maxPlayers } = session;
  if (players.length === 0) return `📋 "${title}"\nยังไม่มีใครลงชื่อครับ`;
  return `🏸 "${title}" (${players.length}/${maxPlayers})\n` +
    players.map((p, i) => `  ${i + 1}. ${p.displayName}`).join('\n');
}

async function notifyGroupFull() {
  if (!session?.groupId) return;
  try {
    await client.pushMessage(session.groupId, {
      type: 'text',
      text: `🎉 "${session.title}" ครบ ${session.maxPlayers} คนแล้ว!\n` +
        session.players.map((p, i) => `  ${i + 1}. ${p.displayName}`).join('\n')
    });
  } catch (e) {}
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🏸 Badminton Bot v3 running on port ${PORT}`));
