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
    setInterval(refreshIdsWithPosts, 60000); // Refresh every 60 seconds
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

// SSE broadcast
function broadcast(data) {
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    batchState.sseClients.forEach((res) => res.write(msg));
}

// API: Get stats
app.get("/api/stats", async (req, res) => {
    const total = await db.collection(INFLUENCER_COLLECTION).countDocuments();
    const processed = await db.collection(INFLUENCER_COLLECTION).countDocuments({ "instagram.cost": { $exists: true } });
    const withCategory = await db.collection(INFLUENCER_COLLECTION).countDocuments({ "instagram.cost": { $exists: true }, "instagram.category": { $ne: null } });
    const noCategory = await db.collection(INFLUENCER_COLLECTION).countDocuments({ "instagram.cost": { $exists: true }, "instagram.category": null });
    const pending = total - processed;
 
    // Break down noCategory into eligible vs ineligible
    // Use cached IDs of influencers that have posts (refreshed every 60s)
    const objectIdsWithPosts = [...cachedIdsWithPosts].map(id => new ObjectId(id));
 
    const eligible = await db.collection(INFLUENCER_COLLECTION).countDocuments({
        "instagram.cost": { $exists: false },
        "instagram.follower_count_actual": { $gte: 1000 },
        "instagram.media_count": { $gte: 10 },
        "instagram.is_private": false,
        _id: { $in: objectIdsWithPosts }
    });
    const ineligible = noCategory - eligible;
 
    // Calculate total cost from influencers
    const costResult = await db.collection(INFLUENCER_COLLECTION).aggregate([
        { $match: { "instagram.cost": { $exists: true } } },
        { $group: { _id: null, total: { $sum: "$instagram.cost" } } }
    ]).toArray();
 
    const totalCost = costResult.length > 0 ? costResult[0].total : 0;
 
    res.json({ total, processed, withCategory, noCategory, eligible, ineligible, pending, totalCost, running: batchState.running });
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
        query["instagram.cost"] = { $exists: true };
    } else if (filter === "pending") {
        query["instagram.cost"] = { $exists: false };
    } else if (filter === "withCategory") {
        query["instagram.category"] = { $ne: null };
    } else if (filter === "noCategory") {
        query["instagram.category"] = null;
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
            category: inf.instagram?.category || null,
            subCategories: inf.instagram?.categories || [],
            cost: inf.instagram?.cost || 0,
            status: inf.instagram?.cost !== undefined ? (inf.instagram?.category ? "categorized" : "no_category") : "pending",
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
            if (result.category) {
                await db.collection(INFLUENCER_COLLECTION).updateOne(
                    { _id: new ObjectId(influencerId) },
                    {
                        $set: {
                            "instagram.category": result.category,
                            "instagram.categories": result.subCategories,
                            "instagram.cost": result.cost,
                        },
                    }
                );
            }

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
                        // All influencers clicked — aggregate cost/tokens and mark completed
                        const objectIds = job.influencer_ids.map(id => new ObjectId(id));
                        const costAgg = await db.collection(INFLUENCER_COLLECTION).aggregate([
                            { $match: { _id: { $in: objectIds }, "instagram.cost": { $exists: true } } },
                            {
                                $group: {
                                    _id: null,
                                    totalCost: { $sum: "$instagram.cost" },
                                    totalInputTokens: { $sum: "$instagram.ai_tokens.input" },
                                    totalOutputTokens: { $sum: "$instagram.ai_tokens.output" },
                                }
                            },
                        ]).toArray();
                        const totals = costAgg[0] || { totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0 };

                        await db.collection("openai_batch_jobs").updateOne(
                            { batch_id: batchId },
                            {
                                $set: {
                                    status: "completed",
                                    completed_at: new Date(),
                                    manually_completed: true,
                                    progress: 100,
                                    cost: parseFloat(totals.totalCost.toFixed(5)),
                                    tokens: (totals.totalInputTokens || 0) + (totals.totalOutputTokens || 0),
                                    error: null,
                                }
                            }
                        );
                        batchCompleted = true;
                        // console.log(`[BATCH] All ${total} influencers Instant-processed — batch ${batchId} marked as completed`);
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

        // Format for UI 
        // console.log(`[DEBUG] Found ${influencers.length} influencers for batch ${req.params.id}`);
        const formatted = influencers.map(inf => {
            // console.log(`[DEBUG] Influencer ${inf._id}: handle=${inf.instagram?.handle}, profile_pic_url=${inf.instagram?.profile_pic_url}`);
            return {
                id: inf._id.toString(),
                name: inf.fullname || inf.instagram?.handle || "", // Fallback to handle if name is missing
                handle: inf.instagram?.handle || "",
                avatar: getAvatarUrl(inf),
                category: inf.instagram?.category || null,
                subCategories: inf.instagram?.categories || [],
                cost: inf.instagram?.cost || 0
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
        const activeJobs = await db.collection("openai_batch_jobs")
            .find({ status: { $in: ["validating", "in_progress", "finalizing", "in_queue"] } })
            .toArray();

        let activeInfluencerIds = [];
        for (const job of activeJobs) {
            if (job.influencer_ids) {
                // Ensure they map to strings so $nin comparison is safe, or ObjectIds if DB uses them.
                activeInfluencerIds.push(...job.influencer_ids
                    .filter(id => (typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id)) || (id && typeof id === 'object'))
                    .map(id => typeof id === 'string' ? new ObjectId(id) : id));
            }
        }

        // Use cached IDs of influencers that have posts (refreshed every 60s)
        const activeIdSet = new Set(activeInfluencerIds.map(id => id.toString()));
        const eligibleIdsWithPosts = [...cachedIdsWithPosts]
            .filter(id => typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id) && !activeIdSet.has(id))
            .map(id => new ObjectId(id));

        const count = await chunkedCount(
            db.collection(INFLUENCER_COLLECTION),
            {
                "instagram.cost": { $exists: false },
                "instagram.follower_count_actual": { $gte: 1000 },
                "instagram.media_count": { $gte: 10 },
                "instagram.is_private": false
            },
            eligibleIdsWithPosts
        );



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
            pendingDBCount: count,
            queuedCount: activeInfluencerIds.length,
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
        // Count only unprocessed documents
        const pendingQuery = { "instagram.cost": { $exists: false } };
        const totalPending = await db.collection(INFLUENCER_COLLECTION).countDocuments(pendingQuery);
        const totalToProcess = docLimit > 0 ? Math.min(docLimit, totalPending) : totalPending;

        batchState.total = totalToProcess;
        broadcast({ type: "started", total: totalToProcess, limit: docLimit });

        let processed = 0;

        while (processed < totalToProcess && !batchState.stopRequested) {
            // Always fetch unprocessed docs (skip 0 since processed ones get ai_category)
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
                                    "instagram.category": result.category,
                                    "instagram.categories": result.subCategories,
                                    "instagram.cost": result.cost,
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
