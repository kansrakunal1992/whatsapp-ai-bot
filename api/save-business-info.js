import { Client } from '@neondatabase/serverless';

export default async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const businessInfo = req.body;
  if (!businessInfo.whatsappNumber) {
    return res.status(400).json({ error: "WhatsApp number is required" });
  }

  const client = new Client(process.env.DATABASE_URL);
  
  try {
    await client.connect();
    await client.query(
      `INSERT INTO business_configs (
        whatsapp_number, business_name, 
        operating_hours, location, 
        business_type, language
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (whatsapp_number) 
       DO UPDATE SET
         business_name = EXCLUDED.business_name,
         operating_hours = EXCLUDED.operating_hours,
         location = EXCLUDED.location,
         business_type = EXCLUDED.business_type,
         language = EXCLUDED.language`,
      [
        businessInfo.whatsappNumber,
        businessInfo.name,
        businessInfo.operatingHours,
        businessInfo.location,
        businessInfo.businessType,
        businessInfo.language
      ]
    );
    
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Database error:", error);
    return res.status(500).json({ error: "Internal server error" });
  } finally {
    await client.end();
  }
};
