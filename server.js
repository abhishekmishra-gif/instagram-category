require("dotenv").config();
const express = require("express");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");
const { processInfluencer } = require("./src/jobs/batchJob");

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME;
const INFLUENCER_COLLECTION = process.env.INFLUENCER_COLLECTION;
const POSTS_COLLECTION = process.env.POSTS_COLLECTION;

let mongoClient;
let db;

// Batch state
let batchState = {
    running: false,
    processed: 0,
    success: 0,
    failed: 0,
    total: 0,
    limit: 0,
    currentInfluencer: null,
    results: [],
    sseClients: [],
    stopRequested: false,
};

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Redirect root to dashboard
app.get("/", (req, res) => {
    res.redirect("/index.html");
});

// Helper to get formatted avatar URL
function getAvatarUrl(inf) {
    let avatarUrl = inf.instagram?.profile_pic_url || "";
    const handle = inf.instagram?.handle;

    // Fallback pattern if URL is missing but handle exists
    if (!avatarUrl && handle) {
        avatarUrl = `https://media.icubeswire.co/instagram_profile/${handle}.jpg`;
    }

    if (avatarUrl.includes("unified-backend-prod-data.s3.ap-south-1.amazonaws.com")) {
        avatarUrl = avatarUrl.replace("unified-backend-prod-data.s3.ap-south-1.amazonaws.com", "media.icubeswire.co");
    } else if (avatarUrl.startsWith("https://") && !avatarUrl.includes("media.icubeswire.co")) {
        avatarUrl = avatarUrl.replace(/https:\/\/[^\/]+/, "https://media.icubeswire.co");
    }

    return avatarUrl;
}

// Connect to MongoDB
async function connectDB() {
    mongoClient = new MongoClient(MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
    });
    await mongoClient.connect();
    db = mongoClient.db(DB_NAME);
    console.log("✅ Connected to MongoDB");
    initBatchManager(db);

    // Load cached IDs of influencers that have posts (non-blocking)
    refreshIdsWithPosts();
    refreshProcessedIds();
    setInterval(refreshIdsWithPosts, 60000);
    setInterval(refreshProcessedIds, 60000);

    // Initial stats computation (runs after caches are ready)
    setTimeout(refreshStats, 5000);
    setInterval(refreshStats, 60000);
}

// Cached set of influencer IDs that have posts in instagram_post_reports
let cachedIdsWithPosts = new Set();

async function refreshIdsWithPosts() {
    try {
        const cursor = db.collection(POSTS_COLLECTION).aggregate([
            { $group: { _id: "$influencer_id" } },
            { $project: { _id: 1 } }
        ], { allowDiskUse: true });

        const newSet = new Set();
        for await (const doc of cursor) {
            newSet.add(doc._id);
        }
        cachedIdsWithPosts = newSet;
    } catch (e) {
        console.error("Failed to refresh IDs with posts:", e.message);
    }
}

// Cached set of influencer IDs that have been batched (from openai_batch_jobs)
let cachedProcessedIds = new Set();

async function refreshProcessedIds() {
    try {
        const jobs = await db.collection("openai_batch_jobs")
            .find({}).project({ influencer_ids: 1 }).toArray();
        const newSet = new Set();
        for (const job of jobs) {
            (job.influencer_ids || []).forEach(id => newSet.add(id));
        }
        cachedProcessedIds = newSet;
    } catch (e) {
        console.error("Failed to refresh processed IDs:", e.message);
    }
}

// Helper: chunked countDocuments to avoid exceeding 16MB BSON limit on $in
async function chunkedCount(collection, baseQuery, ids, idField = '_id', chunkSize = 50000) {
    if (ids.length === 0) return 0;
    let total = 0;
    for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const query = { ...baseQuery, [idField]: { $in: chunk } };
        total += await collection.countDocuments(query);
    }
    return total;
}

// ── Background-cached stats (computed every 60s, served instantly) ──
let cachedStats = { total: 0, processed: 0, withCategory: 0, noCategory: 0, pending: 0, totalCost: 0 };
let statsReady = false;

