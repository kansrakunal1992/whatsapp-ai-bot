import { getAIResponse } from './utils/ai-helper.js';

export default async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { question, businessContext, currentAnswer } = req.body;

  try {
    const prompt = `Rephrase this business response to be more natural while maintaining professionalism:
    
Original Question: ${question}
Current Answer: ${currentAnswer}

Please provide a more colloquial yet professional version in ${businessContext.language || 'English'}.`;

    const answer = await getAIResponse(prompt, businessContext, businessContext.language);
    
    res.json({ answer });
  } catch (error) {
    console.error("Regeneration error:", error);
    res.status(500).json({ error: "Failed to regenerate answer" });
  }
};
