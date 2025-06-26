import { Client } from '@neondatabase/serverless';

export default async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { whatsappNumber, qaPairs } = req.body;
  const client = new Client(process.env.DATABASE_URL);

  try {
    await client.connect();
    await client.query(`
      INSERT INTO business_configs (whatsapp_number, qa_pairs)
      VALUES ($1, $2)
      ON CONFLICT (whatsapp_number)
      DO UPDATE SET 
        qa_pairs = EXCLUDED.qa_pairs,
        last_updated = NOW()
    `, [whatsappNumber, JSON.stringify(qaPairs)]);
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({ error: "Failed to save Q&A" });
  } finally {
    await client.end();
  }
};