async function refreshStats() {
    try {
        const eligibilityFilter = {
            "instagram.follower_count_actual": { $gte: 1000 },
            "instagram.media_count": { $gte: 10 },
            "instagram.is_private": false,
        };

        const total = await db.collection(INFLUENCER_COLLECTION).countDocuments(eligibilityFilter);

        // Processed = eligible influencers that are in any batch job
        const processedObjectIds = [...cachedProcessedIds]
            .filter(id => typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id))
            .map(id => new ObjectId(id));

        const processed = await chunkedCount(
            db.collection(INFLUENCER_COLLECTION),
            eligibilityFilter,
            processedObjectIds
        );

        const withCategory = await chunkedCount(
            db.collection(INFLUENCER_COLLECTION),
            { ...eligibilityFilter, "primary_category": { $exists: true } },
            processedObjectIds
        );

        const noCategory = processed - withCategory;
        const pending = total - processed;

        const costResult = await db.collection("openai_batch_jobs").aggregate([
            { $match: { status: "completed" } },
            { $group: { _id: null, total: { $sum: "$cost" } } }
        ]).toArray();
        const totalCost = costResult.length > 0 ? costResult[0].total : 0;

        cachedStats = { total, processed, withCategory, noCategory, pending, totalCost };
        statsReady = true;
        console.log(`📊 Stats refreshed: total=${total}, processed=${processed}, pending=${pending}`);
    } catch (e) {
        console.error("Failed to refresh stats:", e.message);
    }
}

// SSE broadcast
function broadcast(data) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    batchState.sseClients.forEach((res) => res.write(msg));
}

// API: Get stats (served instantly from background cache)
app.get("/api/stats", (req, res) => {
    res.json({ ...cachedStats, running: batchState.running, ready: statsReady });
});

// API: Get influencers (paginated + search + filter)
app.get("/api/influencers", async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = req.query.search || "";
    const filter = req.query.filter || "all";
    const skip = (page - 1) * limit;

    let query = {};

    // Search
    if (search) {
        query.$or = [
            { fullname: { $regex: search, $options: "i" } },
            { "instagram.handle": { $regex: search, $options: "i" } },
        ];
    }

    // Filter
    if (filter === "processed") {
        const processedObjectIds = [...cachedProcessedIds]
            .filter(id => typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id))
            .map(id => new ObjectId(id));
        query["_id"] = { $in: processedObjectIds };
    } else if (filter === "pending") {
        const processedObjectIds = [...cachedProcessedIds]
            .filter(id => typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id))
            .map(id => new ObjectId(id));
        query["_id"] = { $nin: processedObjectIds };
    } else if (filter === "withCategory") {
        query["primary_category"] = { $ne: null };
    } else if (filter === "noCategory") {
        query["primary_category"] = null;
    }

    const [influencers, total] = await Promise.all([
        db.collection(INFLUENCER_COLLECTION)
            .find(query, {
                projection: {
                    fullname: 1,
                    "instagram.handle": 1,
                    "instagram.follower_count": 1,
                    "instagram.influencer_type": 1,
                    "instagram.profile_pic_url": 1,
                    instagram: 1,
                },
            })
            .skip(skip)
            .limit(limit)
            .toArray(),
        db.collection(INFLUENCER_COLLECTION).countDocuments(query),
    ]);
    const data = influencers.map((inf) => {
        return {
            _id: inf._id.toString(),
            name: inf.fullname || inf.instagram?.handle || "",
            handle: inf.instagram?.handle || "",
            avatar: getAvatarUrl(inf),
            followers: inf.instagram?.follower_count || 0,
            type: inf.instagram?.influencer_type?.type || "",
            dbCategories: (inf.categories || []).join(", "),
            category: inf.primary_category || null,
            subCategories: inf.secondary_categories || [],
            status: cachedProcessedIds.has(inf._id.toString()) ? (inf.primary_category ? "categorized" : "no_category") : "pending",
        };
    });

    res.json({ data, total, page, pages: Math.ceil(total / limit) });
});

