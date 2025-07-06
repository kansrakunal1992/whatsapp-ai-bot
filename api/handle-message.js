import { Pool, Client } from '@neondatabase/serverless';
import twilio from 'twilio';
import { getAIResponse } from './utils/ai-helper.js';

const twiml = new twilio.twiml.MessagingResponse();

// Constants
const SANDBOX_NUMBERS = [
  'whatsapp:+14155238886',
  '+14155238886',
  ...(process.env.TWILIO_SANDBOX_NUMBERS?.split(',') || [])
].map(num => num.trim());

// Pool Configuration (Neon-optimized)
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL, // Uses pooled connection
  max: 3,                  // Optimal for serverless
  idleTimeoutMillis: 5000,  // Matches Neon's 5s idle timeout
  allowExitOnIdle: true,    // Critical for Vercel
  ssl: { rejectUnauthorized: false }
});

// Pool health monitoring
let poolErrorCount = 0;
const MAX_POOL_ERRORS = 2; // Switch to Client after 2 failures

pool.on('error', err => {
  console.error('[POOL ERROR]', err.message);
  poolErrorCount++;
});

// Warm up the pool
pool.query('SELECT 1').catch(() => {});

export default async (req, res) => {
  res.setHeader('Content-Type', 'text/xml');
  let dbClient;
  let usingPool = true;

  try {
    // --- PHASE 1: Initial Checks ---
    const userMessage = req.body.Body?.trim().toLowerCase() || '';
    const fromNumber = req.body.From?.slice(0, 50) || '';
    const toNumber = req.body.To?.slice(0, 50) || '';

    // 1A. Sandbox Activation
    if (userMessage.startsWith('join')) {
      twiml.message("🚀 You're connected! Ask us anything anytime.");
      return res.send(twiml.toString());
    }

    // --- PHASE 2: Database Connection ---
    if (poolErrorCount >= MAX_POOL_ERRORS) {
      console.warn('[FALLBACK] Using direct Client due to pool errors');
      dbClient = new Client({
        connectionString: process.env.POSTGRES_URL_NON_POOLING,
        ssl: { rejectUnauthorized: false }
      });
      await dbClient.connect();
      usingPool = false;
    } else {
      dbClient = await pool.connect();
    }

    // --- PHASE 3: Message Processing ---
    // 3A. Duplicate Check
    const messageId = req.body.MessageSid?.slice(0, 34);
    if (messageId) {
      const { rows: [existing] } = await dbClient.query(
        `SELECT 1 FROM messages WHERE message_id = $1 LIMIT 1`,
        [messageId]
      );
      if (existing) {
        console.log('Duplicate message ignored');
        return res.send(twiml.toString());
      }
    }

    // 3B. Business Config
    const cleanNumber = toNumber.replace('whatsapp:', '');
    const { rows: [config] } = await dbClient.query(
      `SELECT 
        business_name, 
        qa_pairs, 
        language,
        location
       FROM business_configs
       WHERE $1 = ANY(linked_numbers) OR whatsapp_number = $1
       LIMIT 1`,
      [cleanNumber]
    );

    if (!config) {
      throw new Error(`No config for number: ${cleanNumber}`);
    }

    // 3C. AI Response Generation (with timeout)
    const aiResponse = await Promise.race([
      getAIResponse(
        userMessage.slice(0, 1000),
        {
          businessName: config.business_name,
          knownAnswers: config.qa_pairs || {},
          location: config.location
        },
        config.language || 'English'
      ),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('AI timeout')), 10000)
      )
    ]);

    // --- PHASE 4: Response Handling ---
    twiml.message(aiResponse.slice(0, 1000));
    res.send(twiml.toString());

    // --- PHASE 5: Logging (non-blocking) ---
    await dbClient.query(
      `INSERT INTO messages (
        user_number, business_number,
        message, response,
        is_sandbox, message_id
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        fromNumber,
        toNumber,
        userMessage.slice(0, 1000),
        aiResponse.slice(0, 1000),
        SANDBOX_NUMBERS.some(n => toNumber.includes(n)),
        messageId
      ]
    );

  } catch (error) {
    console.error('[ERROR]', {
      error: error.message,
      poolStatus: usingPool ? 'pool' : 'direct-client',
      trace: error.stack?.split('\n').slice(0, 2).join(' | ')
    });

    // Emergency fallback
    twiml.message("We're experiencing high demand. Please try again later.");
    res.send(twiml.toString());

  } finally {
    // --- PHASE 6: Cleanup ---
    if (dbClient) {
      if (usingPool) {
        dbClient.release();
        // Reset error count if successful
        if (poolErrorCount > 0) poolErrorCount = 0;
      } else {
        await dbClient.end().catch(e => 
          console.error('Client cleanup failed:', e.message)
        );
      }
    }
  }
};