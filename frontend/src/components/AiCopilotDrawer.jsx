import React, { useState, useRef, useEffect } from 'react';
import { X, Send, Bot, User, MessageSquare, Loader2 } from 'lucide-react';
import { API_BASE } from '../utils/constants.js';


export default function AiCopilotDrawer({ isOpen, onClose, traceData }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  const handleSend = async (text) => {
    if (!text.trim()) return;
    
    const userMsg = { role: 'user', content: text };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const headers = { 
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      };

      const res = await fetch(`${API_BASE}/api/ai/copilot-chat`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({
          traceContext: traceData,
          query: text,
          history: messages.filter(m => !m.content.startsWith('Error:'))
        })
      });

      const data = await res.json();
      if (data.ok) {
        setMessages(prev => [...prev, { role: 'model', content: data.response }]);
      } else {
        const errPayload = data.error || data.response;
        const errMsg = typeof errPayload === 'object' ? (errPayload.message || JSON.stringify(errPayload)) : errPayload;
        setMessages(prev => [...prev, { role: 'model', content: `Error: ${errMsg}` }]);
      }
    } catch (err) {
      setMessages(prev => [...prev, { role: 'model', content: 'Connection to AI Copilot failed.' }]);
    } finally {
      setLoading(false);
    }
  };

  const suggestions = [
    "Why is Hop #2 flagged as high risk?",
    "Draft an exchange freeze notice.",
    "Summarize the laundering technique."
  ];

  return (
    <div className={`fixed inset-y-0 right-0 w-96 bg-[#0a0e17] border-l border-[var(--color-border-subtle)] transform transition-transform duration-300 z-50 flex flex-col shadow-[0_0_50px_rgba(0,0,0,0.8)] ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}>
      
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-[var(--color-border-subtle)] bg-[rgba(10,14,23,0.9)]">
        <div className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-cyan-400" />
          <h3 className="font-bold text-white">AI Investigator Copilot</h3>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
        {messages.length === 0 ? (
          <div className="text-center mt-10">
            <div className="w-12 h-12 rounded-full bg-cyan-900/30 flex items-center justify-center mx-auto mb-4">
              <MessageSquare className="w-6 h-6 text-cyan-400" />
            </div>
            <p className="text-sm text-[var(--color-text-muted)] mb-6">Ask me anything about this trace, risk factors, or to draft legal notices.</p>
            
            <div className="flex flex-col gap-2">
              {suggestions.map((sug, i) => (
                <button 
                  key={i}
                  onClick={() => handleSend(sug)}
                  className="text-left text-xs bg-slate-800/50 border border-[var(--color-border-subtle)] p-3 rounded-lg hover:border-cyan-500/50 hover:text-cyan-100 transition-colors"
                >
                  {sug}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg, i) => (
            <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${msg.role === 'user' ? 'bg-indigo-600' : 'bg-cyan-900'}`}>
                {msg.role === 'user' ? <User className="w-4 h-4 text-white" /> : <Bot className="w-4 h-4 text-cyan-400" />}
              </div>
              <div className={`p-3 rounded-lg max-w-[75%] text-sm ${msg.role === 'user' ? 'bg-indigo-600/20 border border-indigo-500/30 text-indigo-50' : 'bg-slate-800/50 border border-[var(--color-border-subtle)] text-gray-300'}`}>
                {/* Very simple formatting for newlines */}
                {msg.content.split('\n').map((line, j) => (
                  <p key={j} className={j > 0 ? 'mt-2' : ''}>{line}</p>
                ))}
              </div>
            </div>
          ))
        )}
        {loading && (
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full flex items-center justify-center bg-cyan-900">
              <Bot className="w-4 h-4 text-cyan-400" />
            </div>
            <div className="p-3 rounded-lg bg-slate-800/50 border border-[var(--color-border-subtle)] flex items-center gap-2">
              <Loader2 className="w-4 h-4 text-cyan-400 animate-spin" />
              <span className="text-xs text-gray-400">Analyzing graph context...</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="p-4 border-t border-[var(--color-border-subtle)] bg-[rgba(10,14,23,0.9)]">
        <form 
          onSubmit={(e) => { e.preventDefault(); handleSend(input); }}
          className="relative flex items-center"
        >
          <input 
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Ask AI Copilot..."
            className="w-full bg-slate-900 border border-[var(--color-border-subtle)] rounded-full py-2.5 pl-4 pr-12 text-sm text-white focus:outline-none focus:border-cyan-500 transition-colors"
          />
          <button 
            type="submit"
            disabled={!input.trim() || loading}
            className="absolute right-2 p-1.5 rounded-full text-cyan-400 hover:bg-cyan-900/30 disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
}
