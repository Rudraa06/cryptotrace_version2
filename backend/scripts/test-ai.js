import { GoogleGenAI } from '@google/genai';

async function run() {
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: 'Tell me a joke.'
    });
    console.log(response.text);
  } catch (err) {
    console.error('ERROR:', err);
  }
}

run();
