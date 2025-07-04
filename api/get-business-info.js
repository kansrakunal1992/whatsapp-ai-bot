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
      `SELECT business_name, whatsapp_number, 
              operating_hours, location, 
              business_type, language 
       FROM business_configs 
       WHERE whatsapp_number = $1`,
      [whatsappNumber]
    );

    if (rows.length > 0) {
      // Ensure language field is properly formatted
      const result = rows[0];
      if (!result.language) {
        result.language = 'English'; // Default if missing
      }
      return res.status(200).json(result);
    }
    
    return res.status(200).json({});
  } catch (error) {
    console.error("Database error:", error);
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    await client.end();
  }
};