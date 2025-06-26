import { Client } from '@neondatabase/serverless';
const { MessagingResponse } = require('twilio').twiml;

export default async (req, res) => {
  res.setHeader('Content-Type', 'text/xml');
  const twiml = new MessagingResponse();
  let neonClient;

  try {
    // 1. Connect to Neon
    neonClient = new Client(process.env.DATABASE_URL);
    await neonClient.connect();

    // 2. Auto-create table if missing
    await neonClient.query(`
      CREATE TABLE IF NOT EXISTS message_counts (
        user_number TEXT PRIMARY KEY,
        count INT DEFAULT 1
      );
    `);

    // 3. Process message
    const userNumber = req.body.From;
    const { rows } = await neonClient.query(`
      INSERT INTO message_counts (user_number, count)
      VALUES ($1, 1)
      ON CONFLICT (user_number) 
      DO UPDATE SET count = message_counts.count + 1
      RETURNING count;
    `, [userNumber]);

    // 4. Check limit
    if (rows[0].count > 30) {
      twiml.message("Free trial limit reached (30/30).");
      return res.send(twiml.toString());
    }

    // 5. Simple response
    twiml.message(`✅ Message ${rows[0].count}/30 processed`);

  } catch (error) {
    console.error('Database error:', error);
    twiml.message("⚠️ Temporary system issue. Try again later.");
  } finally {
    if (neonClient) await neonClient.end();
  }

  return res.send(twiml.toString());
};