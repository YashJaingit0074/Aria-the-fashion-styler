import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { AvatarCanvas } from './components/AvatarCanvas';
import { AppState, Outfit } from './types';
import { decode, decodeAudioData, createBlob, encode } from './utils/audio-helpers';

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [amplitude, setAmplitude] = useState(0);
  const [inputAmplitude, setInputAmplitude] = useState(0);
  const [transcription, setTranscription] = useState('');
  const [userInput, setUserInput] = useState('');
  const [location, setLocation] = useState<string>('Detecting...');
  const [currentOutfit, setCurrentOutfit] = useState<Outfit | null>(null);
  
  // Audio Refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const inputAnalyzerRef = useRef<AnalyserNode | null>(null);

  const initAudio = async () => {
    // Standardize initialization for cross-browser support
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContextClass({ sampleRate: 16000 });
      outputAudioContextRef.current = new AudioContextClass({ sampleRate: 24000 });
      
      const outAnalyzer = outputAudioContextRef.current.createAnalyser();
      outAnalyzer.fftSize = 256;
      outAnalyzer.connect(outputAudioContextRef.current.destination);
      analyzerRef.current = outAnalyzer;

      const inAnalyzer = audioContextRef.current.createAnalyser();
      inAnalyzer.fftSize = 256;
      inputAnalyzerRef.current = inAnalyzer;
    }
    
    // CRITICAL: Resume contexts within the click handler to satisfy browser autoplay policies
    if (audioContextRef.current.state === 'suspended') await audioContextRef.current.resume();
    if (outputAudioContextRef.current.state === 'suspended') await outputAudioContextRef.current.resume();
  };

  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          try {
            setLocation(`${pos.coords.latitude.toFixed(2)}, ${pos.coords.longitude.toFixed(2)}`);
          } catch (e) {
            setLocation('Global Hub');
          }
        },
        () => setLocation('Global Hub')
      );
    }
  }, []);

  useEffect(() => {
    let animationId: number;
    const updateAmplitudes = () => {
      if (analyzerRef.current && appState === AppState.SPEAKING) {
        const dataArray = new Uint8Array(analyzerRef.current.frequencyBinCount);
        analyzerRef.current.getByteFrequencyData(dataArray);
        const sum = dataArray.reduce((a, b) => a + b, 0);
        setAmplitude(sum / dataArray.length / 255);
      } else {
        setAmplitude(0);
      }

      if (inputAnalyzerRef.current && (appState === AppState.LISTENING || appState === AppState.SPEAKING)) {
        const dataArray = new Uint8Array(inputAnalyzerRef.current.frequencyBinCount);
        inputAnalyzerRef.current.getByteFrequencyData(dataArray);
        const sum = dataArray.reduce((a, b) => a + b, 0);
        const avg = sum / dataArray.length / 255;
        setInputAmplitude(avg);
      } else {
        setInputAmplitude(0);
      }

      animationId = requestAnimationFrame(updateAmplitudes);
    };
    updateAmplitudes();
    return () => cancelAnimationFrame(animationId);
  }, [appState]);

  const displayOutfitFunctionDeclaration: FunctionDeclaration = {
    name: 'displayOutfitSuggestion',
    parameters: {
      type: Type.OBJECT,
      description: 'Displays a high-fashion outfit manifest card to the user.',
      properties: {
        top: { type: Type.STRING, description: 'Upper body piece (e.g. Chrome-plated bomber jacket)' },
        bottom: { type: Type.STRING, description: 'Lower body piece (e.g. Pleated iridium trousers)' },
        footwear: { type: Type.STRING, description: 'Shoes (e.g. Gravity-defying boots)' },
        accessories: { type: Type.ARRAY, items: { type: Type.STRING }, description: '2-3 futuristic accessories' },
        colorPalette: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Colors in hex' },
        vibe: { type: Type.STRING, description: 'Overall style aesthetic' },
      },
      required: ['top', 'bottom', 'footwear', 'accessories', 'colorPalette', 'vibe'],
    },
  };

  const connectToAria = async () => {
    try {
      setAppState(AppState.CONNECTING);
      await initAudio();
      
      // Use process.env.API_KEY directly for Vercel/Vite environment consistency
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            setAppState(AppState.LISTENING);
            const source = audioContextRef.current!.createMediaStreamSource(stream);
            source.connect(inputAnalyzerRef.current!);
            
            const scriptProcessor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                if (fc.name === 'displayOutfitSuggestion') {
                  setCurrentOutfit(fc.args as any as Outfit);
                  sessionPromise.then(session => {
                    session.sendToolResponse({
                      functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } }
                    });
                  });
                }
              }
            }

            const parts = message.serverContent?.modelTurn?.parts;
            if (parts) {
              for (const part of parts) {
                if (part.inlineData?.data) {
                  setAppState(AppState.SPEAKING);
                  const audioData = decode(part.inlineData.data);
                  const ctx = outputAudioContextRef.current!;
                  
                  // Ensure we are playing at the end of the previous buffer
                  nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
                  const buffer = await decodeAudioData(audioData, ctx, 24000, 1);
                  const source = ctx.createBufferSource();
                  source.buffer = buffer;
                  source.connect(analyzerRef.current!);
                  
                  source.addEventListener('ended', () => {
                    sourcesRef.current.delete(source);
                    if (sourcesRef.current.size === 0) setAppState(AppState.LISTENING);
                  });
                  
                  source.start(nextStartTimeRef.current);
                  nextStartTimeRef.current += buffer.duration;
                  sourcesRef.current.add(source);
                }
              }
            }

            if (message.serverContent?.outputTranscription) {
              setTranscription(prev => (prev + message.serverContent!.outputTranscription!.text).slice(-500));
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => {
                try { s.stop(); } catch(e) {}
              });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setAppState(AppState.LISTENING);
            }
          },
          onerror: (e) => {
            console.error("Aria Neural Error:", e);
            setAppState(AppState.ERROR);
          },
          onclose: () => setAppState(AppState.IDLE)
        },
        config: {
          responseModalities: [Modality.AUDIO],
          tools: [{ functionDeclarations: [displayOutfitFunctionDeclaration] }],
          systemInstruction: `You are Aria, a high-end AI fashion designer. 
          Location: ${location}. Speak with elegance and precision. 
          Your style is Cyber-Couture. Always call 'displayOutfitSuggestion' when recommending a specific look. 
          Be bold, futuristic, and encouraging. Focus on the user's personal expression through high fashion.`,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          },
          outputAudioTranscription: {},
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error("Initialization failed:", err);
      setAppState(AppState.ERROR);
    }
  };

  const handleSendMessage = () => {
    if (!userInput.trim() || !sessionRef.current) return;
    const encodedText = encode(new TextEncoder().encode(userInput));
    sessionRef.current.sendRealtimeInput({
      media: { data: encodedText, mimeType: 'text/plain' }
    });
    setUserInput('');
    setTranscription('');
  };

  return (
    <div className="relative h-screen w-screen bg-[#050505] overflow-hidden">
      <AvatarCanvas isSpeaking={appState === AppState.SPEAKING} amplitude={amplitude} />

      {/* Header */}
      <div className="absolute top-0 w-full p-8 flex justify-between items-start z-20 pointer-events-none">
        <div className="pointer-events-auto">
          <h1 className="text-4xl font-black tracking-tighter italic text-white/90">ARIA <span className="text-gold text-sm not-italic font-light ml-2 uppercase tracking-[0.4em]">Designer Unit</span></h1>
          <div className="flex items-center gap-2 mt-2">
            <div className={`w-2 h-2 rounded-full ${appState === AppState.IDLE ? 'bg-red-500' : (appState === AppState.ERROR ? 'bg-orange-500' : 'bg-gold animate-pulse')}`}></div>
            <span className="text-[10px] text-white/40 uppercase tracking-widest">{appState}</span>
          </div>
        </div>
        <div className="bg-white/5 backdrop-blur-xl border border-white/10 px-4 py-2 rounded-full flex items-center gap-3 pointer-events-auto">
          <i className="fa-solid fa-location-dot text-gold text-xs"></i>
          <span className="text-[10px] uppercase font-mono text-white/60">{location}</span>
        </div>
      </div>

      {/* Neural Stream (Left) */}
      <div className="absolute left-8 top-1/2 -translate-y-1/2 w-80 z-30 pointer-events-none">
        {transcription && (
          <div className="bg-black/60 backdrop-blur-2xl border-l-2 border-gold p-6 rounded-r-3xl animate-in fade-in slide-in-from-left-4 duration-500 pointer-events-auto shadow-2xl">
            <span className="text-[9px] uppercase tracking-widest text-gold/60 mb-2 block font-bold">Neural Output Stream</span>
            <p className="text-sm font-light leading-relaxed italic text-white/80">"{transcription}"</p>
          </div>
        )}
      </div>

      {/* Outfit Card (Right) */}
      {currentOutfit && (
        <div className="absolute right-8 top-1/2 -translate-y-1/2 w-80 z-30 animate-in slide-in-from-right-4 fade-in duration-500">
          <div className="bg-black/60 backdrop-blur-2xl border border-gold/30 rounded-3xl overflow-hidden shadow-[0_0_40px_rgba(212,175,55,0.1)]">
            <div className="bg-gold/10 px-6 py-4 border-b border-gold/20 flex justify-between items-center">
              <div>
                <span className="text-[9px] uppercase tracking-widest text-gold font-bold">Outfit Manifest</span>
                <h2 className="text-xl font-bold tracking-tight">{currentOutfit.vibe}</h2>
              </div>
              <button onClick={() => setCurrentOutfit(null)} className="text-white/20 hover:text-white transition-colors"><i className="fa-solid fa-xmark"></i></button>
            </div>
            <div className="p-6 space-y-4">
              <div><span className="text-[9px] text-white/40 uppercase block">Top</span><p className="text-sm font-medium">{currentOutfit.top}</p></div>
              <div><span className="text-[9px] text-white/40 uppercase block">Bottom</span><p className="text-sm font-medium">{currentOutfit.bottom}</p></div>
              <div><span className="text-[9px] text-white/40 uppercase block">Footwear</span><p className="text-sm font-medium">{currentOutfit.footwear}</p></div>
              <div className="flex flex-wrap gap-2 pt-2">
                {currentOutfit.accessories.map((a, i) => <span key={i} className="text-[10px] bg-white/5 border border-white/10 px-2 py-1 rounded text-white/60">{a}</span>)}
              </div>
              <div className="flex gap-1 pt-2 h-1 rounded-full overflow-hidden">
                {currentOutfit.colorPalette.map((c, i) => <div key={i} className="flex-1 h-full" style={{ backgroundColor: c }} />)}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Controls (Bottom) */}
      <div className="absolute bottom-8 w-full flex flex-col items-center gap-4 z-40 px-8">
        {(appState === AppState.LISTENING || appState === AppState.SPEAKING) && (
          <div className="flex gap-1 items-end h-8">
            {Array.from({ length: 20 }).map((_, i) => (
              <div key={i} className="w-1 bg-cyber rounded-full transition-all duration-75" style={{ height: `${Math.max(10, (appState === AppState.SPEAKING ? amplitude : inputAmplitude) * 100 * (0.5 + Math.random()))}%` }}></div>
            ))}
          </div>
        )}
        
        <div className="w-full max-w-2xl flex gap-3">
          {appState === AppState.IDLE || appState === AppState.ERROR ? (
            <button onClick={connectToAria} className="w-full bg-gold hover:bg-white text-black font-bold py-5 rounded-2xl transition-all shadow-[0_0_30px_rgba(212,175,55,0.2)] uppercase tracking-widest text-sm active:scale-95">
              {appState === AppState.ERROR ? "Retry System Handshake" : "Initialize Aria Architect"}
            </button>
          ) : (
            <>
              <div className="flex-1 relative">
                <input 
                  type="text" 
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                  placeholder="Ask Aria to design your look..."
                  className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 focus:outline-none focus:border-gold transition-colors text-sm"
                />
                <button onClick={handleSendMessage} className="absolute right-4 top-1/2 -translate-y-1/2 text-gold p-2 hover:scale-110 transition-transform"><i className="fa-solid fa-paper-plane"></i></button>
              </div>
              <div className={`w-14 h-14 rounded-2xl flex items-center justify-center border transition-all ${appState === AppState.SPEAKING ? 'border-gold bg-gold/10' : 'border-white/10 bg-white/5'}`}>
                {appState === AppState.SPEAKING ? <i className="fa-solid fa-volume-high text-gold animate-pulse"></i> : <i className={`fa-solid fa-microphone ${appState === AppState.LISTENING ? 'text-cyber' : 'text-white/20'}`}></i>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default App;