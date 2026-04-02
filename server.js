const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_BASE = 'https://jntuhresults.dhethi.com';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// ── In-Memory Cache ──────────────────────────────────────────────

const cache = new Map();

function getCached(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL) {
        cache.delete(key);
        return null;
    }
    return entry.data;
}

function setCache(key, data) {
    cache.set(key, { data, ts: Date.now() });
}

// Cleanup expired entries every hour
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
        if (now - entry.ts > CACHE_TTL) cache.delete(key);
    }
}, 60 * 60 * 1000);

// ── Generic Proxy Fetch ──────────────────────────────────────────

async function proxyFetch(apiPath, queryParams = {}) {
    const url = new URL(apiPath, API_BASE);
    for (const [k, v] of Object.entries(queryParams)) {
        if (v !== undefined && v !== null && v !== '') {
            url.searchParams.set(k, v);
        }
    }

    const cacheKey = url.pathname + url.search;

    // Check cache first
    const cached = getCached(cacheKey);
    if (cached) return { data: cached, fromCache: true };

    // Fetch from upstream with 15s timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
        const resp = await fetch(url.toString(), {
            signal: controller.signal,
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'PEC-BacklogReport/1.0'
            }
        });
        clearTimeout(timeoutId);

        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`Upstream ${resp.status}: ${text.substring(0, 200)}`);
        }

        const data = await resp.json();
        // Don't cache queued/pending responses — they have no real data yet
        if (!data?.message?.toLowerCase().includes('queued')) {
            setCache(cacheKey, data);
        }
        return { data, fromCache: false };
    } catch (err) {
        clearTimeout(timeoutId);
        throw err;
    }
}

// ── Middleware ────────────────────────────────────────────────────

app.use(express.json({ limit: '1mb' }));

// CORS headers (for development flexibility)
app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// Serve static files (Student_Analysis.html, etc.)
app.use(express.static(path.join(__dirname)));

// ── Proxy Routes ─────────────────────────────────────────────────

// 1. GET /api/getAcademicResult?rollNumber=XXX
app.get('/api/getAcademicResult', async (req, res) => {
    try {
        const { data, fromCache } = await proxyFetch('/api/getAcademicResult', {
            rollNumber: req.query.rollNumber
        });
        res.set('X-Cache', fromCache ? 'HIT' : 'MISS');
        res.json(data);
    } catch (err) {
        handleProxyError(res, err);
    }
});

// 2. GET /api/getClassResults?rollNumber=XXX&type=academicresult
app.get('/api/getClassResults', async (req, res) => {
    try {
        const { data, fromCache } = await proxyFetch('/api/getClassResults', {
            rollNumber: req.query.rollNumber,
            type: req.query.type
        });
        res.set('X-Cache', fromCache ? 'HIT' : 'MISS');
        res.json(data);
    } catch (err) {
        handleProxyError(res, err);
    }
});

// 3-5. Other endpoints (getAllResult, getBacklogs, notifications)
for (const endpoint of ['/api/getAllResult', '/api/getBacklogs', '/api/notifications']) {
    app.get(endpoint, async (req, res) => {
        try {
            const { data, fromCache } = await proxyFetch(endpoint, req.query);
            res.set('X-Cache', fromCache ? 'HIT' : 'MISS');
            res.json(data);
        } catch (err) {
            handleProxyError(res, err);
        }
    });
}

// ── Batch Endpoint (NEW) ─────────────────────────────────────────

// POST /api/batch
// Body: { rollNumbers: ["226F1A0501", "226F1A0502", ...] }
app.post('/api/batch', async (req, res) => {
    const { rollNumbers } = req.body;

    if (!Array.isArray(rollNumbers) || rollNumbers.length === 0) {
        return res.status(400).json({ error: 'rollNumbers must be a non-empty array' });
    }
    if (rollNumbers.length > 500) {
        return res.status(400).json({ error: 'Maximum 500 roll numbers per batch' });
    }

    const CONCURRENCY = 20;
    const results = {};
    let idx = 0;

    async function worker() {
        while (idx < rollNumbers.length) {
            const i = idx++;
            if (i >= rollNumbers.length) break;
            const roll = rollNumbers[i];
            try {
                const { data } = await proxyFetch('/api/getAcademicResult', {
                    rollNumber: roll
                });
                results[roll] = { success: true, data };
            } catch (err) {
                results[roll] = { success: false, error: err.message };
            }
        }
    }

    const workers = Array.from(
        { length: Math.min(CONCURRENCY, rollNumbers.length) },
        () => worker()
    );
    await Promise.all(workers);

    res.json({
        total: rollNumbers.length,
        fetched: Object.values(results).filter(r => r.success).length,
        results
    });
});

// ── Cache Stats (debugging) ──────────────────────────────────────

app.get('/api/cache-stats', (req, res) => {
    let totalSize = 0;
    for (const [, entry] of cache) {
        totalSize += JSON.stringify(entry.data).length;
    }
    res.json({
        entries: cache.size,
        memoryEstimateMB: (totalSize / 1024 / 1024).toFixed(2),
        ttlHours: CACHE_TTL / (60 * 60 * 1000)
    });
});

// Clear cache endpoint
app.post('/api/cache-clear', (req, res) => {
    const count = cache.size;
    cache.clear();
    res.json({ cleared: count });
});

// ── Error Handler ────────────────────────────────────────────────

function handleProxyError(res, err) {
    if (err.name === 'AbortError') {
        return res.status(504).json({ error: 'Upstream timeout (15s)' });
    }
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: 'Failed to fetch from upstream', detail: err.message });
}

// ── Fallback: Serve HTML for unmatched routes ────────────────────

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'Student_Analysis.html'));
});

// ── Start Server ─────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`\n  PEC Student Analysis server running at:`);
    console.log(`  → http://localhost:${PORT}\n`);
});
