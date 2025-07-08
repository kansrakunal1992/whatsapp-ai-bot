import { Client } from '@neondatabase/serverless';

export default async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const businessInfo = req.body;
  const client = new Client(process.env.DATABASE_URL);

  try {
    await client.connect();
    await client.query('BEGIN');

    // UPSERT operation - updates if whatsapp_number exists, otherwise inserts
    const result = await client.query(
      `INSERT INTO business_configs (
        whatsapp_number, 
        business_name, 
        operating_hours, 
        location, 
        business_type, 
        language,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      ON CONFLICT (whatsapp_number) 
      DO UPDATE SET
        business_name = EXCLUDED.business_name,
        operating_hours = EXCLUDED.operating_hours,
        location = EXCLUDED.location,
        business_type = EXCLUDED.business_type,
        language = EXCLUDED.language,
        updated_at = NOW()
      RETURNING *`,
      [
        businessInfo.whatsappNumber,
        businessInfo.name,
        businessInfo.operatingHours || { opening: "09:00", closing: "18:00" },
        businessInfo.location || "Not specified",
        businessInfo.type || "Other",
        businessInfo.language || "English"
      ]
    );

    await client.query('COMMIT');
    return res.status(200).json(result.rows[0]);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Database error:', error);
    return res.status(500).json({ 
      error: "Failed to save business info",
      details: error.message 
    });
  } finally {
    await client.end().catch(e => console.error('Error closing connection:', e));
  }
};

export const config = {
  runtime: 'edge',
};