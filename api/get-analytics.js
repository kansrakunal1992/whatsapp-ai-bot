import { Client } from '@neondatabase/serverless';

export default async (req, res) => {
  // 1. Validate input
  const { number } = req.query;
  if (!number || !/^(\+91|91)?\d{10}$/.test(number)) {
    return res.status(400).json({ 
      error: "Valid Indian WhatsApp number required",
      example: "919876543210"
    });
  }

  const client = new Client(process.env.DATABASE_URL);
  
  try {
    await client.connect();

    // 2. Get 7-day summary (optimized single query)
    const { rows: [metrics] } = await client.query(`
      SELECT
        COUNT(*) as total_chats,
        SUM(CASE WHEN is_answered THEN 1 ELSE 0 END) as answered,
        ROUND(100 * AVG(CASE WHEN is_answered THEN 1 ELSE 0 END)) as response_rate,
        COUNT(DISTINCT customer_number) as unique_customers
      FROM message_logs
      WHERE business_number = $1
      AND timestamp > NOW() - INTERVAL '7 days'
    `, [number.replace('+91', '91')]); // Normalize format

    // 3. Get unanswered queries (last 24 hours)
    const { rows: unanswered } = await client.query(`
      SELECT 
        customer_number,
        message,
        TO_CHAR(timestamp, 'DD Mon HH24:MI') as time
      FROM message_logs
      WHERE business_number = $1
      AND is_answered = false
      AND timestamp > NOW() - INTERVAL '1 day'
      ORDER BY timestamp DESC
      LIMIT 10
    `, [number.replace('+91', '91')]);

    // 4. Get peak hours (for Indian timezone)
    const { rows: peakHours } = await client.query(`
      SELECT 
        EXTRACT(HOUR FROM timestamp AT TIME ZONE 'Asia/Kolkata') as hour,
        COUNT(*) as message_count
      FROM message_logs
      WHERE business_number = $1
      GROUP BY hour
      ORDER BY message_count DESC
      LIMIT 3
    `, [number.replace('+91', '91')]);

    // 5. Format response for Indian businesses
    res.status(200).json({
      summary: {
        total_chats: metrics.total_chats || 0,
        response_rate: metrics.response_rate || 0,
        unique_customers: metrics.unique_customers || 0
      },
      unanswered,
      peak_hours: peakHours.map(h => ({
        hour: `${h.hour}:00 - ${h.hour + 1}:00 IST`,
        count: h.message_count
      })),
      last_updated: new Date().toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata'
      })
    });

  } catch (error) {
    console.error("Analytics error:", {
      error: error.message,
      number: number.slice(-4) + '****' // Mask for logs
    });
    res.status(500).json({ 
      error: "Failed to generate analytics",
      solution: "Check server logs"
    });
  } finally {
    await client.end();
  }
};
