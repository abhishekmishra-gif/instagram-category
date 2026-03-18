require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { MongoClient, ObjectId } = require("mongodb");
const { findCategories, printCategoryResult } = require("../src/services/categoryFinder");

// ============================================================
// ⚡ CHANGE THIS ID TO FETCH A DIFFERENT INFLUENCER'S DATA
// ============================================================
const INFLUENCER_ID = "673c4117005171b7340764d5";
// ============================================================

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME;
const INFLUENCER_COLLECTION = process.env.INFLUENCER_COLLECTION;
const POSTS_COLLECTION = process.env.POSTS_COLLECTION;
const POST_LIMIT = 12;

async function getInfluencerWithPosts(influencerId) {
    const client = new MongoClient(MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000,
    });

    try {
        await client.connect();
        console.log("✅ Connected to MongoDB\n");

        const db = client.db(DB_NAME);

        // 1. Fetch the influencer details by _id
        const influencer = await db
            .collection(INFLUENCER_COLLECTION)
            .findOne({ _id: new ObjectId(influencerId) });

        if (!influencer) {
            console.error(`❌ No influencer found with _id: ${influencerId}`);
            return null;
        }

        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("📌 INFLUENCER DETAILS");
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log(`  Name       : ${influencer.fullname}`);
        console.log(`  Username   : ${influencer.instagram?.handle || "N/A"}`);
        console.log(`  Email      : ${influencer.email || "N/A"}`);
        console.log(`  Followers  : ${influencer.instagram?.follower_count || "N/A"}`);
        console.log(`  Following  : ${influencer.instagram?.following_count || "N/A"}`);
        console.log(`  Posts Count : ${influencer.instagram?.media_count || "N/A"}`);
        console.log(`  Categories : ${(influencer.categories || []).join(", ")}`);
        console.log(`  Type       : ${influencer.instagram?.influencer_type?.type || "N/A"} (${influencer.instagram?.influencer_type?.category || "N/A"})`);
        console.log(`  ER         : ${influencer.instagram?.engagement_ratio || "N/A"}%`);
        console.log(`  Avg Likes  : ${influencer.instagram?.average_likes || "N/A"}`);
        console.log(`  Avg Comments: ${influencer.instagram?.average_comments || "N/A"}`);
        console.log(`  Location   : ${influencer.instagram?.location?.city || "N/A"}, ${influencer.instagram?.location?.state || "N/A"}, ${influencer.instagram?.location?.country || "N/A"}`);

        // 2. Fetch 12 posts using the influencer's _id as influencer_id (stored as string)
        const posts = await db
            .collection(POSTS_COLLECTION)
            .find({ influencer_id: influencerId })
            .sort({ created_timestamp: -1 })
            .limit(POST_LIMIT)
            .toArray();

        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`📸 INSTAGRAM POSTS (${posts.length} posts)`);
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        posts.forEach((post, index) => {
            const caption = post.caption?.["0"]?.text || "";
            const truncatedCaption =
                caption.length > 100 ? caption.substring(0, 100) + "..." : caption;

            console.log(`\n  [${index + 1}] ${post.post_shortcode}`);
            console.log(`      Date       : ${post.created_timestamp_formatted || "N/A"}`);
            console.log(`      Type       : ${post.is_video ? "Video/Reel" : post.is_carousel ? "Carousel" : "Image"}`);
            console.log(`      Likes      : ${post.total_likes?.toLocaleString() || 0}`);
            console.log(`      Comments   : ${post.total_comments?.toLocaleString() || 0}`);
            console.log(`      Plays      : ${post.total_play?.toLocaleString() || 0}`);
            console.log(`      ER         : ${post.er?.toFixed(2) || 0}%`);
            console.log(`      Reshares   : ${post.reshare_count?.toLocaleString() || 0}`);
            console.log(`      Paid       : ${post.is_paid_partnership ? "✅ Yes" : "❌ No"}`);
            console.log(`      Hashtags   : ${(post.hashtags || []).slice(0, 10).join(", ") || "None"}`);
            console.log(`      Caption    : ${truncatedCaption || "No caption"}`);
        });

        // 3. Run category analysis
        const categoryResult = await findCategories(influencer, posts);
        printCategoryResult(categoryResult);

        // 4. Combine into a single object
        const combined = {
            influencer: influencer,
            posts: posts,
            categoryAnalysis: categoryResult,
        };

        return combined;
    } catch (error) {
        console.error("❌ Error:", error.message);
        return null;
    } finally {
        await client.close();
        console.log("Disconnected from MongoDB");
    }
}

getInfluencerWithPosts(INFLUENCER_ID);