// API: SSE stream for live updates
app.get("/api/process/status", (req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });

    batchState.sseClients.push(res);

    // Heartbeat every 30s to detect dead connections
    const heartbeat = setInterval(() => {
        try {
            res.write(":heartbeat\n\n");
        } catch (e) {
            // Connection is dead — clean up
            clearInterval(heartbeat);
            batchState.sseClients = batchState.sseClients.filter((c) => c !== res);
        }
    }, 30000);

    req.on("close", () => {
        clearInterval(heartbeat);
        batchState.sseClients = batchState.sseClients.filter((c) => c !== res);
    });

    // Send current state
    res.write(`data: ${JSON.stringify({ type: "state", running: batchState.running, processed: batchState.processed, success: batchState.success, failed: batchState.failed, total: batchState.total, limit: batchState.limit })}\n\n`);
});

// API: Start batch processing
app.post("/api/process/start", async (req, res) => {
    if (batchState.running) {
        return res.status(400).json({ error: "Batch already running" });
    }

    const docLimit = parseInt(req.body.limit) || 0; // 0 = all
    const batchSize = parseInt(req.body.batchSize) || 10;

    batchState = {
        ...batchState,
        running: true,
        processed: 0,
        success: 0,
        failed: 0,
        total: 0,
        limit: docLimit,
        results: [],
        stopRequested: false,
    };

    res.json({ message: "Batch started", limit: docLimit });

    // Run batch in background
    runBatch(docLimit, batchSize).catch(console.error);
});

// API: Stop batch
app.post("/api/process/stop", (req, res) => {
    if (!batchState.running) {
        return res.status(400).json({ error: "No batch running" });
    }
    batchState.stopRequested = true;
    res.json({ message: "Stop requested" });
});

