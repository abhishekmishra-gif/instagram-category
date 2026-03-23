const { ObjectId } = require("mongodb");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

const INFLUENCER_COLLECTION = process.env.INFLUENCER_COLLECTION;
const POSTS_COLLECTION = process.env.POSTS_COLLECTION;
const BATCH_JOBS_COLLECTION = "openai_batch_jobs";

// Shared DB reference — set once via initBatchManager(db)
let _db = null;

function initBatchManager(db) {
  _db = db;
  // Load session state on init
  loadSessionState();
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const { CATEGORY_PROMPT, CATEGORY_NAMES } = require("../data/categories");

const systemPrompt = `You are an expert Instagram influencer category classifier. You will receive the influencer's IDENTITY (username, name, bio, existing database categories) and their recent POST CONTENT (captions + hashtags).

CATEGORIES & THEIR SUB-CATEGORIES (pick ONLY from these):
${CATEGORY_PROMPT}

CLASSIFICATION RULES:
1. POST CONTENT is your PRIMARY evidence. Analyze all captions and hashtags to determine what the influencer actually does professionally.
2. IGNORE paid/sponsored posts and brand collaborations (#ad, brand mentions, product promos) — these are advertisements, NOT identity signals. Celebrities endorse brands regardless of their actual profession.
3. Give EXTRA WEIGHT to posts about: movie/film/song releases, professional achievements, awards, tournaments, career announcements, or creative work — these reveal the true profession.
4. USERNAME and BIO are SECONDARY hints. If the username contains a clear profession keyword (e.g. "gaming", "chef", "fitness"), factor it in strongly.
5. DATABASE CATEGORIES may be INCORRECT. Treat them as a reference only — always verify against post content. If posts clearly contradict the DB category, trust the posts.
6. Do NOT confuse lifestyle/personal posts with the influencer's profession. A sports star posting family photos is still in Sports. An actress posting fashion photos is still in Entertainment.
7. Pick ALL sub-categories that genuinely match from the chosen category's list.
8. NICHE must describe WHO the influencer IS (their professional identity/role), NOT what their posts are about. Examples: "Bollywood Actress", "Cricket Player", "Skincare Blogger", "Tech YouTuber", "Fitness Coach", "Stand-up Comedian" etc. It should be a concise 1-3 word label of their real-world profession or creator identity.
9. Only raw JSON, no markdown.

RESPOND IN THIS EXACT JSON FORMAT:
{"category":"Category Name","sub_categories":["Sub 1","Sub 2"],"niche":"Niche Label","niche_explanation":"1 sentence explanation referencing specific content signals."}`;

const fallbackSystemPrompt = `You are an Instagram influencer category classifier. You have NO post content to analyze. Use ONLY the username, bio, and existing database categories to guess the BEST category.

CATEGORIES & THEIR SUB-CATEGORIES (pick ONLY from these):
${CATEGORY_PROMPT}

RULES:
1. Match based on username hints and database categories ONLY.
2. If the database category clearly maps to one of the valid categories, use it.
3. If nothing matches confidently, return null as the category.
4. Only raw JSON, no markdown.
5. For niche_explanation, briefly reference which bio keyword or username pattern drove the niche decision. If niche is null, set niche_explanation to null as well.
6. Only raw JSON, no markdown.

RESPOND IN THIS EXACT JSON FORMAT:
{"category":"Category Name","sub_categories":["Sub 1"],"confidence":60,"reasoning":"Brief reason","niche":"Niche Label","niche_explanation":"1-2 sentence explanation referencing bio or username signals."}`;

/**
 * Format identically to categoryFinder.js and handle fallbacks
 */
function buildBatchRequestLine(inf, posts) {
  const username = inf.instagram?.handle || inf.username || "";
  const fullname = inf.fullname || "";
  const existingCategories = (inf.categories || inf.secondary_categories || []).join(", ");
  const bio = inf.instagram?.biography || "";

  const captions = (posts || []).map((p, i) => {
    const text = p.caption?.["0"]?.text || "No caption";
    const trimmed = text.length > 500 ? text.substring(0, 500) + "..." : text;
    return `Post ${i + 1}: ${trimmed}`;
  });

  const allHashtags = [
    ...new Set(
      (posts || []).reduce((acc, p) => {
        if (p.hashtags && Array.isArray(p.hashtags)) {
          acc.push(...p.hashtags.map((h) => h.replace(/^#/, "")));
        }
        return acc;
      }, []),
    ),
  ];

  const hasRealCaptions = captions.some((c) => !c.endsWith("No caption"));
  const hasHashtags = allHashtags.length > 0;
  const hasPosts = posts && posts.length > 0;
  const hasContent = hasRealCaptions || hasHashtags;

  let requestSystemPrompt;
  let requestUserPrompt;
  let maxTokens = 300;

  if (!hasPosts || !hasContent) {
    // Match categoryFinder.js: if no useful fallback signals, return null (skip this influencer)
    const hasUsernameHint = username && username.length > 0;
    const hasDbCategories = existingCategories && existingCategories.length > 0;
    if (!hasUsernameHint && !hasDbCategories) {
      return null; // No data at all — will be handled as null category
    }

    requestSystemPrompt = fallbackSystemPrompt;
    requestUserPrompt = `Username: @${username}\nName: ${fullname}\nBio: ${bio || "None"}\nDatabase Categories: ${existingCategories || "None"}\n\nClassify based on the above. Return ONLY the JSON.`;
    maxTokens = 200;
  } else {
    requestSystemPrompt = systemPrompt;
    requestUserPrompt = `INFLUENCER IDENTITY:
Username: @${username}
Name: ${fullname}
Bio: ${bio || "None"}
Database Categories: ${existingCategories || "None"}

ALL POST CAPTIONS:
${captions.join("\n\n")}

ALL HASHTAGS USED:
${allHashtags.slice(0, 50).join(", ")}

Classify this influencer. Use IDENTITY first, then CONFIRM with post content. Return the JSON.`;
  }

  return {
    custom_id: inf._id.toString(),
    method: "POST",
    url: "/v1/chat/completions",
    body: {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: requestSystemPrompt },
        { role: "user", content: requestUserPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: maxTokens,
    },
  };
}

/**
 * Create a new Batch Job Request and submit to OpenAI
 * Now supports mass orchestration, active-queue exclusion, and parallel chunking.
 */
async function scheduleAdvancedBatches(totalLimit = 100, chunkSize = 100) {
  const db = _db;
  if (!db) throw new Error("BatchManager not initialized. Call initBatchManager(db) first.");

  try {

    // 1. Fault Tolerance: Find all influencer IDs that are in ANY batch job (active or completed)
    const allBatchJobs = await db
      .collection(BATCH_JOBS_COLLECTION)
      .find({ status: { $in: ["in_queue", "validating", "in_progress", "finalizing", "completed"] } })
      .toArray();

    let allBatchedInfluencerIds = [];
    allBatchJobs.forEach((job) => {
      if (job.influencer_ids) {
        allBatchedInfluencerIds.push(
          ...job.influencer_ids.map((id) => new ObjectId(id)),
        );
      }
    });

    // 2. Fetch valid influencers WITH posts (keep fetching until we fill totalLimit)
    const validInfluencers = [];
    const allSkippedIds = [];
    let skipOffset = 0;

    while (validInfluencers.length < totalLimit) {
      const validIds = validInfluencers.map(v => v.inf._id);
      const candidates = await db
        .collection(INFLUENCER_COLLECTION)
        .find({
          _id: { $nin: [...allBatchedInfluencerIds, ...allSkippedIds, ...validIds] },
          "instagram.follower_count_actual": { $gte: 1000 },
          "instagram.media_count": { $gte: 15 },
          "instagram.is_private": false,
          $or: [
            { "instagram.ai_attempts": { $exists: false } },
            { "instagram.ai_attempts": { $lt: 3 } }
          ]
        })
        .sort({ updated_at: -1 })
        .limit(totalLimit - validInfluencers.length + 20) // Over-fetch slightly to account for skips
        .toArray();

      if (candidates.length === 0) break; // No more candidates in DB

      for (const inf of candidates) {
        if (validInfluencers.length >= totalLimit) break;

        const posts = await db
          .collection(POSTS_COLLECTION)
          .find({ influencer_id: inf._id.toString() })
          .sort({ created_timestamp: -1 })
          .toArray();

        if (!posts || posts.length === 0) {
          allSkippedIds.push(inf._id);
          continue;
        }

        const requestLine = buildBatchRequestLine(inf, posts);
        if (requestLine === null) {
          allSkippedIds.push(inf._id);
          continue;
        }

        validInfluencers.push({ inf, requestLine, posts });
      }

      // If we didn't find any new valid ones in this batch, stop to avoid infinite loop
      if (candidates.length < (totalLimit - validInfluencers.length + 20)) break;
    }

    // 3. Early Exit
    if (validInfluencers.length === 0) {
      return {
        totalOrchestrated: 0,
        jobsCreated: 0,
        message: "No unlocked influencers with posts found.",
      };
    }

    const scheduledJobs = [];

    // 4. Chunk & Orchestrate
    for (let i = 0; i < validInfluencers.length; i += chunkSize) {
      const chunk = validInfluencers.slice(i, i + chunkSize);

      const jsonlPath = path.join(
        __dirname,
        `batch_request_${Date.now()}_idx${i}.jsonl`,
      );
      const batchLines = chunk.map(item => JSON.stringify(item.requestLine));
      const processedIds = chunk.map(item => item.inf._id.toString());

      // Write chunk to local file
      fs.writeFileSync(jsonlPath, batchLines.join("\n"));

      // Upload chunk to OpenAI
      const fileResponse = await openai.files.create({
        file: fs.createReadStream(jsonlPath),
        purpose: "batch",
      });

      // Trigger parallel Batch Job for chunk
      const batchResponse = await openai.batches.create({
        input_file_id: fileResponse.id,
        endpoint: "/v1/chat/completions",
        completion_window: "24h", // Required by OpenAI
      });

      // Save chunk metadata to MongoDB — only include actually processed influencers
      // Build shortcode map: influencer_id -> [shortcodes used for analysis]
      const shortcodeMap = {};
      for (const item of chunk) {
        shortcodeMap[item.inf._id.toString()] = (item.posts || []).map(p => p.post_shortcode).filter(Boolean);
      }

      const jobDoc = {
        batch_id: batchResponse.id,
        status: batchResponse.status,
        input_file_id: batchResponse.input_file_id,
        output_file_id: null,
        error_file_id: null,
        doc_count: processedIds.length,
        progress: 0,
        tokens: 0,
        cost: 0,
        influencer_ids: processedIds,
        shortcode_map: shortcodeMap,
        created_at: new Date(),
        completed_at: null,
        error: null,
      };

      await db.collection(BATCH_JOBS_COLLECTION).insertOne(jobDoc);
      scheduledJobs.push(jobDoc);

      // Cleanup local temporary chunk file
      fs.unlinkSync(jsonlPath);
    }

    return {
      success: true,
      totalOrchestrated: validInfluencers.length,
      jobsCreated: scheduledJobs.length,
      scheduledJobs,
    };
  } catch (err) {
    console.error("Advanced Batch Orchestration Error:", err);
    throw err;
  }
}

/**
 * Reruns a failed/cancelled/expired batch
 */
async function rerunFailedBatch(batchId) {
  const db = _db;
  if (!db) throw new Error("BatchManager not initialized. Call initBatchManager(db) first.");

  try {

    // Find the original job
    const oldJob = await db.collection(BATCH_JOBS_COLLECTION).findOne({ batch_id: batchId });
    if (!oldJob) throw new Error("Batch job not found.");
    if (!oldJob.influencer_ids || oldJob.influencer_ids.length === 0) throw new Error("No influencers attached to this batch.");

    // Fetch the raw influencers
    const objectIds = oldJob.influencer_ids.map(id => new ObjectId(id));
    const influencers = await db
      .collection(INFLUENCER_COLLECTION)
      .find({ _id: { $in: objectIds } })
      .toArray();

    if (influencers.length === 0) {
      throw new Error("Could not find any of the original influencers in the database.");
    }

    // Clear any existing AI category data the old batch might have temporarily set
    await db.collection(INFLUENCER_COLLECTION).updateMany(
      { _id: { $in: objectIds } },
      { $unset: { "primary_category": "", "secondary_categories": "", "categories": "" } }
    );

    const chunk = influencers; // We assume the old batch was a chunk already


    const jsonlPath = path.join(
      __dirname,
      `batch_rerun_${Date.now()}.jsonl`,
    );
    let batchLines = [];

    // Compile the chunk requests
    const skippedIds = [];
    for (const inf of chunk) {
      // Fetch ONLY by influencer_id (string ObjectId) to match script logic exactly
      let posts = await db
        .collection(POSTS_COLLECTION)
        .find({ influencer_id: inf._id.toString() })
        .sort({ created_timestamp: -1 })
        .toArray();

      // Skip influencers with no posts in the database
      if (!posts || posts.length === 0) {
        skippedIds.push(inf._id);
        continue;
      }

      const requestLine = buildBatchRequestLine(inf, posts);
      if (requestLine === null) {
        skippedIds.push(inf._id);
        continue;
      }
      batchLines.push(JSON.stringify(requestLine));
    }

    if (batchLines.length === 0) {
      return { success: true, newBatchId: null, message: "All influencers had no data, saved as null category" };
    }

    // Write chunk to local file
    fs.writeFileSync(jsonlPath, batchLines.join("\n"));

    // Upload chunk to OpenAI
    const fileResponse = await openai.files.create({
      file: fs.createReadStream(jsonlPath),
      purpose: "batch",
    });

    // Trigger parallel Batch Job for chunk
    const batchResponse = await openai.batches.create({
      input_file_id: fileResponse.id,
      endpoint: "/v1/chat/completions",
      completion_window: "24h",
    });

    // Save chunk metadata to MongoDB
    const jobDoc = {
      batch_id: batchResponse.id,
      status: batchResponse.status,
      input_file_id: batchResponse.input_file_id,
      output_file_id: null,
      error_file_id: null,
      doc_count: chunk.length,
      progress: 0,
      tokens: 0,
      cost: 0,
      influencer_ids: chunk.map((inf) => inf._id.toString()),
      created_at: new Date(),
      completed_at: null,
      error: null,
      rerun_from: batchId, // Track lineage
    };

    await db.collection(BATCH_JOBS_COLLECTION).insertOne(jobDoc);
    fs.unlinkSync(jsonlPath);

    return { success: true, newBatchId: batchResponse.id };
  } catch (err) {
    console.error("Batch Rerun Error:", err);
    throw err;
  }
}

/**
 * Poll OpenAI to sync batch status and ingest if completed
 */
async function syncOpenAIBatches() {
  const db = _db;
  if (!db) throw new Error("BatchManager not initialized. Call initBatchManager(db) first.");

  try {

    // Get all active batches from our DB (skip manually completed ones)
    const activeBatches = await db
      .collection(BATCH_JOBS_COLLECTION)
      .find({
        status: { $nin: ["completed", "failed", "cancelled", "expired"] },
        manually_completed: { $ne: true },
      })
      .toArray();

    for (const job of activeBatches) {
      // Check if all influencers were individually Instant-processed
      if (job.instant_processed_ids && job.influencer_ids &&
        job.instant_processed_ids.length >= job.influencer_ids.length) {
        // Cost is tracked on the batch job itself via content[]
        const totalCost = (job.content || []).reduce((sum, c) => sum + (c.cost || 0), 0);
        const totalTokens = (job.content || []).reduce((sum, c) => sum + ((c.tokens?.input || 0) + (c.tokens?.output || 0)), 0);

        await db.collection(BATCH_JOBS_COLLECTION).updateOne(
          { _id: job._id },
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
        continue; // Skip OpenAI sync for this batch
      }

      const remoteBatch = await openai.batches.retrieve(job.batch_id);

      const updates = {
        status: remoteBatch.status,
        output_file_id: remoteBatch.output_file_id,
        error_file_id: remoteBatch.error_file_id,
      };

      // Calculate progress simply for UI feedback
      if (remoteBatch.request_counts) {
        const total = remoteBatch.request_counts.total || job.doc_count;
        const completed = remoteBatch.request_counts.completed || 0;
        const failed = remoteBatch.request_counts.failed || 0;
        updates.progress =
          Math.round(((completed + failed) / total) * 100) || 0;
      }

      if (remoteBatch.status === "completed" && remoteBatch.output_file_id) {
        // Time to ingest!
        updates.completed_at = new Date();
        updates.error = null;
        await ingestCompletedBatch(db, remoteBatch.output_file_id, job);
      } else if (
        ["failed", "expired", "cancelled"].includes(remoteBatch.status)
      ) {
        updates.error = "Batch failed or cancelled on OpenAI servers";
        updates.completed_at = new Date();
      }

      // Sync Database
      await db
        .collection(BATCH_JOBS_COLLECTION)
        .updateOne({ _id: job._id }, { $set: updates });
    }

    return { success: true, synced: activeBatches.length };
  } catch (err) {
    console.error("Batch Sync Error:", err);
    throw err;
  }
}

/**
 * Download OpenAI Batch Output and map JSON results to influencers
 */
async function ingestCompletedBatch(db, fileId, jobMeta) {
  try {
    const fileRes = await openai.files.content(fileId);
    const fileStr = await fileRes.text();

    const lines = fileStr.split("\n").filter(Boolean);

    // Let's do a bulkwrite to mongodb instead of pinging it 1-by-1
    const bulkOps = [];
    let batchTotalTokens = 0;
    let batchTotalCost = 0;
    const batchContent = []; // Store full AI output per influencer

    for (const line of lines) {
      const row = JSON.parse(line);

      const influencerId = row.custom_id;
      const resBody = row.response.body;

      if (row.error) {
        console.error(`Error for custom_id ${influencerId}:`, row.error);
        continue;
      }

      const messageContent = resBody.choices[0].message.content;
      let parsed;
      try {
        parsed = JSON.parse(messageContent);
      } catch (e) {
        console.error(`Failed to parse json returned for ${influencerId}`);
        continue;
      }

      // Validate category against allowed list (matching categoryFinder.js)
      if (parsed.category && !CATEGORY_NAMES.includes(parsed.category)) {
        const match = CATEGORY_NAMES.find(
          (c) =>
            c.toLowerCase().includes(parsed.category.toLowerCase()) ||
            parsed.category.toLowerCase().includes(c.toLowerCase())
        );
        if (match) {
          parsed.category = match;
        } else {
          parsed.category = null;
        }
      }

      // Save full AI output for this influencer
      const inputTokensForResult = resBody.usage.prompt_tokens || 0;
      const outputTokensForResult = resBody.usage.completion_tokens || 0;
      const costForResult = (inputTokensForResult / 1000) * 0.00015 + (outputTokensForResult / 1000) * 0.0006;

      batchContent.push({
        influencer_id: influencerId,
        category: parsed.category,
        sub_categories: parsed.sub_categories || [],
        tokens: { input: inputTokensForResult, output: outputTokensForResult },
        cost: parseFloat(costForResult.toFixed(5)),
        analyzed_post_shortcodes: (jobMeta.shortcode_map || {})[influencerId] || [],
      });

      // If category is null, increment retry counter on the influencer
      if (parsed.category === null) {
        batchTotalTokens += inputTokensForResult + outputTokensForResult;
        batchTotalCost += costForResult;

        // Increment ai_attempts — after 3 failed attempts, mark as permanently done with null category
        const infDoc = await db.collection(INFLUENCER_COLLECTION).findOneAndUpdate(
          { _id: new ObjectId(influencerId) },
          { $inc: { "instagram.ai_attempts": 1 } },
          { returnDocument: "after" }
        );
        const attempts = infDoc?.instagram?.ai_attempts || 1;
        if (attempts >= 3) {
          await db.collection(INFLUENCER_COLLECTION).updateOne(
            { _id: new ObjectId(influencerId) },
            { $set: { "primary_category": null, "categories": [], "secondary_categories": [] } }
          );
        }
        continue;
      }

      // Cost Calculation (matching categoryFinder.js single mode)
      const inputTokens = resBody.usage.prompt_tokens || 0;
      const outputTokens = resBody.usage.completion_tokens || 0;
      const tokens = { input: inputTokens, output: outputTokens };
      const cost =
        (inputTokens / 1000) * 0.00015 + (outputTokens / 1000) * 0.0006; // Batch pricing

      batchTotalTokens += inputTokens + outputTokens;
      batchTotalCost += cost;

      // Skip if already processed via Instant ⚡ (check batch job's instant_processed_ids)
      const instantIds = jobMeta.instant_processed_ids || [];
      if (instantIds.includes(influencerId)) {
        continue;
      }

      bulkOps.push({
        updateOne: {
          filter: {
            _id: new ObjectId(influencerId),
          },
          update: {
            $set: {
              "categories": [parsed.category],
              "primary_category": parsed.category,
              "secondary_categories": parsed.sub_categories || [],
              "niche": parsed.niche || null,
              "niche_explanation": parsed.niche_explanation || null,
              "analyzed_post_shortcodes": (jobMeta.shortcode_map || {})[influencerId] || [],
            },
          },
        },
      });
    }

    if (bulkOps.length > 0) {
      await db.collection(INFLUENCER_COLLECTION).bulkWrite(bulkOps);
    }

    // Lastly, record the totals back on the batch job for the dashboard tracking
    await db
      .collection(BATCH_JOBS_COLLECTION)
      .updateOne(
        { _id: jobMeta._id },
        {
          $set: {
            tokens: batchTotalTokens,
            cost: parseFloat(batchTotalCost.toFixed(5)),
            content: batchContent,
          },
        },
      );
  } catch (e) {
    console.error("Error during ingestCompletedBatch:", e);
    throw e;
  }
}

// --- STATEFUL ORCHESTRATION LOOP ---
let orchestratorState = {
  isRunning: false,
  burstLimit: 0,
  chunkSize: 0,
  processedCount: 0,
  delayMs: 10000, // 10 seconds between requests
  timing: {
    started: null,
    lastUpdated: null,
    elapsedHrs: 0,
    elapsedMins: 0,
    rate: 0,
    lastId: null,
  },
};

// --- SESSION STATE PERSISTENCE ---
async function saveSessionState() {
  if (!_db) return;
  try {
    const stateToSave = { ...orchestratorState };
    // Don't save isRunning as true — on restart it should be stopped
    stateToSave.isRunning = false;
    stateToSave._id = "current_session";
    await _db.collection("batch_session_state").replaceOne(
      { _id: "current_session" },
      stateToSave,
      { upsert: true }
    );
  } catch (err) {
    console.error("[SessionState] Failed to save state:", err.message);
  }
}

async function loadSessionState() {
  if (!_db) return;
  try {
    const saved = await _db.collection("batch_session_state").findOne({ _id: "current_session" });
    if (saved) {
      orchestratorState.processedCount = saved.processedCount || 0;
      orchestratorState.burstLimit = saved.burstLimit || 0;
      orchestratorState.chunkSize = saved.chunkSize || 0;
      orchestratorState.timing = saved.timing || orchestratorState.timing;
    }
  } catch (err) {
    console.error("[SessionState] Failed to load state:", err.message);
  }
}

// Session state is loaded when initBatchManager(db) is called

async function startContinuousOrchestrator(burstLimit, chunkSize) {
  if (orchestratorState.isRunning) {
    throw new Error("Orchestrator is already manually running.");
  }

  orchestratorState = {
    isRunning: true,
    burstLimit: parseInt(burstLimit) || 0,
    chunkSize: parseInt(chunkSize) || 0,
    processedCount: 0,
    delayMs: 10000,
    timing: {
      started: new Date(),
      lastUpdated: new Date(),
      elapsedHrs: 0,
      elapsedMins: 0,
      rate: 0,
      lastId: null,
    },
  };

  // Fire and forget loop
  runContinuousBatchLoop().catch((err) => {
    console.error("Continuous Loop Error:", err);
    orchestratorState.isRunning = false;
  });

  await saveSessionState();
  return orchestratorState;
}

function stopContinuousOrchestrator() {
  orchestratorState.isRunning = false;
  saveSessionState();
  return orchestratorState;
}

function getOrchestratorStatus() {
  return orchestratorState;
}

async function runContinuousBatchLoop() {
  const db = _db;

  try {

    while (orchestratorState.isRunning) {
      try {
        // Sync statuses with OpenAI to digest completed jobs natively
        await syncOpenAIBatches().catch((err) =>
          console.error("[Orchestrator] Quiet sync error:", err),
        );

        // Verify if there is genuinely anything left to do — eligible minus already batched
        const allJobs = await db.collection(BATCH_JOBS_COLLECTION)
          .find({}).project({ influencer_ids: 1 }).toArray();
        const allBatchedIds = new Set();
        allJobs.forEach(j => (j.influencer_ids || []).forEach(id => allBatchedIds.add(id.toString())));

        // Count eligible influencers not yet in any batch job
        const allBatchedObjectIds = [...allBatchedIds]
          .filter(id => /^[0-9a-fA-F]{24}$/.test(id))
          .map(id => new ObjectId(id));

        // Use a simple check: try to find at least 1 eligible candidate not in batch jobs
        const remainingCandidate = await db.collection(INFLUENCER_COLLECTION).findOne({
          _id: { $nin: allBatchedObjectIds },
          "instagram.follower_count_actual": { $gte: 1000 },
          "instagram.media_count": { $gte: 10 },
          "instagram.is_private": false,
          $or: [
            { "instagram.ai_attempts": { $exists: false } },
            { "instagram.ai_attempts": { $lt: 3 } }
          ]
        });

        if (!remainingCandidate) {
          orchestratorState.isRunning = false;
          break;
        }

        // Just fetch the user's requested 'totalLimit' blindly every interval. OpenAI handles concurrency.

        const result = await scheduleAdvancedBatches(
          orchestratorState.burstLimit,
          orchestratorState.chunkSize,
        );

        if (result.totalOrchestrated === undefined) {
          // Unrecognized batch creation error — silent
        } else if (result.totalOrchestrated > 0) {
          orchestratorState.processedCount += result.totalOrchestrated;

          // Update timing state
          if (orchestratorState.timing && orchestratorState.timing.started) {
            const now = new Date();
            const diffMs = now - orchestratorState.timing.started;
            const diffMinsTotal = Math.floor(diffMs / 60000);
            orchestratorState.timing.elapsedHrs = Math.floor(
              diffMinsTotal / 60,
            );
            orchestratorState.timing.elapsedMins = diffMinsTotal % 60;

            const diffSecs = diffMs / 1000;
            if (diffSecs > 0) {
              orchestratorState.timing.rate =
                orchestratorState.processedCount / diffSecs;
            }

            orchestratorState.timing.lastUpdated = now;
            // Track the latest batch_id
            if (result.scheduledJobs && result.scheduledJobs.length > 0) {
              const lastJob =
                result.scheduledJobs[result.scheduledJobs.length - 1];
              orchestratorState.timing.lastId = lastJob.batch_id || null;
            }
          }

          // Persist state after each successful batch
          await saveSessionState();


        } else {
          // No eligible influencers left to process — auto-pause session
          orchestratorState.isRunning = false;
          if (orchestratorState.timing) {
            orchestratorState.timing.lastUpdated = new Date();
          }
          break;
        }

        if (orchestratorState.isRunning) {
          // Dynamic throttling: scale delay based on in-progress influencer count
          const activeJobs = await db.collection(BATCH_JOBS_COLLECTION)
            .find({ status: { $in: ["validating", "in_progress", "finalizing", "in_queue"] } })
            .project({ influencer_ids: 1 })
            .toArray();
          const inProgressCount = activeJobs.reduce((sum, j) => sum + (j.influencer_ids?.length || 0), 0);

          let dynamicDelay = orchestratorState.delayMs; // 10s baseline
          if (inProgressCount >= 5000) dynamicDelay = 120000;       // 2 min
          else if (inProgressCount >= 2000) dynamicDelay = 60000;   // 1 min
          else if (inProgressCount >= 500) dynamicDelay = 30000;    // 30s
          // else 10s baseline

          console.log(`[Orchestrator] In-progress: ${inProgressCount} influencers → delay: ${dynamicDelay / 1000}s`);

          await new Promise((resolve) =>
            setTimeout(resolve, dynamicDelay),
          );
        }
      } catch (err) {
        console.error(
          "[Orchestrator] Error during batch orchestrator loop:",
          err,
        );
        // Optionally, pause longer on a real error
        await new Promise((resolve) =>
          setTimeout(resolve, orchestratorState.delayMs * 2),
        );
      }
    }
  } catch (dbErr) {
    console.error("[Orchestrator] Fatal DB error:", dbErr);
    orchestratorState.isRunning = false;
  }


  await saveSessionState();
}

// ── Cancel a single OpenAI batch ──
async function cancelSingleBatch(batchId) {
  const col = _db.collection(BATCH_JOBS_COLLECTION);
  const job = await col.findOne({ batch_id: batchId });
  if (!job) throw new Error("Batch not found");
  if (!["in_progress", "validating", "finalizing", "in_queue"].includes(job.status)) {
    throw new Error(`Cannot cancel batch with status: ${job.status}`);
  }

  await openai.batches.cancel(batchId);
  await col.updateOne({ batch_id: batchId }, { $set: { status: "cancelling" } });
  return { batch_id: batchId, status: "cancelling" };
}

// ── Cancel ALL active OpenAI batches ──
async function cancelAllBatches() {
  const col = _db.collection(BATCH_JOBS_COLLECTION);
  const activeJobs = await col.find({
    status: { $in: ["in_progress", "validating", "finalizing", "in_queue"] }
  }).toArray();

  if (activeJobs.length === 0) {
    return { cancelled: 0, message: "No active batches to cancel" };
  }

  const results = [];
  for (const job of activeJobs) {
    try {
      await openai.batches.cancel(job.batch_id);
      await col.updateOne(
        { batch_id: job.batch_id },
        { $set: { status: "cancelling" } }
      );
      results.push({ batch_id: job.batch_id, status: "cancelling" });
    } catch (err) {
      results.push({ batch_id: job.batch_id, error: err.message });
    }
  }

  // Also stop the orchestrator if running
  stopContinuousOrchestrator();

  return {
    cancelled: results.filter(r => !r.error).length,
    failed: results.filter(r => r.error).length,
    total: activeJobs.length,
    results
  };
}

// ── Preview what will be resumed (read-only) ──
async function getResumePreview() {
  const db = _db;
  if (!db) throw new Error("BatchManager not initialized.");

  const col = db.collection(BATCH_JOBS_COLLECTION);
  const cancelledJobs = await col.find({
    status: { $in: ["cancelled", "cancelling"] },
    influencer_ids: { $exists: true, $ne: [] },
    resumed: { $ne: true }
  }).toArray();

  if (cancelledJobs.length === 0) {
    return { cancelledBatches: 0, totalInfluencers: 0, processed: 0, unprocessed: 0, batches: [] };
  }

  // Collect all influencer IDs (deduplicated)
  const allIdStrings = new Set();
  cancelledJobs.forEach(job => {
    (job.influencer_ids || []).forEach(id => allIdStrings.add(id));
  });
  const allObjectIds = [...allIdStrings].map(id => new ObjectId(id));

  // Count how many are in completed batch jobs (processed via openai_batch_jobs)
  const completedJobs = await db.collection(BATCH_JOBS_COLLECTION)
    .find({ status: "completed" }).project({ influencer_ids: 1 }).toArray();
  const completedIdSet = new Set();
  completedJobs.forEach(j => (j.influencer_ids || []).forEach(id => completedIdSet.add(id)));
  const processedCount = [...allIdStrings].filter(id => completedIdSet.has(id)).length;

  const totalInfluencers = allIdStrings.size;
  const unprocessed = totalInfluencers - processedCount;

  return {
    cancelledBatches: cancelledJobs.length,
    totalInfluencers,
    processed: processedCount,
    unprocessed,
    batches: cancelledJobs.map(j => ({
      batch_id: j.batch_id,
      doc_count: j.doc_count,
      created_at: j.created_at,
      status: j.status
    }))
  };
}

// ── Resume cancelled batches (only unprocessed influencers) ──
async function resumeCancelledBatches() {
  const db = _db;
  if (!db) throw new Error("BatchManager not initialized.");

  const col = db.collection(BATCH_JOBS_COLLECTION);
  const cancelledJobs = await col.find({
    status: { $in: ["cancelled", "cancelling"] },
    influencer_ids: { $exists: true, $ne: [] },
    resumed: { $ne: true }
  }).toArray();

  if (cancelledJobs.length === 0) {
    return { resumed: 0, message: "No cancelled batches to resume" };
  }

  // Collect ALL influencer IDs from cancelled batches (deduplicated)
  const allIdStrings = new Set();
  cancelledJobs.forEach(job => {
    (job.influencer_ids || []).forEach(id => allIdStrings.add(id));
  });

  const allObjectIds = [...allIdStrings].map(id => new ObjectId(id));

  // Find influencers not in any completed batch job (unprocessed)
  const completedJobsForResume = await db.collection(BATCH_JOBS_COLLECTION)
    .find({ status: "completed" }).project({ influencer_ids: 1 }).toArray();
  const completedIdSetForResume = new Set();
  completedJobsForResume.forEach(j => (j.influencer_ids || []).forEach(id => completedIdSetForResume.add(id)));
  const unprocessedIds = [...allIdStrings].filter(id => !completedIdSetForResume.has(id));
  const unprocessedObjectIds = unprocessedIds.map(id => new ObjectId(id));

  const unprocessed = unprocessedObjectIds.length > 0
    ? await db.collection(INFLUENCER_COLLECTION).find({ _id: { $in: unprocessedObjectIds } }).toArray()
    : [];

  if (unprocessed.length === 0) {
    // Mark cancelled jobs so they aren't picked up again
    await col.updateMany(
      { _id: { $in: cancelledJobs.map(j => j._id) } },
      { $set: { status: "cancelled", resumed: true } }
    );
    return { resumed: 0, message: "All influencers from cancelled batches are already processed" };
  }

  // Build new batches in chunks (use 10 as default chunk size, or match old batch size)
  const chunkSize = cancelledJobs[0]?.doc_count || 10;
  const chunks = [];
  for (let i = 0; i < unprocessed.length; i += chunkSize) {
    chunks.push(unprocessed.slice(i, i + chunkSize));
  }

  const results = [];
  for (const chunk of chunks) {
    try {
      const jsonlPath = path.join(__dirname, `batch_resume_${Date.now()}.jsonl`);
      let batchLines = [];
      const skippedIds = [];

      for (const inf of chunk) {
        let posts = await db
          .collection(POSTS_COLLECTION)
          .find({ influencer_id: inf._id.toString() })
          .sort({ created_timestamp: -1 })
          .toArray();

        const requestLine = buildBatchRequestLine(inf, posts);
        if (requestLine === null) {
          skippedIds.push(inf._id);
          continue;
        }
        batchLines.push(JSON.stringify(requestLine));
      }

      if (batchLines.length === 0) {
        results.push({ skipped: skippedIds.length, reason: "no data" });
        continue;
      }

      fs.writeFileSync(jsonlPath, batchLines.join("\n"));

      const fileResponse = await openai.files.create({
        file: fs.createReadStream(jsonlPath),
        purpose: "batch",
      });

      const batchResponse = await openai.batches.create({
        input_file_id: fileResponse.id,
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      });

      const jobDoc = {
        batch_id: batchResponse.id,
        status: batchResponse.status,
        input_file_id: batchResponse.input_file_id,
        output_file_id: null,
        error_file_id: null,
        doc_count: chunk.length,
        progress: 0,
        tokens: 0,
        cost: 0,
        influencer_ids: chunk.map(inf => inf._id.toString()),
        created_at: new Date(),
        completed_at: null,
        error: null,
        resumed_from: "cancel-all",
      };

      await db.collection(BATCH_JOBS_COLLECTION).insertOne(jobDoc);
      fs.unlinkSync(jsonlPath);
      results.push({ batch_id: batchResponse.id, count: batchLines.length });
    } catch (err) {
      results.push({ error: err.message });
    }
  }

  // Mark original cancelled batches as resumed so they aren't picked up again
  await col.updateMany(
    { _id: { $in: cancelledJobs.map(j => j._id) } },
    { $set: { resumed: true } }
  );

  return {
    totalUnprocessed: unprocessed.length,
    batchesCreated: results.filter(r => r.batch_id).length,
    results
  };
}

module.exports = {
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
  resumeCancelledBatches,
};
