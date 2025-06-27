// pages/api/get-unanswered.js
import { Client } from '@neondatabase/serverless';

export default async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();

  const { whatsappNumber } = req.query;
  const client = new Client(process.env.DATABASE_URL);

  try {
    await client.connect();
    const { rows } = await client.query(`
      SELECT id, user_number, question, received_at
      FROM unanswered_questions
      WHERE whatsapp_number = $1 AND handled = false
      ORDER BY received_at DESC
    `, [whatsappNumber]);
    
    res.status(200).json(rows);
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({ error: "Failed to fetch unanswered questions" });
  } finally {
    await client.end();
  }
};
