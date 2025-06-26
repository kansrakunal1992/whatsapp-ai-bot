import { Client } from '@neondatabase/serverless';

export default async (req, res) => {
  const { whatsappNumber } = req.query;
  const client = new Client(process.env.DATABASE_URL);

  try {
    await client.connect();
    const { rows } = await client.query(`
      SELECT qa_pairs FROM business_configs
      WHERE whatsapp_number = $1
    `, [whatsappNumber]);
    
    res.status(200).json(rows[0]?.qa_pairs || {});
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({ error: "Failed to fetch Q&A" });
  } finally {
    await client.end();
  }
};
