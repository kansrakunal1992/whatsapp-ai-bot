import { Client } from '@neondatabase/serverless';

export default async (req, res) => {
  const { whatsappNumber } = req.query;
  if (!whatsappNumber) {
    return res.status(400).json({ error: "WhatsApp number is required" });
  }

  const client = new Client(process.env.DATABASE_URL);
  
  try {
    await client.connect();
    
    // Modified query to handle both direct and linked numbers lookup
    const { rows } = await client.query(
      `SELECT 
        business_name, 
        whatsapp_number, 
        operating_hours, 
        location, 
        business_type, 
        language,
        linked_numbers
       FROM business_configs 
       WHERE whatsapp_number = $1 
          OR $1 = ANY(linked_numbers)`,
      [whatsappNumber]
    );

    if (rows.length > 0) {
      const result = rows[0];
      // Ensure language field is properly formatted
      if (!result.language) {
        result.language = 'English'; // Default if missing
      }
      // Ensure linked_numbers is always an array
      if (!result.linked_numbers) {
        result.linked_numbers = [result.whatsapp_number];
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