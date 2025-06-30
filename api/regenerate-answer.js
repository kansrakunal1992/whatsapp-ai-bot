import { getAIResponse } from '../utils/ai-helper.js';

export default async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { question, currentAnswer, businessContext, language } = req.body;
  if (!question) {
    return res.status(400).json({ error: "Question is required" });
  }

  try {
    const prompt = `Rephrase this business response to be more natural while maintaining professionalism:
    
Original Question: ${question}
Current Answer: ${currentAnswer}

Please provide a more colloquial yet professional version in ${language || 'English'}.`;

    const answer = await getAIResponse(
      prompt,
      businessContext,
      language
    );

    return res.status(200).json({ 
      answer: answer || currentAnswer 
    });
  } catch (error) {
    console.error("Regeneration error:", error);
    return res.status(500).json({ 
      error: "Failed to regenerate answer",
      answer: currentAnswer
    });
  }
};
