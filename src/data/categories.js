
const CATEGORIES = {
    "Fashion": [
        "Streetwear", "Luxury Fashion", "Ethnic & Traditional Wear",
        "Men's Fashion", "Women's Fashion", "Sustainable Fashion",
        "Accessories & Jewelry", "Sneaker Culture", "Plus Size Fashion", "Bridal Fashion"
    ],
    "Beauty": [
        "Makeup Artist", "Skincare Expert", "Hair Stylist",
        "Nail Artist", "Men's Grooming", "Organic & Natural Beauty",
        "Fragrance Reviewer", "Beauty Product Reviewer"
    ],
    "Fitness": [
        "Gym & Weight Training", "Yoga & Pilates", "CrossFit & HIIT",
        "Running & Endurance", "Bodybuilding", "Home Workouts",
        "Martial Arts", "Calisthenics", "Women's Fitness", "Dance Fitness"
    ],
    "Wellness": [
        "Mental Health Advocate", "Self Care", "Meditation & Mindfulness",
        "Ayurveda & Naturopathy", "Nutrition & Diet", "Holistic Health",
        "Therapy & Counseling", "Sleep & Recovery"
    ],
    "Travel": [
        "Luxury Traveler", "Budget & Backpack Traveler", "Solo Traveler",
        "Couple & Family Traveler", "Road Tripper", "Hotel & Resort Reviewer",
        "Heritage & Cultural Tourist", "Travel Photographer", "Digital Nomad"
    ],
    "Adventure": [
        "Trekking & Hiking", "Scuba Diving & Snorkeling", "Skydiving & Paragliding",
        "Camping & Overlanding", "Rock Climbing", "Extreme Sports",
        "Wildlife Safari", "Water Sports"
    ],
    "Technology": [
        "Smartphone Reviewer", "Laptop & PC Expert", "AI & Tech Educator",
        "Software & App Reviewer", "Smart Home Expert", "Cybersecurity",
        "EV & Electric Tech", "Tech News & Updates"
    ],
    "Gadgets": [
        "Unboxing Creator", "Wearable & Smart Devices", "Audio & Headphones",
        "Camera & Drone Tech", "Gaming Hardware", "Budget Gadget Finder",
        "Comparison & Spec Reviewer"
    ],
    "Business": [
        "Startup Founder", "E-commerce & D2C", "Freelancer & Side Hustler",
        "Leadership Coach", "Personal Branding Expert", "Small Business Coach",
        "SaaS & B2B", "Real Estate Entrepreneur"
    ],
    "Finance": [
        "Stock Market Trader", "Mutual Fund & SIP Advisor", "Crypto & Web3",
        "Personal Finance Coach", "Tax Planning Expert", "Insurance Advisor",
        "Real Estate Investor", "Financial Literacy Educator"
    ],
    "Gaming": [
        "Mobile Gamer", "PC Gamer", "Console Gamer", "Esports Player",
        "Game Reviewer", "Live Streamer", "Retro Gamer", "VR Gamer"
    ],
    "Esports": [
        "Pro Player", "Team Manager", "Esports Commentator",
        "Tournament Organizer", "Esports Coach", "Content Analyst"
    ],
    "Food": [
        "Restaurant & Cafe Reviewer", "Street Food Explorer", "Home Cook & Recipe Creator",
        "Baker & Dessert Maker", "Regional Cuisine Expert", "Food Photographer",
        "Food Critic", "Healthy Eating Expert"
    ],
    "Cooking": [
        "Home Chef", "Professional Chef", "Baking & Pastry",
        "Quick & Easy Recipes", "Regional & Traditional Cooking",
        "Meal Prep Expert", "Vegan & Vegetarian Chef", "BBQ & Grilling"
    ],
    "Parenting": [
        "Mom Influencer", "Dad Influencer", "Pregnancy & Maternity",
        "Baby Care & Newborn", "Toddler Parenting", "Homeschooling",
        "Kids Fashion & Products", "Single Parent"
    ],
    "Family": [
        "Family Vlogger", "Joint Family Life", "Sibling Content",
        "Family Activities", "Multi-Generational Content", "Family Travel"
    ],
    "Entertainment": [
        "Movie & Web Series Reviewer", "Celebrity News & Gossip",
        "OTT Content Creator", "Reality TV", "Bollywood",
        "Fan Page", "Behind The Scenes"
    ],
    "Pop Culture": [
        "Meme Creator", "Anime & Manga", "K-Pop & K-Drama",
        "Trending Challenges", "Nostalgia & Retro", "Fan Theories",
        "Comic Books & Superheroes"
    ],
    "Sports": [
        "Cricket", "Football", "Basketball", "Badminton & Tennis",
        "Kabaddi & Wrestling", "Boxing & MMA", "Olympics & Athletics",
        "Sports Commentator & Analyst"
    ],
    "Outdoors": [
        "Hiking & Trekking", "Camping", "Fishing",
        "Bird Watching", "Mountain Biking", "Nature Photography",
        "Survival Skills", "Trail Running"
    ],
    "Automotive": [
        "Car Reviewer", "Luxury & Supercar", "Modified Vehicle",
        "EV Enthusiast", "Auto Industry Analyst", "Driving & Road Trip"
    ],
    "Vehicles": [
        "Bike & Motorcycle", "Scooter & Moped", "Off-Road & 4x4",
        "Classic & Vintage Cars", "Commercial Vehicle", "Racing & Motorsport"
    ],
    "DIY": [
        "Home DIY Creator", "Upcycler & Recycler", "Woodworker",
        "Electronics & Tinkering", "3D Printing", "Garage Projects"
    ],
    "Home Improvement": [
        "Interior Designer", "Home Renovation", "Gardening & Landscaping",
        "Smart Home Setup", "Furniture & Decor", "Organization & Declutter"
    ],
    "Education": [
        "Exam Prep Coach", "Language Teacher", "Skill Development Trainer",
        "Edtech & Online Course Creator", "Career Counselor", "Academic Tutor"
    ],
    "Learning": [
        "Science Educator", "History & GK Expert", "Coding & Programming",
        "Creative Skills", "Financial Literacy", "Life Skills Coach"
    ],
    "Pets": [
        "Dog Parent", "Cat Parent", "Pet Trainer",
        "Exotic Pet Owner", "Pet Product Reviewer", "Pet Groomer"
    ],
    "Animals": [
        "Animal Rescue", "Wildlife & Nature", "Marine Life",
        "Farm & Rural Animals", "Zoo & Sanctuary", "Animal Rights Activist"
    ],
    "Photography": [
        "Portrait Photographer", "Landscape & Nature Photographer",
        "Street Photographer", "Wedding Photographer", "Product Photographer",
        "Drone & Aerial Photographer", "Photo Editor & Retoucher"
    ],
    "Videography": [
        "Cinematic Videographer", "Documentary Maker", "Short Film Creator",
        "Wedding Videographer", "Music Video Director", "Vlog Cinematographer"
    ],
    "Music": [
        "Singer & Vocalist", "Rapper & Hip Hop", "Classical & Instrumental",
        "EDM & DJ", "Music Producer", "Indie Artist",
        "Bollywood Musician", "Cover Song Creator"
    ],
    "Performing Arts": [
        "Stand-up Comedian", "Theatre Actor", "Dancer & Choreographer",
        "Magician & Illusionist", "Spoken Word & Poetry", "Street Performer"
    ],
    "Personal Development": [
        "Life Coach", "Mindset & Success Coach", "Public Speaking Coach",
        "Book Reviewer & Reader", "Habit Building", "Time Management"
    ],
    "Motivation": [
        "Motivational Speaker", "Fitness Motivation", "Entrepreneurship Motivation",
        "Student Motivation", "Comeback & Transformation Stories", "Daily Affirmations"
    ],
    "Science": [
        "Physics & Space", "Biology & Medicine", "Chemistry & Materials",
        "Environmental Science", "Technology & Innovation", "Myth Busting & Facts"
    ],
    "Space": [
        "Astronomy", "Astrophotography", "Space News & Updates",
        "Rocket & Satellite Tech", "Space Exploration", "Stargazing"
    ],
    "Lifestyle": [
        "Daily Vlogger", "Minimalist", "Luxury Lifestyle",
        "Routine Creator", "Aesthetic Content", "Work-Life Balance"
    ],
    "Vlogs": [
        "Daily Vlogger", "Travel Vlogger", "Family Vlogger",
        "Challenge & Dare", "Day-In-My-Life", "College & Student Life"
    ],
    "Luxury": [
        "Luxury Brand Ambassador", "Luxury Unboxing", "High-End Fashion",
        "Luxury Travel", "Fine Dining", "Premium Watches & Accessories"
    ],
    "High-End Living": [
        "Real Estate & Mansions", "Supercar Collection", "Private Jet & Yacht",
        "Exclusive Events", "VIP Lifestyle", "Penthouse & Villa Tours"
    ],
    "Health": [
        "Doctor & Medical Advisor", "Physiotherapist", "Dentist",
        "Dietitian & Nutritionist", "Fertility & Pregnancy Expert",
        "Mental Health Professional"
    ],
    "Medical": [
        "Medical Student", "Surgeon", "Dermatologist",
        "Ayurveda & Naturopathy", "Pharmacist", "Nursing Professional"
    ],
    "Social Activism": [
        "Environmental Activist", "Women's Rights Advocate", "LGBTQ+ Advocate",
        "Education Activist", "Rural Development", "Anti-Corruption"
    ],
    "Advocacy": [
        "Mental Health Awareness", "Disability Rights", "Child Welfare",
        "Animal Welfare", "Digital Privacy", "Anti-Bullying"
    ],
    "Sustainability": [
        "Zero Waste Living", "Eco-Friendly Products", "Sustainable Fashion",
        "Renewable Energy", "Organic Farming", "Climate Action"
    ],
    "Eco-Living": [
        "Minimalist Living", "Off-Grid Living", "Urban Farming",
        "Composting & Recycling", "Vegan Lifestyle", "Conscious Consumer"
    ],
    "Relationships": [
        "Couple Content", "Marriage Advice", "Long Distance Relationships",
        "Breakup Recovery", "Family Relationships", "Friendship"
    ],
    "Dating": [
        "Dating Tips & Advice", "Online Dating", "First Date Ideas",
        "Relationship Coach", "Singles Life", "Love & Romance"
    ],
    "Spirituality": [
        "Astrologer", "Tarot Reader", "Vedic Knowledge",
        "Meditation Guide", "Numerologist", "Religious Content Creator"
    ],
    "Mindfulness": [
        "Meditation Coach", "Breathing Techniques", "Journaling & Reflection",
        "Gratitude Practice", "Stress Management", "Sound Healing"
    ],
    "Humor": [
        "Meme Creator", "Sketch & Skit Creator", "Roast & Satire",
        "Prankster", "Regional Comedy", "Observational Humor"
    ],
    "Comedy": [
        "Stand-up Comedian", "Improv & Sketch", "Dark Humor",
        "Parody & Mimicry", "Comedy Podcast", "Duo & Group Comedy"
    ],
    "ASMR": [
        "Eating & Food ASMR", "Tapping & Scratching", "Whispering",
        "Nature Sounds", "Slime & Soap Cutting", "Roleplay ASMR"
    ],
    "Relaxation": [
        "Ambient Sounds", "Nature & Scenic Videos", "Lo-Fi & Chill Music",
        "Guided Meditation", "Sleep Stories", "Visual Therapy"
    ],
    "Unboxing": [
        "Tech Unboxing", "Fashion & Beauty Unboxing", "Toy & Collectibles",
        "Subscription Box", "Mystery Box", "Luxury Unboxing"
    ],
    "Product Reviews": [
        "Tech Product Reviews", "Beauty & Skincare Reviews", "Home & Kitchen",
        "Fashion & Accessories", "Health & Fitness Products", "Budget vs Premium"
    ],
    "Art & Design": [
        "Digital Artist & Illustrator", "Painter & Sketcher", "Graphic Designer",
        "Calligrapher", "Sculptor & Potter", "Art Educator",
        "NFT & Crypto Artist", "Tattoo Artist"
    ],
    "Dance": [
        "Bollywood Dancer", "Hip Hop & Street Dancer", "Classical Dancer",
        "Contemporary & Freestyle", "Dance Cover Creator", "Choreographer",
        "Latin & Salsa", "Dance Tutorial Creator"
    ],
    "Real Estate": [
        "Home Buying Advisor", "Property Investor", "Interior Designer",
        "Architect", "Rental & Co-living", "Luxury Property Tours"
    ],
    "Wedding & Events": [
        "Wedding Planner", "Bridal Makeup & Stylist", "Destination Wedding Expert",
        "Event Manager", "Wedding Photographer", "Sangeet & Mehendi"
    ],
    "Books & Literature": [
        "Book Reviewer", "Poet & Shayari Writer", "Storyteller",
        "Creative Writer", "Bookstagrammer", "Author & Novelist"
    ],
    "News & Current Affairs": [
        "Political Commentator", "Business & Economy Analyst", "Tech News",
        "Fact-Checker", "Regional News", "International Affairs"
    ],
    "Crypto & Web3": [
        "Bitcoin & Crypto Trader", "NFT Creator & Collector", "DeFi & Blockchain",
        "Web3 Developer", "Metaverse & Virtual Worlds", "Crypto Educator"
    ],
    "Gardening & Plants": [
        "Home Gardener", "Terrace & Balcony Garden", "Kitchen Garden",
        "Plantfluencer", "Bonsai & Succulents", "Organic Farming"
    ],
    "Astrology & Tarot": [
        "Vedic Astrologer", "Western Astrologer", "Tarot Card Reader",
        "Numerologist", "Palmist", "Horoscope Creator"
    ]
};

const CATEGORY_NAMES = Object.keys(CATEGORIES);

const CATEGORY_PROMPT = Object.entries(CATEGORIES)
    .map(([cat, subs]) => `${cat}: ${subs.join(", ")}`)
    .join("\n");

module.exports = { CATEGORIES, CATEGORY_NAMES, CATEGORY_PROMPT };
