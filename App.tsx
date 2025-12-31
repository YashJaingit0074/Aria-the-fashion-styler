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
        top: { type: Type.STRING, description: 'Upper body piece' },
        bottom: { type: Type.STRING, description: 'Lower body piece' },
        footwear: { type: Type.STRING, description: 'Shoes' },
        accessories: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Accessories' },
        colorPalette: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Hex codes' },
        vibe: { type: Type.STRING, description: 'Style aesthetic' },
      },
      required: ['top', 'bottom', 'footwear', 'accessories', 'colorPalette', 'vibe'],
    },
  };

  const connectToAria = async () => {
    const key = process.env.API_KEY;
    if (!key) {
      console.error("API_KEY environment variable is missing.");
      setAppState(AppState.ERROR);
      return;
    }

    try {
      setAppState(AppState.CONNECTING);
      await initAudio();
      
      const ai = new GoogleGenAI({ apiKey: key });
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
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setAppState(AppState.LISTENING);
            }
          },
          onerror: (e) => {
            console.error("Gemini Handshake Error:", e);
            setAppState(AppState.ERROR);
          },
          onclose: () => setAppState(AppState.IDLE)
        },
        config: {
          responseModalities: [Modality.AUDIO],
          tools: [{ functionDeclarations: [displayOutfitFunctionDeclaration] }],
          systemInstruction: `You are Aria, a world-class AI fashion architect. 
          Location: ${location}. Speak with high-status elegance and futuristic flair. 
          Call 'displayOutfitSuggestion' whenever you recommend a look.`,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          },
          outputAudioTranscription: {},
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error("Initialization Failed:", err);
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
    <div className="relative h-screen w-screen bg-[#050505] overflow-hidden font-sans">
      <AvatarCanvas isSpeaking={appState === AppState.SPEAKING} amplitude={amplitude} />

      <div className="absolute top-0 w-full p-8 flex justify-between items-start z-20 pointer-events-none">
        <div className="pointer-events-auto">
          <h1 className="text-4xl font-black tracking-tighter italic text-white/90">ARIA <span className="text-gold text-sm not-italic font-light ml-2 uppercase tracking-[0.4em]">Designer Unit</span></h1>
          <div className="flex items-center gap-2 mt-2">
            <div className={`w-2 h-2 rounded-full ${appState === AppState.IDLE ? 'bg-red-500' : (appState === AppState.ERROR ? 'bg-orange-500' : 'bg-gold animate-pulse')}`}></div>
            <span className="text-[10px] text-white/40 uppercase tracking-widest">{appState}</span>
          </div>
        </div>
        <div className="bg-white/5 backdrop-blur-xl border border-white/10 px-4 py-2 rounded-full flex items-center gap-3 pointer-events-auto shadow-xl">
          <i className="fa-solid fa-location-dot text-gold text-xs"></i>
          <span className="text-[10px] uppercase font-mono text-white/60">{location}</span>
        </div>
      </div>

      <div className="absolute left-8 top-1/2 -translate-y-1/2 w-80 z-30 pointer-events-none">
        {transcription && (
          <div className="bg-black/80 backdrop-blur-3xl border-l-2 border-gold p-6 rounded-r-3xl animate-in fade-in slide-in-from-left-4 duration-500 pointer-events-auto shadow-2xl">
            <span className="text-[9px] uppercase tracking-widest text-gold/60 mb-2 block font-bold">Neural Output Stream</span>
            <p className="text-sm font-light leading-relaxed italic text-white/80">"{transcription}"</p>
          </div>
        )}
      </div>

      {currentOutfit && (
        <div className="absolute right-8 top-1/2 -translate-y-1/2 w-80 z-30 animate-in slide-in-from-right-4 fade-in duration-500">
          <div className="bg-black/80 backdrop-blur-3xl border border-gold/30 rounded-3xl overflow-hidden shadow-[0_0_50px_rgba(212,175,55,0.15)]">
            <div className="bg-gold/10 px-6 py-4 border-b border-gold/20 flex justify-between items-center">
              <div>
                <span className="text-[9px] uppercase tracking-widest text-gold font-bold">Outfit Manifest</span>
                <h2 className="text-xl font-bold tracking-tight">{currentOutfit.vibe}</h2>
              </div>
              <button onClick={() => setCurrentOutfit(null)} className="text-white/20 hover:text-white transition-colors"><i className="fa-solid fa-xmark"></i></button>
            </div>
            <div className="p-6 space-y-4">
              <div><span className="text-[9px] text-white/40 uppercase block mb-1">Top</span><p className="text-sm font-medium">{currentOutfit.top}</p></div>
              <div><span className="text-[9px] text-white/40 uppercase block mb-1">Bottom</span><p className="text-sm font-medium">{currentOutfit.bottom}</p></div>
              <div><span className="text-[9px] text-white/40 uppercase block mb-1">Footwear</span><p className="text-sm font-medium">{currentOutfit.footwear}</p></div>
              <div className="flex flex-wrap gap-2 pt-2">
                {currentOutfit.accessories.map((a, i) => <span key={i} className="text-[10px] bg-white/5 border border-white/10 px-2 py-1 rounded text-white/60">{a}</span>)}
              </div>
              <div className="flex gap-1 pt-4 h-1.5 rounded-full overflow-hidden">
                {currentOutfit.colorPalette.map((c, i) => <div key={i} className="flex-1 h-full" style={{ backgroundColor: c }} />)}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="absolute bottom-8 w-full flex flex-col items-center gap-4 z-40 px-8">
        {(appState === AppState.LISTENING || appState === AppState.SPEAKING) && (
          <div className="flex gap-1 items-end h-10 mb-2">
            {Array.from({ length: 24 }).map((_, i) => (
              <div key={i} className="w-1 bg-cyber rounded-full transition-all duration-75 shadow-[0_0_10px_rgba(0,242,255,0.5)]" style={{ height: `${Math.max(15, (appState === AppState.SPEAKING ? amplitude : inputAmplitude) * 100 * (0.4 + Math.random()))}%` }}></div>
            ))}
          </div>
        )}
        
        <div className="w-full max-w-2xl flex gap-3">
          {appState === AppState.IDLE || appState === AppState.ERROR ? (
            <button onClick={connectToAria} className="w-full bg-gold hover:bg-white text-black font-bold py-6 rounded-2xl transition-all shadow-[0_0_40px_rgba(212,175,55,0.3)] uppercase tracking-widest text-sm active:scale-95 group">
              <span className="group-hover:scale-110 transition-transform inline-block">
                {appState === AppState.ERROR ? "Reconnect Neural Link" : "Initialize Aria Architect"}
              </span>
            </button>
          ) : (
            <>
              <div className="flex-1 relative">
                <input 
                  type="text" 
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                  placeholder="Ask Aria to curate your aesthetic..."
                  className="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-5 focus:outline-none focus:border-gold transition-all text-sm backdrop-blur-md shadow-inner"
                />
                <button onClick={handleSendMessage} className="absolute right-5 top-1/2 -translate-y-1/2 text-gold p-2 hover:scale-125 transition-transform"><i className="fa-solid fa-paper-plane"></i></button>
              </div>
              <div className={`w-16 h-16 rounded-2xl flex items-center justify-center border transition-all shadow-xl ${appState === AppState.SPEAKING ? 'border-gold bg-gold/10' : 'border-white/10 bg-white/5'}`}>
                {appState === AppState.SPEAKING ? <i className="fa-solid fa-volume-high text-gold animate-pulse text-xl"></i> : <i className={`fa-solid fa-microphone text-xl ${appState === AppState.LISTENING ? 'text-cyber' : 'text-white/20'}`}></i>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default App;