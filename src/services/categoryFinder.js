
const OpenAI = require("openai");
const { CATEGORY_NAMES, CATEGORY_PROMPT } = require("../data/categories");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });


async function findCategories(influencer, posts) {
    const username = influencer.instagram?.handle || influencer.username || "";
    const fullname = influencer.fullname || "";
    const existingCategories = (influencer.categories || []).join(", ");
    const bio = influencer.instagram?.biography || "";

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
            }, [])
        ),
    ];

    // Check if we have real content (captions or hashtags)
    const hasRealCaptions = captions.some((c) => !c.endsWith("No caption"));
    const hasHashtags = allHashtags.length > 0;
    const hasPosts = posts && posts.length > 0;
    const hasContent = hasRealCaptions || hasHashtags;

    // If no posts OR no content at all, try fallback with username + DB categories
    if (!hasPosts || !hasContent) {
        const hasUsernameHint = username && username.length > 0;
        const hasDbCategories = existingCategories && existingCategories.length > 0;

        // If even fallback signals are empty, return No Category
        if (!hasUsernameHint && !hasDbCategories) {
            return {
                influencerName: fullname,
                handle: username,
                postsAnalyzed: 0,
                category: null,
                subCategories: [],
                reasoning: "No posts, captions, hashtags, or profile signals available",
                cost: 0,
                tokens: { input: 0, output: 0 },
            };
        }

        // Use username + DB categories as fallback
        return await classifyFromFallback(fullname, username, bio, existingCategories, posts?.length || 0);
    }

    const systemPrompt = `You are an expert Instagram influencer category classifier. Analyze the content and pick the single BEST category and ALL genuinely relevant sub-categories.

CATEGORIES & THEIR SUB-CATEGORIES (pick ONLY from these):
${CATEGORY_PROMPT}

RULES:
1. Pick the MOST DOMINANT category across ALL 12 captions.
2. Pick ALL sub-categories that genuinely match this influencer from the chosen category's list.
3. Only include sub-categories with real evidence in the content.
4. Only raw JSON, no markdown.

RESPOND IN THIS EXACT JSON FORMAT:
{"category":"Category Name","sub_categories":["Sub 1","Sub 2"],"confidence":95,"reasoning":"Brief reason"}`;

    const userPrompt = `LAST 12 POST CAPTIONS:
${captions.join("\n\n")}

ALL HASHTAGS USED:
${allHashtags.slice(0, 50).join(", ")}

Analyze the above captions and hashtags ONLY. Return the JSON.`;

    // console.log("\n🤖 Sending data to OpenAI for category analysis...");

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
            ],
            temperature: 0.1,
            max_tokens: 300,
        });

        const rawResponse = response.choices[0]?.message?.content || "";
        const usage = response.usage || {};
        const inputTokens = usage.prompt_tokens || 0;
        const outputTokens = usage.completion_tokens || 0;
        const cost = (inputTokens * 0.15 / 1000000) + (outputTokens * 0.60 / 1000000);

        let parsed;
        try {
            parsed = JSON.parse(rawResponse);
        } catch {
            const jsonMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) {
                parsed = JSON.parse(jsonMatch[1].trim());
            } else {
                const braceMatch = rawResponse.match(/\{[\s\S]*\}/);
                if (braceMatch) {
                    parsed = JSON.parse(braceMatch[0]);
                } else {
                    throw new Error("Could not parse OpenAI response as JSON");
                }
            }
        }

        // Validate category
        if (!CATEGORY_NAMES.includes(parsed.category)) {
            console.warn(`⚠️  "${parsed.category}" not in list — finding closest...`);
            const match = CATEGORY_NAMES.find(
                (c) =>
                    c.toLowerCase().includes(parsed.category.toLowerCase()) ||
                    parsed.category.toLowerCase().includes(c.toLowerCase())
            );
            if (match) parsed.category = match;
        }

        return {
            influencerName: fullname,
            handle: username,
            postsAnalyzed: posts.length,
            category: parsed.category,
            subCategories: parsed.sub_categories || [],
            confidence: parsed.confidence + "%",
            reasoning: parsed.reasoning,
            cost: parseFloat(cost.toFixed(6)),
            tokens: { input: inputTokens, output: outputTokens },
        };
    } catch (error) {
        console.error("❌ OpenAI Error:", error.message);
        throw error;
    }
}

