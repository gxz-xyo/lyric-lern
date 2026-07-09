const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Lưu trạng thái
let token = null;
let activeJobs = new Map(); // jobId -> { questId, type, cancel }
let jobIdCounter = 0;
let completedQuests = new Set();
let progressMap = {}; // jobId -> { current, total }
let isRunning = false;

// WebSocket server cho real-time update
const wss = new WebSocket.Server({ noServer: true });
const clients = new Set();

function broadcast(data) {
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// ------------------- Discord API helpers -------------------
const API_BASE = 'https://discord.com/api/v9';

async function discordGet(endpoint) {
  const res = await axios.get(`${API_BASE}${endpoint}`, {
    headers: { Authorization: token }
  });
  return res.data;
}

async function discordPost(endpoint, body) {
  const res = await axios.post(`${API_BASE}${endpoint}`, body, {
    headers: { Authorization: token, 'Content-Type': 'application/json' }
  });
  return res.data;
}

// ------------------- Lấy danh sách quest -------------------
async function getQuests() {
  const data = await discordGet('/quests');
  // Lọc quest đã enroll, chưa complete, còn hạn
  const quests = data.quests.filter(q =>
    q.userStatus?.enrolledAt &&
    !q.userStatus?.completedAt &&
    new Date(q.config.expiresAt).getTime() > Date.now()
  );
  return quests;
}

function getSupportedTasks(quest) {
  const taskConfig = quest.config.taskConfig ?? quest.config.taskConfigV2;
  const supported = ['WATCH_VIDEO', 'PLAY_ON_DESKTOP', 'STREAM_ON_DESKTOP', 'PLAY_ACTIVITY', 'WATCH_VIDEO_ON_MOBILE'];
  const tasks = Object.keys(taskConfig.tasks).filter(t => supported.includes(t));
  return tasks;
}

function getTaskInfo(quest) {
  const taskConfig = quest.config.taskConfig ?? quest.config.taskConfigV2;
  const tasks = getSupportedTasks(quest);
  if (tasks.length === 0) return null;
  const taskName = tasks[0];
  const secondsNeeded = taskConfig.tasks[taskName].target;
  const secondsDone = quest.userStatus?.progress?.[taskName]?.value || 0;
  return { taskName, secondsNeeded, secondsDone };
}

// ------------------- Các hàm hoàn thành từng loại quest -------------------
async function completeVideoQuest(quest, jobId) {
  const { secondsNeeded, secondsDone } = getTaskInfo(quest);
  let current = secondsDone;
  const maxFuture = 10;
  const speed = 7;
  const enrolledAt = new Date(quest.userStatus.enrolledAt).getTime();

  while (current < secondsNeeded && activeJobs.has(jobId)) {
    const maxAllowed = Math.floor((Date.now() - enrolledAt) / 1000) + maxFuture;
    const diff = maxAllowed - current;
    const timestamp = current + speed;

    if (diff >= speed) {
      try {
        const res = await discordPost(`/quests/${quest.id}/video-progress`, {
          timestamp: Math.min(secondsNeeded, timestamp + Math.random())
        });
        if (res.completed_at) break;
        current = Math.min(secondsNeeded, timestamp);
        progressMap[jobId] = { current, total: secondsNeeded };
        broadcast({ type: 'progress', jobId, questId: quest.id, current, total: secondsNeeded });
      } catch (e) {
        if (e.response?.status === 429) {
          const wait = e.response.data.retry_after * 1000 || 5000;
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw e;
      }
    } else {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Đảm bảo đạt target
  if (current < secondsNeeded) {
    await discordPost(`/quests/${quest.id}/video-progress`, { timestamp: secondsNeeded });
  }
}

async function completeGameQuest(quest, jobId) {
  const applicationId = quest.config.application.id;
  const { secondsNeeded } = getTaskInfo(quest);
  let current = 0;

  // Gửi heartbeat với game_id
  while (current < secondsNeeded && activeJobs.has(jobId)) {
    try {
      const res = await discordPost(`/quests/${quest.id}/heartbeat`, {
        game_id: applicationId,
        terminal: false
      });
      const progress = res.progress?.PLAY_ON_DESKTOP?.value || 0;
      current = Math.min(secondsNeeded, progress);
      progressMap[jobId] = { current, total: secondsNeeded };
      broadcast({ type: 'progress', jobId, questId: quest.id, current, total: secondsNeeded });
      if (current >= secondsNeeded) break;
      await new Promise(r => setTimeout(r, 20000)); // 20s interval
    } catch (e) {
      if (e.response?.status === 429) {
        const wait = e.response.data.retry_after * 1000 || 5000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }

  // Gửi terminal true để kết thúc
  await discordPost(`/quests/${quest.id}/heartbeat`, {
    game_id: applicationId,
    terminal: true
  });
}

async function completeStreamQuest(quest, jobId) {
  // Lấy một voice channel bất kỳ (có thể từ guild hoặc DM)
  // Ở đây lấy channel đầu tiên có thể join
  let channelId = null;
  try {
    const guilds = await discordGet('/users/@me/guilds');
    for (const g of guilds) {
      const channels = await discordGet(`/guilds/${g.id}/channels`);
      const vc = channels.find(c => c.type === 2); // voice
      if (vc) { channelId = vc.id; break; }
    }
  } catch (e) {}
  if (!channelId) {
    // fallback: dùng DM call channel? khó, bỏ qua
    throw new Error('No voice channel found');
  }

  const streamKey = `call:${channelId}:1`;
  const { secondsNeeded } = getTaskInfo(quest);
  let current = 0;

  while (current < secondsNeeded && activeJobs.has(jobId)) {
    try {
      const res = await discordPost(`/quests/${quest.id}/heartbeat`, {
        stream_key: streamKey,
        terminal: false
      });
      const progress = res.progress?.STREAM_ON_DESKTOP?.value || 0;
      current = Math.min(secondsNeeded, progress);
      progressMap[jobId] = { current, total: secondsNeeded };
      broadcast({ type: 'progress', jobId, questId: quest.id, current, total: secondsNeeded });
      if (current >= secondsNeeded) break;
      await new Promise(r => setTimeout(r, 20000));
    } catch (e) {
      if (e.response?.status === 429) {
        const wait = e.response.data.retry_after * 1000 || 5000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }

  await discordPost(`/quests/${quest.id}/heartbeat`, {
    stream_key: streamKey,
    terminal: true
  });
}

async function completeActivityQuest(quest, jobId) {
  // Tương tự stream, dùng stream_key call
  let channelId = null;
  try {
    // Lấy DM channel đầu tiên
    const dms = await discordGet('/users/@me/channels');
    if (dms.length > 0) channelId = dms[0].id;
  } catch (e) {}
  if (!channelId) {
    // fallback guild voice
    const guilds = await discordGet('/users/@me/guilds');
    for (const g of guilds) {
      const channels = await discordGet(`/guilds/${g.id}/channels`);
      const vc = channels.find(c => c.type === 2);
      if (vc) { channelId = vc.id; break; }
    }
  }
  if (!channelId) throw new Error('No channel for activity');

  const streamKey = `call:${channelId}:1`;
  const { secondsNeeded } = getTaskInfo(quest);
  let current = 0;

  while (current < secondsNeeded && activeJobs.has(jobId)) {
    try {
      const res = await discordPost(`/quests/${quest.id}/heartbeat`, {
        stream_key: streamKey,
        terminal: false
      });
      const progress = res.progress?.PLAY_ACTIVITY?.value || 0;
      current = Math.min(secondsNeeded, progress);
      progressMap[jobId] = { current, total: secondsNeeded };
      broadcast({ type: 'progress', jobId, questId: quest.id, current, total: secondsNeeded });
      if (current >= secondsNeeded) break;
      await new Promise(r => setTimeout(r, 20000));
    } catch (e) {
      if (e.response?.status === 429) {
        const wait = e.response.data.retry_after * 1000 || 5000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }

  await discordPost(`/quests/${quest.id}/heartbeat`, {
    stream_key: streamKey,
    terminal: true
  });
}

// ------------------- Hàm chạy một quest -------------------
async function runQuest(quest) {
  const taskInfo = getTaskInfo(quest);
  if (!taskInfo) return;
  const { taskName } = taskInfo;
  const jobId = ++jobIdCounter;
  const cancel = () => {
    activeJobs.delete(jobId);
    delete progressMap[jobId];
  };
  activeJobs.set(jobId, { questId: quest.id, type: taskName, cancel });

  try {
    if (taskName === 'WATCH_VIDEO' || taskName === 'WATCH_VIDEO_ON_MOBILE') {
      await completeVideoQuest(quest, jobId);
    } else if (taskName === 'PLAY_ON_DESKTOP') {
      await completeGameQuest(quest, jobId);
    } else if (taskName === 'STREAM_ON_DESKTOP') {
      await completeStreamQuest(quest, jobId);
    } else if (taskName === 'PLAY_ACTIVITY') {
      await completeActivityQuest(quest, jobId);
    } else {
      throw new Error(`Unsupported task: ${taskName}`);
    }
    // Đánh dấu hoàn thành
    completedQuests.add(quest.id);
    broadcast({ type: 'completed', questId: quest.id });
    activeJobs.delete(jobId);
    delete progressMap[jobId];
  } catch (err) {
    console.error(`Error on quest ${quest.id}:`, err.message);
    activeJobs.delete(jobId);
    delete progressMap[jobId];
    broadcast({ type: 'error', questId: quest.id, error: err.message });
  }
}

// ------------------- API Endpoints -------------------
app.post('/api/login', async (req, res) => {
  const { token: userToken } = req.body;
  if (!userToken) return res.status(400).json({ error: 'Token required' });
  token = userToken;
  try {
    const user = await discordGet('/users/@me');
    res.json({ success: true, username: user.username });
  } catch (err) {
    token = null;
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.get('/api/quests', async (req, res) => {
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const quests = await getQuests();
    const result = quests.map(q => {
      const info = getTaskInfo(q);
      return {
        id: q.id,
        name: q.config.messages.questName,
        task: info?.taskName || 'unknown',
        needed: info?.secondsNeeded || 0,
        done: info?.secondsDone || 0,
        completed: completedQuests.has(q.id),
        running: Array.from(activeJobs.values()).some(j => j.questId === q.id)
      };
    });
    res.json({ quests: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/start', async (req, res) => {
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  if (isRunning) return res.json({ message: 'Already running' });
  isRunning = true;
  res.json({ success: true });

  // Bắt đầu chạy tất cả quest chưa hoàn thành
  (async () => {
    try {
      let quests = await getQuests();
      // Lọc quest chưa hoàn thành và chưa đang chạy
      let incomplete = quests.filter(q => !completedQuests.has(q.id) && !Array.from(activeJobs.values()).some(j => j.questId === q.id));
      while (incomplete.length > 0 && isRunning) {
        for (const q of incomplete) {
          if (!isRunning) break;
          if (completedQuests.has(q.id)) continue;
          await runQuest(q);
        }
        // Refresh danh sách quest
        quests = await getQuests();
        incomplete = quests.filter(q => !completedQuests.has(q.id) && !Array.from(activeJobs.values()).some(j => j.questId === q.id));
      }
    } catch (err) {
      console.error('Auto complete error:', err);
    } finally {
      isRunning = false;
      broadcast({ type: 'done' });
    }
  })();
});

app.post('/api/stop', (req, res) => {
  isRunning = false;
  // Hủy tất cả job đang chạy
  for (const [id, job] of activeJobs) {
    job.cancel();
  }
  activeJobs.clear();
  progressMap = {};
  res.json({ success: true });
});

// ------------------- WebSocket upgrade -------------------
const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
  });
});
