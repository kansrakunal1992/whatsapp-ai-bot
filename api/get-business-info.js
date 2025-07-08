import { Client } from '@neondatabase/serverless';

export default async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const client = new Client(process.env.DATABASE_URL);
  
  try {
    await client.connect();

    // Get the business info from the most recent session
    // You might want to modify this to get by user session or auth token
    const result = await client.query(
      `SELECT 
        whatsapp_number, 
        business_name, 
        operating_hours, 
        location, 
        business_type, 
        language,
        qa_pairs,
        is_pro_account
      FROM business_configs 
      ORDER BY updated_at DESC 
      LIMIT 1`
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No business info found' });
    }

    return res.status(200).json(result.rows[0]);

  } catch (error) {
    console.error('Database error:', error);
    return res.status(500).json({ error: 'Failed to fetch business info' });
  } finally {
    await client.end().catch(e => console.error('Error closing connection:', e));
  }
};

export const config = {
  runtime: 'edge',
};