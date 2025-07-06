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

// Pool Configuration
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  idleTimeoutMillis: 10000,
  allowExitOnIdle: true
});

// Pool health monitoring
let poolErrorCount = 0;
const MAX_POOL_ERRORS = 3;

pool.on('error', err => {
  console.error('[POOL ERROR]', err);
  poolErrorCount++;
});

export default async (req, res) => {
  res.setHeader('Content-Type', 'text/xml');
  let dbClient;
  let usingPool = true;

  try {
    // 1. SANDBOX ACTIVATION
    const userMessage = req.body.Body?.trim().toLowerCase() || '';
    if (userMessage.startsWith('join')) {
      twiml.message("🚀 You're connected! Ask us anything anytime.");
      return res.send(twiml.toString());
    }

    // 2. CONNECTION STRATEGY (Pool fallback logic)
    if (poolErrorCount >= MAX_POOL_ERRORS) {
      console.warn('[FALLBACK] Using single Client due to pool errors');
      dbClient = new Client({ connectionString: process.env.DATABASE_URL });
      await dbClient.connect();
      usingPool = false;
    } else {
      dbClient = await pool.connect();
    }

    // 3. DUPLICATE CHECK
    const messageId = req.body.MessageSid || req.body.SmsSid;
    if (messageId) {
      const { rows: [existing] } = await dbClient.query(
        `SELECT 1 FROM messages WHERE message_id = $1 LIMIT 1`,
        [messageId]
      );
      if (existing) {
        console.log('Duplicate detected - skipping');
        return res.send(twiml.toString());
      }
    }

    // 4. BUSINESS CONFIG
    const cleanNumber = (req.body.To || '').replace('whatsapp:', '');
    const { rows } = await dbClient.query(
      `SELECT qa_pairs, business_name, location, language 
       FROM business_configs
       WHERE $1 = ANY(linked_numbers) OR whatsapp_number = $1
       LIMIT 1`,
      [cleanNumber]
    );
    
    if (!rows.length) {
      throw new Error(`No config for: ${cleanNumber}`);
    }

    // 5. GENERATE RESPONSE
    const aiResponse = await getAIResponse(
      req.body.Body?.slice(0, 1000) || '',
      {
        businessName: rows[0].business_name,
        knownAnswers: rows[0].qa_pairs || {},
        location: rows[0].location
      },
      rows[0].language || 'English'
    );

    // 6. SEND REPLY
    twiml.message(aiResponse.slice(0, 1000));
    res.send(twiml.toString());

    // 7. LOG MESSAGE (non-blocking)
    await dbClient.query(
      `INSERT INTO messages (
        user_number, business_number, message, 
        response, is_sandbox, message_id
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        req.body.From?.slice(0, 50),
        req.body.To?.slice(0, 50),
        req.body.Body?.slice(0, 1000),
        aiResponse.slice(0, 1000),
        SANDBOX_NUMBERS.includes(req.body.To),
        messageId
      ]
    );

  } catch (error) {
    console.error("PROCESSING FAILED:", {
      error: error.message,
      stack: error.stack?.split('\n')[0],
      poolStatus: usingPool ? 'pooled' : 'single-client'
    });

    // Emergency fallback
    twiml.message("We're upgrading our system. Please try again later.");
    res.send(twiml.toString());

  } finally {
    // 8. CONNECTION CLEANUP
    if (dbClient) {
      if (usingPool) {
        dbClient.release(); // Return to pool
      } else {
        await dbClient.end().catch(e => console.error('Client cleanup failed:', e));
      }
    }
    
    // Reset pool error count if successful
    if (usingPool && poolErrorCount > 0) {
      poolErrorCount = 0;
      console.log('[POOL RECOVERED] Reset error count');
    }
  }
};