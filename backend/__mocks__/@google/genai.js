export class GoogleGenAI {
  constructor() {}
  models = {
    generateContent: async () => ({ text: () => 'Mock AI response' })
  }
}
