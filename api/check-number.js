import { Client } from '@neondatabase/serverless';

export default async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { whatsappNumber } = req.body;

  if (!whatsappNumber) {
    return res.status(400).json({ 
      error: 'WhatsApp number is required',
      code: 'MISSING_NUMBER'
    });
  }

  const client = new Client(process.env.DATABASE_URL);
  
  try {
    await client.connect();

    // Check both whatsapp_number and linked_numbers array
    const query = `
      SELECT business_name FROM business_configs 
      WHERE whatsapp_number = $1 OR $1 = ANY(linked_numbers)
      LIMIT 1
    `;
    
    const result = await client.query(query, [whatsappNumber]);

    return res.status(200).json({
      exists: result.rows.length > 0,
      businessName: result.rows[0]?.business_name || null
    });

  } catch (error) {
    console.error('Database error:', error);
    return res.status(500).json({ 
      error: 'Failed to check number',
      code: 'DB_ERROR'
    });
  } finally {
    await client.end().catch(e => console.error('Error closing connection:', e));
  }
};

export const config = {
  runtime: 'edge',
};