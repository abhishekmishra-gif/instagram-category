// Load dotenv only when run directly (not when imported by server.js)
if (require.main === module) {
  require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });
}
const { MongoClient, ObjectId } = require("mongodb");
const { findCategories, printCategoryResult } = require("../services/categoryFinder");

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME;
const INFLUENCER_COLLECTION = process.env.INFLUENCER_COLLECTION;
const POSTS_COLLECTION = process.env.POSTS_COLLECTION;
const POST_LIMIT = 12;
const BATCH_SIZE = 10;

async function processInfluencer(db, influencerId) {
    const influencer = await db
        .collection(INFLUENCER_COLLECTION)
        .findOne({ _id: new ObjectId(influencerId) });

    if (!influencer) {
        console.log(`  ❌ No influencer found with _id: ${influencerId}`);
        return null;
    }

    const posts = await db
        .collection(POSTS_COLLECTION)
        .find({ influencer_id: influencerId })
        .sort({ created_timestamp: -1 })
        .limit(POST_LIMIT)
        .toArray();

    const categoryResult = await findCategories(influencer, posts);

    return {
        influencerId: influencerId,
        name: influencer.fullname,
        handle: influencer.instagram?.handle || "",
        postsAnalyzed: posts.length,
        category: categoryResult.category,
        subCategories: categoryResult.subCategories,
        reasoning: categoryResult.reasoning,
        cost: categoryResult.cost || 0,
        tokens: categoryResult.tokens || { input: 0, output: 0 },
    };
}

async function runBatchJob() {
    const client = new MongoClient(MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
    });

    try {
        await client.connect();
        const db = client.db(DB_NAME);

        // Get total count
        const totalCount = await db.collection(INFLUENCER_COLLECTION).countDocuments();
        const totalBatches = Math.ceil(totalCount / BATCH_SIZE);

        console.log("═".repeat(60));
        console.log("🚀 BATCH CATEGORY ANALYSIS");
        console.log("═".repeat(60));
        console.log(`  Total Influencers : ${totalCount}`);
        console.log(`  Batch Size        : ${BATCH_SIZE}`);
        console.log(`  Total Batches     : ${totalBatches}`);
        console.log("═".repeat(60) + "\n");

        let processed = 0;
        let success = 0;
        let failed = 0;
        let skipped = 0;
        let batchNumber = 0;

        // Process in batches using skip/limit
        while (processed < totalCount) {
            batchNumber++;
            console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            console.log(`📦 BATCH ${batchNumber} / ${totalBatches}  (${processed + 1} - ${Math.min(processed + BATCH_SIZE, totalCount)} of ${totalCount})`);
            console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

            // Fetch 10 influencer IDs
            const influencers = await db
                .collection(INFLUENCER_COLLECTION)
                .find({}, { projection: { _id: 1 } })
                .skip(processed)
                .limit(BATCH_SIZE)
                .toArray();

            if (influencers.length === 0) break;

            // Process each influencer in this batch one by one
            for (let i = 0; i < influencers.length; i++) {
                const INFLUENCER_ID = influencers[i]._id.toString();
                const index = processed + i + 1;

                console.log(`\n  [${index}] Processing: ${INFLUENCER_ID}`);

                try {
                    const result = await processInfluencer(db, INFLUENCER_ID);

                    if (result) {
                        console.log(`      ✅ ${result.name} (@${result.handle})`);
                        console.log(`         Category       : ${result.category}`);
                        console.log(`         Sub-Categories : ${result.subCategories.length ? result.subCategories.join(", ") : null}`);

                        // Save result back to MongoDB
                        await db.collection(INFLUENCER_COLLECTION).updateOne(
                            { _id: new ObjectId(INFLUENCER_ID) },
                            {
                                $set: {
                                    "instagram.category": result.category,
                                    "instagram.categories": result.subCategories,
                                    "instagram.cost": result.cost,
                                },
                            }
                        );
                        success++;
                    } else {
                        skipped++;
                    }
                } catch (err) {
                    console.log(`      ❌ Error: ${err.message}`);
                    failed++;
                }
            }

            processed += influencers.length;

            console.log(`\n  📊 Batch ${batchNumber} done | ✅ ${success} | ❌ ${failed} | ⏭️ ${skipped} | Total: ${processed}/${totalCount}`);

            // Small delay between batches to avoid rate limiting
            if (processed < totalCount) {
                console.log("  ⏳ Waiting 2s before next batch...");
                await new Promise((r) => setTimeout(r, 2000));
            }
        }

        // Final summary
        console.log("\n" + "═".repeat(60));
        console.log("✅ BATCH JOB COMPLETE");
        console.log("═".repeat(60));
        console.log(`  Total Processed : ${processed}`);
        console.log(`  ✅ Success      : ${success}`);
        console.log(`  ❌ Failed       : ${failed}`);
        console.log(`  ⏭️ Skipped      : ${skipped}`);
        console.log("═".repeat(60) + "\n");

    } catch (error) {
        console.error("❌ Fatal Error:", error.message);
    } finally {
        await client.close();
        console.log("🔌 Disconnected from MongoDB");
    }
}

module.exports = { processInfluencer };

if (require.main === module) {
    runBatchJob();
}
