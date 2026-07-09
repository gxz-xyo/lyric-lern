const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let token = null;
let userInfo = null;
let isRunning = false;
let questList = [];
let completedQuests = new Set();
let progressMap = {};
let activeJobs = new Map();

const API_BASE = 'https://discord.com/api/v9';

// Helper: Gọi API Discord
async function discordGet(endpoint) {
    try {
        const res = await axios.get(`${API_BASE}${endpoint}`, {
            headers: { Authorization: token }
        });
        return res.data;
    } catch (err) {
        console.error('Discord API Error:', err.response?.status, err.response?.data);
        throw err;
    }
}

async function discordPost(endpoint, body = {}) {
    try {
        const res = await axios.post(`${API_BASE}${endpoint}`, body, {
            headers: { 
                Authorization: token,
                'Content-Type': 'application/json'
            }
        });
        return res.data;
    } catch (err) {
        console.error('Discord API POST Error:', err.response?.status, err.response?.data);
        throw err;
    }
}

// Lấy danh sách quest
async function getQuests() {
    try {
        const data = await discordGet('/quests');
        if (!data || !data.quests) return [];
        
        // Lọc quest đã enroll, chưa complete, còn hạn
        return data.quests.filter(q => 
            q.userStatus?.enrolledAt &&
            !q.userStatus?.completedAt &&
            new Date(q.config.expiresAt).getTime() > Date.now()
        );
    } catch (err) {
        return [];
    }
}

// Enroll quest
async function enrollQuest(questId) {
    try {
        const result = await discordPost(`/quests/${questId}/enroll`, {});
        console.log(`✅ Enrolled quest: ${questId}`);
        return result;
    } catch (err) {
        console.log(`❌ Failed to enroll quest ${questId}:`, err.response?.status);
        return null;
    }
}

// Lấy task info
function getTaskInfo(quest) {
    const taskConfig = quest.config.taskConfig || quest.config.taskConfigV2;
    if (!taskConfig || !taskConfig.tasks) return null;
    
    const supportedTasks = ['WATCH_VIDEO', 'PLAY_ON_DESKTOP', 'STREAM_ON_DESKTOP', 'PLAY_ACTIVITY', 'WATCH_VIDEO_ON_MOBILE'];
    const availableTasks = Object.keys(taskConfig.tasks).filter(t => supportedTasks.includes(t));
    
    if (availableTasks.length === 0) return null;
    
    const taskName = availableTasks[0];
    const secondsNeeded = taskConfig.tasks[taskName]?.target || 0;
    const secondsDone = quest.userStatus?.progress?.[taskName]?.value || 0;
    
    return { taskName, secondsNeeded, secondsDone };
}

// Hoàn thành Video Quest
async function completeVideoQuest(quest, jobId) {
    const info = getTaskInfo(quest);
    if (!info) return;
    
    const { secondsNeeded, secondsDone } = info;
    let current = secondsDone;
    const enrolledAt = new Date(quest.userStatus.enrolledAt).getTime();
    
    while (current < secondsNeeded && activeJobs.has(jobId)) {
        const maxAllowed = Math.floor((Date.now() - enrolledAt) / 1000) + 10;
        const timestamp = Math.min(secondsNeeded, current + 10);
        
        if (maxAllowed >= current) {
            try {
                await discordPost(`/quests/${quest.id}/video-progress`, {
                    timestamp: timestamp + Math.random()
                });
                current = timestamp;
                progressMap[jobId] = { current, total: secondsNeeded };
            } catch (err) {
                if (err.response?.status === 429) {
                    const wait = (err.response.data.retry_after || 5) * 1000;
                    await new Promise(r => setTimeout(r, wait));
                    continue;
                }
                throw err;
            }
        }
        await new Promise(r => setTimeout(r, 3000));
    }
}

// Hoàn thành Game Quest
async function completeGameQuest(quest, jobId) {
    const info = getTaskInfo(quest);
    if (!info) return;
    
    const { secondsNeeded } = info;
    const applicationId = quest.config.application.id;
    let current = 0;
    
    while (current < secondsNeeded && activeJobs.has(jobId)) {
        try {
            const res = await discordPost(`/quests/${quest.id}/heartbeat`, {
                game_id: applicationId,
                terminal: false
            });
            current = res.progress?.PLAY_ON_DESKTOP?.value || current;
            progressMap[jobId] = { current, total: secondsNeeded };
            if (current >= secondsNeeded) break;
            await new Promise(r => setTimeout(r, 15000));
        } catch (err) {
            if (err.response?.status === 429) {
                const wait = (err.response.data.retry_after || 5) * 1000;
                await new Promise(r => setTimeout(r, wait));
                continue;
            }
            throw err;
        }
    }
    
    if (current >= secondsNeeded) {
        await discordPost(`/quests/${quest.id}/heartbeat`, {
            game_id: applicationId,
            terminal: true
        });
    }
}