// API: Rerun single influencer
app.post("/api/process/rerun/:id", async (req, res) => {
    const influencerId = req.params.id;
    const batchId = req.body?.batchId; // Optional: batch context for auto-completion

    try {
        const result = await processInfluencer(db, influencerId);

        if (result) {
            // Only update MongoDB if a category was found
            // Always update category (even null) so processed state is reflected
            await db.collection(INFLUENCER_COLLECTION).updateOne(
                { _id: new ObjectId(influencerId) },
                {
                    $set: {
                        "primary_category": result.category || null,
                        "secondary_categories": result.subCategories || [],
                        "categories": result.category ? [result.category] : [],
                    },
                }
            );

            broadcast({
                type: "rerun",
                data: {
                    _id: influencerId,
                    name: result.name,
                    handle: result.handle,
                    category: result.category,
                    subCategories: result.subCategories,
                    reasoning: result.reasoning,
                    postsAnalyzed: result.postsAnalyzed,
                    cost: result.cost,
                    status: result.category ? "categorized" : "no_category",
                },
            });

            // Track this influencer as Instant-processed and check batch completion
            let batchCompleted = false;
            // console.log(`[RERUN] influencerId=${influencerId}, batchId=${batchId}`);
            if (batchId) {
                // Add this influencer to the instant_processed_ids set
                await db.collection("openai_batch_jobs").updateOne(
                    { batch_id: batchId },
                    { $addToSet: { instant_processed_ids: influencerId } }
                );

                // Re-fetch the job to check if all influencers have been Instant-processed
                const job = await db.collection("openai_batch_jobs").findOne({ batch_id: batchId });
                if (job && job.influencer_ids && job.instant_processed_ids) {
                    const total = job.influencer_ids.length;
                    const processed = job.instant_processed_ids.length;
                    // console.log(`[RERUN] Instant processed: ${processed}/${total}`);

                    if (processed >= total) {
                        // All influencers clicked — mark batch completed
                        // Cost is tracked on the batch job itself via content[]
                        const totalCost = (job.content || []).reduce((sum, c) => sum + (c.cost || 0), 0);
                        const totalTokens = (job.content || []).reduce((sum, c) => sum + ((c.tokens?.input || 0) + (c.tokens?.output || 0)), 0);

                        await db.collection("openai_batch_jobs").updateOne(
                            { batch_id: batchId },
                            {
                                $set: {
                                    status: "completed",
                                    completed_at: new Date(),
                                    manually_completed: true,
                                    progress: 100,
                                    cost: parseFloat(totalCost.toFixed(5)),
                                    tokens: totalTokens,
                                    error: null,
                                }
                            }
                        );
                        batchCompleted = true;
                    }
                }
            }

            res.json({ success: true, result, batchCompleted });
        } else {
            res.status(404).json({ error: "Influencer not found" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- NATIVE OPENAI BATCH JOBS ---
const {
    initBatchManager,
    scheduleAdvancedBatches,
    rerunFailedBatch,
    syncOpenAIBatches,
    startContinuousOrchestrator,
    stopContinuousOrchestrator,
    getOrchestratorStatus,
    cancelSingleBatch,
    cancelAllBatches,
    getResumePreview,
    resumeCancelledBatches
} = require("./src/services/batchManager");

// API: List all native batch jobs (Paginated + Filtered)
app.get("/api/openai-batch/list", async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const status = req.query.status || "all";
        const search = req.query.search || "";
        const skip = (page - 1) * limit;

        let query = {};
        if (status !== "all") {
            query.status = status;
        }
        if (search) {
            query.batch_id = { $regex: search, $options: "i" };
        }

        const [jobs, total] = await Promise.all([
            db.collection("openai_batch_jobs")
                .find(query)
                .sort({ created_at: -1 })
                .skip(skip)
                .limit(limit)
                .toArray(),
            db.collection("openai_batch_jobs").countDocuments(query)
        ]);

        res.json({
            jobs,
            total,
            page,
            pages: Math.ceil(total / limit)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Fetch influencers for a specific batch job
app.get("/api/openai-batch/:id/influencers", async (req, res) => {
    try {
        const job = await db.collection("openai_batch_jobs").findOne({ batch_id: req.params.id });
        if (!job) return res.status(404).json({ error: "Batch job not found" });

        const ids = (job.influencer_ids || [])
            .filter(id => typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id))
            .map(id => new ObjectId(id));
        const influencers = await db.collection(INFLUENCER_COLLECTION)
            .find({ _id: { $in: ids } })
            .toArray();

        const isCompleted = job.status === "completed";

        // Build per-influencer cost map from batch job's content[]
        const costMap = {};
        (job.content || []).forEach(c => {
            if (c.influencer_id) costMap[c.influencer_id] = c.cost || 0;
        });

        const formatted = influencers.map(inf => {
            const infId = inf._id.toString();
            return {
                id: infId,
                name: inf.fullname || inf.instagram?.handle || "",
                handle: inf.instagram?.handle || "",
                avatar: getAvatarUrl(inf),
                category: isCompleted ? (inf.primary_category || null) : null,
                subCategories: isCompleted ? (inf.secondary_categories || []) : [],
                cost: costMap[infId] || 0
            };
        });

        res.json({
            influencers: formatted,
            timing: {
                created_at: job.created_at,
                completed_at: job.completed_at,
                doc_count: job.doc_count,
                status: job.status
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Rerun a Batch
app.post("/api/openai-batch/:id/rerun", async (req, res) => {
    try {
        const result = await rerunFailedBatch(req.params.id);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Cancel a single batch
app.post("/api/openai-batch/:id/cancel", async (req, res) => {
    try {
        const result = await cancelSingleBatch(req.params.id);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Create new native batch job (Single manual trigger)
app.post("/api/openai-batch/create", async (req, res) => {
    try {
        const limit = parseInt(req.body.limit) || 100;
        const chunkSize = parseInt(req.body.chunkSize) || 100;
        const result = await scheduleAdvancedBatches(limit, chunkSize);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Start Continuous Session
app.post("/api/openai-batch/session/start", async (req, res) => {
    try {
        const limit = parseInt(req.body.limit) || 0;
        const chunkSize = parseInt(req.body.chunkSize) || 0;
        const status = await startContinuousOrchestrator(limit, chunkSize);
        res.json(status);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// API: Stop Continuous Session
app.post("/api/openai-batch/session/stop", (req, res) => {
    const status = stopContinuousOrchestrator();
    res.json(status);
});

// API: Cancel ALL active batches
app.post("/api/openai-batch/cancel-all", async (req, res) => {
    try {
        const result = await cancelAllBatches();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Preview what will be resumed
app.get("/api/openai-batch/resume/preview", async (req, res) => {
    try {
        const result = await getResumePreview();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Resume cancelled batches (only unprocessed influencers)
app.post("/api/openai-batch/resume", async (req, res) => {
    try {
        const result = await resumeCancelledBatches();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Get Session Status
app.get("/api/openai-batch/session/status", async (req, res) => {
    try {
        // Lightweight: only query the small openai_batch_jobs collection
        const activeJobs = await db.collection("openai_batch_jobs")
            .find({ status: { $in: ["validating", "in_progress", "finalizing", "in_queue"] } })
            .project({ influencer_ids: 1 })
            .toArray();

        const queuedCount = activeJobs.reduce((sum, j) => sum + (j.influencer_ids?.length || 0), 0);

        // Get the latest batch_id from DB
        const latestJob = await db.collection("openai_batch_jobs")
            .find({})
            .sort({ created_at: -1 })
            .limit(1)
            .project({ batch_id: 1 })
            .toArray();
        const latestBatchId = latestJob.length > 0 ? latestJob[0].batch_id : null;

        res.json({
            ...getOrchestratorStatus(),
            pendingDBCount: cachedStats.pending,
            queuedCount,
            latestBatchId
        });
    } catch (err) {
        // Fallback to basic state if DB counting fails
        res.json(getOrchestratorStatus());
    }
});

// API: Sync batch jobs from OpenAI
app.post("/api/openai-batch/sync", async (req, res) => {
    try {
        const result = await syncOpenAIBatches();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Background local batch processor (Legacy process)
async function runBatch(docLimit, batchSize) {
    try {
        // Count only unprocessed documents (not in any batch job)
        const processedObjectIds = [...cachedProcessedIds]
            .filter(id => typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id))
            .map(id => new ObjectId(id));
        const pendingQuery = { _id: { $nin: processedObjectIds } };
        const totalPending = await db.collection(INFLUENCER_COLLECTION).countDocuments(pendingQuery);
        const totalToProcess = docLimit > 0 ? Math.min(docLimit, totalPending) : totalPending;

        batchState.total = totalToProcess;
        broadcast({ type: "started", total: totalToProcess, limit: docLimit });

        let processed = 0;

        while (processed < totalToProcess && !batchState.stopRequested) {
            // Always fetch unprocessed docs
            const influencers = await db
                .collection(INFLUENCER_COLLECTION)
                .find(pendingQuery, { projection: { _id: 1 } })
                .limit(batchSize)
                .toArray();

            if (influencers.length === 0) break;

            for (let i = 0; i < influencers.length && processed < totalToProcess; i++) {
                if (batchState.stopRequested) break;

                const id = influencers[i]._id.toString();
                batchState.currentInfluencer = id;

                try {
                    const result = await processInfluencer(db, id);

                    if (result) {
                        await db.collection(INFLUENCER_COLLECTION).updateOne(
                            { _id: new ObjectId(id) },
                            {
                                $set: {
                                    "primary_category": result.category || null,
                                    "secondary_categories": result.subCategories || [],
                                    "categories": result.category ? [result.category] : [],
                                },
                            }
                        );

                        batchState.success++;
                        broadcast({
                            type: "processed",
                            data: {
                                _id: id,
                                name: result.name,
                                handle: result.handle,
                                category: result.category,
                                subCategories: result.subCategories,
                                postsAnalyzed: result.postsAnalyzed,
                                cost: result.cost,
                                status: result.category ? "categorized" : "no_category",
                            },
                            progress: { processed: batchState.processed + 1, success: batchState.success, failed: batchState.failed, total: totalToProcess },
                        });
                    } else {
                        batchState.failed++;
                    }
                } catch (err) {
                    batchState.failed++;
                    broadcast({
                        type: "error",
                        data: { _id: id, error: err.message },
                        progress: { processed: batchState.processed + 1, success: batchState.success, failed: batchState.failed, total: totalToProcess },
                    });
                }

                processed++;
                batchState.processed = processed;
            }

            // Delay between batches
            if (processed < totalToProcess && !batchState.stopRequested) {
                await new Promise((r) => setTimeout(r, 2000));
            }
        }

        batchState.running = false;
        batchState.currentInfluencer = null;
        broadcast({
            type: "completed",
            progress: { processed: batchState.processed, success: batchState.success, failed: batchState.failed, total: totalToProcess },
        });
    } catch (err) {
        batchState.running = false;
        broadcast({ type: "fatal_error", error: err.message });
    }
}

// Start
connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`\n🚀 Dashboard running at http://localhost:${PORT}\n`);
    });
});