async function classifyFromFallback(fullname, username, bio, existingCategories, postsCount) {
    console.log("\n🤖 No captions/hashtags — using username + DB categories as fallback...");

    const fallbackPrompt = `You are an Instagram influencer category classifier. You have NO post content to analyze. Use ONLY the username, bio, and existing database categories to guess the BEST category.

CATEGORIES & THEIR SUB-CATEGORIES (pick ONLY from these):
${CATEGORY_PROMPT}

RULES:
1. Match based on username hints and database categories ONLY.
2. If the database category clearly maps to one of the valid categories, use it.
3. If nothing matches confidently, return null as the category.
4. Only raw JSON, no markdown.

RESPOND IN THIS EXACT JSON FORMAT:
{"category":"Category Name","sub_categories":["Sub 1"],"confidence":60,"reasoning":"Brief reason"}`;

    const userPrompt = `Username: @${username}
Name: ${fullname}
Bio: ${bio || "None"}
Database Categories: ${existingCategories || "None"}

Classify based on the above. Return ONLY the JSON.`;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: fallbackPrompt },
                { role: "user", content: userPrompt },
            ],
            temperature: 0.1,
            max_tokens: 200,
        });

        const rawResponse = response.choices[0]?.message?.content || "";
        const usage = response.usage || {};
        const inputTokens = usage.prompt_tokens || 0;
        const outputTokens = usage.completion_tokens || 0;
        const cost = (inputTokens * 0.15 / 1000000) + (outputTokens * 0.60 / 1000000);
        let parsed;
        try {
            parsed = JSON.parse(rawResponse);
        } catch {
            const braceMatch = rawResponse.match(/\{[\s\S]*\}/);
            if (braceMatch) {
                parsed = JSON.parse(braceMatch[0]);
            } else {
                return {
                    influencerName: fullname, handle: username, postsAnalyzed: postsCount,
                    category: null, subCategories: [], reasoning: "Could not parse fallback response",
                };
            }
        }

        if (!CATEGORY_NAMES.includes(parsed.category) && parsed.category !== null) {
            const match = CATEGORY_NAMES.find(
                (c) => c.toLowerCase().includes(parsed.category.toLowerCase()) ||
                    parsed.category.toLowerCase().includes(c.toLowerCase())
            );
            if (match) parsed.category = match;
            else parsed.category = null;
        }

        return {
            influencerName: fullname,
            handle: username,
            postsAnalyzed: postsCount,
            category: parsed.category,
            subCategories: parsed.category === null ? [] : (parsed.sub_categories || []),
            reasoning: `[Fallback] ${parsed.reasoning}`,
            cost: parseFloat(cost.toFixed(6)),
            tokens: { input: inputTokens, output: outputTokens },
        };
    } catch (error) {
        return {
            influencerName: fullname, handle: username, postsAnalyzed: postsCount,
            category: null, subCategories: [], reasoning: `Fallback error: ${error.message}`,
            cost: 0, tokens: { input: 0, output: 0 },
        };
    }
}

function printCategoryResult(result) {
    console.log("\n" + "═".repeat(60));
    console.log("🏷️  CATEGORY ANALYSIS");
    console.log("═".repeat(60));
    console.log(`  Influencer  : ${result.influencerName} (@${result.handle})`);
    console.log(`  Posts Used   : ${result.postsAnalyzed}`);
    console.log(`\n  ✅ Category       : ${result.category}`);
    console.log(`  📂 Sub-Categories : ${result.subCategories.join(", ")}`);
    console.log(`  🎯 Confidence     : ${result.confidence}`);
    console.log(`  💡 Reason         : ${result.reasoning}`);
    console.log("═".repeat(60) + "\n");
}

module.exports = { findCategories, printCategoryResult };
