const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let browser = null;
let page = null;
let isRunning = false;
let taskLogs = [];

// Script cũ (bạn có thể paste toàn bộ code cũ vào đây)
const DISCORD_SCRIPT = `
// Paste code cũ của bạn vào đây (function() { ... })();
// Vì dài quá, tôi sẽ viết ngắn gọn, nhưng bạn có thể copy nguyên bản
(function() {
    'use strict';
    console.log('✅ Auto Quest script loaded!');
    // ... toàn bộ code cũ của bạn ...
})();
`;

// API: Login và chạy script
app.post('/api/run', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    if (isRunning) return res.json({ message: 'Already running' });

    isRunning = true;
    taskLogs = [];

    try {
        // Khởi tạo browser
        if (!browser) {
            browser = await puppeteer.launch({
                headless: 'new', // Chạy ẩn, không hiện cửa sổ
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
        }

        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });

        // Inject token vào localStorage và vào Discord
        await page.goto('https://discord.com/login');
        
        // Chờ trang load
        await page.waitForSelector('input[name="email"]', { timeout: 10000 });

        // Inject token qua localStorage (cách nhanh để login)
        await page.evaluate((t) => {
            localStorage.setItem('token', t);
            location.reload();
        }, token);

        // Chờ sau khi reload, Discord sẽ tự động đăng nhập
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

        // Kiểm tra đăng nhập thành công
        const loggedIn = await page.evaluate(() => {
            return !!document.querySelector('[aria-label="Servers"]');
        });

        if (!loggedIn) {
            throw new Error('Login failed');
        }

        // Mở console và chạy script
        await page.evaluate((script) => {
            // Tạo một thẻ script để inject code
            const scriptTag = document.createElement('script');
            scriptTag.textContent = script;
            document.head.appendChild(scriptTag);
        }, DISCORD_SCRIPT);

        // Đợi script chạy (có thể cần thời gian)
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Lấy log từ console
        const logs = await page.evaluate(() => {
            return window._questLogs || [];
        });

        taskLogs = logs;

        res.json({ success: true, message: 'Script started' });

        // Cứ mỗi 10s lấy log cập nhật
        const interval = setInterval(async () => {
            if (!page) return;
            const newLogs = await page.evaluate(() => window._questLogs || []);
            taskLogs = newLogs;
            if (newLogs.some(l => l.includes('✅ Completed'))) {
                clearInterval(interval);
                isRunning = false;
            }
        }, 10000);

    } catch (err) {
        isRunning = false;
        res.status(500).json({ error: err.message });
    }
});

// API: Lấy trạng thái
app.get('/api/status', (req, res) => {
    res.json({ running: isRunning, logs: taskLogs });
});

// API: Dừng
app.post('/api/stop', async (req, res) => {
    isRunning = false;
    if (page) {
        await page.close();
        page = null;
    }
    if (browser) {
        await browser.close();
        browser = null;
    }
    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
