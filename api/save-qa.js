import { Client } from '@neondatabase/serverless';

export default async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { whatsappNumber, qaPairs } = req.body;
  if (!whatsappNumber || !qaPairs) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const client = new Client(process.env.DATABASE_URL);
  
  try {
    await client.connect();
    await client.query(
      `INSERT INTO business_configs (whatsapp_number, qa_pairs)
       VALUES ($1, $2)
       ON CONFLICT (whatsapp_number) 
       DO UPDATE SET qa_pairs = EXCLUDED.qa_pairs`,
      [whatsappNumber, qaPairs]
    );
    
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Database error:", error);
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    await client.end();
  }
};
