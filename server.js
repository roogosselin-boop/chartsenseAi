const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize clients
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Price IDs
const PRICE_IDS = {
    starter: process.env.STRIPE_PRICE_STARTER,
    pro: process.env.STRIPE_PRICE_PRO,
    unlimited: process.env.STRIPE_PRICE_UNLIMITED
};

// Plan limits
const PLAN_LIMITS = {
    starter: 30,
    pro: 100,
    unlimited: 999999
};

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'ChartPredict API is running' });
});

// Check/Create user endpoint
app.post('/user', async (req, res) => {
    try {
        const { email, name, avatar_url } = req.body;
        
        if (!email) {
            return res.status(400).json({ error: 'Email required' });
        }

        // Check if user exists
        let { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('email', email)
            .single();

        if (error && error.code === 'PGRST116') {
            // User doesn't exist, create new user
            const { data: newUser, error: insertError } = await supabase
                .from('users')
                .insert([{ 
                    email, 
                    name, 
                    avatar_url,
                    subscription_status: 'free',
                    analyses_used: 0,
                    analyses_limit: 0
                }])
                .select()
                .single();

            if (insertError) {
                console.error('Insert error:', insertError);
                return res.status(500).json({ error: 'Failed to create user' });
            }
            user = newUser;
        } else if (error) {
            console.error('Query error:', error);
            return res.status(500).json({ error: 'Database error' });
        }

        res.json(user);
    } catch (error) {
        console.error('User error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Check subscription status
app.post('/check-subscription', async (req, res) => {
    try {
        const { email } = req.body;
        
        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('email', email)
            .single();

        if (error || !user) {
            return res.json({ 
                canAnalyze: false, 
                reason: 'User not found',
                analysesUsed: 0,
                analysesLimit: 0
            });
        }

        const canAnalyze = user.subscription_status === 'active' && 
                          user.analyses_used < user.analyses_limit;

        res.json({
            canAnalyze,
            reason: canAnalyze ? 'OK' : 'Subscription required or limit reached',
            subscriptionStatus: user.subscription_status,
            subscriptionPlan: user.subscription_plan,
            analysesUsed: user.analyses_used,
            analysesLimit: user.analyses_limit
        });
    } catch (error) {
        console.error('Check subscription error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Create Stripe Checkout Session
app.post('/create-checkout-session', async (req, res) => {
    try {
        const { plan, email } = req.body;
        
        if (!PRICE_IDS[plan]) {
            return res.status(400).json({ error: 'Invalid plan selected' });
        }

        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            payment_method_types: ['card'],
            customer_email: email,
            line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
            success_url: `${FRONTEND_URL}?success=true&plan=${plan}&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${FRONTEND_URL}?canceled=true`,
            metadata: { plan, email }
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Stripe error:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// Stripe Webhook
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const email = session.customer_email || session.metadata?.email;
        const plan = session.metadata?.plan;

        if (email && plan) {
            await supabase
                .from('users')
                .update({
                    subscription_status: 'active',
                    subscription_plan: plan,
                    stripe_customer_id: session.customer,
                    analyses_limit: PLAN_LIMITS[plan],
                    analyses_used: 0,
                    updated_at: new Date().toISOString()
                })
                .eq('email', email);
        }
    }

    if (event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object;
        await supabase
            .from('users')
            .update({
                subscription_status: 'canceled',
                updated_at: new Date().toISOString()
            })
            .eq('stripe_customer_id', subscription.customer);
    }

    res.json({ received: true });
});

// Verify payment (called after successful checkout)
app.post('/verify-payment', async (req, res) => {
    try {
        const { sessionId, email, plan } = req.body;

        // Verify the session with Stripe
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        
        if (session.payment_status === 'paid') {
            // Update user in database
            await supabase
                .from('users')
                .update({
                    subscription_status: 'active',
                    subscription_plan: plan,
                    stripe_customer_id: session.customer,
                    analyses_limit: PLAN_LIMITS[plan],
                    analyses_used: 0,
                    updated_at: new Date().toISOString()
                })
                .eq('email', email);

            res.json({ success: true });
        } else {
            res.json({ success: false, error: 'Payment not completed' });
        }
    } catch (error) {
        console.error('Verify payment error:', error);
        res.status(500).json({ error: 'Verification failed' });
    }
});

// Chart analysis endpoint (with paywall)
app.post('/analyze', async (req, res) => {
    try {
        const { imageData, mode, email, bypassCode } = req.body;

        // Check for bypass code
        if (bypassCode !== 'v00347') {
            // Check subscription
            if (!email) {
                return res.status(401).json({ error: 'auth_required', message: 'Please sign in to analyze charts' });
            }

            const { data: user, error } = await supabase
                .from('users')
                .select('*')
                .eq('email', email)
                .single();

            if (error || !user) {
                return res.status(401).json({ error: 'auth_required', message: 'User not found' });
            }

            if (user.subscription_status !== 'active') {
                return res.status(403).json({ error: 'subscription_required', message: 'Please subscribe to analyze charts' });
            }

            if (user.analyses_used >= user.analyses_limit) {
                return res.status(403).json({ error: 'limit_reached', message: 'Monthly analysis limit reached. Please upgrade your plan.' });
            }

            // Increment usage
            await supabase
                .from('users')
                .update({ 
                    analyses_used: user.analyses_used + 1,
                    updated_at: new Date().toISOString()
                })
                .eq('email', email);
        }

        if (!imageData) {
            return res.status(400).json({ error: 'No image data provided' });
        }

        const matches = imageData.match(/^data:(.+);base64,(.+)$/);
        if (!matches) {
            return res.status(400).json({ error: 'Invalid image format' });
        }

        const mediaType = matches[1];
        const base64Data = matches[2];

        const prompt = mode === 'instant'
            ? `You are a professional futures/stock trading analyst. Analyze this trading chart screenshot.

The trader wants to ENTER THE TRADE IMMEDIATELY for a quick 5-minute scalp.

IMPORTANT: 
- Look at the actual price shown on the chart and use those EXACT price levels
- Keep stop loss and take profit TIGHT (within 5-15 ticks/points of entry for a quick scalp)
- If this is NOT a trading chart, respond with: {"error": "not_a_chart"}

If it IS a trading chart, respond with ONLY this JSON format (no other text):
{
    "direction": "LONG" or "SHORT",
    "confidence": number 60-95,
    "currentPrice": "exact price from chart",
    "stopLoss": "price level close to entry",
    "takeProfit": "price level close to entry", 
    "riskReward": "ratio like 1:1.5",
    "winRate": "percentage like 68%",
    "analysis": "2-3 sentences explaining WHY based on what you see - mention specific patterns, indicators, support/resistance levels visible on the chart"
}`
            : `You are a professional futures/stock trading analyst. Analyze this trading chart screenshot.

The trader wants to WAIT FOR A BETTER ENTRY for a quick 5-minute scalp.

IMPORTANT:
- Look at the actual price shown on the chart and use those EXACT price levels
- Identify a better entry point (pullback level, support/resistance retest, etc.)
- Keep stop loss and take profit TIGHT (within 5-15 ticks/points for a quick scalp)
- If this is NOT a trading chart, respond with: {"error": "not_a_chart"}

If it IS a trading chart, respond with ONLY this JSON format (no other text):
{
    "direction": "LONG" or "SHORT",
    "confidence": number 60-95,
    "currentPrice": "exact current price from chart",
    "entryPrice": "optimal entry price to wait for",
    "stopLoss": "price level close to entry",
    "takeProfit": "price level close to entry",
    "riskReward": "ratio like 1:2",
    "winRate": "percentage like 72%",
    "waitReason": "1 sentence on why this entry is better",
    "analysis": "2-3 sentences explaining WHY based on what you see - mention specific patterns, indicators, support/resistance levels visible on the chart"
}`;

        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            messages: [{
                role: 'user',
                content: [
                    { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
                    { type: 'text', text: prompt }
                ]
            }]
        });

        let resultText = response.content[0].text;
        resultText = resultText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        
        try {
            const result = JSON.parse(resultText);
            res.json(result);
        } catch (parseError) {
            res.status(400).json({ 
                error: 'analysis_failed',
                message: 'Could not analyze the image. Please try a clearer chart screenshot.'
            });
        }

    } catch (error) {
        console.error('Analysis error:', error);
        res.status(500).json({ error: 'server_error', message: 'Analysis failed. Please try again.' });
    }
});

app.listen(PORT, () => {
    console.log(`ChartPredict API running on port ${PORT}`);
});