// Hoàn thành Stream Quest
async function completeStreamQuest(quest, jobId) {
    const info = getTaskInfo(quest);
    if (!info) return;
    
    const { secondsNeeded } = info;
    const streamKey = `call:stream:${quest.id}`;
    let current = 0;
    
    while (current < secondsNeeded && activeJobs.has(jobId)) {
        try {
            const res = await discordPost(`/quests/${quest.id}/heartbeat`, {
                stream_key: streamKey,
                terminal: false
            });
            current = res.progress?.STREAM_ON_DESKTOP?.value || current;
            progressMap[jobId] = { current, total: secondsNeeded };
            if (current >= secondsNeeded) break;
            await new Promise(r => setTimeout(r, 15000));
        } catch (err) {
            if (err.response?.status === 429) {
                const wait = (err.response.data.retry_after || 5) * 1000;
                await new Promise(r => setTimeout(r, wait));
                continue;
            }
            throw err;
        }
    }
    
    if (current >= secondsNeeded) {
        await discordPost(`/quests/${quest.id}/heartbeat`, {
            stream_key: streamKey,
            terminal: true
        });
    }
}

// Chạy quest
async function runQuest(quest) {
    const info = getTaskInfo(quest);
    if (!info) return;
    
    const { taskName } = info;
    const jobId = Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    
    const cancel = () => {
        activeJobs.delete(jobId);
        delete progressMap[jobId];
    };
    
    activeJobs.set(jobId, { questId: quest.id, type: taskName, cancel });
    
    try {
        console.log(`🔄 Starting quest: ${quest.config.messages.questName} (${taskName})`);
        
        if (taskName === 'WATCH_VIDEO' || taskName === 'WATCH_VIDEO_ON_MOBILE') {
            await completeVideoQuest(quest, jobId);
        } else if (taskName === 'PLAY_ON_DESKTOP') {
            await completeGameQuest(quest, jobId);
        } else if (taskName === 'STREAM_ON_DESKTOP') {
            await completeStreamQuest(quest, jobId);
        } else if (taskName === 'PLAY_ACTIVITY') {
            await completeStreamQuest(quest, jobId);
        }
        
        completedQuests.add(quest.id);
        console.log(`✅ Completed quest: ${quest.config.messages.questName}`);
        activeJobs.delete(jobId);
        delete progressMap[jobId];
        
    } catch (err) {
        console.error(`❌ Error on quest ${quest.id}:`, err.message);
        activeJobs.delete(jobId);
        delete progressMap[jobId];
    }
}

// ============= API ROUTES =============

// Login
app.post('/api/login', async (req, res) => {
    const { token: userToken } = req.body;
    if (!userToken) return res.status(400).json({ error: 'Token required' });
    
    token = userToken;
    try {
        const user = await discordGet('/users/@me');
        userInfo = user;
        res.json({ success: true, username: user.username });
    } catch (err) {
        token = null;
        userInfo = null;
        res.status(401).json({ error: 'Invalid token' });
    }
});

// Get quests
app.get('/api/quests', async (req, res) => {
    if (!token) return res.status(401).json({ error: 'Not logged in' });
    
    try {
        const quests = await getQuests();
        const result = quests.map(q => {
            const info = getTaskInfo(q);
            const isCompleted = completedQuests.has(q.id);
            const isRunning = Array.from(activeJobs.values()).some(j => j.questId === q.id);
            
            return {
                id: q.id,
                name: q.config.messages?.questName || 'Unknown Quest',
                task: info?.taskName || 'unknown',
                needed: info?.secondsNeeded || 0,
                done: info?.secondsDone || 0,
                completed: isCompleted,
                running: isRunning,
                enrolled: !!q.userStatus?.enrolledAt,
                expiresAt: q.config.expiresAt
            };
        });
        res.json({ quests: result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Enroll quest
app.post('/api/enroll', async (req, res) => {
    if (!token) return res.status(401).json({ error: 'Not logged in' });
    
    const { questId } = req.body;
    if (!questId) return res.status(400).json({ error: 'Quest ID required' });
    
    try {
        await enrollQuest(questId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start all quests
app.post('/api/start', async (req, res) => {
    if (!token) return res.status(401).json({ error: 'Not logged in' });
    if (isRunning) return res.json({ message: 'Already running' });
    
    isRunning = true;
    res.json({ success: true });
    
    (async () => {
        try {
            // Lấy danh sách quest
            let quests = await getQuests();
            
            // Nếu không có quest nào, thử tự động enroll
            if (quests.length === 0) {
                console.log('📋 No enrolled quests found, checking available quests...');
                const allQuests = await discordGet('/quests');
                if (allQuests?.quests) {
                    const available = allQuests.quests.filter(q => 
                        !q.userStatus?.enrolledAt && 
                        new Date(q.config.expiresAt).getTime() > Date.now()
                    );
                    
                    for (const q of available) {
                        console.log(`📥 Enrolling quest: ${q.config.messages?.questName}`);
                        await enrollQuest(q.id);
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }
                // Refresh danh sách
                quests = await getQuests();
            }
            
            // Lọc quest chưa hoàn thành
            const incomplete = quests.filter(q => 
                !completedQuests.has(q.id) && 
                !Array.from(activeJobs.values()).some(j => j.questId === q.id)
            );
            
            if (incomplete.length === 0) {
                console.log('✅ No quests to complete');
                isRunning = false;
                return;
            }
            
            console.log(`🎯 Starting ${incomplete.length} quests...`);
            
            for (const q of incomplete) {
                if (!isRunning) break;
                if (completedQuests.has(q.id)) continue;
                await runQuest(q);
            }
            
        } catch (err) {
            console.error('Auto complete error:', err);
        } finally {
            isRunning = false;
        }
    })();
});

// Stop all
app.post('/api/stop', (req, res) => {
    isRunning = false;
    for (const [id, job] of activeJobs) {
        job.cancel();
    }
    activeJobs.clear();
    progressMap = {};
    res.json({ success: true });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
