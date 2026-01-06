import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenerativeAI, SchemaType, type Tool, type ChatSession } from '@google/generative-ai';
import { time } from 'console';

// --- TYPE DEFINITIONS ---
interface AppointmentDetails {
  patientName: string;
  department: string;
  doctorName: string;
  symptoms: string;
  timeSlot: string;
}

// --- TOOL DEFINITIONS ---

// Tool 1: Check Availability
const getDoctorAvailabilityTool: Tool = {
  functionDeclarations: [
    {
      name: 'get_doctor_availability',
      description: 'Check if a doctor/department is available. Call this when user asks for a slot.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          department: { type: SchemaType.STRING, description: 'Medical department' },
          doctorName: { type: SchemaType.STRING, description: 'Doctor name (optional)' },
          date: { type: SchemaType.STRING, description: 'Requested date' },
        },
        required: ['department'],
      },
    }
  ]
};

// Tool 2: Confirm & Book (Triggers Save + Sentiment Analysis)
const confirmAppointmentTool: Tool = {
  functionDeclarations: [
    {
      name: 'confirm_appointment',
      description: 'Call this ONLY when the user explicitly agrees to book the appointment.',
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          patientName: { type: SchemaType.STRING, description: 'Name of patient' },
          department: { type: SchemaType.STRING, description: 'Department booked' },
          doctorName: { type: SchemaType.STRING, description: 'Doctor name' },
          symptoms: { type: SchemaType.STRING, description: 'Patient symptoms' },
          timeSlot: { type: SchemaType.STRING, description: 'Confirmed time slot' },
        },
        required: ['patientName', 'department', 'symptoms', 'timeSlot'],
      },
    }
  ]
};

