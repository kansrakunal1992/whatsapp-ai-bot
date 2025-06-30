import { Client } from '@neondatabase/serverless';

export default async (req, res) => {
  const { whatsappNumber } = req.query;
  if (!whatsappNumber) {
    return res.status(400).json({ error: "WhatsApp number is required" });
  }

  const client = new Client(process.env.DATABASE_URL);
  
  try {
    await client.connect();
    const { rows } = await client.query(
      `SELECT qa_pairs FROM business_configs 
       WHERE whatsapp_number = $1`,
      [whatsappNumber]
    );

    if (rows.length > 0) {
      return res.status(200).json(rows[0].qa_pairs || {});
    }
    
    return res.status(200).json({});
  } catch (error) {
    console.error("Database error:", error);
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    await client.end();
  }
};
