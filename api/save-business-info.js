import { Client } from '@neondatabase/serverless';

export default async (req, res) => {
    if (req.method !== 'POST') return res.status(405).end();
    
    const { name, type, whatsappNumber, language, operatingHours, location } = req.body;
    const client = new Client(process.env.DATABASE_URL);

    try {
        await client.connect();
        await client.query(`
            INSERT INTO business_configs (
                whatsapp_number,
                business_name,
                business_type,
                language,
                operating_hours,
                location
            ) VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (whatsapp_number)
            DO UPDATE SET
                business_name = $2,
                business_type = $3,
                language = $4,
                operating_hours = $5,
                location = $6,
                last_updated = NOW()
        `, [
            whatsappNumber,
            name,
            type,
            language,
            JSON.stringify(operatingHours),
            location
        ]);
        
        res.status(200).json({ success: true });
    } catch (error) {
        console.error("Database error:", error);
        res.status(500).json({ error: "Failed to save business info" });
    } finally {
        await client.end();
    }
};