const VoiceAssistant: React.FC = () => {
  const [isListening, setIsListening] = useState(false);
  const [status, setStatus] = useState<string>('Ready to help');
  const [transcription, setTranscription] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [language, setLanguage] = useState<'en-US' | 'ml-IN'>('en-US');

  // Refs
  const chatSessionRef = useRef<ChatSession | null>(null);
  const recognitionRef = useRef<any>(null);
  // We use a ref for transcription history to ensure the analyzer gets the absolute latest data without state lag
  const historyRef = useRef<string[]>([]);

  // 1. SETUP SPEECH RECOGNITION
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = false;
      recognitionRef.current.interimResults = false;
      recognitionRef.current.lang = language;

      recognitionRef.current.onresult = (event: any) => {
        const text = event.results[0][0].transcript;
        handleStandardVoiceInput(text);
      };

      recognitionRef.current.onend = () => setIsListening(false);
      recognitionRef.current.onerror = (event: any) => {
        console.error('Speech recognition error', event.error);
        setIsListening(false);
        setStatus('Error listening');
      };
    }
    window.speechSynthesis.getVoices();
  }, [language]);

  // 2. TEXT-TO-SPEECH HANDLER
  const speak = (text: string) => {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    
    let selectedVoice = null;
    if (language === 'ml-IN') {
      selectedVoice = voices.find(v => v.lang === 'ml-IN') || voices.find(v => v.lang === 'en-IN');
    } else {
      selectedVoice = voices.find(v => v.name.includes('Google') && v.lang === 'en-IN') || voices.find(v => v.lang === 'en-IN');
    }

    if (selectedVoice) utterance.voice = selectedVoice;
    utterance.rate = 0.9; 
    utterance.pitch = 1.0; 
    window.speechSynthesis.speak(utterance);
  };

  // --- HELPER: SENTIMENT ANALYZER ---
  const analyzeAndSave = async (details: AppointmentDetails) => {
    setStatus('Analyzing Sentiment...');
    try {
      const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-3-pro-preview' });

      // Create a prompt with the full conversation history
      const fullConversation = historyRef.current.join('\n');
      const prompt = `
        Analyze the sentiment of the Patient in the following conversation.
        Return ONLY a JSON object: { "sentiment": "Happy|Neutral|Anxious|Angry", "confidence": 0.0 to 1.0 }
        
        Conversation:
        ${fullConversation}
      `;

      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const cleanJson = text.replace(/```json|```/g, '').trim();
      
      // FIXED: Using standard JSON object
      const sentimentData = JSON.parse(cleanJson);

      // --- SAVE TO BACKEND ---
      await fetch('http://localhost:4000/log-appointment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...details,
          sentiment: sentimentData.sentiment,
          confidence: sentimentData.confidence
        })
      });

      console.log("SAVED:", details, sentimentData);
      return sentimentData;

    } catch (e) {
      console.error("Analysis Failed", e);
      return { sentiment: 'Unknown', confidence: 0 };
    }
  };

  // 3. MAIN AI LOGIC
  const handleStandardVoiceInput = async (text: string) => {
    // Update State & Ref
    const userMsg = `You: ${text}`;
    setTranscription(prev => [...prev, userMsg]);
    historyRef.current.push(userMsg);

    setIsProcessing(true);
    setStatus('Thinking...');

    try {
      if (!chatSessionRef.current) {
        const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
        const genAI = new GoogleGenerativeAI(apiKey);
        
        const model = genAI.getGenerativeModel({ 
          model: 'gemini-3-pro-preview', 
          systemInstruction: `You are Puck, a hospital booking assistant.
            1. Ask for Patient Name, Symptoms, and Department.
            2. Check availability using 'get_doctor_availability'.
            3. Once the user says YES to a slot, you MUST use 'confirm_appointment' to finalize it.
            
            OUTPUT FORMAT:
            Reply in strictly valid JSON:
            {
              "text": "Screen text",
              "speech": "Voice text (use Manglish if Malayalam is requested)"
            }`,
          tools: [getDoctorAvailabilityTool, confirmAppointmentTool],
        });

        chatSessionRef.current = model.startChat({ history: [] });
      }

      const result = await chatSessionRef.current.sendMessage(text);
      const response = await result.response;
      const functionCalls = response.functionCalls();

      let displayReply = "";
      let speechReply = "";

      // --- HANDLE TOOLS ---
      if (functionCalls && functionCalls.length > 0) {
        const call = functionCalls[0];
        const args = call.args as any;

        // CHECK AVAILABILITY
        if (call.name === 'get_doctor_availability') {
          // Mock response from "database"
          const functionResponse = {
            result: `Available slots for ${args.department}: Tomorrow 10 AM with Dr. Smith or 2 PM with Dr. Jones.`
          };
          
          // Send result back to Gemini so it can tell the user
          const nextResult = await chatSessionRef.current.sendMessage(
            JSON.stringify(functionResponse)
          );
          const nextResponse = nextResult.response.text();
          
          try {
            const parsed = JSON.parse(nextResponse.replace(/```json|```/g, '').trim());
            displayReply = parsed.text;
            speechReply = parsed.speech;
          } catch {
            displayReply = nextResponse;
            speechReply = nextResponse;
          }
        }
        
        // CONFIRM & ANALYZE
        else if (call.name === 'confirm_appointment') {
          displayReply = `Appointment Confirmed for ${args.patientName}. Details have been saved.`;
          speechReply = "Your appointment is confirmed. I have saved your details.";
          
          // Trigger Background Analysis & Save
          analyzeAndSave({
             patientName: args.patientName,
             department: args.department,
             doctorName: args.doctorName || 'General',
             symptoms: args.symptoms,
            timeSlot: args.timeSlot
          });
        }

      } else {
        // STANDARD REPLY
        const rawText = response.text();
        try {
          const cleanJson = rawText.replace(/```json|```/g, '').trim();
          const parsed = JSON.parse(cleanJson);
          displayReply = parsed.text;
          speechReply = parsed.speech;
        } catch (e) {
          displayReply = rawText;
          speechReply = rawText;
        }
      }

      // Update UI & Speak
      const botMsg = `Puck: ${displayReply}`;
      setTranscription(prev => [...prev, botMsg]);
      historyRef.current.push(botMsg);
      
      speak(speechReply);
      setStatus('Ready');

    } catch (err) {
      console.error(err);
      setStatus('API Error');
      speak("I'm sorry, I encountered an error. Please try again.");
    } finally {
      setIsProcessing(false);
    }
  };

  const toggleListening = () => {
    if (isListening) {
      recognitionRef.current?.stop();
    } else {
      window.speechSynthesis.cancel();
      recognitionRef.current.lang = language; 
      recognitionRef.current?.start();
      setIsListening(true);
      setStatus(language === 'ml-IN' ? 'ശ്രദ്ധിക്കുന്നു...' : 'Listening...');
    }
  };

  return (
    <div className="flex flex-col h-full p-6 md:p-10 bg-white">
      <div className="max-w-4xl mx-auto w-full flex flex-col h-full">
        <header className="mb-8 flex justify-between items-start border-b border-slate-100 pb-6">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <div className="w-8 h-8 bg-red-700 rounded-lg flex items-center justify-center text-white text-xs">
                <i className="fas fa-plus"></i>
              </div>
              <h2 className="text-2xl font-bold text-slate-900">Rajagiri Voice Assistant</h2>
            </div>
            <p className="text-slate-500 text-sm">Powered by Gemini 1.5 Flash</p>
          </div>
          
          <button 
            onClick={() => {
                const newLang = language === 'en-US' ? 'ml-IN' : 'en-US';
                setLanguage(newLang);
                chatSessionRef.current = null;
                setTranscription([]); 
                historyRef.current = [];
            }}
            className="px-4 py-2 bg-slate-100 rounded-full text-xs font-bold text-slate-600 hover:bg-slate-200 transition-colors border border-slate-200"
          >
            <i className="fas fa-language mr-2"></i>
            {language === 'en-US' ? 'English' : 'മലയാളം'}
          </button>
        </header>

        <div className="flex-grow flex flex-col items-center justify-center mb-8">
          <div className={`relative w-60 h-60 rounded-full flex items-center justify-center transition-all duration-500 ${
            isListening ? 'bg-red-600 shadow-[0_0_60px_-10px_rgba(220,38,38,0.3)]' : 'bg-slate-50 border border-slate-200'
          }`}>
            <button
              onClick={toggleListening}
              disabled={isProcessing}
              className={`w-40 h-40 rounded-full flex flex-col items-center justify-center text-white transition-all transform active:scale-95 shadow-xl ${
                isListening ? 'bg-slate-900' : 'bg-red-700 hover:bg-red-800'
              }`}
            >
              {isProcessing ? (
                <i className="fas fa-spinner fa-spin text-3xl"></i>
              ) : (
                <>
                   <i className={`fas ${isListening ? 'fa-stop' : 'fa-microphone'} text-3xl mb-3`}></i>
                   <span className="text-[10px] font-bold uppercase tracking-widest">
                     {isListening ? 'Stop' : (language === 'ml-IN' ? 'സംസാരിക്കൂ' : 'Talk')}
                   </span>
                </>
              )}
            </button>
          </div>
          <div className="mt-8">
            <div className={`px-5 py-2 rounded-full text-[10px] font-black uppercase tracking-[0.2em] shadow-sm border ${
              isListening ? 'bg-red-50 text-red-600 border-red-100' : 'bg-slate-50 text-slate-400 border-slate-200'
            }`}>
              {status}
            </div>
          </div>
        </div>

        <div className="bg-slate-50 rounded-[2rem] p-6 border border-slate-200 h-64 overflow-y-auto flex flex-col-reverse shadow-inner scrollbar-hide">
          <div className="space-y-4">
            {transcription.map((t, i) => (
              <div key={i} className={`flex ${t.startsWith('You:') ? 'justify-end' : 'justify-start'}`}>
                <div className={`p-4 rounded-2xl text-xs leading-relaxed max-w-[85%] shadow-sm ${
                  t.startsWith('You:') 
                    ? 'bg-red-700 text-white rounded-tr-none' 
                    : 'bg-white text-slate-700 border border-slate-100 rounded-tl-none'
                }`}>
                  {t.replace(/^(Puck:|You:)\s*/, '')}
                </div>
              </div>
            ))}
            {transcription.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center opacity-20 py-10">
                <i className="fas fa-wave-square text-2xl mb-2"></i>
                <p className="text-[10px] font-bold uppercase">Click talk to begin</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default VoiceAssistant;